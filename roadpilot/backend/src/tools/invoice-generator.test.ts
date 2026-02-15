import { describe, it, expect } from "vitest";
import { generateInvoice, sendInvoice, generateBOL, trackIFTA } from "./invoice-generator.js";

describe("generateInvoice", () => {
  it("creates an invoice with correct total", async () => {
    const result = await generateInvoice.execute({
      driverId: "driver-001",
      driverName: "John Smith",
      driverMC: "MC-123456",
      loadId: "LD-001",
      brokerName: "Midwest Freight",
      brokerEmail: "pay@midwest.com",
      origin: "Dallas, TX",
      destination: "Chicago, IL",
      pickupDate: "2026-02-14",
      deliveryDate: "2026-02-16",
      rate: 3850,
      detention: 150,
      lumper: 0,
      fuelSurcharge: 75,
      podConfirmed: true,
    });

    expect(result.invoiceNumber).toMatch(/^INV-/);
    expect(result.totalAmount).toBe(3850 + 150 + 0 + 75);
    expect(result.status).toBe("generated");
  });
});

describe("sendInvoice", () => {
  it("sends invoice to recipient", async () => {
    const result = await sendInvoice.execute({
      invoiceId: "inv_123",
      recipientEmail: "pay@midwest.com",
      recipientName: "Midwest Freight",
      driverName: "John Smith",
    });

    expect(result.sent).toBe(true);
    expect(result.message).toContain("Midwest Freight");
  });
});

describe("generateBOL", () => {
  it("generates a BOL with correct info", async () => {
    const result = await generateBOL.execute({
      loadId: "LD-001",
      shipperName: "ABC Manufacturing",
      shipperAddress: "123 Industrial Blvd, Dallas, TX",
      consigneeName: "XYZ Distribution",
      consigneeAddress: "456 Warehouse Ave, Chicago, IL",
      commodityDescription: "Auto Parts - Palletized",
      weight: 42000,
      pieces: 24,
    });

    expect(result.bolNumber).toMatch(/^BOL-/);
    expect(result.status).toBe("generated");
    expect(result.message).toContain("24 pieces");
  });
});

describe("trackIFTA", () => {
  it("records a fuel purchase for IFTA", async () => {
    const result = await trackIFTA.execute({
      driverId: "driver-001",
      state: "TX",
      gallons: 120,
      totalCost: 430.8,
      truckStopName: "Pilot #412",
    });

    expect(result.recorded).toBe(true);
    expect(result.iftaEntryId).toMatch(/^IFTA-/);
    expect(result.quarterSummary).toBeDefined();
    expect(result.quarterSummary.stateBreakdown.length).toBeGreaterThan(0);

    const txEntry = result.quarterSummary.stateBreakdown.find((s) => s.state === "TX");
    expect(txEntry).toBeDefined();
  });
});
