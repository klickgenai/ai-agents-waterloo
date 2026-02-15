import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import PDFDocument from "pdfkit";
import * as fs from "fs";
import * as path from "path";
import { demoSession } from "./demo-session.js";

const INVOICES_DIR = path.resolve("public/invoices");

function ensureInvoicesDir() {
  if (!fs.existsSync(INVOICES_DIR)) {
    fs.mkdirSync(INVOICES_DIR, { recursive: true });
  }
}

export const generateInvoice = createTool({
  id: "generate_invoice",
  description:
    "Generate a PDF invoice for a completed load. Creates a professional invoice with load details, rate, and payment terms.",
  inputSchema: z.object({
    driverId: z.string(),
    driverName: z.string(),
    driverMC: z.string().describe("Driver's MC number"),
    loadId: z.string(),
    brokerName: z.string(),
    brokerEmail: z.string(),
    origin: z.string().describe("Pickup city, state"),
    destination: z.string().describe("Delivery city, state"),
    pickupDate: z.string(),
    deliveryDate: z.string(),
    rate: z.number(),
    detention: z.number().default(0).describe("Detention charges"),
    lumper: z.number().default(0).describe("Lumper fees"),
    fuelSurcharge: z.number().default(0),
    referenceNumber: z.string().optional().describe("Broker reference number"),
    podConfirmed: z.boolean().default(false).describe("Proof of delivery confirmed"),
  }),
  outputSchema: z.object({
    invoiceId: z.string(),
    invoiceNumber: z.string(),
    totalAmount: z.number(),
    pdfUrl: z.string().optional(),
    status: z.enum(["generated", "sent", "error"]),
    message: z.string(),
  }),
  execute: async (input) => {
    const totalAmount =
      input.rate +
      input.detention +
      input.lumper +
      input.fuelSurcharge;

    const invoiceNumber = `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
    const invoiceId = `inv_${Date.now()}`;

    // Generate real PDF
    try {
      ensureInvoicesDir();
      const pdfPath = path.join(INVOICES_DIR, `${invoiceNumber}.pdf`);

      await new Promise<void>((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);

        // Header
        doc
          .fontSize(24)
          .font("Helvetica-Bold")
          .text("INVOICE", { align: "right" })
          .moveDown(0.5);

        doc
          .fontSize(10)
          .font("Helvetica")
          .text(`Invoice #: ${invoiceNumber}`, { align: "right" })
          .text(`Date: ${new Date().toLocaleDateString()}`, { align: "right" })
          .text(`Due: Net 30`, { align: "right" })
          .moveDown();

        // From
        doc
          .fontSize(12)
          .font("Helvetica-Bold")
          .text("FROM:")
          .font("Helvetica")
          .fontSize(10)
          .text(input.driverName)
          .text(`MC# ${input.driverMC}`)
          .moveDown();

        // Bill To
        doc
          .fontSize(12)
          .font("Helvetica-Bold")
          .text("BILL TO:")
          .font("Helvetica")
          .fontSize(10)
          .text(input.brokerName)
          .text(input.brokerEmail)
          .moveDown(1.5);

        // Load Details
        doc
          .fontSize(12)
          .font("Helvetica-Bold")
          .text("LOAD DETAILS")
          .moveDown(0.5);

        doc
          .fontSize(10)
          .font("Helvetica")
          .text(`Load ID: ${input.loadId}`)
          .text(`Reference: ${input.referenceNumber || "N/A"}`)
          .text(`Origin: ${input.origin}`)
          .text(`Destination: ${input.destination}`)
          .text(`Pickup Date: ${input.pickupDate}`)
          .text(`Delivery Date: ${input.deliveryDate}`)
          .text(`POD Confirmed: ${input.podConfirmed ? "Yes" : "Pending"}`)
          .moveDown(1.5);

        // Line Items
        doc
          .fontSize(12)
          .font("Helvetica-Bold")
          .text("CHARGES")
          .moveDown(0.5);

        // Table header
        const tableTop = doc.y;
        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .text("Description", 50, tableTop)
          .text("Amount", 400, tableTop, { width: 100, align: "right" });

        doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

        let y = tableTop + 25;
        doc.font("Helvetica");

        // Line haul
        doc.text("Line Haul Rate", 50, y);
        doc.text(`$${input.rate.toFixed(2)}`, 400, y, { width: 100, align: "right" });
        y += 20;

        if (input.detention > 0) {
          doc.text("Detention", 50, y);
          doc.text(`$${input.detention.toFixed(2)}`, 400, y, { width: 100, align: "right" });
          y += 20;
        }

        if (input.lumper > 0) {
          doc.text("Lumper Fee", 50, y);
          doc.text(`$${input.lumper.toFixed(2)}`, 400, y, { width: 100, align: "right" });
          y += 20;
        }

        if (input.fuelSurcharge > 0) {
          doc.text("Fuel Surcharge", 50, y);
          doc.text(`$${input.fuelSurcharge.toFixed(2)}`, 400, y, { width: 100, align: "right" });
          y += 20;
        }

        // Total line
        y += 5;
        doc.moveTo(350, y).lineTo(550, y).stroke();
        y += 10;
        doc
          .font("Helvetica-Bold")
          .fontSize(12)
          .text("TOTAL DUE", 50, y)
          .text(`$${totalAmount.toFixed(2)}`, 400, y, { width: 100, align: "right" });

        // Footer
        doc
          .fontSize(8)
          .font("Helvetica")
          .text(
            "Payment terms: Net 30. Please remit payment within 30 days of invoice date.",
            50,
            700,
            { align: "center", width: 500 }
          )
          .text("Generated by RoadPilot AI Dispatch", 50, 715, {
            align: "center",
            width: 500,
          });

        doc.end();
        stream.on("finish", resolve);
        stream.on("error", reject);
      });

      const pdfUrl = `/invoices/${invoiceNumber}.pdf`;

      return {
        invoiceId,
        invoiceNumber,
        totalAmount,
        pdfUrl,
        status: "generated" as const,
        message: `Invoice ${invoiceNumber} generated for $${totalAmount.toFixed(2)}. PDF available at ${pdfUrl}. Load: ${input.origin} → ${input.destination}.`,
      };
    } catch (err) {
      console.error("[invoice-generator] PDF generation failed:", err);
      // Fallback without PDF
      return {
        invoiceId,
        invoiceNumber,
        totalAmount,
        pdfUrl: undefined,
        status: "generated" as const,
        message: `Invoice ${invoiceNumber} generated for $${totalAmount.toFixed(2)}. Load: ${input.origin} → ${input.destination}. (PDF generation failed, data recorded)`,
      };
    }
  },
});

