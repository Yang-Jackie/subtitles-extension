(function initReasonCatalog(root) {
  const REASONS = {
    user_stop: {
      code: "user_stop",
      message: "Stopped by user",
      category: "user"
    },
    inactive_timeout: {
      code: "inactive_timeout",
      message: "Stopped after 120 seconds away from the tab",
      category: "timeout"
    },
    silence_timeout: {
      code: "silence_timeout",
      message: "Stopped after 60 seconds without audible audio",
      category: "timeout"
    },
    stream_lost: {
      code: "stream_lost",
      message: "Audio stream lost",
      category: "runtime"
    },
    deepgram_error: {
      code: "deepgram_error",
      message: "Deepgram error",
      category: "provider"
    },
    capture_denied: {
      code: "capture_denied",
      message: "Unable to capture tab audio",
      category: "runtime"
    },
    startup_failed: {
      code: "startup_failed",
      message: "Failed to start subtitle capture",
      category: "runtime"
    },
    tab_closed: {
      code: "tab_closed",
      message: "Tab closed",
      category: "page"
    },
    unsupported_page: {
      code: "unsupported_page",
      message: "Overlay unavailable",
      category: "page"
    },
    network_reconnect: {
      code: "network_reconnect",
      message: "Reconnecting to Deepgram",
      category: "network"
    },
    unknown_failure: {
      code: "unknown_failure",
      message: "Subtitle capture failed",
      category: "unknown"
    }
  };

  const STATUS = {
    setupRequired: "Setup Required",
    setupRequiredDetail: "Add a Deepgram API key to start subtitles.",
    readyTitle: "Ready",
    readyDetail: "Subtitles can start on this tab.",
    startingTitle: "Starting",
    startingDetail: "Preparing audio capture and transcription.",
    runningTitle: "Running",
    runningDetail: "Subtitles are active on this tab.",
    reconnectingTitle: "Reconnecting",
    reconnectingDetail: "The audio capture is still active. Keep the tab open while the connection recovers.",
    pageReloadingTitle: "Page Reloading",
    pageReloadingDetail: "Capture is still active. The overlay should return after the page finishes loading.",
    overlayUnavailableTitle: "Overlay Unavailable",
    overlayUnavailableDetail: "Subtitles may still be running, but this page cannot show the overlay.",
    stoppingTitle: "Stopping",
    stoppingDetail: "Cleaning up audio capture.",
    stoppedTitle: "Stopped",
    failedTitle: "Failed",
    noTabTitle: "No Tab",
    noTabDetail: "Open a normal web page to use subtitles.",
    startingCapture: "Starting capture...",
    listening: "Listening...",
    reconnecting: "Reconnecting...",
    stoppingSubtitles: "Stopping subtitles...",
    saveApiKey: "Save a Deepgram API key before starting subtitles.",
    pageReloading: "Page is reloading; subtitles remain active.",
    overlayUnavailable: "Subtitles are active, but the overlay cannot attach to this page.",
    ready: "Ready.",
    subtitlesActive: "Subtitles active.",
    running: "Subtitles are running on this tab.",
    reconnectingPopup: "Reconnecting to Deepgram...",
    settingsSaved: "API key and language saved locally.",
    apiKeyCleared: "API key cleared.",
    noActiveTab: "No active tab found.",
    failedToReadState: "Failed to read extension state",
    failedToStart: "Failed to start subtitles."
  };

  function createReason(code, source, overrides = {}) {
    const base = REASONS[code] || REASONS.unknown_failure;
    return {
      code: base.code,
      message: overrides.message || base.message,
      category: overrides.category || base.category,
      source,
      at: overrides.at || Date.now()
    };
  }

  function normalizeReason(reason, defaultCode, source) {
    const base = REASONS[defaultCode] || REASONS.unknown_failure;
    if (reason && typeof reason === "object") {
      return createReason(reason.code || base.code, reason.source || source, {
        message: reason.message || base.message,
        category: reason.category || base.category,
        at: reason.at
      });
    }

    if (typeof reason === "string" && reason) {
      return createReason(base.code, source, { message: reason });
    }

    return createReason(base.code, source);
  }

  const api = {
    REASONS,
    STATUS,
    createReason,
    normalizeReason
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.reasonCatalog = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
