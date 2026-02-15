import { describe, it, expect } from "vitest";
import { getHOSStatus, planBreaks, alertHOSViolation } from "./hos-tracker.js";

describe("getHOSStatus", () => {
  it("returns valid HOS status for a driver", async () => {
    const result = await getHOSStatus.execute({ driverId: "driver-001" });

    expect(result.driverId).toBe("driver-001");
    expect(result.currentStatus).toBeDefined();
    expect(result.driveTimeRemaining).toBeGreaterThanOrEqual(0);
    expect(result.onDutyTimeRemaining).toBeGreaterThanOrEqual(0);
    expect(result.cycleTimeRemaining).toBeGreaterThanOrEqual(0);
    expect(result.currentLocation).toBeDefined();
    expect(result.currentLocation.lat).toBeDefined();
    expect(result.currentLocation.lng).toBeDefined();
    expect(result.violations).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });
});

describe("planBreaks", () => {
  it("plans breaks for a short trip that fits in remaining time", async () => {
    const result = await planBreaks.execute({
      driverId: "driver-001",
      destinationCity: "Oklahoma City",
      destinationState: "OK",
      milesRemaining: 200,
      avgSpeed: 55,
    });

    expect(result.totalDriveTimeNeeded).toBeGreaterThan(0);
    expect(result.canMakeItToday).toBe(true);
    expect(result.estimatedArrival).toBeDefined();
  });

  it("adds 10-hour rest for long trips", async () => {
    const result = await planBreaks.execute({
      driverId: "driver-001",
      destinationCity: "New York",
      destinationState: "NY",
      milesRemaining: 1500,
      avgSpeed: 55,
    });

    expect(result.canMakeItToday).toBe(false);
    const restBreak = result.suggestedBreaks.find((b) => b.type === "10_hour_rest");
    expect(restBreak).toBeDefined();
  });
});

describe("alertHOSViolation", () => {
  it("returns critical alert when drive time is very low", async () => {
    const result = await alertHOSViolation.execute({
      driverId: "driver-001",
      driveTimeRemaining: 15,
      onDutyTimeRemaining: 120,
      minutesSinceLastBreak: 200,
    });

    expect(result.alerts.length).toBeGreaterThan(0);
    const critical = result.alerts.find((a) => a.urgency === "critical");
    expect(critical).toBeDefined();
    expect(critical!.actionRequired).toContain("immediately");
  });

  it("returns warning when approaching break limit", async () => {
    const result = await alertHOSViolation.execute({
      driverId: "driver-001",
      driveTimeRemaining: 240,
      onDutyTimeRemaining: 240,
      minutesSinceLastBreak: 460,
    });

    const breakWarning = result.alerts.find((a) =>
      a.message.includes("break")
    );
    expect(breakWarning).toBeDefined();
  });

  it("returns no alerts when everything is fine", async () => {
    const result = await alertHOSViolation.execute({
      driverId: "driver-001",
      driveTimeRemaining: 300,
      onDutyTimeRemaining: 400,
      minutesSinceLastBreak: 60,
    });

    expect(result.alerts.length).toBe(0);
  });
});
