importScripts("session-state.js");

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
const TAB_INACTIVE_TIMEOUT_MS = 120000;
const DEFAULT_LANGUAGE = "en";
const DEEPGRAM_MODEL = "nova-3";
const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN", "zh-TW", "vi"]);

const { CAPTURE_STATES, PAGE_STATES } = sessionState;

const RENDER_MODES = {
  hidden: "hidden",
  status: "status",
  caption: "caption"
};

const sessions = new Map();
const popupPorts = new Map();
let offscreenCreatePromise = null;
let nextSessionId = 1;

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await syncSessionTabActivity(windowId, tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await syncSessionTabActivityForFocusedWindow(windowId);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") {
    return;
  }

  let subscribedTabId = null;
  port.onMessage.addListener(async (message) => {
    if (message?.type !== "popup_subscribe" || !message.tabId) {
      return;
    }

    subscribedTabId = message.tabId;
    addPopupPort(subscribedTabId, port);
    await reconcileSessionWithRuntime(subscribedTabId);
    await postSnapshotToPort(port, subscribedTabId);
  });

  port.onDisconnect.addListener(() => {
    if (subscribedTabId) {
      removePopupPort(subscribedTabId, port);
    }
  });
});

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
  const session = sessions.get(tabId);
  if (!session) {
    return;
  }

  applySessionEvent(tabId, {
    type: "capture_idle",
    terminalReason: createTerminalReason("tab_closed", "Tab closed", "page", "background")
  });

  await sendRuntimeStop(session, "tab_closed").catch(() => {});
  await maybeCloseOffscreenDocument();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.status) {
    return;
  }

  const session = sessions.get(tabId);
  if (!session || !deriveSessionBooleans(session).hasSession) {
    return;
  }

  if (changeInfo.status === "loading") {
    applySessionEvent(tabId, { type: "page_state", pageState: PAGE_STATES.loading });
    return;
  }

  if (changeInfo.status === "complete") {
    await attachContentScript(tabId, { rehydrate: true });
  }
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "settings_save":
      await chrome.storage.local.set({
        deepgramApiKey: message.apiKey || "",
        deepgramLanguage: resolveLanguage(message.language)
      });
      await broadcastSettingsSnapshots();
      return { ok: true };
    case "save_api_key":
      await chrome.storage.local.set({ deepgramApiKey: message.apiKey || "" });
      await broadcastSettingsSnapshots();
      return { ok: true };
    case "save_language":
      await chrome.storage.local.set({ deepgramLanguage: resolveLanguage(message.language) });
      await broadcastSettingsSnapshots();
      return { ok: true };
    case "get_state":
      await reconcileSessionWithRuntime(message.tabId);
      return getPopupState(message.tabId);
    case "session_start":
    case "start_subtitles":
      return startSubtitlesForTab(message.tabId, message.language);
    case "session_stop":
    case "stop_subtitles":
      return stopSubtitlesForTab(message.tabId);
    case "runtime_started":
    case "runtime_running":
    case "runtime_reconnecting":
    case "runtime_stopped":
    case "runtime_failed":
    case "transcript_update":
      return handleRuntimeEvent(message);
    case "content_ready":
      return handleContentReady(message, sender);
    case "content_unavailable":
      return handleContentUnavailable(message);
    case "render_ack":
      return { ok: true };
    case "session_status":
    case "relay_to_tab":
      return handleLegacyMessage(message);
    default:
      return { ok: false, error: "Unsupported message type" };
  }
}

