const DEEPGRAM_BASE_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-3";
const TARGET_SAMPLE_RATE = 16000;
const NO_AUDIO_TIMEOUT_MS = 60000;
const AUDIO_ACTIVITY_THRESHOLD = 0.002;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
const DEBUG_DEEPGRAM = false;
const sessions = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  handleRuntimeMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("Offscreen message failed", error);
      sendResponse({ ok: false, error: error.message || "Unknown error" });
    });

  return true;
});

async function handleRuntimeMessage(message) {
  switch (message?.type) {
    case "runtime_start":
      await startCapture(message);
      return { ok: true };
    case "runtime_stop":
      await stopCapture(message.tabId, {
        notifyStopped: true,
        stopReason: reasonFromCode(message.reasonCode || "user_stop"),
        isFailure: false
      });
      return { ok: true };
    case "runtime_get_snapshot":
      return getSessionState(message.tabId);
    case "has_active_sessions":
      return {
        ok: true,
        active: sessions.size > 0
      };
    case "runtime_list_sessions":
      return {
        ok: true,
        tabIds: Array.from(sessions.keys())
      };
    case "runtime_set_tab_active":
      return updateTabActivity(message.tabId, message.sessionId, message.active, message.inactiveTimeoutMs);
    default:
      return { ok: false, error: "Unsupported offscreen message" };
  }
}

async function startCapture({ sessionId, tabId, streamId, apiKey, language, model }) {
  await stopCapture(tabId, { notifyStopped: false });

  let mediaStream = null;
  let session = null;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error("No audio track available from captured tab");
    }

    session = createSession({
      sessionId,
      tabId,
      apiKey,
      language,
      model,
      mediaStream
    });

    sessions.set(tabId, session);
    await session.initPromise;
  } catch (error) {
    if (session && sessions.get(tabId) === session) {
      await stopCapture(tabId, { notifyStopped: false });
    } else {
      mediaStream?.getTracks().forEach((track) => track.stop());
      sessions.delete(tabId);
    }

    throw error;
  }
}

function createSession({ sessionId, tabId, apiKey, language, model, mediaStream }) {
  const session = {
    sessionId,
    tabId,
    apiKey,
    language,
    model: model || DEFAULT_MODEL,
    mediaStream,
    audioContext: null,
    playbackContext: null,
    sourceNode: null,
    workletNode: null,
    playbackSourceNode: null,
    websocket: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    lastError: "",
    inactiveTimer: null,
    inactiveTimeoutMs: 0,
    silenceTimer: null,
    isTabActive: true,
    stopping: false,
    currentSampleRate: 48000,
    pcmQueue: [],
    initPromise: null,
    flushScheduled: false
  };

  session.initPromise = initializeAudioPipeline(session);
  scheduleSilenceTimeout(session);
  return session;
}

async function initializeAudioPipeline(session) {
  // The audio graph stays in the offscreen document so the service worker can sleep
  // without interrupting the capture or network stream.
  session.audioContext = new AudioContext();
  session.playbackContext = new AudioContext();
  session.currentSampleRate = session.audioContext.sampleRate;
  await session.audioContext.audioWorklet.addModule(chrome.runtime.getURL("pcm-processor.js"));

  session.sourceNode = session.audioContext.createMediaStreamSource(session.mediaStream);
  session.workletNode = new AudioWorkletNode(session.audioContext, "pcm-processor");
  session.workletNode.port.onmessage = (event) => handleWorkletFrame(session, event.data);

  // Chrome mutes the original tab once tab capture starts. Create a separate playback
  // path so the user still hears the tab audio while the worklet consumes the same stream.
  session.playbackSourceNode = session.playbackContext.createMediaStreamSource(session.mediaStream);

  // Connect to a zero-gain sink inside the processing graph so the worklet runs without
  // duplicating audible playback. The audible route is handled by playbackContext below.
  const muteNode = session.audioContext.createGain();
  muteNode.gain.value = 0;

  session.sourceNode.connect(session.workletNode);
  session.workletNode.connect(muteNode);
  muteNode.connect(session.audioContext.destination);
  session.playbackSourceNode.connect(session.playbackContext.destination);

  const audioTrack = session.mediaStream.getAudioTracks()[0];
  audioTrack.addEventListener("ended", () => {
    stopCapture(session.tabId, {
      notifyStopped: true,
      stopReason: createReason("stream_lost", "Audio stream lost", "runtime"),
      isFailure: true
    }).catch(() => {});
  });

  await openDeepgramWebSocket(session);
  await notifyBackground(session, "runtime_running", {
    websocketState: "open"
  });
}

