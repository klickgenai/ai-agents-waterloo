import { describe, it, expect } from "vitest";
import { searchFuelPrices, calculateRouteFuel } from "./fuel-finder.js";

describe("searchFuelPrices", () => {
  it("returns fuel stations sorted by price", async () => {
    const result = await searchFuelPrices.execute({
      latitude: 33.0,
      longitude: -96.8,
      radiusMiles: 20,
      fuelType: "diesel",
    });

    expect(result.stations.length).toBeGreaterThan(0);
    expect(result.averagePrice).toBeGreaterThan(0);

    // Verify sorted by price ascending
    for (let i = 1; i < result.stations.length; i++) {
      expect(result.stations[i].dieselPrice).toBeGreaterThanOrEqual(
        result.stations[i - 1].dieselPrice
      );
    }
  });

  it("respects radius filter", async () => {
    const result = await searchFuelPrices.execute({
      latitude: 33.0,
      longitude: -96.8,
      radiusMiles: 10,
      fuelType: "diesel",
    });

    for (const station of result.stations) {
      expect(station.distanceMiles).toBeLessThanOrEqual(10);
    }
  });

  it("calculates savings correctly", async () => {
    const result = await searchFuelPrices.execute({
      latitude: 33.0,
      longitude: -96.8,
      radiusMiles: 30,
      fuelType: "diesel",
    });

    if (result.stations.length > 0) {
      const expectedSavings =
        Math.round((result.averagePrice - result.stations[0].dieselPrice) * 100) / 100;
      expect(result.cheapestSavings).toBe(expectedSavings);
    }
  });
});

describe("calculateRouteFuel", () => {
  it("calculates total fuel needed for a route", async () => {
    const result = await calculateRouteFuel.execute({
      originCity: "Dallas",
      originState: "TX",
      destinationCity: "Chicago",
      destinationState: "IL",
      totalMiles: 1000,
      currentFuelGallons: 50,
      tankCapacity: 150,
      mpg: 6.5,
    });

    expect(result.totalFuelNeeded).toBeCloseTo(1000 / 6.5, 0);
    expect(result.rangeWithCurrentFuel).toBe(Math.round(50 * 6.5));
    expect(result.totalFuelCost).toBeGreaterThan(0);
  });

  it("plans fuel stops when range is insufficient", async () => {
    const result = await calculateRouteFuel.execute({
      originCity: "Dallas",
      originState: "TX",
      destinationCity: "Los Angeles",
      destinationState: "CA",
      totalMiles: 1500,
      currentFuelGallons: 30,
      tankCapacity: 150,
      mpg: 6.5,
    });

    expect(result.fuelStops.length).toBeGreaterThan(0);
    for (const stop of result.fuelStops) {
      expect(stop.gallonsToFill).toBeGreaterThan(0);
      expect(stop.estimatedCost).toBeGreaterThan(0);
    }
  });
});