async function startSubtitlesForTab(tabId, requestedLanguage) {
  if (!tabId) {
    throw new Error("No active tab available");
  }

  const tab = await chrome.tabs.get(tabId);
  if (!isCapturableUrl(tab.url)) {
    throw new Error("This tab cannot be captured. Try a standard http/https page.");
  }

  const { deepgramApiKey = "", deepgramLanguage = DEFAULT_LANGUAGE } = await chrome.storage.local.get([
    "deepgramApiKey",
    "deepgramLanguage"
  ]);
  if (!deepgramApiKey) {
    throw new Error("Deepgram API key is required");
  }

  const existingSession = sessions.get(tabId);
  if (existingSession && deriveSessionBooleans(existingSession).canStop) {
    return getPopupState(tabId);
  }

  const language = resolveLanguage(requestedLanguage || deepgramLanguage);
  const session = createSessionSnapshot(tabId, { language, model: DEEPGRAM_MODEL });
  sessions.set(tabId, session);
  broadcastSessionSnapshot(tabId);

  try {
    await attachContentScript(tabId, { rehydrate: false });
  } catch (error) {
    applySessionEvent(tabId, {
      type: "page_state",
      pageState: PAGE_STATES.unavailable,
      terminalReason: createTerminalReason("unsupported_page", error.message || "Overlay unavailable", "page", "background")
    });
  }

  applySessionEvent(tabId, {
    type: "render_status",
    status: "Starting capture..."
  });

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    applySessionEvent(tabId, {
      type: "capture_failed",
      terminalReason: createTerminalReason("capture_denied", "Unable to capture tab audio", "runtime", "background")
    });
    await maybeCloseOffscreenDocument();
    throw error;
  }

  await ensureOffscreenDocument();

  const response = await sendOffscreenMessage({
    target: "offscreen",
    type: "runtime_start",
    sessionId: session.sessionId,
    tabId,
    streamId,
    apiKey: deepgramApiKey,
    language,
    model: DEEPGRAM_MODEL
  });

  if (!response?.ok) {
    applySessionEvent(tabId, {
      type: "capture_failed",
      terminalReason: createTerminalReason(
        "startup_failed",
        response?.error || "Failed to start subtitle capture",
        "runtime",
        "offscreen"
      )
    });
    await maybeCloseOffscreenDocument();
    throw new Error(response?.error || "Failed to start subtitle capture");
  }

  await syncSessionTabActivityForTab(tabId);
  return getPopupState(tabId);
}

async function stopSubtitlesForTab(tabId) {
  if (!tabId) {
    throw new Error("No active tab available");
  }

  let session = sessions.get(tabId);
  if (!session) {
    const snapshot = await getPopupState(tabId);
    await sendTabRenderClear(tabId, null).catch(() => {});
    return snapshot;
  }

  const terminalReason = createTerminalReason("user_stop", "Stopped by user", "user", "background");
  applySessionEvent(tabId, {
    type: "capture_stopping",
    terminalReason
  });

  session = sessions.get(tabId);
  await sendRuntimeStop(session, "user_stop").catch(() => {});
  applySessionEvent(tabId, {
    type: "capture_idle",
    terminalReason,
    renderClear: true
  });
  await maybeCloseOffscreenDocument();

  return getPopupState(tabId);
}

async function handleRuntimeEvent(message) {
  if (!isCurrentSessionMessage(message)) {
    return { ok: true, ignored: true };
  }

  switch (message.type) {
    case "runtime_started":
      applySessionEvent(message.tabId, { type: "runtime_seen", runtime: message.runtime });
      break;
    case "runtime_running":
      applySessionEvent(message.tabId, {
        type: "capture_running",
        runtime: {
          hasRuntime: true,
          websocketState: message.websocketState || "open"
        }
      });
      break;
    case "runtime_reconnecting":
      applySessionEvent(message.tabId, {
        type: "capture_reconnecting",
        runtime: {
          hasRuntime: true,
          websocketState: "closed"
        }
      });
      break;
    case "runtime_stopped":
      {
        const session = sessions.get(message.tabId);
        const terminalReason = session?.captureState === CAPTURE_STATES.stopping && session.terminalReason
          ? session.terminalReason
          : normalizeReason(message.reason, "unknown_failure", "Stopped", "runtime", "offscreen");

        applySessionEvent(message.tabId, {
          type: "capture_idle",
          terminalReason
        });
      }
      await maybeCloseOffscreenDocument();
      break;
    case "runtime_failed":
      applySessionEvent(message.tabId, {
        type: "capture_failed",
        terminalReason: normalizeReason(message.reason, "unknown_failure", "Subtitle capture failed", "runtime", "offscreen")
      });
      await maybeCloseOffscreenDocument();
      break;
    case "transcript_update":
      applySessionEvent(message.tabId, {
        type: "transcript_update",
        text: message.text || "",
        isFinal: Boolean(message.isFinal)
      });
      break;
    default:
      return { ok: false, error: "Unsupported runtime event" };
  }

  return { ok: true };
}

