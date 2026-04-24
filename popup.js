const apiKeyInput = document.getElementById("apiKeyInput");
const languageSelect = document.getElementById("languageSelect");
const saveButton = document.getElementById("saveButton");
const toggleButton = document.getElementById("toggleButton");
const statusNode = document.getElementById("status");

let currentTabId = null;
let currentState = "idle";
let currentCanStop = false;

document.addEventListener("DOMContentLoaded", initializePopup);
saveButton.addEventListener("click", saveApiKey);
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

  await refreshState();
}

async function refreshState() {
  if (!currentTabId) {
    renderState({
      apiKeySaved: false,
      active: false,
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
      active: false,
      state: "error",
      error: "Failed to read extension state"
    });
  }
}

async function saveApiKey() {
  const apiKey = apiKeyInput.value.trim();
  const language = languageSelect.value || "en";
  await chrome.runtime.sendMessage({
    target: "background",
    type: "save_api_key",
    apiKey
  });

  await chrome.runtime.sendMessage({
    target: "background",
    type: "save_language",
    language
  });

  statusNode.textContent = apiKey ? "API key and language saved locally." : "API key cleared.";
  await refreshState();
}

async function toggleSubtitles() {
  if (!currentTabId) {
    statusNode.textContent = "No active tab found.";
    return;
  }

  if (currentCanStop) {
    await chrome.runtime.sendMessage({
      target: "background",
      type: "stop_subtitles",
      tabId: currentTabId
    });
    await refreshState();
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "start_subtitles",
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
  const apiKeySaved = Boolean(response?.apiKeySaved);
  const active = Boolean(response?.active);
  const canStop = Boolean(response?.canStop || response?.hasSession);
  const pageState = response?.pageState || "unknown";
  currentState = response?.state || "idle";
  currentCanStop = canStop;

  toggleButton.disabled = (!apiKeySaved && !canStop) || !currentTabId;
  toggleButton.textContent = canStop ? "Stop Subtitles" : "Start Subtitles";
  toggleButton.classList.toggle("stop", canStop);

  if (!apiKeySaved && !canStop) {
    statusNode.textContent = "Save a Deepgram API key before starting subtitles.";
    return;
  }

  if (canStop && pageState === "loading") {
    statusNode.textContent = "Page is reloading; subtitles remain active.";
    return;
  }

  if (canStop && pageState === "content_missing") {
    statusNode.textContent = "Subtitles are active, but the overlay cannot attach to this page.";
    return;
  }

  switch (currentState) {
    case "starting":
      statusNode.textContent = "Starting capture...";
      break;
    case "listening":
      statusNode.textContent = "Subtitles are running on this tab.";
      break;
    case "reconnecting":
      statusNode.textContent = "Reconnecting to Deepgram...";
      break;
    case "error":
      statusNode.textContent = response?.error || "An error occurred.";
      break;
    default:
      statusNode.textContent = active || canStop ? "Subtitles active." : "Ready.";
      break;
  }
}
