import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { geocodeCity, getRoute, haversineDistance } from "../services/geo-service.js";
import {
  FREIGHT_LANES,
  FREIGHT_BROKERS,
  LOAD_BOARD_PATTERNS,
  type FreightLane,
} from "../data/seed-data.js";
import { searchDirectFreight, isDirectFreightConfigured } from "../services/direct-freight-service.js";
import { demoSession, addTrip } from "./demo-session.js";

const LoadResultSchema = z.object({
  id: z.string(),
  origin: z.object({ city: z.string(), state: z.string(), zip: z.string() }),
  destination: z.object({
    city: z.string(),
    state: z.string(),
    zip: z.string(),
  }),
  rate: z.number(),
  ratePerMile: z.number(),
  distance: z.number(),
  weight: z.number().optional(),
  equipmentType: z.enum(["dry_van", "reefer", "flatbed", "step_deck", "other"]),
  hazmat: z.boolean(),
  pickupDate: z.string(),
  deliveryDate: z.string(),
  brokerName: z.string(),
  brokerPhone: z.string(),
  brokerEmail: z.string().optional(),
  postedAt: z.string(),
  notes: z.string().optional(),
  source: z.string().optional(),
});

export type LoadResult = z.infer<typeof LoadResultSchema>;

// Map load board equipment types to our schema types
const EQUIP_MAP: Record<string, LoadResult["equipmentType"]> = {
  "Dry Van": "dry_van",
  Reefer: "reefer",
  Flatbed: "flatbed",
  "Step Deck": "step_deck",
  "Power Only": "other",
};