async function handleContentReady(message, sender) {
  const tabId = message.tabId || sender?.tab?.id;
  if (!tabId) {
    return { ok: true };
  }

  const session = sessions.get(tabId);
  if (session) {
    applySessionEvent(tabId, { type: "page_state", pageState: PAGE_STATES.attached });
    await sendTabRenderUpdate(tabId, session, "render_rehydrate").catch(() => {});
  }

  return { ok: true };
}

function handleContentUnavailable(message) {
  if (message.tabId && sessions.has(message.tabId)) {
    applySessionEvent(message.tabId, {
      type: "page_state",
      pageState: PAGE_STATES.unavailable,
      terminalReason: createTerminalReason(
        "unsupported_page",
        message.reason || "Overlay unavailable",
        "page",
        "content"
      )
    });
  }

  return { ok: true };
}

async function handleLegacyMessage(message) {
  if (message.type === "relay_to_tab") {
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

  if (message.type !== "session_status") {
    return { ok: true };
  }

  const session = sessions.get(message.tabId);
  if (!session) {
    return { ok: true };
  }

  if (message.state === "listening") {
    applySessionEvent(message.tabId, { type: "capture_running" });
  } else if (message.state === "reconnecting") {
    applySessionEvent(message.tabId, { type: "capture_reconnecting" });
  } else if (message.state === "error") {
    applySessionEvent(message.tabId, {
      type: "capture_failed",
      terminalReason: createTerminalReason("unknown_failure", message.error || "Subtitle capture failed", "runtime", "offscreen")
    });
  }

  return { ok: true };
}

function createSessionSnapshot(tabId, settings) {
  const now = Date.now();
  return {
    sessionId: `s_${now}_${nextSessionId++}`,
    tabId,
    desiredActive: true,
    captureState: CAPTURE_STATES.starting,
    pageState: PAGE_STATES.unknown,
    terminalReason: null,
    settings,
    render: createHiddenRender(),
    runtime: {
      hasRuntime: false,
      websocketState: "none",
      isTabActive: true,
      lastRuntimeSeenAt: 0
    },
    createdAt: now,
    updatedAt: now
  };
}

function applySessionEvent(tabId, event) {
  const session = sessions.get(tabId);
  if (!session) {
    return null;
  }

  switch (event.type) {
    case "page_state":
      session.pageState = event.pageState;
      if (event.terminalReason) {
        session.terminalReason = event.terminalReason;
      }
      break;
    case "capture_stopping":
      session.desiredActive = false;
      session.captureState = CAPTURE_STATES.stopping;
      session.terminalReason = event.terminalReason || session.terminalReason;
      session.render = createStatusRender(session.terminalReason?.message || "Stopping subtitles...");
      break;
    case "capture_running":
      session.desiredActive = true;
      session.captureState = CAPTURE_STATES.running;
      session.terminalReason = null;
      session.runtime = {
        ...session.runtime,
        ...event.runtime,
        hasRuntime: true,
        websocketState: event.runtime?.websocketState || "open",
        lastRuntimeSeenAt: Date.now()
      };
      session.render = createStatusRender("Listening...");
      break;
    case "capture_reconnecting":
      session.captureState = CAPTURE_STATES.reconnecting;
      session.runtime = {
        ...session.runtime,
        ...event.runtime,
        hasRuntime: true,
        websocketState: "closed",
        lastRuntimeSeenAt: Date.now()
      };
      session.render = createStatusRender("Reconnecting...");
      break;
    case "capture_idle":
      session.desiredActive = false;
      session.captureState = CAPTURE_STATES.idle;
      session.runtime = {
        ...session.runtime,
        hasRuntime: false,
        websocketState: "none",
        lastRuntimeSeenAt: Date.now()
      };
      session.terminalReason = event.terminalReason || session.terminalReason;
      session.render = event.renderClear ? createHiddenRender() : createStatusRender(session.terminalReason?.message || "");
      break;
    case "capture_failed":
      session.desiredActive = false;
      session.captureState = CAPTURE_STATES.failed;
      session.runtime = {
        ...session.runtime,
        hasRuntime: false,
        websocketState: "none",
        lastRuntimeSeenAt: Date.now()
      };
      session.terminalReason = event.terminalReason || session.terminalReason;
      session.render = createStatusRender(session.terminalReason?.message || "Subtitle capture failed");
      break;
    case "runtime_seen":
      session.runtime = {
        ...session.runtime,
        ...event.runtime,
        lastRuntimeSeenAt: Date.now()
      };
      break;
    case "render_status":
      session.render = createStatusRender(event.status || "");
      break;
    case "transcript_update":
      session.render = createCaptionRender(event.text, event.isFinal, session.render);
      break;
    default:
      break;
  }

  session.updatedAt = Date.now();
  sessions.set(tabId, session);
  broadcastSessionSnapshot(tabId);
  pushRenderForSession(session).catch(() => {});
  return session;
}

async function attachContentScript(tabId, { rehydrate }) {
  const session = sessions.get(tabId);
  if (session) {
    session.pageState = PAGE_STATES.injecting;
    session.updatedAt = Date.now();
    broadcastSessionSnapshot(tabId);
  }

  await ensureContentScript(tabId);

  const updatedSession = sessions.get(tabId);
  if (updatedSession) {
    updatedSession.pageState = PAGE_STATES.attached;
    updatedSession.updatedAt = Date.now();
    broadcastSessionSnapshot(tabId);
    if (rehydrate) {
      await sendTabRenderUpdate(tabId, updatedSession, "render_rehydrate").catch(() => {});
    }
  }
}

async function reconcileSessionWithRuntime(tabId) {
  const session = sessions.get(tabId);
  if (!session) {
    return null;
  }

  const runtimeSnapshot = await getRuntimeSnapshot(tabId);
  if (!runtimeSnapshot) {
    if (session.runtime.hasRuntime && isLiveCaptureState(session.captureState)) {
      applySessionEvent(tabId, {
        type: "capture_failed",
        terminalReason: createTerminalReason("unknown_failure", "Runtime session disappeared", "runtime", "background")
      });
    }
    return sessions.get(tabId) || null;
  }

  if (!runtimeSnapshot.hasRuntime) {
    if (session.runtime.hasRuntime && isLiveCaptureState(session.captureState)) {
      applySessionEvent(tabId, {
        type: "capture_failed",
        terminalReason: createTerminalReason("unknown_failure", "Runtime session disappeared", "runtime", "background")
      });
    }
    return sessions.get(tabId) || null;
  }

  session.runtime = {
    ...session.runtime,
    hasRuntime: Boolean(runtimeSnapshot.hasRuntime),
    websocketState: runtimeSnapshot.websocketState || "none",
    isTabActive: runtimeSnapshot.isTabActive !== false,
    lastRuntimeSeenAt: Date.now()
  };

  if (runtimeSnapshot.hasRuntime) {
    session.captureState = sessionState.mapRuntimeSnapshotToCaptureState(runtimeSnapshot, session.captureState);
  }

  session.updatedAt = Date.now();
  sessions.set(tabId, session);
  return session;
}

async function getRuntimeSnapshot(tabId) {
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
      type: "runtime_get_snapshot",
      tabId
    });
    return response?.ok ? response : null;
  } catch (error) {
    console.warn("Failed to read offscreen runtime snapshot", error);
    return null;
  }
}

