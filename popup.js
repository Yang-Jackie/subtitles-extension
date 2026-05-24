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
      error: "No active tab found"
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
      error: "Failed to read extension state"
    });
  }
}

async function saveSettings() {
  const apiKey = apiKeyInput.value.trim();
  await persistSettings();

  statusNode.textContent = apiKey ? "API key and language saved locally." : "API key cleared.";
  await refreshState();
}

async function toggleSubtitles() {
  if (!currentTabId) {
    statusNode.textContent = "No active tab found.";
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
      throw new Error(response?.error || "Failed to start subtitles.");
    }
    await refreshState();
  } catch (error) {
    statusNode.textContent = error.message || "Failed to start subtitles.";
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
    statusNode.textContent = "Save a Deepgram API key before starting subtitles.";
    return;
  }

  if (terminalReason?.message && !canStop) {
    statusNode.textContent = terminalReason.message;
    return;
  }

  if (canStop && pageState === "loading") {
    statusNode.textContent = "Page is reloading; subtitles remain active.";
    return;
  }

  if (canStop && pageState === "unavailable") {
    statusNode.textContent = "Subtitles are active, but the overlay cannot attach to this page.";
    return;
  }

  switch (captureState) {
    case "starting":
      statusNode.textContent = "Starting capture...";
      break;
    case "running":
      statusNode.textContent = "Subtitles are running on this tab.";
      break;
    case "reconnecting":
      statusNode.textContent = "Reconnecting to Deepgram...";
      break;
    case "stopping":
      statusNode.textContent = "Stopping subtitles...";
      break;
    case "failed":
      statusNode.textContent = terminalReason?.message || response?.error || "Subtitle capture failed.";
      break;
    default:
      statusNode.textContent = canStop ? "Subtitles active." : "Ready.";
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
