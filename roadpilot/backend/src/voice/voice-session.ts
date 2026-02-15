import { randomUUID } from "crypto";
import { fillerCache } from "./filler-cache.js";
import { PulseSTTPipeline, type STTCallbacks } from "./stt-pipeline.js";
import { TTSSentencePipeline } from "./tts-pipeline.js";
import { TTSWebSocket, type TTSStreamCallbacks } from "./tts-synthesize.js";
import { extractActionItem, type ActionItem } from "./action-extractor.js";
import type { Mastra } from "@mastra/core";
import { demoSession } from "../tools/demo-session.js";

export type SessionState = "idle" | "listening" | "thinking" | "speaking";

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

interface VoiceSessionCallbacks {
  onStateChange: (state: SessionState) => void;
  onTranscript: (role: "user" | "assistant", text: string) => void;
  onFillerAudio: (audioBuffer: Buffer, text: string) => void;
  onAudioChunk: (audioBuffer: Buffer, sentenceText: string) => void;
  onActionItem: (item: ActionItem) => void;
  onSessionEnded: (summary: SessionSummary) => void;
  onError: (error: Error) => void;
}

export interface SessionSummary {
  sessionId: string;
  driverId: string;
  transcript: TranscriptEntry[];
  actionItems: ActionItem[];
  startedAt: number;
  endedAt: number;
}

export interface PreFetchedContext {
  hos?: Record<string, unknown>;
  location?: string;
  activeTrip?: Record<string, unknown>;
  recentLoads?: Array<Record<string, unknown>>;
}

export class VoiceSession {
  readonly sessionId: string;
  readonly driverId: string;
  private state: SessionState = "idle";
  private conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
  private transcript: TranscriptEntry[] = [];
  private actionItems: ActionItem[] = [];
  private callbacks: VoiceSessionCallbacks;
  private mastra: Mastra;
  private sttPipeline: PulseSTTPipeline | null = null;
  private ttsPipeline: TTSSentencePipeline | null = null;
  private ttsWebSocket: TTSWebSocket | null = null;
  private abortController: AbortController | null = null;
  private startedAt: number;
  private preFetchedContext: PreFetchedContext = {};
  private audioBuffer: Buffer[] = [];         // Buffer audio while STT connects
  private sttConnecting = false;              // True while awaiting STT connection

  constructor(
    driverId: string,
    mastra: Mastra,
    callbacks: VoiceSessionCallbacks
  ) {
    this.sessionId = randomUUID();
    this.driverId = driverId;
    this.mastra = mastra;
    this.callbacks = callbacks;
    this.startedAt = Date.now();
  }

  /** Pre-fetch context for instant answers to common questions */
  async preFetch(): Promise<PreFetchedContext> {
    const agent = this.mastra.getAgent("roadpilot");
    const tools = (await agent.listTools()) as Record<string, any>;

    const loc = demoSession.driverLocation;
    const fuelLocation = loc ? `${loc.lat},${loc.lng}` : "current";
    const parkingLocation = loc ? `${loc.lat},${loc.lng}` : "current";

    const results = await Promise.allSettled([
      tools.getHOSStatus?.execute({ driverId: this.driverId }),
      tools.searchFuelPrices?.execute({ location: fuelLocation, radius: 20 }),
      tools.searchParking?.execute({ location: parkingLocation, radius: 30 }),
    ]);

    const locationStr = loc ? `${loc.city}, ${loc.state}` : "current";

    this.preFetchedContext = {
      hos: results[0].status === "fulfilled" ? results[0].value : undefined,
      location: locationStr,
    };

    console.log(`[VoiceSession ${this.sessionId}] Context pre-fetched (location: ${locationStr})`);
    return this.preFetchedContext;
  }