async function getRuntimeSessionTabIds() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });

  if (existingContexts.length === 0) {
    return [];
  }

  try {
    const response = await sendOffscreenMessage({
      target: "offscreen",
      type: "runtime_list_sessions"
    });
    return response?.ok && Array.isArray(response.tabIds) ? response.tabIds : [];
  } catch (error) {
    console.warn("Failed to read offscreen session tabs", error);
    return [];
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

async function syncSessionTabActivity(windowId, activeTabId) {
  const sessionTabIds = await getRuntimeSessionTabIds();
  if (sessionTabIds.length === 0) {
    return;
  }

  for (const sessionTabId of sessionTabIds) {
    const session = sessions.get(sessionTabId);
    const active = windowId !== chrome.windows.WINDOW_ID_NONE && sessionTabId === activeTabId;
    if (session) {
      session.runtime.isTabActive = active;
      session.updatedAt = Date.now();
      broadcastSessionSnapshot(sessionTabId);
    }

    await sendOffscreenMessage({
      target: "offscreen",
      type: "runtime_set_tab_active",
      sessionId: session?.sessionId,
      tabId: sessionTabId,
      active,
      inactiveTimeoutMs: TAB_INACTIVE_TIMEOUT_MS
    }).catch(() => {});
  }
}

async function syncSessionTabActivityForFocusedWindow(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await syncSessionTabActivity(windowId, null);
    return;
  }

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    await syncSessionTabActivity(windowId, activeTab?.id || null);
  } catch (error) {
    console.warn("Failed to sync session tab activity", error);
  }
}

