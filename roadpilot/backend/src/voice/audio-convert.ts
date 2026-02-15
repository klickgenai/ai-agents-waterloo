/**
 * Audio format conversion for Twilio Media Streams <-> Smallest AI STT/TTS.
 *
 * Twilio Media Streams: mulaw 8kHz, base64-encoded
 * Smallest Pulse STT: PCM 16kHz linear16 (raw buffers)
 * Smallest Waves TTS: PCM 24kHz 16-bit mono (raw, we request no WAV header)
 */

// ─── Mulaw decode table (ITU-T G.711) ───────────────────────────────────────
const MULAW_DECODE_TABLE = new Int16Array(256);
(function buildDecodeTable() {
  for (let i = 0; i < 256; i++) {
    let mulaw = ~i & 0xff;
    const sign = mulaw & 0x80;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0f;
    let magnitude = ((mantissa << 1) + 33) << (exponent + 2);
    magnitude -= 0x84;
    MULAW_DECODE_TABLE[i] = sign ? -magnitude : magnitude;
  }
})();

// ─── Mulaw encode ───────────────────────────────────────────────────────────
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function linear16ToMulawSample(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  const expMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & (expMask >> (7 - exponent))) break;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

/**
 * Decode mulaw buffer to PCM 16-bit signed.
 * Each mulaw byte becomes a 2-byte PCM sample.
 */
export function mulawToLinear16(mulawBuf: Buffer): Buffer {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(MULAW_DECODE_TABLE[mulawBuf[i]], i * 2);
  }
  return pcm;
}

/**
 * Encode PCM 16-bit signed buffer to mulaw.
 * Every 2 bytes of PCM become 1 mulaw byte.
 */
export function linear16ToMulaw(pcmBuf: Buffer): Buffer {
  const numSamples = Math.floor(pcmBuf.length / 2);
  const mulaw = Buffer.alloc(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const sample = pcmBuf.readInt16LE(i * 2);
    mulaw[i] = linear16ToMulawSample(sample);
  }
  return mulaw;
}

/**
 * Resample PCM 16-bit buffer using linear interpolation.
 * Works for both upsampling (8k→16k) and downsampling (24k→8k).
 */
export function resample(pcmBuf: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcmBuf;

  const numInputSamples = Math.floor(pcmBuf.length / 2);
  const ratio = fromRate / toRate;
  const numOutputSamples = Math.floor(numInputSamples / ratio);
  const output = Buffer.alloc(numOutputSamples * 2);

  for (let i = 0; i < numOutputSamples; i++) {
    const srcIdx = i * ratio;
    const srcIdxFloor = Math.floor(srcIdx);
    const frac = srcIdx - srcIdxFloor;

    const s0 = pcmBuf.readInt16LE(Math.min(srcIdxFloor, numInputSamples - 1) * 2);
    const s1 = pcmBuf.readInt16LE(Math.min(srcIdxFloor + 1, numInputSamples - 1) * 2);
    const interpolated = Math.round(s0 + frac * (s1 - s0));

    output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
  }

  return output;
}

/**
 * Convert Twilio mulaw 8kHz base64 payload → PCM 16kHz buffer for Pulse STT.
 * Pipeline: base64 decode → mulaw decode → upsample 8k→16k
 */
export function mulawToSTT(mulawBase64: string): Buffer {
  const mulawBuf = Buffer.from(mulawBase64, "base64");
  const pcm8k = mulawToLinear16(mulawBuf);
  const pcm16k = resample(pcm8k, 8000, 16000);
  return pcm16k;
}

/**
 * Convert Waves TTS raw PCM 24kHz → mulaw 8kHz base64 for Twilio.
 * Pipeline: downsample 24k→8k → encode mulaw → base64
 */
export function ttsToMulaw(rawPcm24k: Buffer): string {
  const pcm8k = resample(rawPcm24k, 24000, 8000);
  const mulawBuf = linear16ToMulaw(pcm8k);
  return mulawBuf.toString("base64");
}
