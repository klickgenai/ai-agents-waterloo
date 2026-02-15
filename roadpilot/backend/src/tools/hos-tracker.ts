import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { geocodeCity, haversineDistance } from "../services/geo-service.js";
import { findNearbyTruckStops } from "../services/places-service.js";
import { TRUCK_STOPS } from "../data/seed-data.js";
import { demoSession } from "./demo-session.js";

const HOSStatusSchema = z.object({
  driverId: z.string(),
  currentStatus: z.enum([
    "driving",
    "on_duty",
    "sleeper_berth",
    "off_duty",
  ]),
  driveTimeRemaining: z.number().describe("Minutes of drive time remaining today"),
  onDutyTimeRemaining: z.number().describe("Minutes of on-duty time remaining today"),
  cycleTimeRemaining: z.number().describe("Minutes remaining in 70-hour/8-day cycle"),
  breakTimeRequired: z.boolean().describe("Whether a 30-min break is required"),
  minutesSinceLastBreak: z.number(),
  currentLocation: z.object({
    lat: z.number(),
    lng: z.number(),
    city: z.string().optional(),
    state: z.string().optional(),
  }),
  violations: z.array(
    z.object({
      type: z.string(),
      description: z.string(),
      severity: z.enum(["warning", "violation"]),
    })
  ),
  lastUpdated: z.string(),
});

export type HOSStatus = z.infer<typeof HOSStatusSchema>;

/**
 * Assume HOS status based on time of day:
 * - Morning (5-9 AM): Fresh — just started, 10-11 hours remaining
 * - Midday (9 AM - 2 PM): Mid-shift — 5-7 hours remaining
 * - Afternoon (2-6 PM): Getting tight — 3-5 hours remaining
 * - Evening (6-10 PM): End of day — 0-2 hours remaining
 * - Night (10 PM - 5 AM): Off duty / sleeper berth
 */
function getTimeBasedHOS(hour: number): {
  status: "driving" | "on_duty" | "sleeper_berth" | "off_duty";
  driveUsed: number;
  onDutyUsed: number;
  sinceBreak: number;
} {
  if (hour >= 5 && hour < 9) {
    return { status: "driving", driveUsed: (hour - 5) * 60, onDutyUsed: (hour - 5) * 60 + 30, sinceBreak: (hour - 5) * 60 };
  } else if (hour >= 9 && hour < 14) {
    return { status: "driving", driveUsed: (hour - 5) * 60 - 30, onDutyUsed: (hour - 5) * 60, sinceBreak: (hour - 9) * 60 };
  } else if (hour >= 14 && hour < 18) {
    return { status: "driving", driveUsed: (hour - 5) * 60 - 60, onDutyUsed: (hour - 5) * 60 - 30, sinceBreak: (hour - 14) * 60 };
  } else if (hour >= 18 && hour < 22) {
    return { status: "on_duty", driveUsed: 600, onDutyUsed: (hour - 5) * 60 - 60, sinceBreak: (hour - 18) * 60 };
  } else {
    return { status: "sleeper_berth", driveUsed: 0, onDutyUsed: 0, sinceBreak: 0 };
  }
}