async function syncSessionTabActivityForTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const focusedWindow = await chrome.windows.getLastFocused();
    const isFocusedTab = focusedWindow?.id === tab.windowId && tab.active;
    const session = sessions.get(tabId);
    if (session) {
      session.runtime.isTabActive = isFocusedTab;
      session.updatedAt = Date.now();
      broadcastSessionSnapshot(tabId);
    }

    await sendOffscreenMessage({
      target: "offscreen",
      type: "runtime_set_tab_active",
      sessionId: session?.sessionId,
      tabId,
      active: isFocusedTab,
      inactiveTimeoutMs: TAB_INACTIVE_TIMEOUT_MS
    }).catch(() => {});
  } catch (error) {
    console.warn("Failed to sync tab activity for session", error);
  }
}

async function sendRuntimeStop(session, reasonCode) {
  if (!session) {
    return;
  }

  await sendOffscreenMessage({
    target: "offscreen",
    type: "runtime_stop",
    sessionId: session.sessionId,
    tabId: session.tabId,
    reasonCode
  });
}

async function pushRenderForSession(session) {
  if (!session || session.pageState !== PAGE_STATES.attached) {
    return;
  }

  await sendTabRenderUpdate(session.tabId, session, "render_update");
}

async function sendTabRenderUpdate(tabId, session, type) {
  await sendTabMessage(tabId, {
    type,
    sessionId: session.sessionId,
    render: session.render,
    captureState: session.captureState,
    pageState: session.pageState,
    terminalReason: session.terminalReason
  });
}

async function sendTabRenderClear(tabId, sessionId) {
  await sendTabMessage(tabId, {
    type: "render_clear",
    sessionId
  });
}

async function getPopupState(tabId) {
  const settings = await getStoredSettings();
  const session = sessions.get(tabId) || null;
  return {
    ok: true,
    ...settings,
    snapshot: buildSessionSnapshot(session, settings),
    ...derivePopupState(session)
  };
}

async function postSnapshotToPort(port, tabId) {
  try {
    port.postMessage({
      type: "session_snapshot",
      snapshot: await getPopupState(tabId)
    });
  } catch (error) {
    removePopupPort(tabId, port);
  }
}

function broadcastSessionSnapshot(tabId) {
  const ports = popupPorts.get(tabId);
  if (!ports || ports.size === 0) {
    return;
  }

  for (const port of ports) {
    postSnapshotToPort(port, tabId);
  }
}

async function broadcastSettingsSnapshots() {
  for (const tabId of popupPorts.keys()) {
    broadcastSessionSnapshot(tabId);
  }
}

function addPopupPort(tabId, port) {
  if (!popupPorts.has(tabId)) {
    popupPorts.set(tabId, new Set());
  }

  popupPorts.get(tabId).add(port);
}

function removePopupPort(tabId, port) {
  const ports = popupPorts.get(tabId);
  if (!ports) {
    return;
  }

  ports.delete(port);
  if (ports.size === 0) {
    popupPorts.delete(tabId);
  }
}

