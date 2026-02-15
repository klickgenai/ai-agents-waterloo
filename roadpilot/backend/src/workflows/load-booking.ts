import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

const searchStep = createStep({
  id: "search-loads",
  description: "Search load boards for matching freight",
  inputSchema: z.object({
    originCity: z.string(),
    originState: z.string().optional(),
    destinationCity: z.string(),
    destinationState: z.string().optional(),
    minRatePerMile: z.number().optional(),
    equipmentType: z.string().optional(),
    noHazmat: z.boolean().default(true),
    driverId: z.string(),
  }),
  outputSchema: z.object({
    loads: z.array(
      z.object({
        id: z.string(),
        origin: z.string(),
        destination: z.string(),
        rate: z.number(),
        ratePerMile: z.number(),
        distance: z.number(),
        brokerName: z.string(),
        brokerPhone: z.string(),
        pickupDate: z.string(),
        equipmentType: z.string(),
      })
    ),
    totalFound: z.number(),
  }),
  execute: async ({ inputData }) => {
    // In production, this calls the actual searchLoads tool
    // For the workflow, we simulate the search
    return {
      loads: [
        {
          id: `LD-${Date.now()}-001`,
          origin: `${inputData.originCity}, ${inputData.originState || ""}`,
          destination: `${inputData.destinationCity}, ${inputData.destinationState || ""}`,
          rate: 3850,
          ratePerMile: 3.85,
          distance: 1000,
          brokerName: "Midwest Freight Solutions",
          brokerPhone: "+1-555-0101",
          pickupDate: new Date(Date.now() + 86400000).toISOString(),
          equipmentType: inputData.equipmentType || "dry_van",
        },
      ],
      totalFound: 1,
    };
  },
});

const profitabilityStep = createStep({
  id: "calculate-profitability",
  description: "Calculate profitability for top load results",
  inputSchema: z.object({
    loads: z.array(
      z.object({
        id: z.string(),
        origin: z.string(),
        destination: z.string(),
        rate: z.number(),
        ratePerMile: z.number(),
        distance: z.number(),
        brokerName: z.string(),
        brokerPhone: z.string(),
        pickupDate: z.string(),
        equipmentType: z.string(),
      })
    ),
    totalFound: z.number(),
  }),
  outputSchema: z.object({
    rankedLoads: z.array(
      z.object({
        id: z.string(),
        origin: z.string(),
        destination: z.string(),
        rate: z.number(),
        ratePerMile: z.number(),
        netProfit: z.number(),
        profitPerMile: z.number(),
        recommendation: z.string(),
        brokerName: z.string(),
        brokerPhone: z.string(),
      })
    ),
  }),
  execute: async ({ inputData }) => {
    const rankedLoads = inputData.loads.map((load) => {
      const fuelCost = (load.distance / 6.5) * 3.8;
      const operatingCost = load.distance * 0.3;
      const netProfit = load.rate - fuelCost - operatingCost;
      const profitPerMile = netProfit / load.distance;

      return {
        id: load.id,
        origin: load.origin,
        destination: load.destination,
        rate: load.rate,
        ratePerMile: load.ratePerMile,
        netProfit: Math.round(netProfit * 100) / 100,
        profitPerMile: Math.round(profitPerMile * 100) / 100,
        recommendation:
          profitPerMile >= 1.5
            ? "Excellent"
            : profitPerMile >= 1.0
              ? "Good"
              : "Average",
        brokerName: load.brokerName,
        brokerPhone: load.brokerPhone,
      };
    });

    rankedLoads.sort((a, b) => b.profitPerMile - a.profitPerMile);

    return { rankedLoads };
  },
});

const hosCheckStep = createStep({
  id: "check-hos-feasibility",
  description: "Verify driver has enough HOS to complete the load",
  inputSchema: z.object({
    rankedLoads: z.array(
      z.object({
        id: z.string(),
        origin: z.string(),
        destination: z.string(),
        rate: z.number(),
        ratePerMile: z.number(),
        netProfit: z.number(),
        profitPerMile: z.number(),
        recommendation: z.string(),
        brokerName: z.string(),
        brokerPhone: z.string(),
      })
    ),
  }),
  outputSchema: z.object({
    feasibleLoads: z.array(
      z.object({
        id: z.string(),
        origin: z.string(),
        destination: z.string(),
        rate: z.number(),
        ratePerMile: z.number(),
        netProfit: z.number(),
        profitPerMile: z.number(),
        recommendation: z.string(),
        brokerName: z.string(),
        brokerPhone: z.string(),
        hosFeasible: z.boolean(),
        hosNote: z.string(),
      })
    ),
    readyToPresent: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    // Mock HOS check - in production would query ELD API
    const driveTimeRemaining = 360; // 6 hours remaining

    const feasibleLoads = inputData.rankedLoads.map((load) => {
      // Rough estimate: 1000 miles / 55 mph = ~18 hours driving
      const estimatedDriveHours = 1000 / 55;
      const hosFeasible = estimatedDriveHours * 60 <= driveTimeRemaining + 660; // Can start today and finish tomorrow

      return {
        ...load,
        hosFeasible,
        hosNote: hosFeasible
          ? `You have ${Math.round(driveTimeRemaining / 60)} hours drive time today. You can start this and finish tomorrow.`
          : "Insufficient HOS to make pickup on time. Consider a closer load.",
      };
    });

    return {
      feasibleLoads,
      readyToPresent: feasibleLoads.some((l) => l.hosFeasible),
    };
  },
});

export const loadBookingWorkflow = createWorkflow({
  id: "load-booking",
  description:
    "End-to-end load search, profitability ranking, HOS feasibility check, and presentation to driver",
  inputSchema: z.object({
    originCity: z.string(),
    originState: z.string().optional(),
    destinationCity: z.string(),
    destinationState: z.string().optional(),
    minRatePerMile: z.number().optional(),
    equipmentType: z.string().optional(),
    noHazmat: z.boolean().default(true),
    driverId: z.string(),
  }),
  outputSchema: z.object({
    feasibleLoads: z.array(
      z.object({
        id: z.string(),
        origin: z.string(),
        destination: z.string(),
        rate: z.number(),
        ratePerMile: z.number(),
        netProfit: z.number(),
        profitPerMile: z.number(),
        recommendation: z.string(),
        brokerName: z.string(),
        brokerPhone: z.string(),
        hosFeasible: z.boolean(),
        hosNote: z.string(),
      })
    ),
    readyToPresent: z.boolean(),
  }),
})
  .then(searchStep)
  .then(profitabilityStep)
  .then(hosCheckStep)
  .commit();