function handleWorkletFrame(session, data) {
  if (!data?.samples || session.stopping) {
    return;
  }

  const samples = new Float32Array(data.samples);
  if (hasAudibleAudio(samples)) {
    scheduleSilenceTimeout(session);
  }

  session.pcmQueue.push(samples);
  if (session.flushScheduled) {
    return;
  }

  session.flushScheduled = true;
  queueMicrotask(() => {
    session.flushScheduled = false;
    flushPcmQueue(session);
  });
}

function flushPcmQueue(session) {
  if (session.stopping || !session.websocket || session.websocket.readyState !== WebSocket.OPEN) {
    session.pcmQueue.length = 0;
    return;
  }

  if (session.pcmQueue.length === 0) {
    return;
  }

  let totalLength = 0;
  for (const chunk of session.pcmQueue) {
    totalLength += chunk.length;
  }

  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of session.pcmQueue) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  session.pcmQueue.length = 0;

  const downsampled = downsampleBuffer(combined, session.currentSampleRate, TARGET_SAMPLE_RATE);
  if (downsampled.length === 0) {
    return;
  }

  const linear16 = floatToInt16Buffer(downsampled);
  session.websocket.send(linear16.buffer);
}

async function openDeepgramWebSocket(session) {
  const params = new URLSearchParams({
    model: session.model || DEFAULT_MODEL,
    encoding: "linear16",
    sample_rate: String(TARGET_SAMPLE_RATE),
    language: session.language,
    punctuate: "true",
    interim_results: "true",
    endpointing: "300"
  });

  const url = `${DEEPGRAM_BASE_URL}?${params.toString()}`;
  const protocols = ["token", session.apiKey];

  await new Promise((resolve, reject) => {
    let hasOpened = false;
    console.log("Opening Deepgram websocket", {
      tabId: session.tabId,
      model: session.model || DEFAULT_MODEL,
      sampleRate: session.currentSampleRate,
      language: session.language
    });

    const websocket = new WebSocket(url, protocols);
    websocket.binaryType = "arraybuffer";
    session.websocket = websocket;

    websocket.onopen = async () => {
      hasOpened = true;
      console.log("Deepgram websocket connected", {
        tabId: session.tabId,
        model: session.model || DEFAULT_MODEL,
        sampleRate: session.currentSampleRate
      });
      session.lastError = "";
      session.reconnectAttempt = 0;
      resolve();
    };

    websocket.onmessage = (event) => handleDeepgramMessage(session, event.data);

    websocket.onerror = (event) => {
      console.error("Deepgram websocket error", {
        tabId: session.tabId,
        model: session.model || DEFAULT_MODEL,
        sampleRate: session.currentSampleRate,
        event
      });
      reject(new Error("Deepgram WebSocket connection failed"));
    };

    websocket.onclose = async (event) => {
      console.warn("Deepgram websocket closed", {
        tabId: session.tabId,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      });

      if (session.stopping) {
        return;
      }

      if (!hasOpened) {
        return;
      }

      await notifyBackground(session, "runtime_reconnecting", {
        reason: createReason("network_reconnect", "Reconnecting to Deepgram", "network")
      });

      scheduleReconnect(session);
    };
  });
}

