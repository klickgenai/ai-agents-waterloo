/**
 * Twilio outbound call service for broker negotiations.
 *
 * Flow:
 * 1. initiate call via Twilio REST API → TwiML streams audio to our WebSocket
 * 2. Incoming audio (broker speech): mulaw 8kHz → PCM 16kHz → Pulse STT → transcript
 * 3. Transcript → Claude (negotiation AI) → response text
 * 4. Response text → Waves TTS → PCM 24kHz → mulaw 8kHz → Twilio Media Stream
 * 5. On call end → return negotiation result
 */

import Twilio from "twilio";
import WebSocket from "ws";
import Anthropic from "@anthropic-ai/sdk";
import { PulseSTTPipeline } from "../voice/stt-pipeline.js";
import { mulawToSTT, ttsToMulaw } from "../voice/audio-convert.js";
import { synthesizeSpeech } from "../voice/tts-synthesize.js";

export type CallState = "idle" | "ringing" | "connected" | "negotiating" | "completed" | "failed";

export interface CallConfig {
  brokerPhone: string;
  brokerName: string;
  loadDetails: {
    loadId: string;
    origin: string;
    destination: string;
    distance: number;
    pickupDate: string;
    rate: number;
    ratePerMile: number;
    weight?: number;
    commodity?: string;
    equipmentType?: string;
  };
  targetRate: number;
  minimumRate: number;
  driverName: string;
  driverMC: string;
  negotiationStyle: "firm" | "moderate" | "flexible";
}

export interface NegotiationResult {
  agreed: boolean;
  negotiatedRate?: number;
  negotiatedRatePerMile?: number;
  transcript: string[];
  callDuration: number;
  brokerCounterOffer?: number;
  notes: string;
}

// Active call sessions keyed by Twilio call SID
const activeSessions = new Map<string, TwilioCallSession>();

export function getSession(callSid: string): TwilioCallSession | undefined {
  return activeSessions.get(callSid);
}

export function getSessionByCallId(callId: string): TwilioCallSession | undefined {
  for (const session of activeSessions.values()) {
    if (session.callId === callId) return session;
  }
  return undefined;
}

export class TwilioCallSession {
  readonly callId: string;
  private config: CallConfig;
  private state: CallState = "idle";
  private callSid: string | null = null;
  private streamSid: string | null = null;
  private twilioWs: WebSocket | null = null;
  private sttPipeline: PulseSTTPipeline | null = null;
  private anthropic: Anthropic;
  private conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
  private transcript: string[] = [];
  private startTime: number = 0;
  private endTime: number = 0;
  private result: NegotiationResult | null = null;
  private pendingSpeech = "";
  private speaking = false;
  private isProcessing = false;       // Lock to prevent concurrent handleBrokerSpeech calls
  private sttConnecting = false;
  private audioBuffer: Buffer[] = [];
  private greetingSent = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;  // Abort streaming Claude + TTS
  private bargeInAudioLevel: number[] = [];                 // Track audio energy during speech for barge-in detection
  private negotiationEndSignal: { agreed: boolean; ratePerMile?: number } | null = null;  // AI-determined result
  private onCallComplete: ((result: NegotiationResult) => void) | null = null;

  constructor(config: CallConfig) {
    this.callId = `CALL-${Date.now()}`;
    this.config = config;
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    });
  }

  get currentState(): CallState {
    return this.state;
  }

  getTranscript(): string[] {
    return [...this.transcript];
  }

  getResult(): NegotiationResult | null {
    return this.result;
  }

  /** Register a callback to be called when the call completes with the result. */
  onComplete(callback: (result: NegotiationResult) => void): void {
    this.onCallComplete = callback;
  }

  /**
   * Initiate the outbound call via Twilio REST API.
   * Twilio will connect to our /twilio-media WebSocket for audio streaming.
   */
  async startCall(): Promise<{ callSid: string; status: string }> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID!;
    const authToken = process.env.TWILIO_AUTH_TOKEN!;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER!;
    const ngrokUrl = process.env.NGROK_URL!;

    if (!accountSid || !authToken || !fromNumber || !ngrokUrl) {
      throw new Error("Missing Twilio env vars (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, NGROK_URL)");
    }

    const client = Twilio(accountSid, authToken);
    this.startTime = Date.now();
    this.setState("ringing");

    // TwiML that connects the call to our Media Stream WebSocket
    const wsUrl = ngrokUrl.replace(/^https?/, "wss") + "/twilio-media";
    const statusUrl = ngrokUrl + "/api/twilio/call-status";

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callId" value="${this.callId}" />
    </Stream>
  </Connect>