  /** Initialize and set to listening state */
  async startListening(): Promise<void> {
    if (!process.env.SMALLEST_API_KEY) throw new Error("SMALLEST_API_KEY required for voice");
    const apiKey = process.env.SMALLEST_API_KEY;

    // Eagerly create + connect the shared TTS WebSocket for this session
    if (!this.ttsWebSocket) {
      const ttsCallbacks: TTSStreamCallbacks = {
        onAudioChunk: () => {},
        onRequestComplete: () => {},
        onError: (err) => console.error("[TTS-WS] Session error:", err.message),
      };
      this.ttsWebSocket = new TTSWebSocket(apiKey, ttsCallbacks, {
        voiceId: "sophia",
        sampleRate: 24000,
        speed: 1.0,
      });
      this.ttsWebSocket.connect().catch((err) => {
        console.error("[TTS-WS] Eager connect failed (will retry on first use):", err.message);
      });
    }

    // Pre-warm the first STT connection so it's ready when user speaks
    this.preWarmSTT();

    this.setState("listening");
  }

  /**
   * Pre-warm a fresh Pulse STT connection in the background.
   * Called after each utterance completes so the next one is ready instantly.
   */
  private preWarmSTT(): void {
    const apiKey = process.env.SMALLEST_API_KEY;
    if (!apiKey) return;

    // Don't pre-warm if we already have a connected pipeline
    if (this.sttPipeline?.isConnected()) return;

    // Clean up any dead pipeline
    if (this.sttPipeline) {
      this.sttPipeline.disconnect();
      this.sttPipeline = null;
    }

    const sttCallbacks: STTCallbacks = {
      onInterim: (text) => {
        this.callbacks.onTranscript("user", text);
      },
      onFinal: () => {},
      onError: (err) => {
        console.error(`[VoiceSession ${this.sessionId}] STT error:`, err.message);
        this.callbacks.onError(err);
      },
    };

    this.sttPipeline = new PulseSTTPipeline(apiKey, sttCallbacks);
    this.sttPipeline.connect().then(() => {
      console.log(`[VoiceSession ${this.sessionId}] STT pre-warmed and ready`);
    }).catch((err) => {
      console.error(`[VoiceSession ${this.sessionId}] STT pre-warm failed:`, err.message);
      // Will retry on next speech_start
      this.sttPipeline = null;
    });
  }

  /** Called when client detects speech started */
  async onSpeechStart(): Promise<void> {
    this.audioFrameCount = 0;
    this.audioBuffer = [];
    this.sttConnecting = false;

    const apiKey = process.env.SMALLEST_API_KEY!;

    // If pre-warmed pipeline is ready, use it directly
    if (this.sttPipeline?.isConnected()) {
      this.sttPipeline.resetUtterance();
      console.log(`[VoiceSession ${this.sessionId}] Speech started — using pre-warmed STT`);
      return;
    }

    // No pre-warmed connection — need to connect now (buffer audio while waiting)
    console.log(`[VoiceSession ${this.sessionId}] Speech started — STT not pre-warmed, connecting now...`);
    this.sttConnecting = true;

    // Clean up any dead pipeline
    if (this.sttPipeline) {
      this.sttPipeline.disconnect();
    }

    const sttCallbacks: STTCallbacks = {
      onInterim: (text) => this.callbacks.onTranscript("user", text),
      onFinal: () => {},
      onError: (err) => this.callbacks.onError(err),
    };

    this.sttPipeline = new PulseSTTPipeline(apiKey, sttCallbacks);
    try {
      await this.sttPipeline.connect();
      this.sttPipeline.resetUtterance();
      this.sttConnecting = false;

      // Flush buffered audio
      if (this.audioBuffer.length > 0) {
        console.log(`[VoiceSession ${this.sessionId}] Flushing ${this.audioBuffer.length} buffered audio frames`);
        for (const buf of this.audioBuffer) {
          this.sttPipeline.sendAudio(buf);
        }
        this.audioBuffer = [];
      }
    } catch (err) {
      console.error(`[VoiceSession ${this.sessionId}] STT connect failed during speech:`, (err as Error).message);
      this.sttConnecting = false;
      this.audioBuffer = [];
      this.sttPipeline = null;
      this.callbacks.onError(err as Error);
    }
  }

