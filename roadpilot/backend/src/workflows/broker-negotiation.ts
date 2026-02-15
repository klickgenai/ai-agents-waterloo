import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

const validateNegotiationParams = createStep({
  id: "validate-negotiation",
  description: "Validate negotiation parameters before initiating call",
  inputSchema: z.object({
    loadId: z.string(),
    brokerPhone: z.string(),
    brokerName: z.string(),
    driverName: z.string(),
    driverMC: z.string(),
    equipmentType: z.string(),
    targetRate: z.number(),
    minimumRate: z.number(),
    origin: z.string(),
    destination: z.string(),
    pickupDate: z.string(),
    negotiationStyle: z.enum(["firm", "moderate", "flexible"]).default("moderate"),
  }),
  outputSchema: z.object({
    valid: z.boolean(),
    callParams: z.object({
      loadId: z.string(),
      brokerPhone: z.string(),
      brokerName: z.string(),
      driverName: z.string(),
      driverMC: z.string(),
      equipmentType: z.string(),
      targetRate: z.number(),
      minimumRate: z.number(),
      origin: z.string(),
      destination: z.string(),
      pickupDate: z.string(),
      negotiationStyle: z.string(),
      marketRateContext: z.string(),
    }),
    validationMessage: z.string(),
  }),
  execute: async ({ inputData }) => {
    // Validate minimum rate is reasonable
    if (inputData.minimumRate > inputData.targetRate) {
      return {
        valid: false,
        callParams: {
          ...inputData,
          marketRateContext: "",
        },
        validationMessage:
          "Minimum rate cannot be higher than target rate. Please adjust.",
      };
    }

    // Mock market rate context - in production would fetch from DAT rate data
    const marketRateContext = `Current market rate for ${inputData.origin} to ${inputData.destination}: $3.45-$3.90/mile. Your target of $${inputData.targetRate}/mile is within market range.`;

    return {
      valid: true,
      callParams: {
        ...inputData,
        marketRateContext,
      },
      validationMessage: "Parameters validated. Ready to call broker.",
    };
  },
});

const initiateCallStep = createStep({
  id: "initiate-call",
  description: "Place outbound call to broker via Smallest AI Atoms",
  inputSchema: z.object({
    valid: z.boolean(),
    callParams: z.object({
      loadId: z.string(),
      brokerPhone: z.string(),
      brokerName: z.string(),
      driverName: z.string(),
      driverMC: z.string(),
      equipmentType: z.string(),
      targetRate: z.number(),
      minimumRate: z.number(),
      origin: z.string(),
      destination: z.string(),
      pickupDate: z.string(),
      negotiationStyle: z.string(),
      marketRateContext: z.string(),
    }),
    validationMessage: z.string(),
  }),
  outputSchema: z.object({
    callId: z.string(),
    status: z.string(),
    message: z.string(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.valid) {
      return {
        callId: "",
        status: "aborted",
        message: inputData.validationMessage,
      };
    }

    const { callParams } = inputData;

    // TODO: Replace with real Smallest AI Atoms API
    // const atomsClient = new SmallestAI({ apiKey: process.env.SMALLEST_AI_API_KEY });
    // const call = await atomsClient.calls.create({
    //   to: callParams.brokerPhone,
    //   agent: {
    //     name: "RoadPilot Dispatch",
    //     instructions: `You are calling on behalf of ${callParams.driverName} (MC# ${callParams.driverMC})...`,
    //     knowledge: callParams.marketRateContext,
    //   },
    //   parameters: {
    //     targetRate: callParams.targetRate,
    //     minimumRate: callParams.minimumRate,
    //     negotiationStyle: callParams.negotiationStyle,
    //   }
    // });

    const callId = `CALL-${Date.now()}`;

    return {
      callId,
      status: "initiated",
      message: `Calling ${callParams.brokerName} at ${callParams.brokerPhone}. Negotiating for load ${callParams.loadId}. Target: $${callParams.targetRate}/mi, won't go below $${callParams.minimumRate}/mi.`,
    };
  },
});

const processOutcomeStep = createStep({
  id: "process-outcome",
  description: "Process the call outcome and take appropriate action",
  inputSchema: z.object({
    callId: z.string(),
    status: z.string(),
    message: z.string(),
  }),
  outputSchema: z.object({
    callId: z.string(),
    negotiationComplete: z.boolean(),
    outcome: z.object({
      agreed: z.boolean(),
      finalRate: z.number().optional(),
      summary: z.string(),
      nextAction: z.string(),
    }),
  }),
  execute: async ({ inputData }) => {
    if (inputData.status === "aborted") {
      return {
        callId: inputData.callId,
        negotiationComplete: false,
        outcome: {
          agreed: false,
          summary: inputData.message,
          nextAction: "Fix parameters and try again.",
        },
      };
    }

    // TODO: In production, poll Atoms API for call completion
    // Mock: simulate successful negotiation
    return {
      callId: inputData.callId,
      negotiationComplete: true,
      outcome: {
        agreed: true,
        finalRate: 3.75,
        summary:
          "Broker accepted $3.75/mile. Rate confirmation being sent. Pickup confirmed for tomorrow at 8 AM.",
        nextAction:
          "Rate confirmation will arrive via email within 30 minutes. Load is booked.",
      },
    };
  },
});

export const brokerNegotiationWorkflow = createWorkflow({
  id: "broker-negotiation",
  description:
    "End-to-end broker negotiation: validate parameters, place call via Atoms, process outcome, confirm booking",
  inputSchema: z.object({
    loadId: z.string(),
    brokerPhone: z.string(),
    brokerName: z.string(),
    driverName: z.string(),
    driverMC: z.string(),
    equipmentType: z.string(),
    targetRate: z.number(),
    minimumRate: z.number(),
    origin: z.string(),
    destination: z.string(),
    pickupDate: z.string(),
    negotiationStyle: z.enum(["firm", "moderate", "flexible"]).default("moderate"),
  }),
  outputSchema: z.object({
    callId: z.string(),
    negotiationComplete: z.boolean(),
    outcome: z.object({
      agreed: z.boolean(),
      finalRate: z.number().optional(),
      summary: z.string(),
      nextAction: z.string(),
    }),
  }),
})
  .then(validateNegotiationParams)
  .then(initiateCallStep)
  .then(processOutcomeStep)
  .commit();
