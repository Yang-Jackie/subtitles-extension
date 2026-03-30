const apiKeyInput = document.getElementById("apiKeyInput");
const modelSelect = document.getElementById("modelSelect");
const saveButton = document.getElementById("saveButton");
const toggleButton = document.getElementById("toggleButton");
const statusNode = document.getElementById("status");

let currentTabId = null;
let currentState = "idle";

document.addEventListener("DOMContentLoaded", initializePopup);
saveButton.addEventListener("click", saveApiKey);
toggleButton.addEventListener("click", toggleSubtitles);

async function initializePopup() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;

  const { deepgramApiKey = "", deepgramModelPreset = "nova-3-monolingual" } = await chrome.storage.local.get([
    "deepgramApiKey",
    "deepgramModelPreset"
  ]);
  apiKeyInput.value = deepgramApiKey;
  modelSelect.value = deepgramModelPreset;

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
  const modelPreset = modelSelect.value || "nova-3-monolingual";
  await chrome.runtime.sendMessage({
    target: "background",
    type: "save_api_key",
    apiKey
  });

  await chrome.runtime.sendMessage({
    target: "background",
    type: "save_model_preset",
    modelPreset
  });

  statusNode.textContent = apiKey ? "API key and model preset saved locally." : "API key cleared.";
  await refreshState();
}

async function toggleSubtitles() {
  if (!currentTabId) {
    statusNode.textContent = "No active tab found.";
    return;
  }

  if (currentState === "listening" || currentState === "reconnecting") {
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
      modelPreset: modelSelect.value || "nova-3-monolingual"
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
  currentState = response?.state || "idle";

  toggleButton.disabled = !apiKeySaved || !currentTabId;
  toggleButton.textContent = active ? "Stop Subtitles" : "Start Subtitles";
  toggleButton.classList.toggle("stop", active);

  if (!apiKeySaved) {
    statusNode.textContent = "Save a Deepgram API key before starting subtitles.";
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
      statusNode.textContent = active ? "Subtitles active." : "Ready.";
      break;
  }
}