</Response>`;

    const call = await client.calls.create({
      to: this.config.brokerPhone,
      from: fromNumber,
      twiml,
      statusCallback: statusUrl,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    this.callSid = call.sid;
    activeSessions.set(call.sid, this);
    activeSessions.set(this.callId, this);

    console.log(`[TwilioCall] Initiated call ${call.sid} to ${this.config.brokerPhone}`);

    return { callSid: call.sid, status: call.status };
  }

  /**
   * Called when Twilio connects the Media Stream WebSocket.
   * @param ws The WebSocket connection
   * @param bufferedMessages Messages that arrived before this handler was attached
   */
  handleMediaStream(ws: WebSocket, bufferedMessages?: string[]): void {
    this.twilioWs = ws;
    console.log(`[TwilioCall] Media stream connected for call ${this.callId}`);

    // Process a single message (used for both buffered and live messages)
    const processMessage = async (raw: string) => {
      try {
        const msg = JSON.parse(raw);

        switch (msg.event) {
          case "connected":
            console.log(`[TwilioCall] Stream connected`);
            break;

          case "start":
            this.streamSid = msg.start.streamSid;
            this.setState("connected");
            console.log(`[TwilioCall] Stream started, SID: ${this.streamSid}`);
            // Send opening greeting after a brief delay
            setTimeout(() => this.sendGreeting(), 500);
            break;

          case "media":
            // Incoming audio from the broker
            await this.handleIncomingAudio(msg.media.payload);
            break;

          case "stop":
            console.log(`[TwilioCall] Stream stopped`);
            this.endCall("Stream stopped");
            break;
        }
      } catch (err) {
        console.error(`[TwilioCall] Message error:`, err);
      }
    };

    // Replay any buffered messages (especially the "start" event)
    if (bufferedMessages) {
      for (const raw of bufferedMessages) {
        processMessage(raw);
      }
    }

    // Handle future messages
    ws.on("message", (data: WebSocket.Data) => {
      processMessage(data.toString());
    });

    ws.on("close", () => {
      console.log(`[TwilioCall] Media stream WebSocket closed`);
      this.endCall("WebSocket closed");
    });

    ws.on("error", (err) => {
      console.error(`[TwilioCall] WebSocket error:`, err);
    });
  }

  /**
   * Handle status callback from Twilio.
   */
  handleStatusUpdate(status: string): void {
    console.log(`[TwilioCall] Status update: ${status}`);
    switch (status) {
      case "ringing":
        this.setState("ringing");
        break;
      case "in-progress":
        this.setState("connected");
        break;
      case "completed":
      case "failed":
      case "busy":
      case "no-answer":
      case "canceled":
        this.endCall(status);
        break;
    }
  }

  /**
   * Generate and send the opening greeting via TTS.
   * Uses Claude to generate a natural, context-aware opening line.
   */
  private async sendGreeting(): Promise<void> {
    if (this.greetingSent) return;
    this.greetingSent = true;
    this.setState("negotiating");

    let greeting: string;
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system: `You are Tasha, a freight dispatcher making a phone call to a broker. Generate ONLY the opening line — 1-2 short sentences. Sound natural and casual, like a real person picking up the phone. Mention who you are, what load posting you're calling about, and ask if it's still available. Never say "on behalf of". Never use filler sounds. No quotes around the text.`,
        messages: [{
          role: "user",
          content: `Generate the opening line for a call to broker ${this.config.brokerName}. You're calling from ${this.config.driverName} transport. The load is ${this.config.loadDetails.equipmentType || "dry van"}, ${this.config.loadDetails.origin} to ${this.config.loadDetails.destination}, posted at $${this.config.loadDetails.ratePerMile}/mi. Current time: ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}.`,
        }],
      });

      const text = response.content[0];
      greeting = text.type === "text" ? text.text.trim() : "";
    } catch (err) {
      console.warn(`[TwilioCall] Greeting generation failed, using fallback:`, err);
      greeting = "";
    }

    // Fallback if AI fails or returns empty
    if (!greeting) {
      greeting = `Hey, this is Tasha calling from ${this.config.driverName} transport. I'm looking at your posting from ${this.config.loadDetails.origin} to ${this.config.loadDetails.destination} — is that one still available?`;
    }

    // Strip any quotes the model might have wrapped around it
    greeting = greeting.replace(/^["']|["']$/g, "").trim();

    this.transcript.push(`[AI] ${greeting}`);
    this.conversationHistory.push({ role: "assistant", content: greeting });

    await this.speakText(greeting);

    // Start listening for broker response
    this.startSTT();
    this.startMaxSilenceTimer();
  }

  /**
   * Start STT pipeline for transcribing broker speech.
   * Uses a continuous Pulse connection. Collects interim text and triggers
   * handleBrokerSpeech after a silence gap following speech.
   */
  private async startSTT(): Promise<void> {
    const apiKey = process.env.SMALLEST_API_KEY!;
    this.audioBuffer = [];
    this.sttConnecting = true;
    this.pendingSpeech = "";
    this.hasSpeechActivity = false;

    this.sttPipeline = new PulseSTTPipeline(apiKey, {
      onInterim: (text) => {
        // Pulse sends accumulated text in interim — track it
        this.pendingSpeech = text.trim();
        this.hasSpeechActivity = true;
        this.resetSilenceTimer();
        console.log(`[TwilioCall] STT interim: "${text.trim().substring(0, 80)}"`);
      },
      onFinal: (text) => {
        // flush() was called — this has the final text
        if (text.trim()) {
          console.log(`[TwilioCall] STT final (flush): "${text.trim()}"`);
          this.pendingSpeech = text.trim();
        }
      },
      onError: (err) => {
        console.error(`[TwilioCall] STT error:`, err);
      },
    });

    try {
      await this.sttPipeline.connect();
      this.sttConnecting = false;
      console.log(`[TwilioCall] STT connected for broker audio`);

      // Flush buffered audio
      for (const buf of this.audioBuffer) {
        this.sttPipeline.sendAudio(buf);
      }
      this.audioBuffer = [];
    } catch (err) {
      console.error(`[TwilioCall] STT connect failed:`, err);
      this.sttConnecting = false;
    }
  }

  private hasSpeechActivity = false;

  /**
   * Reset silence timer — when broker stops talking for 1.2s, collect speech and respond.
   */
  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    // Clear max silence timer — broker is talking
    if (this.maxSilenceTimer) {
      clearTimeout(this.maxSilenceTimer);
      this.maxSilenceTimer = null;
    }
    this.silenceTimer = setTimeout(async () => {
      if (this.isProcessing || this.speaking) return; // Don't process while already handling a turn
      if (!this.pendingSpeech || !this.hasSpeechActivity) return;

      const text = this.pendingSpeech.trim();
      this.pendingSpeech = "";
      this.hasSpeechActivity = false;

      // Filter out empty or meaningless STT artifacts
      if (text.length < 2) {
        console.log(`[TwilioCall] Ignoring too-short STT text: "${text}"`);
        this.startMaxSilenceTimer();
        return;
      }

      console.log(`[TwilioCall] Silence detected, processing broker speech: "${text}"`);
      await this.handleBrokerSpeech(text);
    }, 1200);
  }

  /**
   * Start a max silence timer — if broker doesn't speak for 15s, prompt them.
   * Prevents the call from hanging in silence indefinitely.
   */
  private startMaxSilenceTimer(): void {
    if (this.maxSilenceTimer) clearTimeout(this.maxSilenceTimer);
    this.maxSilenceTimer = setTimeout(async () => {
      if (this.speaking || this.isProcessing) return;
      if (this.state !== "negotiating") return;

      console.log(`[TwilioCall] Max silence reached, prompting broker`);
      // Inject a system hint so Claude prompts the broker
      this.conversationHistory.push({
        role: "user",
        content: "[silence — the broker hasn't responded for a while]",
      });

      const rawResponse = await this.streamNegotiationResponse();
      if (rawResponse) {
        const endSignal = this.parseEndSignal(rawResponse);
        const cleanResponse = this.stripEndSignal(rawResponse);
        this.transcript.push(`[AI] ${cleanResponse}`);
        this.conversationHistory.push({ role: "assistant", content: cleanResponse });

        if (endSignal) {
          this.negotiationEndSignal = endSignal;
          setTimeout(() => this.endCall("negotiation_complete"), 3000);
        }
      }
    }, 15000);
  }

  /**
   * Handle incoming mulaw audio from Twilio and forward to STT.
   * During AI speech, detect broker barge-in by monitoring audio energy.
   */
  private async handleIncomingAudio(mulawBase64: string): Promise<void> {
    const pcm16k = mulawToSTT(mulawBase64);

    // During AI speech, check for broker barge-in
    if (this.speaking) {
      // Calculate audio energy (RMS of PCM samples)
      let sumSquares = 0;
      const numSamples = Math.floor(pcm16k.length / 2);
      for (let i = 0; i < numSamples; i++) {
        const sample = pcm16k.readInt16LE(i * 2);
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / numSamples);

      // Track recent levels to detect sustained speech (not just a blip)
      this.bargeInAudioLevel.push(rms);
      if (this.bargeInAudioLevel.length > 8) this.bargeInAudioLevel.shift();

      // If we have 5+ consecutive frames above threshold, broker is talking over us
      const BARGE_IN_THRESHOLD = 800;
      const loudFrames = this.bargeInAudioLevel.filter((l) => l > BARGE_IN_THRESHOLD).length;
      if (loudFrames >= 5) {
        console.log(`[TwilioCall] Broker barge-in detected (RMS: ${Math.round(rms)}), aborting speech`);
        this.abortCurrentSpeech();
        this.bargeInAudioLevel = [];
        // Buffer this audio for STT since broker is speaking
        this.audioBuffer.push(pcm16k);
        // Start STT to capture what they're saying
        if (!this.sttPipeline && !this.sttConnecting) {
          this.startSTT();
        }
      }
      return;
    }

    if (this.sttConnecting) {
      this.audioBuffer.push(pcm16k);
      return;
    }

    if (this.sttPipeline) {
      this.sttPipeline.sendAudio(pcm16k);
    }
  }

  /**
   * Abort current AI speech — stop TTS and Claude stream.
   * Called on broker barge-in or call end.
   */
  private abortCurrentSpeech(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.speaking = false;
    // Send clear message to Twilio to stop any queued audio
    if (this.twilioWs && this.twilioWs.readyState === WebSocket.OPEN && this.streamSid) {
      this.twilioWs.send(JSON.stringify({
        event: "clear",
        streamSid: this.streamSid,
      }));
    }
  }

  /**
   * Handle transcribed broker speech — stream Claude's response and pipeline TTS.
   * Protected by isProcessing lock to prevent concurrent calls.
   */
  private async handleBrokerSpeech(text: string): Promise<void> {
    if (this.isProcessing) {
      console.log(`[TwilioCall] Already processing, queuing: "${text.substring(0, 40)}"`);
      // Append to pending so it's picked up on next silence
      this.pendingSpeech = (this.pendingSpeech ? this.pendingSpeech + " " : "") + text;
      this.hasSpeechActivity = true;
      return;
    }

    this.isProcessing = true;

    try {
      console.log(`[TwilioCall] Broker said: "${text}"`);
      this.transcript.push(`[Broker] ${text}`);
      this.conversationHistory.push({ role: "user", content: text });

      // Stop STT while we generate response
      if (this.sttPipeline) {
        this.sttPipeline.disconnect();
        this.sttPipeline = null;
      }

      // Stream Claude's response and speak chunks as they arrive
      const rawResponse = await this.streamNegotiationResponse();

      if (rawResponse) {
        // Check for AI-driven end signal before recording in history
        const endSignal = this.parseEndSignal(rawResponse);
        const cleanResponse = this.stripEndSignal(rawResponse);

        console.log(`[TwilioCall] AI responded: "${cleanResponse}"${endSignal ? ` [END: ${endSignal.agreed ? "agreed" : "declined"}${endSignal.ratePerMile ? ` @ $${endSignal.ratePerMile}/mi` : ""}]` : ""}`);
        this.transcript.push(`[AI] ${cleanResponse}`);
        // Store clean version in history (without signal tags)
        this.conversationHistory.push({ role: "assistant", content: cleanResponse });

        // If Claude signaled the call is over, end it
        if (endSignal) {
          this.negotiationEndSignal = endSignal;
          setTimeout(() => this.endCall("negotiation_complete"), 3000);
          return;
        }
      }

      // Resume listening
      if (this.state === "negotiating") {
        this.startSTT();
        this.startMaxSilenceTimer();
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Build the negotiation system prompt.
   */
  private buildNegotiationPrompt(): string {
    const { config } = this;
    const styleGuide = {
      firm: "Be direct and firm. Don't concede easily. Reference market data to justify your rate.",
      moderate: "Be professional and open to reasonable compromise. Meet in the middle when possible.",
      flexible: "Be accommodating but still aim for a fair rate. Prioritize getting the load booked.",
    };

    return `You are Tasha, a freight dispatcher calling a broker about a load. You're a real person who does this 50 times a day. This is a normal phone call — talk like a human, not a bot.

YOUR VOICE:
- 1-2 short sentences max per response. Phone calls are fast back-and-forth.
- Start responses with natural reactions: "yeah", "so", "okay", "right", "gotcha", "oh okay"
- Use casual phrasing: "gonna", "wanna", "kinda"
- Sound confident but friendly — you know the market, you're not desperate
- NEVER sound scripted. NEVER use formal phrases like "I appreciate your time" or "on behalf of"
- NEVER use filler sounds like "um", "uh", "hmm" — those sound bad on phone systems. Instead just start talking.

RATES — HOW TO SAY THEM:
- Always write rates as numbers with a dollar sign: "$3.80 per mile" not "three eighty"
- This is critical for the phone system to pronounce correctly
- Examples: "$3.75 per mile", "$4.00 per mile", "$1,925 total"

EXAMPLES — GOOD vs BAD:
BAD: "The current market rate for this lane is approximately three dollars and eighty cents per mile."
GOOD: "Yeah so we're seeing about $3.80 per mile on this lane right now."

BAD: "I would like to counteroffer at three dollars and seventy-five cents per mile."
GOOD: "Could you do $3.75 per mile? That'd work for us."

BAD: "Thank you for your time, I appreciate the opportunity to discuss this load."
GOOD: "Alright sounds good. Just send over the rate con when you get a chance. Thanks!"

LOAD INFO:
- Route: ${config.loadDetails.origin} to ${config.loadDetails.destination}
- Distance: ${config.loadDetails.distance} miles
- Equipment: ${config.loadDetails.equipmentType || "Dry Van"}
- Pickup: ${config.loadDetails.pickupDate}
- Posted rate: $${config.loadDetails.rate} total ($${config.loadDetails.ratePerMile} per mile)
${config.loadDetails.weight ? `- Weight: ${config.loadDetails.weight} lbs` : ""}
${config.loadDetails.commodity ? `- Commodity: ${config.loadDetails.commodity}` : ""}

NEGOTIATION:
- You want: $${config.targetRate} per mile. Don't go below $${config.minimumRate} per mile.
- Your driver: ${config.driverName}, MC number ${config.driverMC}
- Style: ${config.negotiationStyle} — ${styleGuide[config.negotiationStyle]}
- If they offer above your target, take it: "Yeah that works, let's do it."
- If between your min and target, push once then accept: "Can you come up a little? ... Okay, we can make that work."
- If they won't meet your minimum, walk away: "Yeah I don't think we can make that work. Thanks though."
- When agreed, confirm rate and pickup, ask for rate con.

CALL ENDING — CRITICAL:
When you decide the negotiation is finished (deal agreed, deal declined, or broker ends call), you MUST append a signal tag at the very end of your response. This tag is NOT spoken — it's stripped before audio.

- If deal agreed: end your message with <<END:agreed:RATE>> where RATE is the per-mile rate (e.g. <<END:agreed:3.75>>)
- If deal declined or no agreement: end with <<END:declined>>
- If the conversation is still ongoing, do NOT include any tag.

Examples:
"Yeah that works, let's do it. Just send the rate con over. Thanks! <<END:agreed:3.80>>"
"Yeah I don't think we can make that work. Thanks though. <<END:declined>>"
"Could you do $3.75 per mile? That'd work for us."  (no tag — still negotiating)`;
  }

  /**
   * Stream Claude's negotiation response, feeding sentences to TTS as they arrive.
   * This is the main latency optimization — we start speaking before Claude finishes generating.
   */
  private async streamNegotiationResponse(): Promise<string | null> {
    const systemPrompt = this.buildNegotiationPrompt();
    const models = ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"];

    for (const model of models) {
      try {
        const fullText = await this.streamAndSpeak(model, systemPrompt);
        if (fullText !== null) {
          if (model !== models[0]) {
            console.log(`[TwilioCall] Used fallback model: ${model}`);
          }
          return fullText;
        }
      } catch (err: any) {
        const isRateLimit = err?.status === 429 || err?.error?.error?.type === "rate_limit_error";
        if (isRateLimit && model !== models[models.length - 1]) {
          console.warn(`[TwilioCall] Rate limited on ${model}, falling back to next model...`);
          continue;
        }
        console.error(`[TwilioCall] Claude error (${model}):`, err);
      }
    }

    return null;
  }

  /**
   * Stream Claude response and speak sentences as they complete.
   * Feeds text to TTS sentence-by-sentence while Claude is still generating.
   * Uses AbortController so barge-in or call-end can stop mid-stream.
   */
  private async streamAndSpeak(model: string, systemPrompt: string): Promise<string | null> {
    this.speaking = true;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    let fullText = "";
    let sentenceBuffer = "";
    const ttsQueue: Promise<void>[] = [];

    try {
      const stream = this.anthropic.messages.stream({
        model,
        max_tokens: 200,
        system: systemPrompt,
        messages: this.conversationHistory.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      // Sentence boundary regex — split on . ! ? followed by space (not commas — too aggressive for short responses)
      const sentenceEndRegex = /[.!?]\s/;

      stream.on("text", (textDelta) => {
        if (signal.aborted) return;
        fullText += textDelta;
        sentenceBuffer += textDelta;

        const match = sentenceBuffer.match(sentenceEndRegex);
        if (match && match.index !== undefined) {
          const splitAt = match.index + 1;
          const sentence = sentenceBuffer.substring(0, splitAt).trim();
          sentenceBuffer = sentenceBuffer.substring(splitAt).trim();

          // Strip any signal tags before sending to TTS
          const cleanSentence = this.stripEndSignal(sentence);
          if (cleanSentence && !signal.aborted) {
            console.log(`[TwilioCall] Streaming sentence to TTS: "${cleanSentence}"`);
            const prev = ttsQueue[ttsQueue.length - 1] || Promise.resolve();
            ttsQueue.push(prev.then(() => {
              if (signal.aborted) return;
              return this.speakChunk(cleanSentence);
            }));
          }
        }
      });

      // Wait for Claude to finish (or abort)
      await stream.finalMessage();

      // Speak any remaining text (strip end signal tag before TTS)
      const remainingText = this.stripEndSignal(sentenceBuffer).trim();
      if (remainingText && !signal.aborted) {
        const prev = ttsQueue[ttsQueue.length - 1] || Promise.resolve();
        ttsQueue.push(prev.then(() => {
          if (signal.aborted) return;
          return this.speakChunk(remainingText);
        }));
      }

      // Wait for all TTS to finish
      await Promise.all(ttsQueue);
    } catch (err: any) {
      // Re-throw rate limit errors for model fallback
      const isRateLimit = err?.status === 429 || err?.error?.error?.type === "rate_limit_error";
      if (isRateLimit) throw err;

      if (!signal.aborted) {
        console.error(`[TwilioCall] Stream error:`, err);
      }
    } finally {
      this.speaking = false;
      this.abortController = null;
    }

    return fullText || null;
  }

  /**
   * Parse the <<END:...>> signal tag from Claude's response.
   * Returns the tag data if found, or null if the conversation is still ongoing.
   * The tag is stripped from the response text before TTS.
   */
  private parseEndSignal(response: string): { agreed: boolean; ratePerMile?: number } | null {
    const match = response.match(/<<END:(agreed|declined)(?::(\d+(?:\.\d+)?))?>>$/);
    if (!match) return null;

    const agreed = match[1] === "agreed";
    const ratePerMile = match[2] ? parseFloat(match[2]) : undefined;
    return { agreed, ratePerMile };
  }

  /**
   * Strip the <<END:...>> signal tag from response text so it's not spoken aloud.
   */
  private stripEndSignal(response: string): string {
    return response.replace(/\s*<<END:[^>]+>>\s*$/, "").trim();
  }

  /**
   * Synthesize text and send as mulaw audio to Twilio.
   * Used for the greeting (sets speaking flag). For streamed responses, use speakChunk().
   */
  private async speakText(text: string): Promise<void> {
    if (!this.twilioWs || this.twilioWs.readyState !== WebSocket.OPEN) return;

    this.speaking = true;
    console.log(`[TwilioCall] Speaking: "${text.substring(0, 80)}..."`);

    try {
      const chunks = this.chunkText(text, 120);
      for (const chunk of chunks) {
        await this.speakChunk(chunk);
      }
    } catch (err) {
      console.error(`[TwilioCall] TTS/send error:`, err);
    }

    this.speaking = false;
  }

  /**
   * Synthesize and send a single text chunk as mulaw audio to Twilio.
   * Called by both speakText (greeting) and streamAndSpeak (streamed response).
   */
  private async speakChunk(text: string): Promise<void> {
    if (!this.twilioWs || this.twilioWs.readyState !== WebSocket.OPEN) return;

    const apiKey = process.env.SMALLEST_API_KEY!;

    try {
      // Split into sub-chunks if over 120 chars (Waves limit)
      const subChunks = text.length > 120 ? this.chunkText(text, 120) : [text];

      for (const chunk of subChunks) {
        console.log(`[TwilioCall] TTS chunk: "${chunk}"`);
        const pcm24k = await synthesizeSpeech(apiKey, {
          text: chunk,
          voiceId: "sophia",
          sampleRate: 24000,
          speed: 1.0,
          addWavHeader: false,
        });

        const mulawBase64 = ttsToMulaw(pcm24k);
        const mulawBuf = Buffer.from(mulawBase64, "base64");
        const chunkSize = 160;

        for (let i = 0; i < mulawBuf.length; i += chunkSize) {
          const audioChunk = mulawBuf.subarray(i, Math.min(i + chunkSize, mulawBuf.length));

          if (this.twilioWs && this.twilioWs.readyState === WebSocket.OPEN && this.streamSid) {
            this.twilioWs.send(JSON.stringify({
              event: "media",
              streamSid: this.streamSid,
              media: {
                payload: audioChunk.toString("base64"),
              },
            }));
          }

          await new Promise((resolve) => setTimeout(resolve, 18));
        }
      }
    } catch (err) {
      console.error(`[TwilioCall] TTS chunk error:`, err);
    }
  }

  private chunkText(text: string, maxLen: number): string[] {
    const sentences = text.match(/[^.!?,;]+[.!?,;]+|[^.!?,;]+$/g) || [text];
    const chunks: string[] = [];
    let current = "";

    for (const s of sentences) {
      if ((current + s).length > maxLen) {
        if (current) chunks.push(current.trim());
        if (s.length > maxLen) {
          const words = s.split(/\s+/);
          let wordChunk = "";
          for (const w of words) {
            if ((wordChunk + " " + w).length > maxLen) {
              if (wordChunk) chunks.push(wordChunk.trim());
              wordChunk = w;
            } else {
              wordChunk += (wordChunk ? " " : "") + w;
            }
          }
          current = wordChunk;
        } else {
          current = s;
        }
      } else {
        current += s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  /**
   * End the call and compute result.
   */
  private endCall(reason: string): void {
    if (this.state === "completed" || this.state === "failed") return;

    this.endTime = Date.now();
    const duration = Math.floor((this.endTime - this.startTime) / 1000);

    console.log(`[TwilioCall] Call ended: ${reason}, duration: ${duration}s`);

    // Clean up
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.maxSilenceTimer) clearTimeout(this.maxSilenceTimer);
    this.abortCurrentSpeech();
    if (this.sttPipeline) {
      this.sttPipeline.disconnect();
      this.sttPipeline = null;
    }

    // Parse negotiation result from transcript
    this.result = this.parseNegotiationResult(duration);
    this.setState(reason === "failed" || reason === "no-answer" || reason === "busy" ? "failed" : "completed");

    // Notify completion callback (voice session will use this to report back to driver)
    if (this.onCallComplete && this.result) {
      try {
        this.onCallComplete(this.result);
      } catch (err) {
        console.error(`[TwilioCall] Completion callback error:`, err);
      }
    }

    // Try to hang up via Twilio API
    if (this.callSid) {
      try {
        const client = Twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
        client.calls(this.callSid).update({ status: "completed" }).catch(() => {});
      } catch {
        // ignore
      }
    }

    // Clean up session after a delay
    setTimeout(() => {
      if (this.callSid) activeSessions.delete(this.callSid);
      activeSessions.delete(this.callId);
    }, 300000); // Keep for 5 minutes for status queries
  }

  /**
   * Build negotiation result using the AI-determined signal.
   * If no signal was received (e.g. call dropped), fall back to AI transcript analysis.
   */
  private parseNegotiationResult(duration: number): NegotiationResult {
    // Use the AI-determined signal if available
    if (this.negotiationEndSignal) {
      const { agreed, ratePerMile } = this.negotiationEndSignal;
      return {
        agreed,
        negotiatedRate: ratePerMile
          ? Math.round(ratePerMile * this.config.loadDetails.distance)
          : undefined,
        negotiatedRatePerMile: ratePerMile,
        transcript: this.transcript,
        callDuration: duration,
        notes: agreed
          ? `Negotiation successful. ${this.config.brokerName} agreed to $${ratePerMile?.toFixed(2)}/mi. Rate confirmation pending.`
          : `Negotiation did not reach agreement. Consider adjusting rate or trying another broker.`,
      };
    }

    // Fallback: no signal (call dropped, stream error, etc.)
    // Fire an async AI analysis — for now return a best-effort result.
    // The async analysis will update this.result when it completes.
    const result: NegotiationResult = {
      agreed: false,
      transcript: this.transcript,
      callDuration: duration,
      notes: "Call ended without clear negotiation outcome. Transcript analysis pending.",
    };

    // Async AI analysis of the transcript (non-blocking)
    this.analyzeTranscriptWithAI(duration).then((analyzed) => {
      if (analyzed) {
        Object.assign(result, analyzed);
        this.result = result;
        console.log(`[TwilioCall] AI transcript analysis complete: agreed=${analyzed.agreed}, rate=$${analyzed.negotiatedRatePerMile}/mi`);
      }
    }).catch((err) => {
      console.error(`[TwilioCall] AI transcript analysis failed:`, err);
    });

    return result;
  }

  /**
   * Use Claude to analyze the full transcript and determine the outcome.
   * Called as a fallback when no <<END:...>> signal was received (e.g. call dropped).
   */
  private async analyzeTranscriptWithAI(duration: number): Promise<Partial<NegotiationResult> | null> {
    if (this.transcript.length < 2) return null;

    try {
      const response = await this.anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: "You analyze freight broker call transcripts. Respond with ONLY a JSON object, no other text.",
        messages: [{
          role: "user",
          content: `Analyze this broker negotiation transcript and determine the outcome.

Transcript:
${this.transcript.join("\n")}

Respond with JSON:
{"agreed": true/false, "ratePerMile": number_or_null, "notes": "brief summary of what happened"}`,
        }],
      });

      const text = response.content[0];
      if (text.type !== "text") return null;

      const parsed = JSON.parse(text.text);
      return {
        agreed: parsed.agreed === true,
        negotiatedRatePerMile: parsed.ratePerMile || undefined,
        negotiatedRate: parsed.ratePerMile
          ? Math.round(parsed.ratePerMile * this.config.loadDetails.distance)
          : undefined,
        notes: parsed.notes || "",
      };
    } catch (err) {
      console.error(`[TwilioCall] Transcript analysis error:`, err);
      return null;
    }
  }

  private setState(state: CallState): void {
    this.state = state;
    console.log(`[TwilioCall] State: ${state}`);
  }
}