  /** Feed raw PCM audio from the browser mic (only during speech) */
  private audioFrameCount = 0;
  feedAudio(pcmBuffer: Buffer): void {
    this.audioFrameCount++;
    if (this.audioFrameCount % 10 === 1) {
      console.log(`[VoiceSession ${this.sessionId}] Audio frame #${this.audioFrameCount}, size=${pcmBuffer.length}bytes, connecting=${this.sttConnecting}, hasPipeline=${!!this.sttPipeline}`);
    }
    // Buffer audio while STT is connecting
    if (this.sttConnecting) {
      this.audioBuffer.push(Buffer.from(pcmBuffer));
      return;
    }
    if (this.sttPipeline) {
      this.sttPipeline.sendAudio(pcmBuffer);
    }
  }

  /** Called when client detects speech ended */
  async onSpeechEnd(): Promise<void> {
    if (!this.sttPipeline) return;

    console.log(`[VoiceSession ${this.sessionId}] Speech ended — collecting transcript (${this.audioFrameCount} total frames sent)`);
    const text = await this.sttPipeline.endUtterance();
    // endUtterance() disconnects the pipeline — it's now dead
    this.sttPipeline = null;

    // Pre-warm the NEXT STT connection immediately (during thinking + TTS time)
    this.preWarmSTT();

    if (text) {
      console.log(`[VoiceSession ${this.sessionId}] Transcript: "${text}"`);
      this.callbacks.onTranscript("user", text);
      await this.handleUserMessage(text);
    } else {
      console.log(`[VoiceSession ${this.sessionId}] No speech detected`);
    }
  }

