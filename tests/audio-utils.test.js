const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasAudibleAudio,
  downsampleBuffer,
  floatToInt16Buffer
} = require("../audio-utils.js");

test("hasAudibleAudio respects the configured threshold", () => {
  assert.equal(hasAudibleAudio(new Float32Array([0, 0.001, -0.0019]), 0.002), false);
  assert.equal(hasAudibleAudio(new Float32Array([0, 0.002, -0.001]), 0.002), true);
  assert.equal(hasAudibleAudio(new Float32Array([0, -0.003]), 0.002), true);
});

test("downsampleBuffer returns the same buffer when sample rates match", () => {
  const source = new Float32Array([0.1, 0.2, 0.3]);
  assert.equal(downsampleBuffer(source, 16000, 16000), source);
});

test("downsampleBuffer averages input ranges when lowering sample rate", () => {
  const source = new Float32Array([1, 3, 5, 7]);
  assert.deepEqual(Array.from(downsampleBuffer(source, 4, 2)), [2, 6]);
});

test("downsampleBuffer rejects upsampling", () => {
  assert.throws(() => downsampleBuffer(new Float32Array([1, 2]), 16000, 48000), {
    message: "Output sample rate must be lower than input sample rate"
  });
});

test("floatToInt16Buffer clamps and converts signed float samples", () => {
  assert.deepEqual(
    Array.from(floatToInt16Buffer(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]))),
    [-32768, -32768, -16384, 0, 16383, 32767, 32767]
  );
});
