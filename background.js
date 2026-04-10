const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
const DEFAULT_LANGUAGE = "en";
const DEFAULT_MODEL_PRESET = "nova-3-monolingual";
const MODEL_PRESETS = {
  "nova-3-monolingual": {
    endpointPath: "/v1/listen",
    model: "nova-3",
    language: "en"
  },
  "nova-3-multilingual": {
    endpointPath: "/v1/listen",
    model: "nova-3",
    language: "multi"
  }
};
const SESSION_STATES = {
  idle: "idle",
  starting: "starting",
  listening: "listening",
  reconnecting: "reconnecting",
  stopped: "stopped",
  error: "error"
};

const sessions = new Map();
let offscreenCreatePromise = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target && message.target !== "background") {
    return false;
  }

  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("Message handling failed", error);
      sendResponse({ ok: false, error: error.message || "Unknown error" });
    });

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSessionState(tabId);
  if (!session?.active) {
    return;
  }

  sessions.delete(tabId);
  await sendOffscreenMessage({
    target: "offscreen",
    type: "stop_capture",
    tabId
  }).catch(() => {});
  await maybeCloseOffscreenDocument();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "loading" || !sessions.has(tabId)) {
    return;
  }

  const session = sessions.get(tabId);
  session.state = SESSION_STATES.starting;
  session.lastError = "";
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "save_api_key":
      await chrome.storage.local.set({ deepgramApiKey: message.apiKey || "" });
      return { ok: true };
    case "save_model_preset":
      await chrome.storage.local.set({ deepgramModelPreset: message.modelPreset || DEFAULT_MODEL_PRESET });
      return { ok: true };
    case "get_state":
      return getPopupState(message.tabId);
    case "start_subtitles":
      return startSubtitlesForTab(message.tabId, message.modelPreset);
    case "stop_subtitles":
      return stopSubtitlesForTab(message.tabId);
    case "session_status":
      return updateSessionStatus(message, sender);
    case "relay_to_tab":
      return relayToTab(message);
    default:
      return { ok: false, error: "Unsupported message type" };
  }
}

async function getPopupState(tabId) {
  const { deepgramApiKey = "", deepgramModelPreset = DEFAULT_MODEL_PRESET } = await chrome.storage.local.get([
    "deepgramApiKey",
    "deepgramModelPreset"
  ]);
  const session = await getSessionState(tabId);

  return {
    ok: true,
    apiKeySaved: Boolean(deepgramApiKey),
    modelPreset: deepgramModelPreset,
    active: session?.state === SESSION_STATES.listening || session?.state === SESSION_STATES.reconnecting,
    state: session?.state || SESSION_STATES.idle,
    error: session?.lastError || ""
  };
}

async function startSubtitlesForTab(tabId, requestedModelPreset) {
  if (!tabId) {
    throw new Error("No active tab available");
  }

  const tab = await chrome.tabs.get(tabId);
  if (!isCapturableUrl(tab.url)) {
    throw new Error("This tab cannot be captured. Try a standard http/https page.");
  }

  const { deepgramApiKey = "" } = await chrome.storage.local.get("deepgramApiKey");
  if (!deepgramApiKey) {
    throw new Error("Deepgram API key is required");
  }

  const { deepgramModelPreset = DEFAULT_MODEL_PRESET } = await chrome.storage.local.get("deepgramModelPreset");
  const modelPreset = requestedModelPreset || deepgramModelPreset || DEFAULT_MODEL_PRESET;
  const modelConfig = resolveModelPreset(modelPreset);
  const existingSession = await getSessionState(tabId);

  if (existingSession?.active) {
    return getPopupState(tabId);
  }

  await ensureContentScript(tabId);
  await ensureOffscreenDocument();

  sessions.set(tabId, {
    state: SESSION_STATES.starting,
    lastError: ""
  });

  await sendTabMessage(tabId, {
    type: "subtitle_update",
    text: "",
    isFinal: false,
    status: "Listening..."
  });

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    sessions.set(tabId, {
      state: SESSION_STATES.error,
      lastError: "Failed to capture tab audio"
    });
    await sendTabMessage(tabId, {
      type: "subtitle_update",
      text: "",
      isFinal: false,
      status: "Unable to capture tab audio"
    });
    throw error;
  }

  const response = await sendOffscreenMessage({
    target: "offscreen",
    type: "start_capture",
    tabId,
    streamId,
    apiKey: deepgramApiKey,
    language: DEFAULT_LANGUAGE,
    modelPreset,
    modelConfig
  });

  if (!response?.ok) {
    sessions.set(tabId, {
      state: SESSION_STATES.error,
      lastError: response?.error || "Failed to start subtitle capture"
    });

    await sendTabMessage(tabId, {
      type: "subtitle_update",
      text: "",
      isFinal: false,
      status: response?.error || "Failed to start subtitle capture"
    }).catch(() => {});

    throw new Error(response?.error || "Failed to start subtitle capture");
  }

  return getPopupState(tabId);
}

