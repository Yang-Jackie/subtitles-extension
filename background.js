const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
const TAB_INACTIVE_TIMEOUT_MS = 120000;
const DEFAULT_LANGUAGE = "en";
const DEEPGRAM_MODEL = "nova-3";
const SUPPORTED_LANGUAGES = new Set([
  "en",
  "zh-CN",
  "zh-TW",
  "vi"
]);
const SESSION_STATES = {
  idle: "idle",
  starting: "starting",
  listening: "listening",
  reconnecting: "reconnecting",
  stopping: "stopping",
  stopped: "stopped",
  error: "error"
};
const PAGE_STATES = {
  unknown: "unknown",
  loading: "loading",
  ready: "ready",
  contentMissing: "content_missing"
};

const sessions = new Map();
let offscreenCreatePromise = null;

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await syncSessionTabActivity(windowId, tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await syncSessionTabActivityForFocusedWindow(windowId);
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
  const session = await getSessionState(tabId);
  if (!session?.canStop && !session?.hasRuntimeSession) {
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
  if (!changeInfo.status) {
    return;
  }

  const session = await getSessionState(tabId);
  if (!session?.canStop) {
    return;
  }

  const cachedSession = sessions.get(tabId) || {
    state: session.state,
    lastError: session.lastError || "",
    pageState: PAGE_STATES.unknown
  };

  if (changeInfo.status === "loading") {
    cachedSession.pageState = PAGE_STATES.loading;
    sessions.set(tabId, cachedSession);
    return;
  }

  if (changeInfo.status === "complete") {
    try {
      await ensureContentScript(tabId);
      cachedSession.pageState = PAGE_STATES.ready;
      await sendTabMessage(tabId, {
        type: "subtitle_update",
        text: "",
        isFinal: false,
        status: session.state === SESSION_STATES.reconnecting ? "Reconnecting..." : "Listening..."
      }).catch(() => {});
    } catch (error) {
      cachedSession.pageState = PAGE_STATES.contentMissing;
      cachedSession.lastError = error.message || cachedSession.lastError || "";
    }

    sessions.set(tabId, cachedSession);
  }
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "save_api_key":
      await chrome.storage.local.set({ deepgramApiKey: message.apiKey || "" });
      return { ok: true };
    case "save_language":
      await chrome.storage.local.set({ deepgramLanguage: resolveLanguage(message.language) });
      return { ok: true };
    case "get_state":
      return getPopupState(message.tabId);
    case "start_subtitles":
      return startSubtitlesForTab(message.tabId, message.language);
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
  const { deepgramApiKey = "", deepgramLanguage = DEFAULT_LANGUAGE } = await chrome.storage.local.get([
    "deepgramApiKey",
    "deepgramLanguage"
  ]);
  const session = await getSessionState(tabId);

  return {
    ok: true,
    apiKeySaved: Boolean(deepgramApiKey),
    language: resolveLanguage(deepgramLanguage),
    active: isActiveCaptureState(session?.state),
    hasSession: Boolean(session?.hasSession),
    hasRuntimeSession: Boolean(session?.hasRuntimeSession),
    canStop: Boolean(session?.canStop),
    captureState: session?.captureState || session?.state || SESSION_STATES.idle,
    state: session?.state || SESSION_STATES.idle,
    pageState: session?.pageState || PAGE_STATES.unknown,
    error: session?.lastError || ""
  };
}

async function getIdlePopupState(error = "") {
  const { deepgramApiKey = "", deepgramLanguage = DEFAULT_LANGUAGE } = await chrome.storage.local.get([
    "deepgramApiKey",
    "deepgramLanguage"
  ]);

  return {
    ok: true,
    apiKeySaved: Boolean(deepgramApiKey),
    language: resolveLanguage(deepgramLanguage),
    active: false,
    hasSession: false,
    hasRuntimeSession: false,
    canStop: false,
    captureState: SESSION_STATES.idle,
    state: SESSION_STATES.idle,
    pageState: PAGE_STATES.unknown,
    error
  };
}

async function startSubtitlesForTab(tabId, requestedLanguage) {
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

  const { deepgramLanguage = DEFAULT_LANGUAGE } = await chrome.storage.local.get("deepgramLanguage");
  const language = resolveLanguage(requestedLanguage || deepgramLanguage);
  const existingSession = await getSessionState(tabId);

  if (existingSession?.canStop || existingSession?.hasRuntimeSession) {
    return getPopupState(tabId);
  }

  await ensureContentScript(tabId);
  await ensureOffscreenDocument();

  sessions.set(tabId, {
    state: SESSION_STATES.starting,
    lastError: "",
    pageState: PAGE_STATES.ready
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
    sessions.delete(tabId);
    await sendTabMessage(tabId, {
      type: "subtitle_update",
      text: "",
      isFinal: false,
      status: "Unable to capture tab audio"
    });
    await maybeCloseOffscreenDocument();
    throw error;
  }

  const response = await sendOffscreenMessage({
    target: "offscreen",
    type: "start_capture",
    tabId,
    streamId,
    apiKey: deepgramApiKey,
    language,
    model: DEEPGRAM_MODEL
  });

  if (!response?.ok) {
    sessions.delete(tabId);

    await sendTabMessage(tabId, {
      type: "subtitle_update",
      text: "",
      isFinal: false,
      status: response?.error || "Failed to start subtitle capture"
    }).catch(() => {});

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

  const session = await getSessionState(tabId);
  if (!session?.canStop && !session?.hasRuntimeSession) {
    await sendTabMessage(tabId, { type: "subtitle_clear" }).catch(() => {});
    await maybeCloseOffscreenDocument();
    return getIdlePopupState(session?.lastError || "");
  }

  const cachedSession = sessions.get(tabId);
  if (cachedSession) {
    cachedSession.state = SESSION_STATES.stopping;
    sessions.set(tabId, cachedSession);
  }

  await sendOffscreenMessage({
    target: "offscreen",
    type: "stop_capture",
    tabId
  }).catch(() => {});
  await sendTabMessage(tabId, { type: "subtitle_clear" }).catch(() => {});
  sessions.delete(tabId);
  await maybeCloseOffscreenDocument();

  return getIdlePopupState(session?.lastError || "");
}

async function updateSessionStatus(message) {
  const session = sessions.get(message.tabId) || {
    state: SESSION_STATES.idle,
    lastError: "",
    pageState: PAGE_STATES.unknown
  };

  session.state = message.state || session.state;
  if (typeof message.error === "string" && message.error.length > 0) {
    session.lastError = message.error;
  } else if (session.state === SESSION_STATES.listening || session.state === SESSION_STATES.reconnecting || session.state === SESSION_STATES.stopped) {
    session.lastError = "";
  }

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
  const offscreenSession = await getOffscreenSessionState(tabId);
  const cachedSession = sessions.get(tabId);

  if (offscreenSession) {
    const offscreenState = offscreenSession.state || SESSION_STATES.idle;
    const offscreenHasRuntimeSession = Boolean(
      offscreenSession.hasRuntimeSession ||
      offscreenSession.hasSession ||
      offscreenSession.active
    );

    if (offscreenHasRuntimeSession) {
      const session = {
        state: offscreenState,
        hasRuntimeSession: true,
        lastError: offscreenSession.lastError || cachedSession?.lastError || "",
        pageState: cachedSession?.pageState || PAGE_STATES.unknown
      };
      sessions.set(tabId, session);
      return normalizeSessionState(session);
    }

    if (!cachedSession || !isLocalTransitionState(cachedSession.state)) {
      sessions.delete(tabId);
      return null;
    }
  }

  if (!cachedSession) {
    return null;
  }

  if (!isLocalTransitionState(cachedSession.state)) {
    sessions.delete(tabId);
    return null;
  }

  return normalizeSessionState(cachedSession);
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

async function getOffscreenSessionTabIds() {
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
      type: "list_session_tabs"
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
  const sessionTabIds = await getOffscreenSessionTabIds();
  if (sessionTabIds.length === 0) {
    return;
  }

  for (const sessionTabId of sessionTabIds) {
    const active = windowId !== chrome.windows.WINDOW_ID_NONE && sessionTabId === activeTabId;
    await sendOffscreenMessage({
      target: "offscreen",
      type: "set_tab_active",
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
    await sendOffscreenMessage({
      target: "offscreen",
      type: "set_tab_active",
      tabId,
      active: isFocusedTab,
      inactiveTimeoutMs: TAB_INACTIVE_TIMEOUT_MS
    }).catch(() => {});
  } catch (error) {
    console.warn("Failed to sync tab activity for session", error);
  }
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

function resolveLanguage(language) {
  return SUPPORTED_LANGUAGES.has(language) ? language : DEFAULT_LANGUAGE;
}

function normalizeSessionState(session) {
  const state = session?.state || SESSION_STATES.idle;
  const hasRuntimeSession = Boolean(session?.hasRuntimeSession);
  const hasLocalTransition = isLocalTransitionState(state);
  const canStop = hasRuntimeSession || hasLocalTransition;

  return {
    active: isActiveCaptureState(state),
    hasSession: canStop,
    hasRuntimeSession,
    canStop,
    captureState: state,
    state,
    pageState: session?.pageState || PAGE_STATES.unknown,
    lastError: session?.lastError || ""
  };
}

function isActiveCaptureState(state) {
  return state === SESSION_STATES.listening || state === SESSION_STATES.reconnecting;
}

function isLocalTransitionState(state) {
  return state === SESSION_STATES.starting || state === SESSION_STATES.stopping;
}