export const getHOSStatus = createTool({
  id: "get_hos_status",
  description:
    "Get the current Hours of Service (HOS) status for the driver from their ELD device. Shows remaining drive time, on-duty time, cycle time, and any violations.",
  inputSchema: z.object({
    driverId: z.string().describe("The driver's unique ID"),
  }),
  outputSchema: HOSStatusSchema,
  execute: async (input) => {
    const hour = new Date().getHours();
    const hos = getTimeBasedHOS(hour);

    // Use demo session location or default to Dallas
    const location = demoSession.driverLocation || {
      city: "Dallas",
      state: "TX",
      lat: 32.7767,
      lng: -96.797,
    };

    const driveTimeRemaining = Math.max(0, 660 - hos.driveUsed); // 11 hours max
    const onDutyTimeRemaining = Math.max(0, 840 - hos.onDutyUsed); // 14 hours max

    const violations = [];
    if (driveTimeRemaining <= 0) {
      violations.push({
        type: "drive_time_exceeded",
        description: "11-hour driving limit has been reached",
        severity: "violation" as const,
      });
    }
    if (hos.sinceBreak >= 480) {
      violations.push({
        type: "break_required",
        description: "8-hour driving without 30-minute break",
        severity: "violation" as const,
      });
    }

    return {
      driverId: input.driverId,
      currentStatus: hos.status,
      driveTimeRemaining,
      onDutyTimeRemaining,
      cycleTimeRemaining: 4200 - hos.onDutyUsed, // 70 hours
      breakTimeRequired: hos.sinceBreak >= 420, // warn at 7 hours
      minutesSinceLastBreak: hos.sinceBreak,
      currentLocation: {
        lat: location.lat,
        lng: location.lng,
        city: location.city,
        state: location.state,
      },
      violations,
      lastUpdated: new Date().toISOString(),
    };
  },
});