export const searchLoads = createTool({
  id: "search_loads",
  description:
    "Search for available freight loads on load boards. Pulls real-time data from Direct Freight when API key is configured, otherwise uses dynamic market-based data. Filters by origin, destination, rate per mile, equipment type, hazmat, and weight.",
  inputSchema: z.object({
    originCity: z.string().optional().describe("Origin city name. If omitted, uses the driver's current GPS location."),
    originState: z
      .string()
      .optional()
      .describe("Origin state (2-letter code)"),
    destinationCity: z.string().describe("Destination city name"),
    destinationState: z
      .string()
      .optional()
      .describe("Destination state (2-letter code)"),
    minRatePerMile: z
      .number()
      .optional()
      .describe("Minimum rate per mile in dollars"),
    equipmentType: z
      .enum(["dry_van", "reefer", "flatbed", "step_deck", "any"])
      .optional()
      .describe("Type of trailer/equipment required"),
    noHazmat: z
      .boolean()
      .optional()
      .default(true)
      .describe("Exclude hazmat loads"),
    maxWeight: z
      .number()
      .optional()
      .describe("Maximum weight in pounds"),
    maxDeadheadMiles: z
      .number()
      .optional()
      .default(100)
      .describe("Maximum deadhead miles from current location"),
  }),
  outputSchema: z.object({
    loads: z.array(LoadResultSchema),
    totalFound: z.number(),
    searchParams: z.object({
      origin: z.string(),
      destination: z.string(),
      filters: z.string(),
    }),
    dataSource: z.string(),
  }),
  execute: async (input) => {
    // Fall back to GPS location if origin not specified
    let originCity = input.originCity;
    let originState = input.originState;
    if (!originCity && demoSession.driverLocation?.city) {
      originCity = demoSession.driverLocation.city;
      originState = originState || demoSession.driverLocation.state;
      console.log(`[load-search] No origin specified, using GPS location: ${originCity}, ${originState}`);
    }
    if (!originCity) {
      originCity = "Dallas"; // last resort fallback
      originState = originState || "TX";
    }

    const originStr = `${originCity}, ${originState || ""}`.trim();
    const destStr = `${input.destinationCity}, ${input.destinationState || ""}`.trim();

    // Try to get real route distance via geocoding + ORS
    let realDistance: number | null = null;
    let realDuration: number | null = null;
    try {
      let originCoords: { lat: number; lng: number };
      // Use GPS coords directly if available and origin matches GPS city
      if (demoSession.driverLocation && demoSession.driverLocation.city === originCity) {
        originCoords = { lat: demoSession.driverLocation.lat, lng: demoSession.driverLocation.lng };
      } else {
        originCoords = await geocodeCity(originCity, originState);
      }
      const destCoords = await geocodeCity(input.destinationCity, input.destinationState);
      const route = await getRoute(originCoords, destCoords);
      realDistance = Math.round(route.distanceMiles);
      realDuration = route.durationHours;

      // Update driver location in demo session
      demoSession.driverLocation = {
        city: originCity,
        state: originState || "",
        lat: originCoords.lat,
        lng: originCoords.lng,
      };
    } catch (err) {
      console.warn("[load-search] Geocoding/routing failed:", (err as Error).message);
    }

    let loads: LoadResult[] = [];
    let dataSource = "market-data";

    // --- Strategy 1: Try Direct Freight API for real-time loads ---
    if (isDirectFreightConfigured()) {
      const realLoads = await searchDirectFreight({
        originCity,
        originState,
        destinationCity: input.destinationCity,
        destinationState: input.destinationState,
        equipmentType: input.equipmentType,
        maxResults: 10,
      });

      if (realLoads && realLoads.length > 0) {
        loads = realLoads.map((l) => ({
          ...l,
          // Override distance with real routing if available
          distance: realDistance ?? l.distance,
          source: "Direct Freight",
        }));
        dataSource = "Direct Freight (live)";
      }
    }

    // --- Strategy 2: Dynamic market-based data ---
    if (loads.length === 0) {
      loads = generateDynamicLoads(
        { ...input, originCity, originState },
        realDistance,
        realDuration,
      );
      dataSource = "market-data";
    }

    // Apply filters
    let filtered = loads;
    if (input.minRatePerMile) {
      filtered = filtered.filter((l) => l.ratePerMile >= input.minRatePerMile!);
    }
    if (input.noHazmat) {
      filtered = filtered.filter((l) => !l.hazmat);
    }
    if (input.equipmentType && input.equipmentType !== "any") {
      filtered = filtered.filter((l) => l.equipmentType === input.equipmentType);
    }
    if (input.maxWeight) {
      filtered = filtered.filter((l) => !l.weight || l.weight <= input.maxWeight!);
    }

    // Sort by rate per mile descending (best paying first)
    filtered.sort((a, b) => b.ratePerMile - a.ratePerMile);

    // Store first load in demo session for continuity
    if (filtered.length > 0) {
      const best = filtered[0];
      demoSession.selectedLoad = {
        loadId: best.id,
        origin: { city: best.origin.city, state: best.origin.state },
        destination: { city: best.destination.city, state: best.destination.state },
        rate: best.rate,
        ratePerMile: best.ratePerMile,
        distance: best.distance,
        equipmentType: best.equipmentType,
        brokerName: best.brokerName,
        brokerPhone: best.brokerPhone,
        brokerEmail: best.brokerEmail,
        pickupDate: best.pickupDate,
        deliveryDate: best.deliveryDate,
        weight: best.weight,
        commodity: best.notes?.split(".")[0],
      };
      demoSession.selectedBroker = {
        name: best.brokerName,
        phone: best.brokerPhone,
        email: best.brokerEmail,
      };

      // Add top loads as "searching" trips for dashboard visibility
      const topLoads = filtered.slice(0, 3);
      for (const load of topLoads) {
        addTrip({
          origin: `${load.origin.city}, ${load.origin.state}`,
          destination: `${load.destination.city}, ${load.destination.state}`,
          rate: load.rate,
          ratePerMile: load.ratePerMile,
          distance: load.distance,
          weight: load.weight || 0,
          equipmentType: load.equipmentType,
          brokerName: load.brokerName,
          brokerPhone: load.brokerPhone,
          pickupDate: load.pickupDate,
          deliveryDate: load.deliveryDate,
          status: "searching",
          commodity: load.notes?.split(".")[0] || "",
        });
      }
    }

    return {
      loads: filtered,
      totalFound: filtered.length,
      searchParams: {
        origin: originStr,
        destination: destStr,
        filters: [
          input.minRatePerMile ? `min $${input.minRatePerMile}/mi` : null,
          input.noHazmat ? "no hazmat" : null,
          input.equipmentType !== "any" ? input.equipmentType : null,
        ]
          .filter(Boolean)
          .join(", "),
      },
      dataSource,
    };
  },
});

// ============================================================================
// Dynamic load generation using market data + time-awareness
// ============================================================================

interface SearchInput {
  originCity: string;
  originState?: string;
  destinationCity: string;
  destinationState?: string;
  equipmentType?: string;
}

