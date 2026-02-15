export interface ActionButton {
  label: string;
  action: string; // "start_trip" | "navigate" | "dismiss" | "download" | "reserve" | "call"
  data?: Record<string, unknown>;
}

export interface ActionItem {
  type: string;
  title: string;
  summary: string;
  data: Record<string, unknown>;
  actionButtons: ActionButton[];
}

interface ToolCallInfo {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}

export function extractActionItem(toolCall: ToolCallInfo): ActionItem | null {
  const { toolName, args, result } = toolCall;
  const res = result as Record<string, unknown>;

  switch (toolName) {
    case "searchLoads": {
      const loads = (res?.loads as Array<Record<string, unknown>>) || [];
      if (loads.length === 0) return null;
      const origin = args.origin || "Origin";
      const dest = args.destination || "Destination";
      const topLoad = loads[0];
      const ratePerMile = topLoad?.ratePerMile || topLoad?.rate_per_mile;
      return {
        type: "loads",
        title: `${origin} to ${dest}`,
        summary: `Found ${loads.length} load${loads.length > 1 ? "s" : ""}${ratePerMile ? `, best at $${ratePerMile}/mi` : ""}`,
        data: { loads, origin, dest },
        actionButtons: [
          { label: "Start Trip", action: "start_trip", data: { load: topLoad } },
          { label: "Dismiss", action: "dismiss" },
        ],
      };
    }

    case "calculateProfitability": {
      const profit = res?.netProfit ?? res?.net_profit;
      const profitPerMile = res?.profitPerMile ?? res?.profit_per_mile;
      const recommendation = res?.recommendation as string;
      return {
        type: "profitability",
        title: "Profitability Analysis",
        summary: `Net profit: $${profit}${profitPerMile ? ` ($${profitPerMile}/mi)` : ""}`,
        data: res,
        actionButtons: [
          ...(recommendation?.toLowerCase().includes("recommend")
            ? [{ label: "Book Load", action: "start_trip" as const }]
            : []),
          { label: "Dismiss", action: "dismiss" },
        ],
      };
    }

    case "getHOSStatus": {
      const driveRemaining = res?.driveTimeRemaining ?? res?.drive_time_remaining;
      const onDutyRemaining = res?.onDutyTimeRemaining ?? res?.on_duty_time_remaining;
      const hours = typeof driveRemaining === "number" ? Math.floor(driveRemaining / 60) : "?";
      const mins = typeof driveRemaining === "number" ? driveRemaining % 60 : 0;
      return {
        type: "hos",
        title: "Hours of Service",
        summary: `Drive: ${hours}h ${mins}m remaining`,
        data: { driveRemaining, onDutyRemaining, ...res },
        actionButtons: [{ label: "Dismiss", action: "dismiss" }],
      };
    }

    case "planBreaks": {
      const breaks = (res?.breaks as Array<Record<string, unknown>>) || [];
      return {
        type: "breaks",
        title: "Break Plan",
        summary: `${breaks.length} break${breaks.length !== 1 ? "s" : ""} scheduled`,
        data: res,
        actionButtons: [{ label: "Dismiss", action: "dismiss" }],
      };
    }

    case "alertHOSViolation": {
      const urgency = res?.urgency as string;
      const message = res?.message as string;
      return {
        type: "hos_alert",
        title: `HOS ${urgency === "critical" ? "Alert" : "Warning"}`,
        summary: message || "Check your hours",
        data: res,
        actionButtons: [
          { label: "Find Parking", action: "navigate", data: { action: "searchParking" } },
          { label: "Dismiss", action: "dismiss" },
        ],
      };
    }

    case "searchFuelPrices": {
      const stations = (res?.stations as Array<Record<string, unknown>>) || [];
      if (stations.length === 0) return null;
      const cheapest = stations[0];
      const name = cheapest?.name || "Station";
      const price = cheapest?.price || cheapest?.dieselPrice;
      return {
        type: "fuel",
        title: `${name} $${price}/gal`,
        summary: `Cheapest of ${stations.length} stations nearby`,
        data: { stations },
        actionButtons: [
          { label: "Navigate", action: "navigate", data: { station: cheapest } },
          { label: "Dismiss", action: "dismiss" },
        ],
      };
    }

    case "calculateRouteFuel": {
      const stops = (res?.fuelStops as Array<Record<string, unknown>>) || [];
      const totalCost = res?.totalFuelCost ?? res?.total_fuel_cost;
      return {
        type: "route_fuel",
        title: "Fuel Route Plan",
        summary: `${stops.length} stop${stops.length !== 1 ? "s" : ""}${totalCost ? `, est. $${totalCost}` : ""}`,
        data: res,
        actionButtons: [{ label: "Dismiss", action: "dismiss" }],
      };
    }

    case "searchParking": {
      const locations = (res?.locations as Array<Record<string, unknown>>) || [];
      if (locations.length === 0) return null;
      const top = locations[0];
      const name = top?.name || "Truck Stop";
      return {
        type: "parking",
        title: `${name}`,
        summary: `${locations.length} parking option${locations.length !== 1 ? "s" : ""} found`,
        data: { locations },
        actionButtons: [
          { label: "Navigate", action: "navigate", data: { location: top } },
          { label: "Reserve", action: "reserve", data: { location: top } },
          { label: "Dismiss", action: "dismiss" },
        ],
      };
    }

    case "reserveSpot": {
      const confirmation = res?.reservationId || res?.confirmation;
      return {
        type: "reservation",
        title: "Parking Reserved",
        summary: `Confirmation: ${confirmation || "Confirmed"}`,
        data: res,
        actionButtons: [
          { label: "Navigate", action: "navigate" },
          { label: "Dismiss", action: "dismiss" },
        ],
      };
    }

    case "generateInvoice": {
      const invoiceNum = res?.invoiceNumber || res?.invoice_number;
      return {
        type: "invoice",
        title: `Invoice ${invoiceNum || ""}`,
        summary: "Invoice generated",
        data: res,
        actionButtons: [
          { label: "Download", action: "download", data: { type: "invoice" } },
          { label: "Dismiss", action: "dismiss" },
        ],
      };
    }

    case "sendInvoice": {
      return {
        type: "invoice_sent",
        title: "Invoice Sent",
        summary: `Sent to ${args.email || "broker"}`,
        data: res,
        actionButtons: [{ label: "Dismiss", action: "dismiss" }],
      };
    }

    case "generateBOL": {
      return {
        type: "bol",
        title: "Bill of Lading",
        summary: "BOL generated",
        data: res,
        actionButtons: [
          { label: "Download", action: "download", data: { type: "bol" } },
          { label: "Dismiss", action: "dismiss" },
        ],
      };
    }

    case "trackIFTA": {
      return {
        type: "ifta",
        title: "IFTA Recorded",
        summary: `Fuel purchase tracked in ${args.state || "state"}`,
        data: res,
        actionButtons: [{ label: "Dismiss", action: "dismiss" }],
      };
    }

    case "initiateBrokerCall": {
      const callId = res?.callId || res?.call_id;
      return {
        type: "broker_call",
        title: "Calling Broker",
        summary: `Call initiated${callId ? ` (${callId})` : ""}`,
        data: res,
        actionButtons: [{ label: "Dismiss", action: "dismiss" }],
      };
    }

    case "getBrokerCallStatus": {
      const outcome = res?.outcome as string;
      const agreedRate = res?.agreedRate ?? res?.agreed_rate;
      return {
        type: "broker_result",
        title: "Broker Call Result",
        summary: agreedRate ? `Agreed at $${agreedRate}/mi` : outcome || "Call completed",
        data: res,
        actionButtons: [
          ...(agreedRate ? [{ label: "Confirm Booking", action: "start_trip" as const }] : []),
          { label: "Dismiss", action: "dismiss" },
        ],
      };
    }

    case "confirmLoad": {
      return {
        type: "load_confirmed",
        title: "Load Booked",
        summary: "Load confirmed and booked",
        data: res,
        actionButtons: [
          { label: "Start Trip", action: "start_trip" },
          { label: "Dismiss", action: "dismiss" },
        ],
      };
    }

    default:
      return null;
  }
}
