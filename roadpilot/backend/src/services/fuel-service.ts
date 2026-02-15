/**
 * Real diesel price service using EIA (Energy Information Administration) API.
 * Fetches weekly retail diesel prices by PADD region.
 * Caches for 1 hour since prices update weekly.
 */

import {
  DIESEL_PRICES_BY_REGION,
  type DieselRegionPricing,
} from "../data/seed-data.js";

interface EIAPriceData {
  region: string;
  paddDistrict: string;
  pricePerGallon: number;
  date: string;
}

let priceCache: EIAPriceData[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// EIA series IDs for weekly retail diesel prices by PADD region
const EIA_SERIES: Record<string, { seriesId: string; region: string; padd: string }> = {
  US: { seriesId: "PET.EMD_EPD2D_PTE_NUS_DPG.W", region: "US Average", padd: "US" },
  PADD1: { seriesId: "PET.EMD_EPD2D_PTE_R10_DPG.W", region: "East Coast", padd: "PADD 1" },
  PADD2: { seriesId: "PET.EMD_EPD2D_PTE_R20_DPG.W", region: "Midwest", padd: "PADD 2" },
  PADD3: { seriesId: "PET.EMD_EPD2D_PTE_R30_DPG.W", region: "Gulf Coast", padd: "PADD 3" },
  PADD4: { seriesId: "PET.EMD_EPD2D_PTE_R40_DPG.W", region: "Rocky Mountain", padd: "PADD 4" },
  PADD5: { seriesId: "PET.EMD_EPD2D_PTE_R50_DPG.W", region: "West Coast", padd: "PADD 5" },
};

// Map states to PADD regions for lookup
const STATE_TO_PADD: Record<string, string> = {};
for (const region of DIESEL_PRICES_BY_REGION) {
  for (const state of region.states) {
    STATE_TO_PADD[state] = region.paddDistrict;
  }
}
// Add extra states not in seed data
Object.assign(STATE_TO_PADD, {
  CO: "PADD 4",
  WY: "PADD 4",
  MT: "PADD 4",
  ID: "PADD 4",
  UT: "PADD 4",
  HI: "PADD 5",
  AK: "PADD 5",
  // Canadian provinces get US avg as fallback
  ON: "US",
  QC: "US",
  BC: "PADD 5",
  AB: "PADD 4",
});

/**
 * Fetch real diesel prices from EIA API.
 * Returns prices by PADD region with 1-hour caching.
 */
export async function getDieselPrices(): Promise<EIAPriceData[]> {
  const now = Date.now();
  if (priceCache && now - cacheTimestamp < CACHE_TTL_MS) {
    return priceCache;
  }

  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    console.warn("[fuel-service] No EIA_API_KEY, using seed data fallback");
    return getFallbackPrices();
  }

  try {
    const results: EIAPriceData[] = [];

    // Fetch all regions in parallel
    const fetches = Object.entries(EIA_SERIES).map(async ([key, info]) => {
      const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${apiKey}&frequency=weekly&data[0]=value&facets[series][]=${info.seriesId}&sort[0][column]=period&sort[0][direction]=desc&length=1`;

      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[fuel-service] EIA returned ${res.status} for ${key}`);
        return null;
      }

      const data = (await res.json()) as {
        response?: { data?: Array<{ value: number; period: string }> };
      };

      const entry = data?.response?.data?.[0];
      if (entry?.value) {
        return {
          region: info.region,
          paddDistrict: info.padd,
          pricePerGallon: entry.value,
          date: entry.period,
        };
      }
      return null;
    });

    const settled = await Promise.all(fetches);
    for (const item of settled) {
      if (item) results.push(item);
    }

    if (results.length > 0) {
      priceCache = results;
      cacheTimestamp = now;
      console.log(`[fuel-service] Fetched ${results.length} EIA price regions`);
      return results;
    }

    return getFallbackPrices();
  } catch (err) {
    console.error("[fuel-service] EIA fetch failed:", err);
    return getFallbackPrices();
  }
}

/**
 * Get diesel price for a specific state.
 */
export async function getDieselPriceForState(state: string): Promise<number> {
  const prices = await getDieselPrices();
  const padd = STATE_TO_PADD[state] || "US";
  const match = prices.find((p) => p.paddDistrict === padd);
  if (match) return match.pricePerGallon;

  const usAvg = prices.find((p) => p.paddDistrict === "US");
  return usAvg?.pricePerGallon ?? 3.50;
}

/**
 * Fallback prices from seed data when EIA API is unavailable.
 */
function getFallbackPrices(): EIAPriceData[] {
  return DIESEL_PRICES_BY_REGION.map((r) => ({
    region: r.region,
    paddDistrict: r.paddDistrict,
    pricePerGallon: r.avgPricePerGallon,
    date: new Date().toISOString().split("T")[0],
  }));
}
