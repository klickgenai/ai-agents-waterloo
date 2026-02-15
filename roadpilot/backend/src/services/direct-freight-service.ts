/**
 * Direct Freight API integration for real-time load board data.
 * API: https://api.directfreight.com/v1/boards/loads
 *
 * When DIRECT_FREIGHT_API_KEY is set, this fetches real loads.
 * Otherwise returns null so the caller can fall back to seed data.
 */

import type { LoadResult } from "../tools/load-search.js";

const DIRECT_FREIGHT_BASE = "https://api.directfreight.com/v1";

// Map our equipment types to Direct Freight trailer types
const EQUIP_TO_DF: Record<string, string[]> = {
  dry_van: ["V"],
  reefer: ["R"],
  flatbed: ["F"],
  step_deck: ["SD"],
  any: ["V", "R", "F", "SD", "PO"],
};

// Map Direct Freight trailer types back to our schema
const DF_TO_EQUIP: Record<string, LoadResult["equipmentType"]> = {
  V: "dry_van",
  R: "reefer",
  F: "flatbed",
  SD: "step_deck",
  PO: "other",
};

// US state name to abbreviation map for normalizing API responses
const STATE_ABBREVS: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY",
};

function normalizeState(input: string): string {
  if (input.length === 2) return input.toUpperCase();
  return STATE_ABBREVS[input.toLowerCase()] || input.toUpperCase();
}

interface DirectFreightSearchParams {
  originCity: string;
  originState?: string;
  destinationCity: string;
  destinationState?: string;
  equipmentType?: string;
  maxResults?: number;
}

interface DirectFreightLoad {
  load_id?: string;
  origin_city?: string;
  origin_state?: string;
  origin_zip?: string;
  destination_city?: string;
  destination_state?: string;
  destination_zip?: string;
  rate?: number;
  rate_per_mile?: number;
  distance?: number;
  weight?: number;
  trailer_type?: string;
  commodity?: string;
  pickup_date?: string;
  delivery_date?: string;
  broker_name?: string;
  broker_phone?: string;
  broker_email?: string;
  broker_mc?: string;
  posted_at?: string;
  requirements?: string[];
  hazmat?: boolean;
  [key: string]: unknown;
}

/**
 * Search Direct Freight load board for available loads.
 * Returns null if no API key is configured or if the request fails.
 */
export async function searchDirectFreight(
  params: DirectFreightSearchParams
): Promise<LoadResult[] | null> {
  const apiKey = process.env.DIRECT_FREIGHT_API_KEY;
  if (!apiKey) return null;

  const originState = params.originState ? normalizeState(params.originState) : undefined;
  const destState = params.destinationState ? normalizeState(params.destinationState) : undefined;

  const trailerTypes = params.equipmentType && params.equipmentType !== "any"
    ? EQUIP_TO_DF[params.equipmentType] || ["V"]
    : ["V", "R", "F"];

  const body: Record<string, unknown> = {
    origin_city: params.originCity,
    destination_city: params.destinationCity,
    origin_radius: 50,
    destination_radius: 50,
    trailer_type: trailerTypes,
    page_number: 1,
    item_count: params.maxResults || 10,
  };

  if (originState) body.origin_state = [originState];
  if (destState) body.destination_state = [destState];

  try {
    console.log(`[DirectFreight] Searching: ${params.originCity} → ${params.destinationCity}`);

    const response = await fetch(`${DIRECT_FREIGHT_BASE}/boards/loads`, {
      method: "POST",
      headers: {
        "api-token": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.warn(`[DirectFreight] API error (${response.status}): ${errorText}`);
      return null;
    }

    const data = await response.json() as { loads?: DirectFreightLoad[]; data?: DirectFreightLoad[]; results?: DirectFreightLoad[] };

    // The API response structure may vary — try common shapes
    const rawLoads: DirectFreightLoad[] = data.loads || data.data || data.results || [];

    if (rawLoads.length === 0) {
      console.log("[DirectFreight] No loads found for this route");
      return null;
    }

    console.log(`[DirectFreight] Found ${rawLoads.length} loads`);

    return rawLoads.map((load) => mapDirectFreightLoad(load)).filter(Boolean) as LoadResult[];
  } catch (err) {
    console.warn("[DirectFreight] Search failed:", (err as Error).message);
    return null;
  }
}

function mapDirectFreightLoad(raw: DirectFreightLoad): LoadResult | null {
  const distance = raw.distance || 0;
  const ratePerMile = raw.rate_per_mile || (raw.rate && distance ? raw.rate / distance : 0);
  const rate = raw.rate || Math.round(ratePerMile * distance);

  if (!raw.origin_city || !raw.destination_city) return null;

  return {
    id: raw.load_id || `DF-${Math.floor(Math.random() * 9000000) + 1000000}`,
    origin: {
      city: raw.origin_city,
      state: raw.origin_state || "",
      zip: raw.origin_zip || "",
    },
    destination: {
      city: raw.destination_city,
      state: raw.destination_state || "",
      zip: raw.destination_zip || "",
    },
    rate,
    ratePerMile: Math.round(ratePerMile * 100) / 100,
    distance,
    weight: raw.weight,
    equipmentType: DF_TO_EQUIP[raw.trailer_type || "V"] || "dry_van",
    hazmat: raw.hazmat || false,
    pickupDate: raw.pickup_date || new Date(Date.now() + 86400000).toISOString(),
    deliveryDate: raw.delivery_date || new Date(Date.now() + 172800000).toISOString(),
    brokerName: raw.broker_name || "Direct Freight Broker",
    brokerPhone: raw.broker_phone || "",
    brokerEmail: raw.broker_email,
    postedAt: raw.posted_at || new Date().toISOString(),
    notes: [
      raw.commodity,
      ...(raw.requirements || []),
    ].filter(Boolean).join(". ") || undefined,
  };
}

/**
 * Check if the Direct Freight API is configured and reachable.
 */
export function isDirectFreightConfigured(): boolean {
  return !!process.env.DIRECT_FREIGHT_API_KEY;
}
