import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { demoSession, getActiveVoiceSession, updateTripStatus } from "./demo-session.js";
import { TwilioCallSession, getSessionByCallId, type NegotiationResult } from "../services/twilio-call-service.js";

export const initiateBrokerCall = createTool({
  id: "initiate_broker_call",
  description:
    "Initiate an outbound phone call to a broker to negotiate load rates. The AI agent will call the broker, negotiate rates conversationally, and report back with the result.",
  inputSchema: z.object({
    brokerPhone: z.string().describe("Broker's phone number"),
    brokerName: z.string().describe("Broker's name or company"),
    loadId: z.string().describe("The load ID being negotiated"),
    driverName: z.string().describe("Driver's name for introduction"),
    driverMC: z.string().describe("Driver's MC number"),
    equipmentType: z.string().describe("Equipment type available"),
    targetRate: z.number().describe("Target rate per mile the driver wants"),
    minimumRate: z.number().describe("Absolute minimum rate per mile"),
    loadDetails: z.object({
      origin: z.string(),
      destination: z.string(),
      pickupDate: z.string(),
      weight: z.number().optional(),
    }),
    negotiationStyle: z
      .enum(["firm", "moderate", "flexible"])
      .default("moderate")
      .describe("How aggressively to negotiate"),
  }),
  outputSchema: z.object({
    callId: z.string(),
    status: z.enum(["initiated", "in_progress", "completed", "failed", "no_answer"]),
    message: z.string(),
    estimatedDuration: z.string(),
  }),
  execute: async (input) => {
    // Demo override: route ALL calls to the verified demo number (Twilio trial limitation)
    const DEMO_PHONE = process.env.DEMO_BROKER_PHONE || "+16479377325";
    const actualPhone = DEMO_PHONE;

    // Save to demo session
    demoSession.selectedBroker = {
      name: input.brokerName,
      phone: actualPhone,
    };
    demoSession.brokerCallStartTime = Date.now();

    try {
      const session = new TwilioCallSession({
        brokerPhone: actualPhone,
        brokerName: input.brokerName,
        loadDetails: {
          loadId: input.loadId,
          origin: input.loadDetails.origin,
          destination: input.loadDetails.destination,
          distance: demoSession.selectedLoad?.distance || 500,
          pickupDate: input.loadDetails.pickupDate,
          rate: demoSession.selectedLoad?.rate || input.targetRate * (demoSession.selectedLoad?.distance || 500),
          ratePerMile: demoSession.selectedLoad?.ratePerMile || input.targetRate,
          weight: input.loadDetails.weight,
          commodity: demoSession.selectedLoad?.commodity,
          equipmentType: input.equipmentType,
        },
        targetRate: input.targetRate,
        minimumRate: input.minimumRate,
        driverName: input.driverName,
        driverMC: input.driverMC,
        negotiationStyle: input.negotiationStyle,
      });

      // Register callback to auto-notify the driver when call completes
      session.onComplete((result: NegotiationResult) => {
        console.log(`[Broker Call] Call completed. Agreed: ${result.agreed}, Rate: $${result.negotiatedRatePerMile}/mi`);

        // Save result to demo session
        demoSession.brokerCallResult = {
          agreed: result.agreed,
          negotiatedRate: result.negotiatedRate,
          negotiatedRatePerMile: result.negotiatedRatePerMile,
          transcript: result.transcript,
          callDuration: result.callDuration,
        };

        if (result.agreed && result.negotiatedRatePerMile) {
          demoSession.agreedRate = result.negotiatedRate;
          demoSession.agreedRatePerMile = result.negotiatedRatePerMile;
        }

        // Auto-notify the active voice session so Tasha reports back to the driver
        const voiceSession = getActiveVoiceSession();
        if (voiceSession) {
          const load = demoSession.selectedLoad;
          const brokerName = input.brokerName;
          let msg: string;

          if (result.agreed && result.negotiatedRatePerMile) {
            msg = `[SYSTEM EVENT - Broker call completed] I just finished the call with ${brokerName}. Great news - they agreed to $${result.negotiatedRatePerMile.toFixed(2)} per mile${result.negotiatedRate ? ` ($${result.negotiatedRate} total)` : ""}. The load is from ${load?.origin?.city || "origin"} to ${load?.destination?.city || "destination"}. They'll send the rate confirmation shortly. Should I confirm and book this load for you?`;
          } else {
            msg = `[SYSTEM EVENT - Broker call completed] I just finished the call with ${brokerName}. Unfortunately we couldn't agree on a rate. ${result.notes}. Would you like me to try another broker or adjust the target rate?`;
          }

          // Small delay to ensure the call cleanup finishes first
          setTimeout(() => {
            voiceSession.injectSystemMessage(msg).catch((err) => {
              console.error(`[Broker Call] Failed to notify voice session:`, err);
            });
          }, 2000);
        }
      });

      const { callSid, status } = await session.startCall();
      demoSession.brokerCallId = session.callId;

      // Update matching trip to "negotiating"
      const matchingTrip = demoSession.trips.find(
        (t) => t.brokerName === input.brokerName && t.status === "searching"
      );
      if (matchingTrip) {
        updateTripStatus(matchingTrip.id, "negotiating");
      }

      console.log(
        `[Broker Call] Initiated Twilio call ${callSid} to ${input.brokerName} at ${input.brokerPhone}`
      );

      return {
        callId: session.callId,
        status: "initiated" as const,
        message: `Calling ${input.brokerName} at ${input.brokerPhone} about load ${input.loadId}. Target rate: $${input.targetRate}/mi. I'll negotiate and report back.`,
        estimatedDuration: "2-5 minutes",
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Broker Call] Failed to initiate call: ${errorMsg}`);

      const callId = `CALL-FAILED-${Date.now()}`;
      demoSession.brokerCallId = callId;

      return {
        callId,
        status: "failed" as const,
        message: `Failed to initiate call to ${input.brokerName}: ${errorMsg}. The driver may need to call manually at ${input.brokerPhone}.`,
        estimatedDuration: "N/A",
      };
    }
  },
});

export const getBrokerCallStatus = createTool({
  id: "get_broker_call_status",
  description:
    "Check the status and outcome of an ongoing or completed broker call made by the AI phone agent.",
  inputSchema: z.object({
    callId: z.string().describe("The call ID to check"),
  }),
  outputSchema: z.object({
    callId: z.string(),
    status: z.enum([
      "in_progress",
      "completed",
      "failed",
      "no_answer",
      "voicemail",
    ]),
    duration: z.number().optional().describe("Call duration in seconds"),
    outcome: z
      .object({
        agreed: z.boolean(),
        agreedRate: z.number().optional(),
        brokerCounterOffer: z.number().optional(),
        notes: z.string(),
        nextSteps: z.string(),
      })
      .optional(),
    transcript: z.string().optional(),
  }),
  execute: async (input) => {
    const session = getSessionByCallId(input.callId);

    if (!session) {
      // No active session — might be an old call ID
      return {
        callId: input.callId,
        status: "failed" as const,
        transcript: "Call session not found. The call may have already ended.",
      };
    }

    const state = session.currentState;
    const transcript = session.getTranscript();
    const result = session.getResult();

    if (state === "completed" && result) {
      // Save to demo session
      if (result.agreed && result.negotiatedRatePerMile) {
        demoSession.agreedRate = result.negotiatedRate;
        demoSession.agreedRatePerMile = result.negotiatedRatePerMile;
        demoSession.brokerCallResult = {
          agreed: true,
          negotiatedRate: result.negotiatedRate,
          negotiatedRatePerMile: result.negotiatedRatePerMile,
          transcript: result.transcript,
          callDuration: result.callDuration,
        };
      }

      return {
        callId: input.callId,
        status: "completed" as const,
        duration: result.callDuration,
        outcome: {
          agreed: result.agreed,
          agreedRate: result.negotiatedRatePerMile,
          brokerCounterOffer: result.brokerCounterOffer,
          notes: result.notes,
          nextSteps: result.agreed
            ? "Rate confirmation will be emailed. Confirm pickup details."
            : "Consider adjusting rate or trying another broker.",
        },
        transcript: transcript.join("\n"),
      };
    }

    if (state === "failed") {
      return {
        callId: input.callId,
        status: "failed" as const,
        transcript: "Call failed to connect.",
      };
    }

    // Still in progress
    const statusMap: Record<string, string> = {
      idle: "in_progress",
      ringing: "in_progress",
      connected: "in_progress",
      negotiating: "in_progress",
    };

    return {
      callId: input.callId,
      status: (statusMap[state] || "in_progress") as "in_progress",
      duration: Math.floor((Date.now() - (demoSession.brokerCallStartTime || Date.now())) / 1000),
      transcript: transcript.length > 0
        ? transcript.join("\n")
        : `[System] ${state === "ringing" ? "Ringing..." : "Connected, negotiating..."}`,
    };
  },
});

export const confirmLoad = createTool({
  id: "confirm_load",
  description:
    "Confirm a load booking after successful broker negotiation. Records the agreed rate and booking details.",
  inputSchema: z.object({
    loadId: z.string(),
    driverId: z.string(),
    brokerName: z.string(),
    agreedRate: z.number().describe("Agreed rate for the load (total)"),
    agreedRatePerMile: z.number(),
    pickupDate: z.string(),
    deliveryDate: z.string(),
    origin: z.string(),
    destination: z.string(),
    specialInstructions: z.string().optional(),
  }),
  outputSchema: z.object({
    bookingId: z.string(),
    confirmed: z.boolean(),
    rateConSent: z.boolean(),
    message: z.string(),
  }),
  execute: async (input) => {
    const bookingId = `BK-${Date.now()}`;

    // Save to demo session
    demoSession.bookingId = bookingId;
    demoSession.agreedRate = input.agreedRate;
    demoSession.agreedRatePerMile = input.agreedRatePerMile;

    // Update matching trip to "booked" with negotiated rate
    const matchingTrip = demoSession.trips.find(
      (t) => t.brokerName === input.brokerName && (t.status === "negotiating" || t.status === "searching")
    );
    if (matchingTrip) {
      updateTripStatus(matchingTrip.id, "booked");
      matchingTrip.rate = input.agreedRate;
      matchingTrip.ratePerMile = input.agreedRatePerMile;
    }

    return {
      bookingId,
      confirmed: true,
      rateConSent: true,
      message: `Load confirmed! Booking ${bookingId}. ${input.origin} → ${input.destination} at $${input.agreedRatePerMile}/mi ($${input.agreedRate} total). Rate confirmation sent to ${input.brokerName}. Pickup: ${input.pickupDate}.`,
    };
  },
});