function generateDynamicLoads(
  input: SearchInput,
  realDistance: number | null,
  realDuration: number | null
): LoadResult[] {
  const now = new Date();
  const loads: LoadResult[] = [];

  // Find matching lanes
  const matchingLanes = findMatchingLanes(
    input.originCity,
    input.originState,
    input.destinationCity,
    input.destinationState
  );

  // Time-based market adjustments
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  const marketMultiplier = getMarketMultiplier(hour, dayOfWeek);

  // Generate loads from matching lanes with dynamic pricing
  for (const lane of matchingLanes) {
    const distance = realDistance ?? lane.distanceMiles;
    const transitHours = realDuration ?? lane.typicalTransitHours;

    // Pick 3-5 brokers for this lane based on load-to-truck ratio
    const numBrokers = Math.min(
      Math.floor(lane.loadToTruckRatio) + 1,
      5
    );
    const shuffledBrokers = [...FREIGHT_BROKERS].sort(() => Math.random() - 0.5);

    for (let i = 0; i < numBrokers && i < shuffledBrokers.length; i++) {
      const broker = shuffledBrokers[i];
      const equipType = pickEquipmentType(input.equipmentType);
      const equipPattern = LOAD_BOARD_PATTERNS.equipmentTypes.find(
        (e) => EQUIP_MAP[e.type] === equipType
      ) || LOAD_BOARD_PATTERNS.equipmentTypes[0];

      // Dynamic rate based on lane data + market conditions + time
      const baseRate = lane.rateRange.low +
        Math.random() * (lane.rateRange.high - lane.rateRange.low);
      const adjustedRate = Math.round(baseRate * marketMultiplier * 100) / 100;
      const totalRate = Math.round(adjustedRate * distance);

      // Dynamic dates — pickup within next 1-3 days
      const pickupOffset = (1 + Math.floor(Math.random() * 3)) * 86400000;
      const pickup = new Date(now.getTime() + pickupOffset);
      const delivery = new Date(pickup.getTime() + transitHours * 3600000);

      // Realistic posting age (most loads posted within last few hours)
      const ageMinutes = Math.floor(Math.random() * 240) + 5; // 5 min to 4 hours
      const postedAt = new Date(now.getTime() - ageMinutes * 60000);

      // Pick commodity from equipment patterns
      const commodity = equipPattern.commonCommodities[
        Math.floor(Math.random() * equipPattern.commonCommodities.length)
      ];

      // Pick 1-3 requirements
      const numReqs = 1 + Math.floor(Math.random() * 3);
      const reqs = [...LOAD_BOARD_PATTERNS.commonRequirements]
        .sort(() => Math.random() - 0.5)
        .slice(0, numReqs);

      const weight = Math.floor(
        equipPattern.typicalWeight.min +
        Math.random() * (equipPattern.typicalWeight.max - equipPattern.typicalWeight.min)
      );

      loads.push({
        id: `DAT-${Math.floor(Math.random() * 9000000) + 1000000}`,
        origin: {
          city: lane.origin.city,
          state: lane.origin.state,
          zip: generateZip(lane.origin.state),
        },
        destination: {
          city: lane.destination.city,
          state: lane.destination.state,
          zip: generateZip(lane.destination.state),
        },
        rate: totalRate,
        ratePerMile: adjustedRate,
        distance,
        weight,
        equipmentType: equipType,
        hazmat: Math.random() < 0.05, // 5% chance of hazmat
        pickupDate: pickup.toISOString(),
        deliveryDate: delivery.toISOString(),
        brokerName: broker.name,
        brokerPhone: broker.headquarters.includes("TX") ? `(214) ${randomPhonePart()}` :
                     broker.headquarters.includes("IL") ? `(312) ${randomPhonePart()}` :
                     `(800) ${randomPhonePart()}`,
        brokerEmail: `dispatch@${broker.name.toLowerCase().replace(/[\s.()]/g, "")}.com`,
        postedAt: postedAt.toISOString(),
        notes: `${commodity}. ${reqs.join(". ")}.`,
        source: "market-data",
      });
    }
  }

  // If no matching lanes, generate loads for any city pair using real distance
  if (loads.length === 0) {
    const distance = realDistance ?? 500;
    const transitHours = realDuration ?? distance / 55;
    const shuffledBrokers = [...FREIGHT_BROKERS].sort(() => Math.random() - 0.5);

    // Generate 4-6 loads for unknown routes
    const numLoads = 4 + Math.floor(Math.random() * 3);

    for (let i = 0; i < numLoads && i < shuffledBrokers.length; i++) {
      const broker = shuffledBrokers[i];
      const equipType = pickEquipmentType(input.equipmentType);
      const equipPattern = LOAD_BOARD_PATTERNS.equipmentTypes.find(
        (e) => EQUIP_MAP[e.type] === equipType
      ) || LOAD_BOARD_PATTERNS.equipmentTypes[0];

      // Base rate from equipment spot rate + market conditions
      const baseRate = equipPattern.spotRatePerMile2025.low +
        Math.random() * (equipPattern.spotRatePerMile2025.high - equipPattern.spotRatePerMile2025.low);
      const adjustedRate = Math.round(baseRate * marketMultiplier * 100) / 100;
      const totalRate = Math.round(adjustedRate * distance);

      const pickupOffset = (1 + Math.floor(Math.random() * 3)) * 86400000;
      const pickup = new Date(now.getTime() + pickupOffset);
      const delivery = new Date(pickup.getTime() + transitHours * 3600000);

      const ageMinutes = Math.floor(Math.random() * 240) + 5;
      const postedAt = new Date(now.getTime() - ageMinutes * 60000);

      const commodity = equipPattern.commonCommodities[
        Math.floor(Math.random() * equipPattern.commonCommodities.length)
      ];
      const numReqs = 1 + Math.floor(Math.random() * 3);
      const reqs = [...LOAD_BOARD_PATTERNS.commonRequirements]
        .sort(() => Math.random() - 0.5)
        .slice(0, numReqs);

      const weight = Math.floor(
        equipPattern.typicalWeight.min +
        Math.random() * (equipPattern.typicalWeight.max - equipPattern.typicalWeight.min)
      );

      loads.push({
        id: `DAT-${Math.floor(Math.random() * 9000000) + 1000000}`,
        origin: {
          city: input.originCity,
          state: input.originState || "",
          zip: generateZip(input.originState || "TX"),
        },
        destination: {
          city: input.destinationCity,
          state: input.destinationState || "",
          zip: generateZip(input.destinationState || ""),
        },
        rate: totalRate,
        ratePerMile: adjustedRate,
        distance,
        weight,
        equipmentType: equipType,
        hazmat: Math.random() < 0.05,
        pickupDate: pickup.toISOString(),
        deliveryDate: delivery.toISOString(),
        brokerName: broker.name,
        brokerPhone: `(800) ${randomPhonePart()}`,
        brokerEmail: `dispatch@${broker.name.toLowerCase().replace(/[\s.()]/g, "")}.com`,
        postedAt: postedAt.toISOString(),
        notes: `${commodity}. ${reqs.join(". ")}.`,
        source: "market-data",
      });
    }
  }

  return loads;
}

