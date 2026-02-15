import { describe, it, expect } from "vitest";
import { searchLoads, calculateProfitability } from "./load-search.js";

describe("searchLoads", () => {
  it("returns loads matching origin and destination", async () => {
    const result = await searchLoads.execute({
      originCity: "Dallas",
      originState: "TX",
      destinationCity: "Chicago",
      destinationState: "IL",
      noHazmat: true,
      maxDeadheadMiles: 100,
    });

    expect(result.loads).toBeDefined();
    expect(result.loads.length).toBeGreaterThan(0);
    expect(result.totalFound).toBe(result.loads.length);
    expect(result.searchParams.origin).toContain("Dallas");
    expect(result.searchParams.destination).toContain("Chicago");
  });

  it("filters by minimum rate per mile", async () => {
    const result = await searchLoads.execute({
      originCity: "Dallas",
      destinationCity: "Chicago",
      minRatePerMile: 4.0,
      noHazmat: true,
      maxDeadheadMiles: 100,
    });

    for (const load of result.loads) {
      expect(load.ratePerMile).toBeGreaterThanOrEqual(4.0);
    }
  });

  it("filters by equipment type", async () => {
    const result = await searchLoads.execute({
      originCity: "Dallas",
      destinationCity: "Chicago",
      equipmentType: "dry_van",
      noHazmat: true,
      maxDeadheadMiles: 100,
    });

    for (const load of result.loads) {
      expect(load.equipmentType).toBe("dry_van");
    }
  });

  it("excludes hazmat loads when noHazmat is true", async () => {
    const result = await searchLoads.execute({
      originCity: "Dallas",
      destinationCity: "Chicago",
      noHazmat: true,
      maxDeadheadMiles: 100,
    });

    for (const load of result.loads) {
      expect(load.hazmat).toBe(false);
    }
  });

  it("returns proper load structure", async () => {
    const result = await searchLoads.execute({
      originCity: "Dallas",
      destinationCity: "Chicago",
      noHazmat: true,
      maxDeadheadMiles: 100,
    });

    const load = result.loads[0];
    expect(load.id).toBeDefined();
    expect(load.origin.city).toBe("Dallas");
    expect(load.destination.city).toBe("Chicago");
    expect(load.rate).toBeGreaterThan(0);
    expect(load.ratePerMile).toBeGreaterThan(0);
    expect(load.brokerName).toBeDefined();
    expect(load.brokerPhone).toBeDefined();
  });
});

describe("calculateProfitability", () => {
  it("calculates net profit correctly", async () => {
    const result = await calculateProfitability.execute({
      loadId: "LD-001",
      totalRate: 3850,
      totalMiles: 1000,
      deadheadMiles: 50,
      fuelPricePerGallon: 3.8,
      mpg: 6.5,
      tollEstimate: 45,
    });

    expect(result.loadId).toBe("LD-001");
    expect(result.grossRevenue).toBe(3850);
    expect(result.fuelCost).toBeGreaterThan(0);
    expect(result.netProfit).toBeLessThan(result.grossRevenue);
    expect(result.profitPerMile).toBeGreaterThan(0);
    expect(result.profitMargin).toBeGreaterThan(0);
    expect(result.profitMargin).toBeLessThan(100);
  });

  it("accounts for deadhead miles in fuel cost", async () => {
    const withDeadhead = await calculateProfitability.execute({
      loadId: "LD-001",
      totalRate: 3000,
      totalMiles: 1000,
      deadheadMiles: 200,
      fuelPricePerGallon: 3.8,
      mpg: 6.5,
      tollEstimate: 0,
    });

    const withoutDeadhead = await calculateProfitability.execute({
      loadId: "LD-001",
      totalRate: 3000,
      totalMiles: 1000,
      deadheadMiles: 0,
      fuelPricePerGallon: 3.8,
      mpg: 6.5,
      tollEstimate: 0,
    });

    expect(withDeadhead.fuelCost).toBeGreaterThan(withoutDeadhead.fuelCost);
    expect(withDeadhead.netProfit).toBeLessThan(withoutDeadhead.netProfit);
  });

  it("gives correct recommendation based on profit per mile", async () => {
    const excellent = await calculateProfitability.execute({
      loadId: "LD-001",
      totalRate: 5000,
      totalMiles: 500,
      deadheadMiles: 0,
      fuelPricePerGallon: 3.0,
      mpg: 8,
      tollEstimate: 0,
    });

    expect(excellent.recommendation).toContain("Excellent");
  });
});
