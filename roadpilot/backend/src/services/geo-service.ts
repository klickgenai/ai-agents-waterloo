/**
 * Geocoding + truck routing service using Nominatim (OSM) and OpenRouteService.
 * In-memory caching to avoid hitting rate limits during demo.
 */

const geocodeCache = new Map<string, { lat: number; lng: number }>();
const routeCache = new Map<
  string,
  { distanceMiles: number; durationHours: number; polyline: number[][] }
>();

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const ORS_BASE = "https://api.openrouteservice.org/v2";

function getORSKey(): string {
  return process.env.OPENROUTESERVICE_API_KEY || "";
}

/**
 * Geocode a city name to lat/lng using Nominatim.
 * Results are cached in-memory.
 */
export async function geocodeCity(
  city: string,
  state?: string
): Promise<{ lat: number; lng: number }> {
  const query = state ? `${city}, ${state}` : city;
  const cacheKey = query.toLowerCase().trim();

  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey)!;
  }

  try {
    const params = new URLSearchParams({
      q: query,
      format: "json",
      limit: "1",
      countrycodes: "us,ca",
    });

    const res = await fetch(`${NOMINATIM_BASE}/search?${params}`, {
      headers: { "User-Agent": "RoadPilot-Demo/1.0" },
    });

    if (!res.ok) {
      throw new Error(`Nominatim returned ${res.status}`);
    }

    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!data.length) {
      throw new Error(`No geocoding result for "${query}"`);
    }

    const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    geocodeCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[geo-service] geocodeCity failed for "${query}":`, err);
    throw err;
  }
}

/**
 * Get a truck route between two points using OpenRouteService (driving-hgv profile).
 * Falls back to haversine estimate if ORS key is missing or request fails.
 */
export async function getRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): Promise<{ distanceMiles: number; durationHours: number; polyline: number[][] }> {
  const cacheKey = `${origin.lat},${origin.lng}->${destination.lat},${destination.lng}`;

  if (routeCache.has(cacheKey)) {
    return routeCache.get(cacheKey)!;
  }

  const apiKey = getORSKey();

  if (apiKey) {
    try {
      const res = await fetch(`${ORS_BASE}/directions/driving-hgv`, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          coordinates: [
            [origin.lng, origin.lat],
            [destination.lng, destination.lat],
          ],
          units: "mi",
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          routes: Array<{
            summary: { distance: number; duration: number };
            geometry: { coordinates: number[][] };
          }>;
        };

        if (data.routes?.length) {
          const route = data.routes[0];
          const result = {
            distanceMiles: Math.round(route.summary.distance * 10) / 10,
            durationHours: Math.round((route.summary.duration / 3600) * 10) / 10,
            polyline: route.geometry?.coordinates || [],
          };
          routeCache.set(cacheKey, result);
          return result;
        }
      } else {
        console.warn(`[geo-service] ORS returned ${res.status}, falling back to haversine`);
      }
    } catch (err) {
      console.warn("[geo-service] ORS request failed, falling back to haversine:", err);
    }
  }

  // Fallback: haversine distance with road factor
  const straightLine = haversineDistance(
    origin.lat,
    origin.lng,
    destination.lat,
    destination.lng
  );
  const roadDistance = Math.round(straightLine * 1.3); // road factor
  const result = {
    distanceMiles: roadDistance,
    durationHours: Math.round((roadDistance / 55) * 10) / 10, // ~55 mph avg for trucks
    polyline: [],
  };
  routeCache.set(cacheKey, result);
  return result;
}

/**
 * Calculate the great-circle distance between two coordinates in miles.
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Reverse geocode lat/lng to city/state using Nominatim.
 * Results cached by coords rounded to 2 decimals (~1km precision).
 */
const reverseCache = new Map<string, { city: string; state: string }>();

export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<{ city: string; state: string }> {
  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;

  if (reverseCache.has(cacheKey)) {
    return reverseCache.get(cacheKey)!;
  }

  try {
    const params = new URLSearchParams({
      lat: lat.toString(),
      lon: lng.toString(),
      format: "json",
      zoom: "10",
    });

    const res = await fetch(`${NOMINATIM_BASE}/reverse?${params}`, {
      headers: { "User-Agent": "RoadPilot-Demo/1.0" },
    });

    if (!res.ok) {
      throw new Error(`Nominatim reverse returned ${res.status}`);
    }

    const data = (await res.json()) as {
      address?: { city?: string; town?: string; village?: string; county?: string; state?: string };
    };

    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.county || "Unknown";
    const state = addr.state || "";

    const result = { city, state };
    reverseCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[geo-service] reverseGeocode failed for ${lat},${lng}:`, err);
    return { city: "Unknown", state: "" };
  }
}