function handleDeepgramMessage(session, rawMessage) {
  let payload;
  try {
    payload = JSON.parse(rawMessage);
  } catch (error) {
    console.warn("Skipping non-JSON Deepgram message", error);
    return;
  }

  if (DEBUG_DEEPGRAM) {
    const alternative = payload?.channel?.alternatives?.[0];
    const words = alternative?.words || [];
    console.log("Deepgram update", {
      type: payload.type,
      is_final: Boolean(payload.is_final),
      speech_final: Boolean(payload.speech_final),
      transcript: (alternative?.transcript || "").trim(),
      word_count: words.length,
      word_tail: words.slice(-5).map((word) => word.word).filter(Boolean)
    });
  }

  if (payload.type === "Metadata" || payload.type === "UtteranceEnd") {
    return;
  }

  if (payload.type === "Error") {
    const errorMessage = payload.description || payload.message || "Deepgram error";
    session.lastError = errorMessage;
    stopCapture(session.tabId, {
      notifyStopped: true,
      stopReason: createReason("deepgram_error", errorMessage, "provider"),
      isFailure: true
    }).catch(() => {});
    return;
  }

  const alternative = payload?.channel?.alternatives?.[0];
  const transcript = (alternative?.transcript || "").trim();
  if (!transcript) {
    return;
  }

  const isFinal = Boolean(payload.is_final);
  notifyBackground(session, "transcript_update", {
    text: transcript,
    isFinal
  }).catch((error) => {
    console.warn("Failed to deliver transcript update", error);
  });
}

