import { TTSWebSocket, type TTSStreamCallbacks } from "./tts-synthesize.js";

export interface TTSCallbacks {
  onAudioChunk: (wavBuffer: Buffer, sentenceText: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

// Sentence boundary regex: split on . ! ? followed by space or end
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;
const MIN_SENTENCE_LENGTH = 12;

// Batch N PCM chunks from Waves into one WAV before sending to browser.
// Each Waves chunk = 7680 bytes = ~160ms at 24kHz 16-bit mono.
// Batch of 3 = ~480ms — good balance between latency and smooth playback.
// First batch uses 1 chunk for lowest initial latency.
const FIRST_BATCH_SIZE = 1;   // Send first chunk ASAP (~160ms)
const BATCH_SIZE = 3;         // Subsequent batches (~480ms each)

/**
 * TTS pipeline that buffers Claude streaming text, splits into sentences,
 * and streams audio chunks to the browser in real-time via Waves TTS WebSocket.
 *
 * Key optimization: audio chunks are forwarded to the browser as they arrive
 * from Waves, instead of waiting for the entire sentence to be synthesized.
 */
export class TTSSentencePipeline {
  private apiKey: string;
  private callbacks: TTSCallbacks;
  private voiceId: string;
  private aborted = false;
  private textBuffer = "";
  private sentenceQueue: string[] = [];
  private processing = false;
  private finishing = false;
  private ttsWs: TTSWebSocket | null = null;
  private ownsWebSocket: boolean;

  constructor(
    apiKey: string,
    callbacks: TTSCallbacks,
    voiceId = "sophia",
    sharedTtsWs?: TTSWebSocket
  ) {
    this.apiKey = apiKey;
    this.callbacks = callbacks;
    this.voiceId = voiceId;
    if (sharedTtsWs) {
      this.ttsWs = sharedTtsWs;
      this.ownsWebSocket = false;
    } else {
      this.ownsWebSocket = true;
    }
  }

  /** Feed streaming text from Claude. Buffers until complete sentences detected. */
  feedText(text: string): void {
    if (this.aborted) return;
    this.textBuffer += text;
    this.extractSentences();
  }

  /** Signal that Claude is done generating. Flush remaining text. */
  finish(): void {
    if (this.aborted) return;
    const remaining = this.textBuffer.trim();
    if (remaining) {
      this.sentenceQueue.push(remaining);
      this.textBuffer = "";
    }
    if (this.processing) {
      this.finishing = true;
    } else {
      this.processQueue(true);
    }
  }

  abort(): void {
    this.aborted = true;
    this.textBuffer = "";
    this.sentenceQueue = [];
    if (this.ownsWebSocket && this.ttsWs) {
      this.ttsWs.disconnect();
      this.ttsWs = null;
    }
  }

  private extractSentences(): void {
    const parts = this.textBuffer.split(SENTENCE_BOUNDARY);

    if (parts.length > 1) {
      for (let i = 0; i < parts.length - 1; i++) {
        const sentence = parts[i].trim();
        if (sentence.length >= MIN_SENTENCE_LENGTH) {
          this.sentenceQueue.push(sentence);
        } else if (sentence) {
          parts[i + 1] = sentence + " " + parts[i + 1];
        }
      }
      this.textBuffer = parts[parts.length - 1];
    }

    if (this.sentenceQueue.length > 0 && !this.processing) {
      this.processQueue(false);
    }
  }

  /** Lazily create and connect the TTS WebSocket */
  private async ensureConnected(): Promise<void> {
    if (!this.ttsWs) {
      const noopCallbacks: TTSStreamCallbacks = {
        onAudioChunk: () => {},
        onRequestComplete: () => {},
        onError: (err) => this.callbacks.onError(err),
      };
      this.ttsWs = new TTSWebSocket(this.apiKey, noopCallbacks, {
        voiceId: this.voiceId,
        sampleRate: 24000,
        speed: 1.0,
      });
    }
    await this.ttsWs.connect();
  }

  private async processQueue(isFinal: boolean): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.sentenceQueue.length > 0 && !this.aborted) {
      const sentence = this.sentenceQueue.shift()!;
      try {
        await this.synthesizeSentenceStreaming(sentence);
      } catch (err) {
        if (!this.aborted) {
          this.callbacks.onError(err as Error);
        }
      }
    }

    this.processing = false;

    if (this.sentenceQueue.length > 0 && !this.aborted) {
      return this.processQueue(isFinal || this.finishing);
    }

    if ((isFinal || this.finishing) && !this.aborted) {
      this.finishing = false;
      if (this.ownsWebSocket && this.ttsWs) {
        this.ttsWs.disconnect();
        this.ttsWs = null;
      }
      this.callbacks.onDone();
    }
  }

  /**
   * Stream-synthesize a sentence: send text to Waves, forward audio chunks
   * to the browser as they arrive (batched for smooth playback).
   */
  private async synthesizeSentenceStreaming(text: string): Promise<void> {
    const chunks = this.chunkText(text, 120);

    await this.ensureConnected();

    for (const chunk of chunks) {
      if (this.aborted) return;

      await new Promise<void>((resolve, reject) => {
        const pcmBatch: Buffer[] = [];
        let isFirstBatch = true;
        const batchTarget = () => isFirstBatch ? FIRST_BATCH_SIZE : BATCH_SIZE;

        const origChunkCb = this.ttsWs!["callbacks"].onAudioChunk;
        const origCompleteCb = this.ttsWs!["callbacks"].onRequestComplete;
        const origErrorCb = this.ttsWs!["callbacks"].onError;

        const flushBatch = () => {
          if (pcmBatch.length === 0 || this.aborted) return;
          const combined = Buffer.concat(pcmBatch);
          pcmBatch.length = 0;
          const wav = this.addWavHeader(combined, 24000, 16, 1);
          this.callbacks.onAudioChunk(wav, text);
          isFirstBatch = false;
        };

        const restore = () => {
          this.ttsWs!["callbacks"].onAudioChunk = origChunkCb;
          this.ttsWs!["callbacks"].onRequestComplete = origCompleteCb;
          this.ttsWs!["callbacks"].onError = origErrorCb;
        };

        this.ttsWs!["callbacks"].onAudioChunk = (pcm: Buffer) => {
          if (this.aborted) { restore(); return; }
          pcmBatch.push(pcm);
          if (pcmBatch.length >= batchTarget()) {
            flushBatch();
          }
        };

        this.ttsWs!["callbacks"].onRequestComplete = () => {
          flushBatch(); // Flush remaining chunks
          restore();
          resolve();
        };

        this.ttsWs!["callbacks"].onError = (err: Error) => {
          restore();
          reject(err);
        };

        this.ttsWs!.synthesize(chunk);
      });
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

  private addWavHeader(pcm: Buffer, sampleRate: number, bitsPerSample: number, channels: number): Buffer {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcm.length;
    const headerSize = 44;
    const header = Buffer.alloc(headerSize);

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);

    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
  }
}
