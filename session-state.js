(function initSessionState(root) {
  const captureStates = {
    idle: "idle",
    starting: "starting",
    running: "running",
    reconnecting: "reconnecting",
    stopping: "stopping",
    failed: "failed"
  };

  const pageStates = {
    unknown: "unknown",
    loading: "loading",
    injecting: "injecting",
    attached: "attached",
    detached: "detached",
    unavailable: "unavailable"
  };

  const validCaptureTransitions = new Map([
    [captureStates.idle, new Set([captureStates.starting])],
    [captureStates.starting, new Set([captureStates.running, captureStates.failed, captureStates.stopping, captureStates.idle])],
    [captureStates.running, new Set([captureStates.reconnecting, captureStates.stopping, captureStates.failed, captureStates.idle])],
    [captureStates.reconnecting, new Set([captureStates.running, captureStates.stopping, captureStates.failed, captureStates.idle])],
    [captureStates.stopping, new Set([captureStates.idle, captureStates.failed])],
    [captureStates.failed, new Set([captureStates.starting, captureStates.idle])]
  ]);

  function isValidCaptureTransition(fromState, toState) {
    if (fromState === toState) {
      return true;
    }

    return Boolean(validCaptureTransitions.get(fromState)?.has(toState));
  }

  function deriveSessionBooleans(session) {
    const captureState = session?.captureState || captureStates.idle;
    return {
      active: captureState === captureStates.running || captureState === captureStates.reconnecting,
      canStop: Boolean(
        session?.desiredActive ||
        captureState === captureStates.starting ||
        captureState === captureStates.running ||
        captureState === captureStates.reconnecting ||
        captureState === captureStates.stopping
      ),
      hasSession: Boolean(captureState !== captureStates.idle || session?.terminalReason)
    };
  }

  function mapRuntimeSnapshotToCaptureState(snapshot, fallbackState = captureStates.idle) {
    if (!snapshot?.hasRuntime) {
      return fallbackState;
    }

    if (snapshot.isReconnecting || snapshot.websocketState === "connecting") {
      return captureStates.reconnecting;
    }

    if (snapshot.websocketState === "open") {
      return captureStates.running;
    }

    return fallbackState;
  }

  const api = {
    CAPTURE_STATES: captureStates,
    PAGE_STATES: pageStates,
    deriveSessionBooleans,
    isValidCaptureTransition,
    mapRuntimeSnapshotToCaptureState
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.sessionState = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
