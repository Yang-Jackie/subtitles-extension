(function initAudioUtils(root) {
  const DEFAULT_AUDIO_ACTIVITY_THRESHOLD = 0.002;

  function hasAudibleAudio(samples, threshold = DEFAULT_AUDIO_ACTIVITY_THRESHOLD) {
    for (let i = 0; i < samples.length; i += 1) {
      if (Math.abs(samples[i]) >= threshold) {
        return true;
      }
    }

    return false;
  }

  function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
    if (outputSampleRate === inputSampleRate) {
      return buffer;
    }

    if (outputSampleRate > inputSampleRate) {
      throw new Error("Output sample rate must be lower than input sample rate");
    }

    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const outputLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(outputLength);
    let outputOffset = 0;
    let inputOffset = 0;

    while (outputOffset < result.length) {
      const nextInputOffset = Math.round((outputOffset + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;

      for (let i = inputOffset; i < nextInputOffset && i < buffer.length; i += 1) {
        accum += buffer[i];
        count += 1;
      }

      result[outputOffset] = count > 0 ? accum / count : 0;
      outputOffset += 1;
      inputOffset = nextInputOffset;
    }

    return result;
  }

  function floatToInt16Buffer(float32Buffer) {
    const int16Buffer = new Int16Array(float32Buffer.length);

    for (let i = 0; i < float32Buffer.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, float32Buffer[i]));
      int16Buffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    return int16Buffer;
  }

  const api = {
    DEFAULT_AUDIO_ACTIVITY_THRESHOLD,
    hasAudibleAudio,
    downsampleBuffer,
    floatToInt16Buffer
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.audioUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