  /** Handle a complete user utterance */
  async handleUserMessage(text: string): Promise<void> {
    this.conversationHistory.push({ role: "user", content: text });
    this.transcript.push({ role: "user", text, timestamp: Date.now() });

    this.setState("thinking");

    // Abort any previous response
    if (this.abortController) {
      this.abortController.abort();
    }
    const localAbort = new AbortController();
    this.abortController = localAbort;

    const apiKey = process.env.SMALLEST_API_KEY;
    if (!apiKey) {
      this.callbacks.onError(new Error("SMALLEST_API_KEY required"));
      return;
    }

    const messages = this.buildMessages();

    try {
      const agent = this.mastra.getAgent("roadpilot");

      console.log(`[VoiceSession ${this.sessionId}] Starting Claude stream with ${messages.length} messages`);
      const stream = await agent.stream(messages as any, {
        maxSteps: 10,
        abortSignal: localAbort.signal,
      });
      console.log(`[VoiceSession ${this.sessionId}] Claude stream created, processing chunks...`);

      let fillerSent = false;
      let fullResponseText = "";

      this.ttsPipeline = new TTSSentencePipeline(
        apiKey,
        {
          onAudioChunk: (audioBuffer, sentenceText) => {
            if (this.state !== "speaking") this.setState("speaking");
            this.callbacks.onAudioChunk(audioBuffer, sentenceText);
          },
          onDone: () => {
            this.setState("listening");
            // Pre-warm STT when TTS finishes (in case the earlier pre-warm expired)
            this.preWarmSTT();
          },
          onError: (err) => {
            console.error("[TTS] Error:", err.message);
            this.callbacks.onError(err);
          },
        },
        "sophia",
        this.ttsWebSocket ?? undefined
      );

      for await (const chunk of stream.fullStream) {
        if (localAbort.signal.aborted) break;
        const payload = (chunk as any).payload;

        if (chunk.type === "text-delta") {
          const textDelta: string = payload?.text ?? "";
          if (!fillerSent) {
            fillerSent = true;
            const filler = fillerCache.getSmartFiller();
            if (filler?.audio) {
              this.callbacks.onFillerAudio(filler.audio, filler.text);
            }
          }
          fullResponseText += textDelta;
          this.ttsPipeline.feedText(textDelta);
        }

        if (chunk.type === "tool-call") {
          const toolName: string = payload?.toolName ?? "";
          if (!fillerSent) {
            fillerSent = true;
            const filler = fillerCache.getSmartFiller(toolName);
            if (filler?.audio) {
              this.callbacks.onFillerAudio(filler.audio, filler.text);
            }
          }
        }

        if (chunk.type === "tool-result") {
          const actionItem = extractActionItem({
            toolName: payload?.toolName ?? "",
            args: (payload?.args ?? {}) as Record<string, unknown>,
            result: payload?.result,
          });
          if (actionItem) {
            this.actionItems.push(actionItem);
            this.callbacks.onActionItem(actionItem);
          }
        }
      }

      if (this.ttsPipeline && !localAbort.signal.aborted) {
        this.ttsPipeline.finish();
      }

      if (fullResponseText) {
        this.conversationHistory.push({ role: "assistant", content: fullResponseText });
        this.transcript.push({ role: "assistant", text: fullResponseText, timestamp: Date.now() });
        this.callbacks.onTranscript("assistant", fullResponseText);
      }
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") {
        console.log(`[VoiceSession ${this.sessionId}] Response aborted (interrupt)`);
      } else {
        console.error(`[VoiceSession ${this.sessionId}] Stream error:`, err);
        this.callbacks.onError(err as Error);
      }
      this.setState("listening");
    }
  }

  async injectSystemMessage(message: string): Promise<void> {
    console.log(`[VoiceSession ${this.sessionId}] System event injected: "${message.substring(0, 80)}"`);
    await this.handleUserMessage(message);
  }

  /** Interrupt current response — user started speaking again */
  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.ttsPipeline) {
      this.ttsPipeline.abort();
      this.ttsPipeline = null;
    }

    this.setState("listening");
  }

  /** End the session and return summary */
  end(): SessionSummary {
    if (this.sttPipeline) {
      this.sttPipeline.flush();
      this.sttPipeline.disconnect();
      this.sttPipeline = null;
    }

    if (this.abortController) {
      this.abortController.abort();
    }

    if (this.ttsPipeline) {
      this.ttsPipeline.abort();
      this.ttsPipeline = null;
    }

    if (this.ttsWebSocket) {
      this.ttsWebSocket.disconnect();
      this.ttsWebSocket = null;
    }

    this.setState("idle");

    const summary: SessionSummary = {
      sessionId: this.sessionId,
      driverId: this.driverId,
      transcript: this.transcript,
      actionItems: this.actionItems,
      startedAt: this.startedAt,
      endedAt: Date.now(),
    };

    this.callbacks.onSessionEnded(summary);
    return summary;
  }

  getState(): SessionState {
    return this.state;
  }

  getActionItems(): ActionItem[] {
    return this.actionItems;
  }

  private setState(state: SessionState): void {
    if (this.state !== state) {
      this.state = state;
      this.callbacks.onStateChange(state);
    }
  }

  private buildMessages(): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    if (this.preFetchedContext.hos) {
      const hos = this.preFetchedContext.hos;
      const contextParts: string[] = [];

      if (hos.driveTimeRemaining || hos.drive_time_remaining) {
        const mins = (hos.driveTimeRemaining ?? hos.drive_time_remaining) as number;
        const hrs = Math.floor(mins / 60);
        const m = mins % 60;
        contextParts.push(`Driver has ${hrs}h ${m}m of drive time remaining`);
      }

      if (this.preFetchedContext.activeTrip) {
        const trip = this.preFetchedContext.activeTrip;
        contextParts.push(`Active trip: ${trip.origin} to ${trip.destination}`);
      }

      if (contextParts.length > 0) {
        messages.push({
          role: "system",
          content: `Current driver context (pre-fetched, no need to call tools for this): ${contextParts.join(". ")}`,
        });
      }
    }

    messages.push(...this.conversationHistory);

    return messages;
  }
}