/**
 * Market rate multiplier based on time of day and day of week.
 * Rates tend to spike on Fridays and late in the day as capacity tightens.
 */
function getMarketMultiplier(hour: number, dayOfWeek: number): number {
  let multiplier = 1.0;

  // Day of week effect (Mon=1, Fri=5)
  if (dayOfWeek === 5) multiplier *= 1.08; // Friday — tight capacity
  else if (dayOfWeek === 1) multiplier *= 0.95; // Monday — more capacity
  else if (dayOfWeek === 0 || dayOfWeek === 6) multiplier *= 0.90; // Weekend — low volume

  // Time of day effect
  if (hour >= 14 && hour <= 17) multiplier *= 1.05; // Afternoon rush — rates climb
  else if (hour >= 6 && hour <= 9) multiplier *= 1.02; // Morning activity
  else if (hour >= 20 || hour < 6) multiplier *= 0.95; // Off-hours — fewer postings, slight discount

  return multiplier;
}

function pickEquipmentType(requested?: string): LoadResult["equipmentType"] {
  if (requested && requested !== "any") return requested as LoadResult["equipmentType"];
  // Weighted random: 58% dry van, 22% reefer, 14% flatbed, 4% step deck, 2% other
  const roll = Math.random();
  if (roll < 0.58) return "dry_van";
  if (roll < 0.80) return "reefer";
  if (roll < 0.94) return "flatbed";
  if (roll < 0.98) return "step_deck";
  return "other";
}

// ZIP code prefixes by state for realistic-looking data
const STATE_ZIP_PREFIXES: Record<string, string[]> = {
  TX: ["750", "751", "752", "760", "770", "773", "780", "782", "786", "790"],
  IL: ["600", "601", "606", "610", "612", "616", "618", "620"],
  GA: ["300", "303", "305", "306", "310", "312", "318"],
  OK: ["730", "731", "734", "735", "740", "741", "745"],
  TN: ["370", "371", "374", "378", "380", "381", "383"],
  CO: ["800", "801", "802", "803", "804", "805", "806"],
  CA: ["900", "902", "906", "910", "912", "917", "920", "921"],
  FL: ["320", "321", "327", "330", "331", "336", "337"],
  LA: ["700", "701", "703", "704", "706", "707", "708"],
  MO: ["630", "631", "636", "640", "641", "644", "647"],
  AL: ["350", "351", "354", "356", "358", "360", "361"],
  AR: ["716", "717", "718", "720", "721", "722", "723"],
  MS: ["386", "387", "388", "390", "391", "392", "393"],
};

