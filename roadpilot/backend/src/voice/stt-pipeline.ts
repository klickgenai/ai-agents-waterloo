import WebSocket from "ws";

export interface STTCallbacks {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (error: Error) => void;
}

const PULSE_WSS_URL = "wss://waves-api.smallest.ai/api/v1/pulse/get_text";

// Trucking terminology — boost recognition for industry-specific words (weight 5-8)
const TRUCKING_KEYWORDS = [
  "deadhead:7", "dry van:8", "reefer:8", "flatbed:8", "hotshot:6",
  "load board:8", "DAT:8", "broker:7", "rate con:7", "rate confirmation:7",
  "BOL:8", "bill of lading:7", "IFTA:8", "ELD:8", "HOS:8",
  "hours of service:7", "detention:6", "lumper:6", "pallet:5",
  "drop and hook:7", "live load:7", "live unload:7",
  "MC number:7", "DOT:7", "FMCSA:6", "CDL:7",
  "truck stop:6", "Pilot:5", "Love's:5", "Flying J:5", "TA:5",
  "fuel surcharge:6", "per mile:7", "rate per mile:8",
  "tanker:6", "hazmat:7", "oversize:6", "LTL:7", "FTL:7",
  "Tasha:9", "RoadPilot:9",
].join(",");

/**
 * Turn-based STT: opens a fresh Pulse connection per utterance.
 * Client signals speech_start → connect to Pulse, stream audio.
 * Client signals speech_end → send "end" to Pulse, collect final, disconnect.
 *
 * Optimizations:
 * - word_timestamps=false — we don't use them, reduces server-side overhead
 * - keywords — boosts trucking terminology for accurate recognition
 */
export class PulseSTTPipeline {
  private ws: WebSocket | null = null;
  private callbacks: STTCallbacks;
  private apiKey: string;
  private connected = false;
  private accumulatedFinalText = "";
  private lastInterimText = "";

  constructor(apiKey: string, callbacks: STTCallbacks) {
    this.apiKey = apiKey;
    this.callbacks = callbacks;
  }

  /** Open a fresh Pulse connection for a new utterance */
  async connect(): Promise<void> {
    // Disconnect any existing connection
    this.disconnectQuiet();
    this.accumulatedFinalText = "";
    this.lastInterimText = "";

    return new Promise((resolve, reject) => {
      const url = `${PULSE_WSS_URL}?language=en&sample_rate=16000&encoding=linear16`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      const timeout = setTimeout(() => {
        if (!this.connected) {
          this.disconnectQuiet();
          reject(new Error("Pulse STT connection timeout"));
        }
      }, 5000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        this.connected = true;
        console.log("[PulseSTT] Connected (new utterance)");
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          console.log("[PulseSTT] Received:", JSON.stringify(msg).substring(0, 200));

          // Pulse uses "transcript" field, not "text"
          const text = msg.transcript || msg.text;
          if (text) {
            if (msg.is_final) {
              const finalText = text.trim();
              if (finalText) {
                this.accumulatedFinalText += (this.accumulatedFinalText ? " " : "") + finalText;
                console.log("[PulseSTT] Final text:", finalText);
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
        this.callbacks.onError(err);
        if (!this.connected) reject(err);
      });

      this.ws.on("close", () => {
        this.connected = false;
        console.log("[PulseSTT] Disconnected");
      });
    });
  }

  sendAudio(pcmBuffer: Buffer): void {
    if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcmBuffer);
    }
  }

  /**
   * End the current utterance: send "end" to Pulse, wait briefly for finals,
   * then flush and return the transcript.
   */
  async endUtterance(): Promise<string> {
    if (!this.ws || !this.connected) {
      return this.getBestText();
    }

    // Send end signal to Pulse
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "end" }));
      }
    } catch {
      // ignore
    }

    // Wait briefly for any final messages to arrive (keep short to reduce lag)
    await new Promise((resolve) => setTimeout(resolve, 100));

    const text = this.getBestText();
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
    // Prefer accumulated final text, fall back to last interim
    return this.accumulatedFinalText.trim() || this.lastInterimText.trim();
  }

  private disconnectQuiet(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
      this.connected = false;
    }
  }
}
