const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CAPTURE_STATES,
  deriveSessionBooleans,
  isValidCaptureTransition,
  mapRuntimeSnapshotToCaptureState
} = require("../session-state.js");

test("normal stop is represented as idle with a terminal reason", () => {
  const session = {
    desiredActive: false,
    captureState: CAPTURE_STATES.idle,
    terminalReason: {
      code: "user_stop",
      message: "Stopped by user"
    }
  };

  assert.deepEqual(deriveSessionBooleans(session), {
    active: false,
    canStop: false,
    hasSession: true
  });
});

test("live capture states derive active and stoppable flags", () => {
  assert.deepEqual(deriveSessionBooleans({ captureState: CAPTURE_STATES.running }), {
    active: true,
    canStop: true,
    hasSession: true
  });

  assert.deepEqual(deriveSessionBooleans({ captureState: CAPTURE_STATES.reconnecting }), {
    active: true,
    canStop: true,
    hasSession: true
  });
});

test("capture transition table rejects durable stopped-style transitions", () => {
  assert.equal(isValidCaptureTransition(CAPTURE_STATES.running, CAPTURE_STATES.reconnecting), true);
  assert.equal(isValidCaptureTransition(CAPTURE_STATES.stopping, CAPTURE_STATES.idle), true);
  assert.equal(isValidCaptureTransition(CAPTURE_STATES.idle, CAPTURE_STATES.running), false);
});

test("runtime snapshots map to public capture states", () => {
  assert.equal(
    mapRuntimeSnapshotToCaptureState({ hasRuntime: true, websocketState: "open" }),
    CAPTURE_STATES.running
  );

  assert.equal(
    mapRuntimeSnapshotToCaptureState({ hasRuntime: true, websocketState: "connecting" }),
    CAPTURE_STATES.reconnecting
  );

  assert.equal(
    mapRuntimeSnapshotToCaptureState({ hasRuntime: false, websocketState: "none" }, CAPTURE_STATES.idle),
    CAPTURE_STATES.idle
  );
});
