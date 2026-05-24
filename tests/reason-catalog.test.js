const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REASONS,
  STATUS,
  createReason,
  normalizeReason
} = require("../reason-catalog.js");

test("createReason builds a timestamped catalog reason", () => {
  const reason = createReason("silence_timeout", "offscreen", { at: 123 });

  assert.deepEqual(reason, {
    code: "silence_timeout",
    message: "Stopped after 60 seconds without audible audio",
    category: "timeout",
    source: "offscreen",
    at: 123
  });
});

test("createReason supports message overrides", () => {
  const reason = createReason("deepgram_error", "offscreen", {
    message: "Invalid API key",
    at: 456
  });

  assert.equal(reason.message, "Invalid API key");
  assert.equal(reason.category, REASONS.deepgram_error.category);
  assert.equal(reason.at, 456);
});

test("normalizeReason preserves structured runtime reasons", () => {
  const reason = normalizeReason({
    code: "stream_lost",
    message: "Audio stream lost",
    category: "runtime",
    source: "offscreen",
    at: 789
  }, "unknown_failure", "background");

  assert.deepEqual(reason, {
    code: "stream_lost",
    message: "Audio stream lost",
    category: "runtime",
    source: "offscreen",
    at: 789
  });
});

test("normalizeReason converts string reasons with fallback metadata", () => {
  const reason = normalizeReason("Something broke", "unknown_failure", "background");

  assert.equal(reason.code, "unknown_failure");
  assert.equal(reason.message, "Something broke");
  assert.equal(reason.category, "unknown");
  assert.equal(reason.source, "background");
});

test("STATUS contains shared popup status strings", () => {
  assert.equal(STATUS.ready, "Ready.");
  assert.equal(STATUS.reconnectingPopup, "Reconnecting to Deepgram...");
});
