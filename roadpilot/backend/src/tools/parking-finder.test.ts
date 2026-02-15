import { describe, it, expect } from "vitest";
import { searchParking, reserveSpot } from "./parking-finder.js";

describe("searchParking", () => {
  it("returns parking locations with availability data", async () => {
    const result = await searchParking.execute({
      latitude: 33.0,
      longitude: -96.8,
      radiusMiles: 30,
      requireReservable: false,
    });

    expect(result.locations.length).toBeGreaterThan(0);
    expect(result.totalLocations).toBe(result.locations.length);
    expect(["low", "moderate", "high", "critical"]).toContain(result.parkingScarcity);

    for (const loc of result.locations) {
      expect(loc.totalSpots).toBeGreaterThan(0);
      expect(loc.availableSpots).toBeGreaterThanOrEqual(0);
      expect(loc.amenities).toBeDefined();
    }
  });

  it("filters by reservable only", async () => {
    const result = await searchParking.execute({
      latitude: 33.0,
      longitude: -96.8,
      radiusMiles: 30,
      requireReservable: true,
    });

    for (const loc of result.locations) {
      expect(loc.isReservable).toBe(true);
    }
  });

  it("sorts by available spots descending", async () => {
    const result = await searchParking.execute({
      latitude: 33.0,
      longitude: -96.8,
      radiusMiles: 30,
      requireReservable: false,
    });

    for (let i = 1; i < result.locations.length; i++) {
      expect(result.locations[i].availableSpots).toBeLessThanOrEqual(
        result.locations[i - 1].availableSpots
      );
    }
  });
});

describe("reserveSpot", () => {
  it("returns a reservation confirmation", async () => {
    const result = await reserveSpot.execute({
      locationId: "PKG-001",
      driverId: "driver-001",
      arrivalTime: new Date(Date.now() + 3600000).toISOString(),
    });

    expect(result.reservationId).toBeDefined();
    expect(result.locationName).toBeDefined();
    expect(result.spotNumber).toBeDefined();
    expect(result.cost).toBeGreaterThan(0);
    expect(result.confirmationSent).toBe(true);
  });
});
