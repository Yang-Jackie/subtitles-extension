class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const frameCount = input[0]?.length || 0;
    if (frameCount === 0) {
      return true;
    }

    // Mix all input channels into a single mono PCM frame. The main thread
    // resamples and converts these Float32 samples into Deepgram's linear16 format.
    const monoSamples = new Float32Array(frameCount);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      let mixed = 0;
      for (let channelIndex = 0; channelIndex < input.length; channelIndex += 1) {
        mixed += input[channelIndex][frameIndex] || 0;
      }
      monoSamples[frameIndex] = mixed / input.length;
    }

    this.port.postMessage({ samples: monoSamples }, [monoSamples.buffer]);
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