async function stopSubtitlesForTab(tabId) {
  if (!tabId) {
    throw new Error("No active tab available");
  }

  const session = await getSessionState(tabId);
  await sendOffscreenMessage({
    target: "offscreen",
    type: "stop_capture",
    tabId
  }).catch(() => {});
  await sendTabMessage(tabId, { type: "subtitle_clear" }).catch(() => {});
  sessions.delete(tabId);
  await maybeCloseOffscreenDocument();

  return {
    ok: true,
    apiKeySaved: true,
    active: false,
    state: SESSION_STATES.idle,
    error: session?.lastError || ""
  };
}

async function updateSessionStatus(message) {
  const session = sessions.get(message.tabId) || {
    state: SESSION_STATES.idle,
    lastError: ""
  };

  session.state = message.state || session.state;
  session.lastError = message.error || "";

  if (session.state === SESSION_STATES.stopped) {
    sessions.delete(message.tabId);
    await maybeCloseOffscreenDocument();
  } else {
    sessions.set(message.tabId, session);
  }

  return { ok: true };
}

async function relayToTab(message) {
  if (!message.tabId || !message.payload) {
    return { ok: false, error: "Missing relay target" };
  }

  try {
    await sendTabMessage(message.tabId, message.payload);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || "Failed to message tab" };
  }
}

async function getSessionState(tabId) {
  let session = sessions.get(tabId);
  if (session) {
    return {
      active: session.state === SESSION_STATES.listening || session.state === SESSION_STATES.reconnecting,
      state: session.state,
      lastError: session.lastError || ""
    };
  }

  const offscreenSession = await getOffscreenSessionState(tabId);
  if (!offscreenSession) {
    return null;
  }

  session = {
    state: offscreenSession.state || SESSION_STATES.idle,
    lastError: offscreenSession.lastError || ""
  };

  if (session.state === SESSION_STATES.stopped) {
    sessions.delete(tabId);
  } else {
    sessions.set(tabId, session);
  }

  return {
    active: Boolean(offscreenSession.active),
    state: session.state,
    lastError: session.lastError
  };
}

async function getOffscreenSessionState(tabId) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });

  if (existingContexts.length === 0) {
    return null;
  }

  try {
    const response = await sendOffscreenMessage({
      target: "offscreen",
      type: "get_session_state",
      tabId
    });
    return response?.ok ? response : null;
  } catch (error) {
    console.warn("Failed to read offscreen session state", error);
    return null;
  }
}

async function ensureContentScript(tabId) {
  try {
    await sendTabMessage(tabId, { type: "ping" });
    return;
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (offscreenCreatePromise) {
    await offscreenCreatePromise;
    return;
  }

  offscreenCreatePromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio, process PCM frames, and stream them to Deepgram."
  });

  try {
    await offscreenCreatePromise;
  } finally {
    offscreenCreatePromise = null;
  }
}

async function maybeCloseOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });

  if (existingContexts.length === 0) {
    return;
  }

  try {
    const response = await sendOffscreenMessage({
      target: "offscreen",
      type: "has_active_sessions"
    });

    if (response?.ok && response.active) {
      return;
    }
  } catch (error) {
    console.warn("Failed to check offscreen activity before closing document", error);
    return;
  }

  await chrome.offscreen.closeDocument();
}

function isCapturableUrl(url) {
  if (!url) {
    return false;
  }

  return url.startsWith("http://") || url.startsWith("https://");
}

function sendOffscreenMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function sendTabMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function resolveModelPreset(modelPreset) {
  return MODEL_PRESETS[modelPreset] || MODEL_PRESETS[DEFAULT_MODEL_PRESET];
}