export const planBreaks = createTool({
  id: "plan_breaks",
  description:
    "Calculate the optimal break schedule for remaining route based on current HOS status, distance remaining, and available rest stops.",
  inputSchema: z.object({
    driverId: z.string(),
    destinationCity: z.string(),
    destinationState: z.string(),
    milesRemaining: z.number().describe("Miles remaining to destination"),
    avgSpeed: z
      .number()
      .default(55)
      .describe("Average driving speed in mph"),
  }),
  outputSchema: z.object({
    totalDriveTimeNeeded: z.number().describe("Minutes of drive time needed"),
    canMakeItToday: z.boolean(),
    suggestedBreaks: z.array(
      z.object({
        type: z.enum(["30_min_break", "10_hour_rest", "fuel_stop"]),
        afterMiles: z.number(),
        afterMinutes: z.number(),
        suggestedLocation: z.string(),
        reason: z.string(),
      })
    ),
    estimatedArrival: z.string(),
  }),
  execute: async (input) => {
    const hour = new Date().getHours();
    const hos = getTimeBasedHOS(hour);
    const driveTimeRemaining = Math.max(0, 660 - hos.driveUsed);

    const driveTimeNeeded = (input.milesRemaining / input.avgSpeed) * 60;
    const canMakeItToday = driveTimeNeeded <= driveTimeRemaining;

    const suggestedBreaks: Array<{
      type: "30_min_break" | "10_hour_rest" | "fuel_stop";
      afterMiles: number;
      afterMinutes: number;
      suggestedLocation: string;
      reason: string;
    }> = [];

    // Get current location
    const location = demoSession.driverLocation || {
      lat: 32.7767,
      lng: -96.797,
    };

    // Find real nearby truck stops for break suggestions
    let nearbyStopNames: string[] = [];
    try {
      const osmStops = await findNearbyTruckStops(location.lat, location.lng, 150);
      nearbyStopNames = osmStops
        .filter((s) => s.name !== "Fuel Station")
        .map((s) => `${s.name}${s.address ? ` - ${s.address}` : ""}`);
    } catch {
      // Fall back to seed data
    }

    // Supplement with seed data
    const seedStops = TRUCK_STOPS
      .map((s) => ({
        ...s,
        dist: haversineDistance(location.lat, location.lng, s.lat, s.lng),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5)
      .map((s) => `${s.name} (${s.brand}) - ${s.city}, ${s.state} (${s.interstate} Exit ${s.exitNumber})`);

    const allStops = [...nearbyStopNames, ...seedStops];

    // Need a 30-min break before 8 hours of driving
    if (hos.sinceBreak > 300 || driveTimeNeeded > 120) {
      const breakAfterMinutes = Math.max(60, 480 - hos.sinceBreak);
      const breakAfterMiles = Math.round((breakAfterMinutes / 60) * input.avgSpeed);

      suggestedBreaks.push({
        type: "30_min_break",
        afterMiles: Math.min(breakAfterMiles, input.milesRemaining),
        afterMinutes: breakAfterMinutes,
        suggestedLocation: allStops[0] || "Nearest truck stop",
        reason: "Required 30-minute break before 8-hour driving limit",
      });
    }

    // Need 10-hour rest if can't make it today
    if (!canMakeItToday) {
      const restAfterMiles = Math.round((driveTimeRemaining / 60) * input.avgSpeed);

      suggestedBreaks.push({
        type: "10_hour_rest",
        afterMiles: restAfterMiles,
        afterMinutes: driveTimeRemaining,
        suggestedLocation: allStops[1] || allStops[0] || "Nearest truck stop with parking",
        reason: "11-hour drive limit reached. 10-hour rest required.",
      });
    }

    // Fuel stop suggestion if long route
    if (input.milesRemaining > 400) {
      suggestedBreaks.push({
        type: "fuel_stop",
        afterMiles: Math.round(input.milesRemaining * 0.45),
        afterMinutes: Math.round((input.milesRemaining * 0.45 / input.avgSpeed) * 60),
        suggestedLocation: allStops[2] || allStops[0] || "Nearest fuel station",
        reason: "Recommended fuel stop at roughly mid-route",
      });
    }

    const arrivalMinutes = canMakeItToday
      ? driveTimeNeeded + (suggestedBreaks.length > 0 ? 30 : 0)
      : driveTimeNeeded + 600 + 30; // rest + break

    return {
      totalDriveTimeNeeded: Math.round(driveTimeNeeded),
      canMakeItToday,
      suggestedBreaks,
      estimatedArrival: new Date(
        Date.now() + arrivalMinutes * 60000
      ).toISOString(),
    };
  },
});

export const alertHOSViolation = createTool({
  id: "alert_hos_violation",
  description:
    "Check for approaching HOS violations and generate proactive alerts. Call this periodically to warn the driver before they exceed limits.",
  inputSchema: z.object({
    driverId: z.string(),
    driveTimeRemaining: z.number().describe("Minutes of drive time remaining"),
    onDutyTimeRemaining: z.number().describe("Minutes of on-duty time remaining"),
    minutesSinceLastBreak: z.number(),
  }),
  outputSchema: z.object({
    alerts: z.array(
      z.object({
        urgency: z.enum(["info", "warning", "critical"]),
        message: z.string(),
        actionRequired: z.string(),
        minutesUntilViolation: z.number(),
      })
    ),
  }),
  execute: async (input) => {
    const alerts = [];

    if (input.driveTimeRemaining <= 30) {
      alerts.push({
        urgency: "critical" as const,
        message: `Only ${input.driveTimeRemaining} minutes of drive time remaining!`,
        actionRequired: "Find parking immediately. You must stop driving.",
        minutesUntilViolation: input.driveTimeRemaining,
      });
    } else if (input.driveTimeRemaining <= 60) {
      alerts.push({
        urgency: "warning" as const,
        message: `${input.driveTimeRemaining} minutes of drive time remaining.`,
        actionRequired: "Start looking for parking within the next 30 minutes.",
        minutesUntilViolation: input.driveTimeRemaining,
      });
    }

    if (input.minutesSinceLastBreak >= 450) {
      // 7.5 hours
      alerts.push({
        urgency: "warning" as const,
        message: `You've been driving ${Math.round(input.minutesSinceLastBreak / 60)} hours since your last break.`,
        actionRequired:
          "Take a 30-minute break soon. Required before 8 hours of driving.",
        minutesUntilViolation: 480 - input.minutesSinceLastBreak,
      });
    }

    if (input.onDutyTimeRemaining <= 60) {
      alerts.push({
        urgency: "warning" as const,
        message: `${input.onDutyTimeRemaining} minutes of on-duty time remaining in your 14-hour window.`,
        actionRequired:
          "Wrap up for the day. Your 14-hour window is closing.",
        minutesUntilViolation: input.onDutyTimeRemaining,
      });
    }

    return { alerts };
  },
});