function generateZip(state: string): string {
  const prefixes = STATE_ZIP_PREFIXES[state.toUpperCase()];
  if (prefixes) {
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const suffix = String(Math.floor(Math.random() * 100)).padStart(2, "0");
    return prefix + suffix;
  }
  // Fallback: random 5-digit zip
  return String(Math.floor(Math.random() * 90000) + 10000);
}

function randomPhonePart(): string {
  return `${Math.floor(Math.random() * 900) + 100}-${Math.floor(Math.random() * 9000) + 1000}`;
}

function matchesCity(
  city1: string,
  state1: string,
  city2: string,
  state2?: string
): boolean {
  const c1 = city1.toLowerCase().trim();
  const c2 = city2.toLowerCase().trim();
  if (state2 && state1.toUpperCase() !== state2.toUpperCase()) return false;
  return c1 === c2 || c1.includes(c2) || c2.includes(c1);
}

function findMatchingLanes(
  originCity: string,
  originState?: string,
  destCity?: string,
  destState?: string
): FreightLane[] {
  return FREIGHT_LANES.filter((lane) => {
    const originMatch = matchesCity(lane.origin.city, lane.origin.state, originCity, originState);
    const destMatch = destCity
      ? matchesCity(lane.destination.city, lane.destination.state, destCity, destState)
      : true;
    return originMatch && destMatch;
  });
}

export const calculateProfitability = createTool({
  id: "calculate_profitability",
  description:
    "Calculate the profitability of a load considering fuel costs, deadhead miles, tolls, and operating expenses.",
  inputSchema: z.object({
    loadId: z.string().describe("The load ID to calculate profitability for"),
    totalRate: z.number().describe("Total rate for the load in dollars"),
    totalMiles: z.number().describe("Total loaded miles"),
    deadheadMiles: z
      .number()
      .default(0)
      .describe("Empty miles to reach pickup"),
    fuelPricePerGallon: z
      .number()
      .default(3.8)
      .describe("Current diesel price per gallon"),
    mpg: z.number().default(6.5).describe("Truck fuel efficiency in MPG"),
    tollEstimate: z.number().default(0).describe("Estimated toll costs"),
  }),
  outputSchema: z.object({
    loadId: z.string(),
    grossRevenue: z.number(),
    fuelCost: z.number(),
    tollCost: z.number(),
    operatingCost: z.number(),
    netProfit: z.number(),
    profitPerMile: z.number(),
    profitMargin: z.number(),
    recommendation: z.string(),
  }),
  execute: async (input) => {
    const totalMilesWithDeadhead = input.totalMiles + input.deadheadMiles;
    const gallonsNeeded = totalMilesWithDeadhead / input.mpg;
    const fuelCost = gallonsNeeded * input.fuelPricePerGallon;

    // Operating cost estimate: insurance, maintenance, etc. (~$0.30/mile)
    const operatingCost = totalMilesWithDeadhead * 0.3;
    const netProfit =
      input.totalRate - fuelCost - input.tollEstimate - operatingCost;
    const profitPerMile = netProfit / totalMilesWithDeadhead;
    const profitMargin = (netProfit / input.totalRate) * 100;

    let recommendation: string;
    if (profitPerMile >= 1.5) {
      recommendation = "Excellent load! Well above average profitability.";
    } else if (profitPerMile >= 1.0) {
      recommendation = "Good load. Above average profitability.";
    } else if (profitPerMile >= 0.5) {
      recommendation =
        "Average load. Consider if it positions you well for the next load.";
    } else {
      recommendation =
        "Below average profitability. Only take if it gets you to a hot market.";
    }

    return {
      loadId: input.loadId,
      grossRevenue: input.totalRate,
      fuelCost: Math.round(fuelCost * 100) / 100,
      tollCost: input.tollEstimate,
      operatingCost: Math.round(operatingCost * 100) / 100,
      netProfit: Math.round(netProfit * 100) / 100,
      profitPerMile: Math.round(profitPerMile * 100) / 100,
      profitMargin: Math.round(profitMargin * 10) / 10,
      recommendation,
    };
  },
});