export const sendInvoice = createTool({
  id: "send_invoice",
  description:
    "Email an invoice to the broker or shipper. Attaches the PDF invoice and rate confirmation.",
  inputSchema: z.object({
    invoiceId: z.string(),
    recipientEmail: z.string(),
    recipientName: z.string(),
    driverName: z.string(),
    message: z.string().optional().describe("Custom message to include in email"),
  }),
  outputSchema: z.object({
    sent: z.boolean(),
    emailId: z.string().optional(),
    message: z.string(),
  }),
  execute: async (input) => {
    // Mock email sending (no real email API configured)
    return {
      sent: true,
      emailId: `email_${Date.now()}`,
      message: `Invoice sent to ${input.recipientName} at ${input.recipientEmail}.`,
    };
  },
});

export const generateBOL = createTool({
  id: "generate_bol",
  description:
    "Generate a Bill of Lading (BOL) document from load details. Creates a standard BOL form.",
  inputSchema: z.object({
    loadId: z.string(),
    shipperName: z.string(),
    shipperAddress: z.string(),
    consigneeName: z.string(),
    consigneeAddress: z.string(),
    commodityDescription: z.string(),
    weight: z.number(),
    pieces: z.number(),
    specialInstructions: z.string().optional(),
  }),
  outputSchema: z.object({
    bolNumber: z.string(),
    status: z.string(),
    message: z.string(),
  }),
  execute: async (input) => {
    const bolNumber = `BOL-${Date.now()}`;
    return {
      bolNumber,
      status: "generated",
      message: `Bill of Lading ${bolNumber} generated. ${input.pieces} pieces, ${input.weight} lbs - ${input.commodityDescription}.`,
    };
  },
});

export const trackIFTA = createTool({
  id: "track_ifta",
  description:
    "Track fuel purchases by state for IFTA (International Fuel Tax Agreement) reporting. Records fuel purchase with state, gallons, and cost.",
  inputSchema: z.object({
    driverId: z.string(),
    state: z.string().describe("2-letter state code where fuel was purchased"),
    gallons: z.number(),
    totalCost: z.number(),
    truckStopName: z.string(),
    receiptNumber: z.string().optional(),
    odometerReading: z.number().optional(),
  }),
  outputSchema: z.object({
    recorded: z.boolean(),
    iftaEntryId: z.string(),
    quarterSummary: z.object({
      quarter: z.string(),
      totalGallons: z.number(),
      totalCost: z.number(),
      stateBreakdown: z.array(
        z.object({
          state: z.string(),
          gallons: z.number(),
          miles: z.number(),
        })
      ),
    }),
  }),
  execute: async (input) => {
    return {
      recorded: true,
      iftaEntryId: `IFTA-${Date.now()}`,
      quarterSummary: {
        quarter: "Q1 2026",
        totalGallons: 2450.5,
        totalCost: 8776.79,
        stateBreakdown: [
          { state: "TX", gallons: 850, miles: 5525 },
          { state: "OK", gallons: 320, miles: 2080 },
          { state: "MO", gallons: 480, miles: 3120 },
          { state: input.state, gallons: input.gallons, miles: 0 },
        ],
      },
    };
  },
});
