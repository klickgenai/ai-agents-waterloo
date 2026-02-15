import { synthesizeSpeech } from "./tts-synthesize.js";

export type FillerCategory = "general" | "load" | "hos" | "fuel" | "parking" | "broker" | "invoice" | "route";

interface FillerPhrase {
  text: string;
  category: FillerCategory;
  audio: Buffer | null;
}

const FILLER_PHRASES: Array<{ text: string; category: FillerCategory }> = [
  // General
  { text: "Alright, let me check that.", category: "general" },
  { text: "Hold on one second.", category: "general" },
  { text: "Yeah, give me just a moment.", category: "general" },
  { text: "Okay, let me see here.", category: "general" },
  { text: "Alright, hang on.", category: "general" },

  // Load search
  { text: "Let me pull up some loads.", category: "load" },
  { text: "Okay, checking the boards now.", category: "load" },
  { text: "Alright, let me see what's out there.", category: "load" },
  { text: "Yeah, let me check the load boards.", category: "load" },

  // HOS
  { text: "Let me pull up your hours.", category: "hos" },
  { text: "Okay, checking your log.", category: "hos" },
  { text: "Let me see where you're at on hours.", category: "hos" },
  { text: "Yeah, let me check your clock.", category: "hos" },

  // Fuel
  { text: "Let me find you some cheap diesel.", category: "fuel" },
  { text: "Checking fuel prices nearby.", category: "fuel" },
  { text: "Okay, let me see what's around you.", category: "fuel" },
  { text: "Yeah, let me check the fuel stops.", category: "fuel" },

  // Parking
  { text: "Let me see what's available.", category: "parking" },
  { text: "Checking truck stops near you.", category: "parking" },
  { text: "Okay, let me find you a spot.", category: "parking" },
  { text: "Yeah, let me check parking.", category: "parking" },

  // Broker
  { text: "Alright, let me get them on the line.", category: "broker" },
  { text: "Okay, reaching out to the broker.", category: "broker" },
  { text: "Yeah, let me call them up.", category: "broker" },
  { text: "Alright, let me ring them.", category: "broker" },

  // Invoice / Paperwork
  { text: "Okay, let me pull that up.", category: "invoice" },
  { text: "Yeah, let me get that together.", category: "invoice" },
  { text: "Alright, working on that now.", category: "invoice" },

  // Route planning
  { text: "Let me map that out.", category: "route" },
  { text: "Yeah, let me check the route.", category: "route" },
];

// Map tool names to filler categories
const TOOL_CATEGORY_MAP: Record<string, FillerCategory> = {
  searchLoads: "load",
  calculateProfitability: "load",
  getHOSStatus: "hos",
  planBreaks: "hos",
  alertHOSViolation: "hos",
  searchFuelPrices: "fuel",
  calculateRouteFuel: "route",
  searchParking: "parking",
  reserveSpot: "parking",
  generateInvoice: "invoice",
  sendInvoice: "invoice",
  generateBOL: "invoice",
  trackIFTA: "invoice",
  initiateBrokerCall: "broker",
  getBrokerCallStatus: "broker",
  confirmLoad: "load",
};

class FillerCache {
  private fillers: FillerPhrase[] = [];
  private ready = false;
  private lastUsedIndex: Map<FillerCategory, number> = new Map();

  async initialize(): Promise<void> {
    const apiKey = process.env.SMALLEST_API_KEY;
    if (!apiKey) {
      console.warn("[FillerCache] No SMALLEST_API_KEY — fillers will be text-only");
      this.fillers = FILLER_PHRASES.map((p) => ({ ...p, audio: null }));
      this.ready = true;
      return;
    }

    console.log(`[FillerCache] Pre-generating ${FILLER_PHRASES.length} filler phrases...`);
    const startTime = Date.now();

    // Generate fillers in small batches to avoid rate limits
    const BATCH_SIZE = 3;
    for (let i = 0; i < FILLER_PHRASES.length; i += BATCH_SIZE) {
      const batch = FILLER_PHRASES.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (phrase) => {
          const buffer = await synthesizeSpeech(apiKey, {
            text: phrase.text,
            voiceId: "sophia",
            sampleRate: 24000,
            speed: 1.0,
            addWavHeader: true,
          });
          return { ...phrase, audio: buffer };
        })
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        const phrase = batch[j];
        if (r.status === "fulfilled") {
          this.fillers.push(r.value);
        } else {
          console.warn(`[FillerCache] Failed: "${phrase.text}"`);
          this.fillers.push({ ...phrase, audio: null });
        }
      }

      // Small delay between batches
      if (i + BATCH_SIZE < FILLER_PHRASES.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    const successCount = this.fillers.filter((f) => f.audio !== null).length;
    console.log(
      `[FillerCache] Ready: ${successCount}/${FILLER_PHRASES.length} cached in ${Date.now() - startTime}ms`
    );
    this.ready = true;
  }

  getSmartFiller(toolName?: string): { text: string; audio: Buffer | null } | null {
    if (!this.ready || this.fillers.length === 0) return null;

    const category: FillerCategory = toolName
      ? TOOL_CATEGORY_MAP[toolName] || "general"
      : "general";

    // Get fillers for the category
    const categoryFillers = this.fillers.filter((f) => f.category === category);
    if (categoryFillers.length === 0) {
      // Fallback to general
      const generalFillers = this.fillers.filter((f) => f.category === "general");
      if (generalFillers.length === 0) return null;
      return this.pickRoundRobin(generalFillers, "general");
    }

    return this.pickRoundRobin(categoryFillers, category);
  }

  private pickRoundRobin(
    fillers: FillerPhrase[],
    category: FillerCategory
  ): { text: string; audio: Buffer | null } {
    const lastIndex = this.lastUsedIndex.get(category) ?? -1;
    const nextIndex = (lastIndex + 1) % fillers.length;
    this.lastUsedIndex.set(category, nextIndex);
    const filler = fillers[nextIndex];
    return { text: filler.text, audio: filler.audio };
  }

  isReady(): boolean {
    return this.ready;
  }
}

export const fillerCache = new FillerCache();
