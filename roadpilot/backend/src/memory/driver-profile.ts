import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";

export interface DriverProfile {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  mcNumber?: string;
  dotNumber?: string;
  equipmentType: string;
  tankCapacity: number;
  avgMPG: number;
  preferredLanes: Array<{
    origin: string;
    destination: string;
    minRate: number;
  }>;
  avoidStates: string[];
  maxWeight: number;
  hasHazmat: boolean;
  hasTWIC: boolean;
  homeBase?: string;
  minRatePerMile?: number;
}

export async function getDriverProfile(
  driverId: string
): Promise<DriverProfile | null> {
  try {
    const result = await db
      .select()
      .from(schema.driverProfiles)
      .where(eq(schema.driverProfiles.id, driverId))
      .limit(1);

    if (result.length === 0) return null;

    const row = result[0];
    return {
      id: row.id,
      name: row.name,
      email: row.email || undefined,
      phone: row.phone || undefined,
      mcNumber: row.mcNumber || undefined,
      dotNumber: row.dotNumber || undefined,
      equipmentType: row.equipmentType || "dry_van",
      tankCapacity: row.tankCapacity || 150,
      avgMPG: parseFloat(row.avgMPG || "6.5"),
      preferredLanes: (row.preferredLanes as DriverProfile["preferredLanes"]) || [],
      avoidStates: (row.avoidStates as string[]) || [],
      maxWeight: row.maxWeight || 45000,
      hasHazmat: row.hasHazmat || false,
      hasTWIC: row.hasTWIC || false,
      homeBase: row.homeBase || undefined,
      minRatePerMile: row.minRatePerMile
        ? parseFloat(row.minRatePerMile)
        : undefined,
    };
  } catch {
    // Database not available — return null so the app can work without DB
    return null;
  }
}

export async function updateDriverPreference(
  driverId: string,
  key: string,
  value: unknown,
  source: "explicit" | "inferred" = "inferred",
  confidence: number = 0.5
): Promise<void> {
  try {
    // Upsert: check if preference exists
    const existing = await db
      .select()
      .from(schema.driverPreferences)
      .where(
        and(
          eq(schema.driverPreferences.driverId, driverId),
          eq(schema.driverPreferences.key, key)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(schema.driverPreferences)
        .set({
          value: JSON.stringify(value),
          source,
          confidence: String(confidence),
          updatedAt: new Date(),
        })
        .where(eq(schema.driverPreferences.id, existing[0].id));
    } else {
      await db.insert(schema.driverPreferences).values({
        driverId,
        key,
        value: JSON.stringify(value),
        source,
        confidence: String(confidence),
      });
    }
  } catch {
    console.warn(
      `Failed to update preference ${key} for driver ${driverId}`
    );
  }
}

export async function getDriverPreferences(
  driverId: string
): Promise<Record<string, unknown>> {
  try {
    const prefs = await db
      .select()
      .from(schema.driverPreferences)
      .where(eq(schema.driverPreferences.driverId, driverId));

    const result: Record<string, unknown> = {};
    for (const pref of prefs) {
      result[pref.key] = pref.value;
    }
    return result;
  } catch {
    return {};
  }
}
