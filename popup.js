const apiKeyInput = document.getElementById("apiKeyInput");
const languageSelect = document.getElementById("languageSelect");
const saveButton = document.getElementById("saveButton");
const toggleButton = document.getElementById("toggleButton");
const statusNode = document.getElementById("status");
const statusPanel = document.getElementById("statusPanel");
const statusTitle = document.getElementById("statusTitle");
const statusDetail = document.getElementById("statusDetail");
const settings = document.getElementById("settings");
const settingsToggle = document.getElementById("settingsToggle");
const settingsSummary = document.getElementById("settingsSummary");

let currentTabId = null;
let currentSnapshot = null;
let popupPort = null;
let settingsManuallyToggled = false;

document.addEventListener("DOMContentLoaded", initializePopup);
saveButton.addEventListener("click", saveSettings);
toggleButton.addEventListener("click", toggleSubtitles);
settingsToggle.addEventListener("click", toggleSettings);
apiKeyInput.addEventListener("input", () => renderState(currentSnapshot));
languageSelect.addEventListener("change", updateSettingsSummary);

async function initializePopup() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;

  const { deepgramApiKey = "", deepgramLanguage = "en" } = await chrome.storage.local.get([
    "deepgramApiKey",
    "deepgramLanguage"
  ]);
  apiKeyInput.value = deepgramApiKey;
  languageSelect.value = deepgramLanguage;
  updateSettingsSummary();

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
  settingsManuallyToggled = false;
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
  const viewModel = derivePopupViewModel(response);

  statusTitle.textContent = viewModel.title;
  statusDetail.textContent = viewModel.detail;
  statusPanel.className = viewModel.tone;

  toggleButton.disabled = viewModel.buttonDisabled;
  toggleButton.textContent = viewModel.buttonText;
  toggleButton.classList.toggle("stop", viewModel.canStop);
  statusNode.textContent = viewModel.secondaryStatus;
  updateSettingsSummary();
  syncSettingsVisibility(viewModel.requiresSettings);
}

function derivePopupViewModel(response) {
  const apiKeySaved = Boolean(response?.apiKeySaved || apiKeyInput.value.trim());
  const canStop = Boolean(response?.canStop || response?.snapshot?.canStop);
  const captureState = response?.captureState || response?.snapshot?.captureState || "idle";
  const pageState = response?.pageState || response?.snapshot?.pageState || "unknown";
  const terminalReason = response?.terminalReason || response?.snapshot?.terminalReason || null;
  const noActiveTab = !currentTabId;
  const startDisabled = (!apiKeySaved && !canStop) || noActiveTab;

  const base = {
    tone: "neutral",
    title: reasonCatalog.STATUS.readyTitle,
    detail: reasonCatalog.STATUS.readyDetail,
    buttonText: canStop ? "Stop Subtitles" : "Start Subtitles",
    buttonDisabled: startDisabled,
    canStop,
    secondaryStatus: "",
    requiresSettings: false
  };

  if (noActiveTab) {
    return {
      ...base,
      tone: "warning",
      title: reasonCatalog.STATUS.noTabTitle,
      detail: reasonCatalog.STATUS.noTabDetail,
      buttonDisabled: true,
      requiresSettings: !apiKeySaved
    };
  }

  if (!apiKeySaved && !canStop) {
    return {
      ...base,
      tone: "warning",
      title: reasonCatalog.STATUS.setupRequired,
      detail: reasonCatalog.STATUS.setupRequiredDetail,
      buttonDisabled: true,
      requiresSettings: true
    };
  }

  if (canStop && pageState === "loading") {
    return {
      ...base,
      tone: "warning",
      title: reasonCatalog.STATUS.pageReloadingTitle,
      detail: reasonCatalog.STATUS.pageReloadingDetail
    };
  }

  if (canStop && pageState === "unavailable") {
    return {
      ...base,
      tone: "warning",
      title: reasonCatalog.STATUS.overlayUnavailableTitle,
      detail: reasonCatalog.STATUS.overlayUnavailableDetail
    };
  }

  switch (captureState) {
    case "starting":
      return {
        ...base,
        tone: "warning",
        title: reasonCatalog.STATUS.startingTitle,
        detail: ""
      };
    case "running":
      return {
        ...base,
        tone: "good",
        title: reasonCatalog.STATUS.runningTitle,
        detail: ""
      };
    case "reconnecting":
      return {
        ...base,
        tone: "warning",
        title: reasonCatalog.STATUS.reconnectingTitle,
        detail: reasonCatalog.STATUS.reconnectingDetail
      };
    case "stopping":
      return {
        ...base,
        tone: "warning",
        title: reasonCatalog.STATUS.stoppingTitle,
        detail: "",
        buttonDisabled: true
      };
    case "failed":
      return {
        ...base,
        tone: "danger",
        title: reasonCatalog.STATUS.failedTitle,
        detail: terminalReason?.message || response?.error || reasonCatalog.REASONS.unknown_failure.message,
        buttonDisabled: startDisabled
      };
    default:
      if (terminalReason?.message) {
        return {
          ...base,
          tone: terminalReason.category === "user" ? "neutral" : "warning",
          title: reasonCatalog.STATUS.stoppedTitle,
          detail: terminalReason.message,
          buttonDisabled: startDisabled
        };
      }

      return {
        ...base,
        detail: ""
      };
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

function toggleSettings() {
  settingsManuallyToggled = true;
  setSettingsOpen(!settings.classList.contains("open"));
}

function syncSettingsVisibility(requiresSettings) {
  if (requiresSettings) {
    setSettingsOpen(true);
    return;
  }

  if (!settingsManuallyToggled) {
    setSettingsOpen(false);
  }
}

function setSettingsOpen(isOpen) {
  settings.classList.toggle("open", isOpen);
  settingsToggle.setAttribute("aria-expanded", String(isOpen));
}

function updateSettingsSummary() {
  const selectedLanguage = languageSelect.options[languageSelect.selectedIndex]?.text || languageSelect.value;
  settingsSummary.textContent = apiKeyInput.value.trim() ? selectedLanguage : `No key - ${selectedLanguage}`;
}
