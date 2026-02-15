/**
 * Real truck stop and parking location service using Overpass API (OpenStreetMap).
 * Queries for fuel stations and truck parking near a given coordinate.
 * Rate limited to ~1 req/sec on public Overpass instance.
 */

const OVERPASS_API = "https://overpass-api.de/api/interpreter";

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1100; // slightly over 1 second

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface NearbyTruckStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  brand?: string;
  amenities: string[];
  fuelTypes: string[];
  hasHGV: boolean;
  address?: string;
}

export interface NearbyParking {
  id: string;
  name: string;
  lat: number;
  lng: number;
  capacity?: number;
  isTruckParking: boolean;
  amenities: string[];
  operator?: string;
}

async function rateLimitedFetch(query: string): Promise<OverpassElement[]> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) =>
      setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed)
    );
  }
  lastRequestTime = Date.now();

  const res = await fetch(OVERPASS_API, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) {
    throw new Error(`Overpass API returned ${res.status}`);
  }

  const data = (await res.json()) as { elements: OverpassElement[] };
  return data.elements || [];
}

/**
 * Find nearby truck stops / fuel stations via Overpass (OSM).
 * Searches for amenity=fuel with truck-related tags.
 */
export async function findNearbyTruckStops(
  lat: number,
  lng: number,
  radiusKm: number = 30
): Promise<NearbyTruckStop[]> {
  try {
    // Query for fuel stations, especially those tagged for trucks/HGV
    const query = `
[out:json][timeout:15];
(
  node["amenity"="fuel"]["hgv"~"yes|designated"](around:${radiusKm * 1000},${lat},${lng});
  way["amenity"="fuel"]["hgv"~"yes|designated"](around:${radiusKm * 1000},${lat},${lng});
  node["amenity"="fuel"]["brand"~"Pilot|Flying J|Love|TA |Petro|QuikTrip|Casey|Buc-ee",i](around:${radiusKm * 1000},${lat},${lng});
  way["amenity"="fuel"]["brand"~"Pilot|Flying J|Love|TA |Petro|QuikTrip|Casey|Buc-ee",i](around:${radiusKm * 1000},${lat},${lng});
);
out center 20;
`;

    const elements = await rateLimitedFetch(query);

    return elements.map((el) => {
      const elLat = el.lat ?? el.center?.lat ?? lat;
      const elLng = el.lon ?? el.center?.lon ?? lng;
      const tags = el.tags || {};

      const amenities: string[] = [];
      if (tags.shower === "yes" || tags.showers === "yes") amenities.push("Showers");
      if (tags.shop === "convenience" || tags.shop) amenities.push("Shop");
      if (tags.internet_access === "wlan" || tags.wifi === "yes") amenities.push("WiFi");
      if (tags.restaurant === "yes" || tags.food === "yes") amenities.push("Restaurant");
      if (tags.laundry === "yes") amenities.push("Laundry");

      const fuelTypes: string[] = ["Diesel"];
      if (tags["fuel:diesel"] === "yes") fuelTypes.includes("Diesel") || fuelTypes.push("Diesel");
      if (tags["fuel:HGV_diesel"] === "yes") fuelTypes.push("Truck Diesel");
      if (tags["fuel:adblue"] === "yes" || tags.def === "yes") fuelTypes.push("DEF");

      return {
        id: `osm-${el.id}`,
        name: tags.name || tags.brand || "Fuel Station",
        lat: elLat,
        lng: elLng,
        brand: tags.brand,
        amenities,
        fuelTypes,
        hasHGV: tags.hgv === "yes" || tags.hgv === "designated",
        address: [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"], tags["addr:state"]]
          .filter(Boolean)
          .join(", ") || undefined,
      };
    });
  } catch (err) {
    console.error("[places-service] findNearbyTruckStops failed:", err);
    return [];
  }
}

/**
 * Find nearby truck parking via Overpass (OSM).
 * Searches for parking areas tagged for HGV / truck use.
 */
export async function findNearbyParking(
  lat: number,
  lng: number,
  radiusKm: number = 30
): Promise<NearbyParking[]> {
  try {
    const query = `
[out:json][timeout:15];
(
  node["amenity"="parking"]["hgv"~"yes|designated|only"](around:${radiusKm * 1000},${lat},${lng});
  way["amenity"="parking"]["hgv"~"yes|designated|only"](around:${radiusKm * 1000},${lat},${lng});
  node["amenity"="parking"]["parking"="truck"](around:${radiusKm * 1000},${lat},${lng});
  way["amenity"="parking"]["parking"="truck"](around:${radiusKm * 1000},${lat},${lng});
  node["highway"="rest_area"](around:${radiusKm * 1000},${lat},${lng});
  way["highway"="rest_area"](around:${radiusKm * 1000},${lat},${lng});
);
out center 20;
`;

    const elements = await rateLimitedFetch(query);

    return elements.map((el) => {
      const elLat = el.lat ?? el.center?.lat ?? lat;
      const elLng = el.lon ?? el.center?.lon ?? lng;
      const tags = el.tags || {};

      const amenities: string[] = [];
      if (tags.toilets === "yes") amenities.push("Restrooms");
      if (tags.shower === "yes" || tags.showers === "yes") amenities.push("Showers");
      if (tags.internet_access === "wlan" || tags.wifi === "yes") amenities.push("WiFi");
      if (tags.lit === "yes") amenities.push("Lit");
      if (tags.surveillance === "yes") amenities.push("Security");

      const isTruck =
        tags.hgv === "yes" ||
        tags.hgv === "designated" ||
        tags.hgv === "only" ||
        tags.parking === "truck" ||
        tags.highway === "rest_area";

      return {
        id: `osm-${el.id}`,
        name: tags.name || (tags.highway === "rest_area" ? "Rest Area" : "Truck Parking"),
        lat: elLat,
        lng: elLng,
        capacity: tags.capacity ? parseInt(tags.capacity, 10) : undefined,
        isTruckParking: isTruck,
        amenities,
        operator: tags.operator,
      };
    });
  } catch (err) {
    console.error("[places-service] findNearbyParking failed:", err);
    return [];
  }
}