function derivePopupState(session) {
  const booleans = deriveSessionBooleans(session);
  return {
    active: booleans.active,
    hasSession: booleans.hasSession,
    hasRuntimeSession: Boolean(session?.runtime?.hasRuntime),
    canStop: booleans.canStop,
    captureState: session?.captureState || CAPTURE_STATES.idle,
    state: session?.captureState || CAPTURE_STATES.idle,
    pageState: session?.pageState || PAGE_STATES.unknown,
    terminalReason: session?.terminalReason || null,
    error: session?.terminalReason?.message || ""
  };
}

function deriveSessionBooleans(session) {
  return sessionState.deriveSessionBooleans(session);
}

function buildSessionSnapshot(session, settings) {
  if (!session) {
    return {
      sessionId: null,
      tabId: null,
      desiredActive: false,
      captureState: CAPTURE_STATES.idle,
      pageState: PAGE_STATES.unknown,
      terminalReason: null,
      settings: {
        language: settings.language,
        model: DEEPGRAM_MODEL
      },
      render: createHiddenRender(),
      runtime: {
        hasRuntime: false,
        websocketState: "none",
        isTabActive: true,
        lastRuntimeSeenAt: 0
      },
      active: false,
      canStop: false,
      hasSession: false
    };
  }

  return {
    ...session,
    ...deriveSessionBooleans(session)
  };
}

async function getStoredSettings() {
  const { deepgramApiKey = "", deepgramLanguage = DEFAULT_LANGUAGE } = await chrome.storage.local.get([
    "deepgramApiKey",
    "deepgramLanguage"
  ]);

  return {
    apiKeySaved: Boolean(deepgramApiKey),
    language: resolveLanguage(deepgramLanguage)
  };
}

function createHiddenRender() {
  return {
    mode: RENDER_MODES.hidden,
    status: "",
    finalText: "",
    interimText: "",
    isFinal: false
  };
}

function createStatusRender(status) {
  return {
    mode: status ? RENDER_MODES.status : RENDER_MODES.hidden,
    status: status || "",
    finalText: "",
    interimText: "",
    isFinal: false
  };
}

function createCaptionRender(text, isFinal, previousRender) {
  if (isFinal) {
    return {
      mode: RENDER_MODES.caption,
      status: "",
      finalText: text || "",
      interimText: "",
      isFinal: true
    };
  }

  return {
    mode: RENDER_MODES.caption,
    status: "",
    finalText: previousRender?.finalText || "",
    interimText: text || "",
    isFinal: false
  };
}

function createTerminalReason(code, message, category, source) {
  return {
    code,
    message,
    category,
    source,
    at: Date.now()
  };
}

function normalizeReason(reason, defaultCode, defaultMessage, defaultCategory, defaultSource) {
  if (reason && typeof reason === "object") {
    return {
      code: reason.code || defaultCode,
      message: reason.message || defaultMessage,
      category: reason.category || defaultCategory,
      source: reason.source || defaultSource,
      at: reason.at || Date.now()
    };
  }

  if (typeof reason === "string" && reason) {
    return createTerminalReason(defaultCode, reason, defaultCategory, defaultSource);
  }

  return createTerminalReason(defaultCode, defaultMessage, defaultCategory, defaultSource);
}

function isCurrentSessionMessage(message) {
  const session = sessions.get(message.tabId);
  return Boolean(session && message.sessionId && session.sessionId === message.sessionId);
}

function isLiveCaptureState(captureState) {
  return captureState === CAPTURE_STATES.starting ||
    captureState === CAPTURE_STATES.running ||
    captureState === CAPTURE_STATES.reconnecting ||
    captureState === CAPTURE_STATES.stopping;
}

function isCapturableUrl(url) {
  if (!url) {
    return false;
  }

  return url.startsWith("http://") || url.startsWith("https://");
}

function resolveLanguage(language) {
  return SUPPORTED_LANGUAGES.has(language) ? language : DEFAULT_LANGUAGE;
}

function sendOffscreenMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function sendTabMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}
