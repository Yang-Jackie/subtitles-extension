const apiKeyInput = document.getElementById("apiKeyInput");
const languageSelect = document.getElementById("languageSelect");
const saveButton = document.getElementById("saveButton");
const toggleButton = document.getElementById("toggleButton");
const statusNode = document.getElementById("status");

let currentTabId = null;
let currentSnapshot = null;
let popupPort = null;

document.addEventListener("DOMContentLoaded", initializePopup);
saveButton.addEventListener("click", saveSettings);
toggleButton.addEventListener("click", toggleSubtitles);

async function initializePopup() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;

  const { deepgramApiKey = "", deepgramLanguage = "en" } = await chrome.storage.local.get([
    "deepgramApiKey",
    "deepgramLanguage"
  ]);
  apiKeyInput.value = deepgramApiKey;
  languageSelect.value = deepgramLanguage;

  connectPopupPort();
  await refreshState();
}

function connectPopupPort() {
  if (!currentTabId) {
    return;
  }

  popupPort = chrome.runtime.connect({ name: "popup" });
  popupPort.onMessage.addListener((message) => {
    if (message?.type === "session_snapshot") {
      renderState(message.snapshot);
    }
  });
  popupPort.onDisconnect.addListener(() => {
    popupPort = null;
  });
  popupPort.postMessage({
    type: "popup_subscribe",
    tabId: currentTabId
  });
}

async function refreshState() {
  if (!currentTabId) {
    renderState({
      apiKeySaved: false,
      captureState: "idle",
      state: "idle",
      error: reasonCatalog.STATUS.noActiveTab
    });
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "get_state",
      tabId: currentTabId
    });
    renderState(response);
  } catch (error) {
    renderState({
      apiKeySaved: false,
      captureState: "failed",
      state: "failed",
      error: reasonCatalog.STATUS.failedToReadState
    });
  }
}

async function saveSettings() {
  const apiKey = apiKeyInput.value.trim();
  await persistSettings();

  statusNode.textContent = apiKey ? reasonCatalog.STATUS.settingsSaved : reasonCatalog.STATUS.apiKeyCleared;
  await refreshState();
}

async function toggleSubtitles() {
  if (!currentTabId) {
    statusNode.textContent = reasonCatalog.STATUS.noActiveTab;
    return;
  }

  if (currentSnapshot?.canStop) {
    await chrome.runtime.sendMessage({
      target: "background",
      type: "session_stop",
      tabId: currentTabId
    });
    await refreshState();
    return;
  }

  try {
    await persistSettings();
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "session_start",
      tabId: currentTabId,
      language: languageSelect.value || "en"
    });
    if (!response?.ok) {
      throw new Error(response?.error || reasonCatalog.STATUS.failedToStart);
    }
    await refreshState();
  } catch (error) {
    statusNode.textContent = error.message || reasonCatalog.STATUS.failedToStart;
  }
}

function renderState(response) {
  currentSnapshot = response || {};
  const apiKeySaved = Boolean(response?.apiKeySaved || apiKeyInput.value.trim());
  const canStop = Boolean(response?.canStop || response?.snapshot?.canStop);
  const captureState = response?.captureState || response?.snapshot?.captureState || "idle";
  const pageState = response?.pageState || response?.snapshot?.pageState || "unknown";
  const terminalReason = response?.terminalReason || response?.snapshot?.terminalReason || null;

  toggleButton.disabled = (!apiKeySaved && !canStop) || !currentTabId;
  toggleButton.textContent = canStop ? "Stop Subtitles" : "Start Subtitles";
  toggleButton.classList.toggle("stop", canStop);

  if (!apiKeySaved && !canStop) {
    statusNode.textContent = reasonCatalog.STATUS.saveApiKey;
    return;
  }

  if (terminalReason?.message && !canStop) {
    statusNode.textContent = terminalReason.message;
    return;
  }

  if (canStop && pageState === "loading") {
    statusNode.textContent = reasonCatalog.STATUS.pageReloading;
    return;
  }

  if (canStop && pageState === "unavailable") {
    statusNode.textContent = reasonCatalog.STATUS.overlayUnavailable;
    return;
  }

  switch (captureState) {
    case "starting":
      statusNode.textContent = reasonCatalog.STATUS.startingCapture;
      break;
    case "running":
      statusNode.textContent = reasonCatalog.STATUS.running;
      break;
    case "reconnecting":
      statusNode.textContent = reasonCatalog.STATUS.reconnectingPopup;
      break;
    case "stopping":
      statusNode.textContent = reasonCatalog.STATUS.stoppingSubtitles;
      break;
    case "failed":
      statusNode.textContent = terminalReason?.message || response?.error || reasonCatalog.REASONS.unknown_failure.message;
      break;
    default:
      statusNode.textContent = canStop ? reasonCatalog.STATUS.subtitlesActive : reasonCatalog.STATUS.ready;
      break;
  }
}

async function persistSettings() {
  await chrome.runtime.sendMessage({
    target: "background",
    type: "settings_save",
    apiKey: apiKeyInput.value.trim(),
    language: languageSelect.value || "en"
  });
}
