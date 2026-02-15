import WebSocket from "ws";

export interface STTCallbacks {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (error: Error) => void;
}

const PULSE_WSS_URL = "wss://waves-api.smallest.ai/api/v1/pulse/get_text";

/**
 * Per-utterance STT pipeline wrapping Pulse WebSocket.
 *
 * Pulse requires a FRESH WebSocket per utterance — after sending { type: "end" },
 * the server closes the connection and won't process new audio on it.
 *
 * Usage:
 *   connect()       — open connection (call early to pre-warm)
 *   sendAudio()     — stream PCM audio
 *   endUtterance()  — send "end", wait for final, return transcript, disconnect
 *   disconnect()    — force-close (cleanup)
 */
export class PulseSTTPipeline {
  private ws: WebSocket | null = null;
  private callbacks: STTCallbacks;
  private apiKey: string;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  // Per-utterance state
  private accumulatedFinalText = "";
  private lastInterimText = "";
  private audioChunksSent = 0;
  private gotAnyResponse = false;
  private gotLastFinal = false;

  constructor(apiKey: string, callbacks: STTCallbacks) {
    this.apiKey = apiKey;
    this.callbacks = callbacks;
  }

  /** Open Pulse WebSocket connection. Call early to pre-warm. */
  async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = `${PULSE_WSS_URL}?language=en&sample_rate=16000&encoding=linear16`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      const timeout = setTimeout(() => {
        if (!this.connected) {
          this.disconnectQuiet();
          this.connectPromise = null;
          reject(new Error("Pulse STT connection timeout"));
        }
      }, 5000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        this.connected = true;
        this.connectPromise = null;
        console.log("[PulseSTT] Connected");
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.gotAnyResponse = true;
          console.log("[PulseSTT] Received:", JSON.stringify(msg).substring(0, 200));

          const text = msg.transcript || msg.text;
          if (text) {
            if (msg.is_final) {
              if (this.gotLastFinal) {
                console.log("[PulseSTT] Ignoring duplicate final");
              } else {
                const finalText = text.trim();
                if (finalText) {
                  this.accumulatedFinalText += (this.accumulatedFinalText ? " " : "") + finalText;
                  console.log("[PulseSTT] Final text:", finalText);
                }
                if (msg.is_last) this.gotLastFinal = true;
              }
            } else {
              this.lastInterimText = text.trim();
              const display = this.accumulatedFinalText
                ? this.accumulatedFinalText + " " + text
                : text;
              this.callbacks.onInterim(display);
            }
          }
        } catch {
          // ignore non-JSON
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        console.error("[PulseSTT] Error:", err.message);
        this.connected = false;
        this.connectPromise = null;
        this.callbacks.onError(err);
        if (!this.connected) reject(err);
      });

      this.ws.on("close", (code, reason) => {
        this.connected = false;
        this.connectPromise = null;
        console.log(`[PulseSTT] Disconnected (code=${code})`);
      });
    });

    return this.connectPromise;
  }

  /** Reset per-utterance state. Call before streaming audio for a new utterance. */
  resetUtterance(): void {
    this.accumulatedFinalText = "";
    this.lastInterimText = "";
    this.audioChunksSent = 0;
    this.gotAnyResponse = false;
    this.gotLastFinal = false;
  }

  sendAudio(pcmBuffer: Buffer): void {
    if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) {
      // Apply gain boost to compensate for browser echo cancellation suppressing mic
      const boosted = this.applyGain(pcmBuffer);
      this.ws.send(boosted);
      this.audioChunksSent++;
      if (this.audioChunksSent % 10 === 1) {
        const samples = new Int16Array(boosted.buffer, boosted.byteOffset, boosted.length / 2);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += (samples[i] / 32768) ** 2;
        const rms = Math.sqrt(sum / samples.length);
        console.log(`[PulseSTT] Audio chunk #${this.audioChunksSent}, RMS: ${rms.toFixed(5)} (gain: ${this.currentGain.toFixed(1)}x), size: ${boosted.length}b, gotResponse: ${this.gotAnyResponse}`);
      }
    }
  }

  /**
   * Auto-gain: boost quiet audio so Pulse can transcribe it even when
   * browser echo cancellation is suppressing the mic after TTS playback.
   * Targets RMS ~0.08. Caps gain at 8x to avoid amplifying pure noise.
   */
  private currentGain = 1.0;
  private static readonly TARGET_RMS = 0.08;
  private static readonly MAX_GAIN = 8.0;
  private static readonly GAIN_SMOOTHING = 0.15; // How fast gain adapts (0-1)

  private applyGain(pcmBuffer: Buffer): Buffer {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);

    // Measure raw RMS
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += (samples[i] / 32768) ** 2;
    const rawRms = Math.sqrt(sum / samples.length);

    // Update adaptive gain
    if (rawRms > 0.001) { // Only adjust if there's actual signal (not silence)
      const idealGain = Math.min(PulseSTTPipeline.TARGET_RMS / rawRms, PulseSTTPipeline.MAX_GAIN);
      this.currentGain = this.currentGain * (1 - PulseSTTPipeline.GAIN_SMOOTHING) + idealGain * PulseSTTPipeline.GAIN_SMOOTHING;
    }

    // If gain is close to 1x, skip processing
    if (this.currentGain < 1.2) return pcmBuffer;

    // Apply gain to a copy of the buffer
    const output = Buffer.alloc(pcmBuffer.length);
    const outSamples = new Int16Array(output.buffer, output.byteOffset, output.length / 2);
    const gain = this.currentGain;
    for (let i = 0; i < samples.length; i++) {
      const amplified = samples[i] * gain;
      // Clamp to int16 range
      outSamples[i] = amplified > 32767 ? 32767 : amplified < -32768 ? -32768 : amplified;
    }
    return output;
  }

  /**
   * End utterance: send "end" to Pulse, wait for final transcript,
   * then DISCONNECT (Pulse won't accept new audio after "end").
   */
  async endUtterance(): Promise<string> {
    if (!this.ws || !this.connected) {
      return this.getBestText();
    }

    // Send end signal
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "end" }));
      }
    } catch {
      // ignore
    }

    // Wait for final transcript
    const waitMs = this.gotAnyResponse ? 300 : 800;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      const ws = this.ws;
      if (!ws) { clearTimeout(timer); resolve(); return; }

      const earlyResolve = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.is_final && msg.is_last) {
            clearTimeout(timer);
            ws.removeListener("message", earlyResolve);
            resolve();
          }
        } catch { /* ignore */ }
      };
      ws.on("message", earlyResolve);
      setTimeout(() => { ws.removeListener("message", earlyResolve); }, waitMs + 50);
    });

    if (!this.gotAnyResponse && this.audioChunksSent > 0) {
      console.warn(`[PulseSTT] WARNING: Sent ${this.audioChunksSent} audio chunks but got NO response from Pulse`);
    }

    const text = this.getBestText();

    // Disconnect — Pulse won't accept new audio after "end"
    this.disconnectQuiet();

    return text;
  }

  /** Force flush — get whatever text we have */
  flush(): void {
    const text = this.getBestText();
    if (text) {
      console.log("[PulseSTT] Flush:", text);
      this.callbacks.onFinal(text);
    }
    this.accumulatedFinalText = "";
    this.lastInterimText = "";
  }

  disconnect(): void {
    this.disconnectQuiet();
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  private getBestText(): string {
    return this.accumulatedFinalText.trim() || this.lastInterimText.trim();
  }

  private disconnectQuiet(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
      this.connected = false;
    }
  }
}