function scheduleReconnect(session) {
  if (session.reconnectTimer || session.stopping) {
    return;
  }

  const delay = RECONNECT_DELAYS_MS[Math.min(session.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  session.reconnectAttempt += 1;

  session.reconnectTimer = setTimeout(async () => {
    session.reconnectTimer = null;

    if (session.stopping) {
      return;
    }

    try {
      await openDeepgramWebSocket(session);
      await notifyBackground(session, "runtime_running", {
        websocketState: "open"
      });
    } catch (error) {
      console.error("Deepgram reconnect failed", error);
      scheduleReconnect(session);
    }
  }, delay);
}

function updateTabActivity(tabId, sessionId, active, inactiveTimeoutMs = 0) {
  const session = sessions.get(tabId);
  if (!session) {
    return { ok: true };
  }
  if (sessionId && session.sessionId !== sessionId) {
    return { ok: true, ignored: true };
  }

  session.isTabActive = Boolean(active);
  if (Number.isFinite(inactiveTimeoutMs) && inactiveTimeoutMs > 0) {
    session.inactiveTimeoutMs = inactiveTimeoutMs;
  }

  if (session.isTabActive) {
    clearInactiveTimeout(session);
  } else {
    scheduleInactiveTimeout(session);
  }

  return { ok: true };
}

function scheduleInactiveTimeout(session) {
  if (session.stopping || session.isTabActive || session.inactiveTimer) {
    return;
  }

  const timeoutMs = session.inactiveTimeoutMs || 0;
  if (timeoutMs <= 0) {
    return;
  }

  session.inactiveTimer = setTimeout(() => {
    session.inactiveTimer = null;
    if (session.stopping || session.isTabActive) {
      return;
    }

    stopCapture(session.tabId, {
      notifyStopped: true,
      stopReason: createReason("inactive_timeout", "Stopped after 120 seconds away from the tab", "timeout"),
      isFailure: false
    }).catch((error) => {
      console.warn("Failed to stop capture after tab inactivity", error);
    });
  }, timeoutMs);
}

function clearInactiveTimeout(session) {
  if (!session.inactiveTimer) {
    return;
  }

  clearTimeout(session.inactiveTimer);
  session.inactiveTimer = null;
}

function scheduleSilenceTimeout(session) {
  if (session.stopping) {
    return;
  }

  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
  }

  session.silenceTimer = setTimeout(() => {
    session.silenceTimer = null;
    if (session.stopping) {
      return;
    }

    stopCapture(session.tabId, {
      notifyStopped: true,
      stopReason: createReason("silence_timeout", "Stopped after 60 seconds without audible audio", "timeout"),
      isFailure: false
    }).catch((error) => {
      console.warn("Failed to stop capture after silence timeout", error);
    });
  }, NO_AUDIO_TIMEOUT_MS);
}

function clearSilenceTimeout(session) {
  if (!session.silenceTimer) {
    return;
  }

  clearTimeout(session.silenceTimer);
  session.silenceTimer = null;
}

async function stopCapture(tabId, { notifyStopped, stopReason = null, isFailure = false }) {
  const session = sessions.get(tabId);
  if (!session) {
    return;
  }

  session.stopping = true;
  if (stopReason) {
    session.lastError = stopReason.message || "";
  }
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  clearInactiveTimeout(session);
  clearSilenceTimeout(session);

  if (session.websocket) {
    try {
      session.websocket.close();
    } catch (error) {
      console.warn("Failed to close Deepgram socket", error);
    }
  }

  if (session.workletNode) {
    try {
      session.workletNode.port.onmessage = null;
      session.workletNode.disconnect();
    } catch (error) {
      console.warn("Failed to disconnect worklet", error);
    }
  }

  if (session.sourceNode) {
    try {
      session.sourceNode.disconnect();
    } catch (error) {
      console.warn("Failed to disconnect source node", error);
    }
  }

  if (session.playbackSourceNode) {
    try {
      session.playbackSourceNode.disconnect();
    } catch (error) {
      console.warn("Failed to disconnect playback source", error);
    }
  }

  if (session.audioContext) {
    try {
      await session.audioContext.close();
    } catch (error) {
      console.warn("Failed to close audio context", error);
    }
  }

  if (session.playbackContext) {
    try {
      await session.playbackContext.close();
    } catch (error) {
      console.warn("Failed to close playback context", error);
    }
  }

  session.mediaStream?.getTracks().forEach((track) => track.stop());
  sessions.delete(tabId);

  if (notifyStopped) {
    await notifyBackground(session, isFailure ? "runtime_failed" : "runtime_stopped", {
      reason: stopReason || createReason("user_stop", "Stopped by user", "user")
    });
  }
}

function getSessionState(tabId) {
  const session = sessions.get(tabId);
  const websocketState = deriveWebsocketState(session);

  return {
    ok: true,
    sessionId: session?.sessionId || null,
    tabId,
    hasRuntime: Boolean(session),
    websocketState,
    isReconnecting: Boolean(session?.reconnectTimer || websocketState === "connecting"),
    lastError: session?.lastError || "",
    isTabActive: session?.isTabActive !== false,
    hasInactiveTimer: Boolean(session?.inactiveTimer),
    hasSilenceTimer: Boolean(session?.silenceTimer)
  };
}

function deriveWebsocketState(session) {
  if (!session) {
    return "none";
  }

  switch (session.websocket?.readyState) {
    case WebSocket.CONNECTING:
      return "connecting";
    case WebSocket.OPEN:
      return "open";
    case WebSocket.CLOSING:
    case WebSocket.CLOSED:
      return "closed";
    default:
      return "none";
  }
}

function hasAudibleAudio(samples) {
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) >= AUDIO_ACTIVITY_THRESHOLD) {
      return true;
    }
  }

  return false;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) {
    return buffer;
  }

  if (outputSampleRate > inputSampleRate) {
    throw new Error("Output sample rate must be lower than input sample rate");
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(outputLength);
  let outputOffset = 0;
  let inputOffset = 0;

  while (outputOffset < result.length) {
    const nextInputOffset = Math.round((outputOffset + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let i = inputOffset; i < nextInputOffset && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }

    result[outputOffset] = count > 0 ? accum / count : 0;
    outputOffset += 1;
    inputOffset = nextInputOffset;
  }

  return result;
}

function floatToInt16Buffer(float32Buffer) {
  const int16Buffer = new Int16Array(float32Buffer.length);

  for (let i = 0; i < float32Buffer.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Buffer[i]));
    int16Buffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return int16Buffer;
}

function reasonFromCode(code) {
  switch (code) {
    case "tab_closed":
      return createReason("tab_closed", "Tab closed", "page");
    case "inactive_timeout":
      return createReason("inactive_timeout", "Stopped after 120 seconds away from the tab", "timeout");
    case "silence_timeout":
      return createReason("silence_timeout", "Stopped after 60 seconds without audible audio", "timeout");
    case "user_stop":
    default:
      return createReason("user_stop", "Stopped by user", "user");
  }
}

function createReason(code, message, category) {
  return {
    code,
    message,
    category,
    source: "offscreen",
    at: Date.now()
  };
}

async function notifyBackground(session, type, payload = {}) {
  await chrome.runtime.sendMessage({
    target: "background",
    type,
    sessionId: session.sessionId,
    tabId: session.tabId,
    ...payload
  });
}
