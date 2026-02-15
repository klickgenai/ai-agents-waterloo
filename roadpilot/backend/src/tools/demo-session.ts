/**
 * Shared demo session state across all tools.
 * Provides continuity during the demo walkthrough so data flows
 * consistently from load search -> negotiation -> booking -> invoicing.
 */

export type TripStatus = "searching" | "negotiating" | "booked" | "in_transit" | "delivered";

export interface Trip {
  id: string;
  origin: string;
  destination: string;
  rate: number;
  ratePerMile: number;
  distance: number;
  weight: number;
  equipmentType: string;
  brokerName: string;
  brokerPhone: string;
  pickupDate: string;
  deliveryDate: string;
  status: TripStatus;
  commodity: string;
  createdAt: string;
}

export interface DemoSession {
  selectedLoad?: {
    loadId: string;
    origin: { city: string; state: string };
    destination: { city: string; state: string };
    rate: number;
    ratePerMile: number;
    distance: number;
    equipmentType: string;
    brokerName: string;
    brokerPhone: string;
    brokerEmail?: string;
    pickupDate: string;
    deliveryDate: string;
    weight?: number;
    commodity?: string;
  };
  selectedBroker?: {
    name: string;
    phone: string;
    email?: string;
    mcNumber?: string;
  };
  agreedRate?: number;
  agreedRatePerMile?: number;
  bookingId?: string;
  brokerCallStartTime?: number;
  brokerCallId?: string;
  driverLocation?: {
    city: string;
    state: string;
    lat: number;
    lng: number;
  };
  brokerCallResult?: {
    agreed: boolean;
    negotiatedRate?: number;
    negotiatedRatePerMile?: number;
    transcript?: string[];
    callDuration?: number;
  };
  trips: Trip[];
}

export const demoSession: DemoSession = { trips: [] };

// Reference to the active voice session for post-call notifications
// Stored separately to avoid circular typing issues
let _activeVoiceSession: { injectSystemMessage: (msg: string) => Promise<void> } | null = null;

export function setActiveVoiceSession(session: { injectSystemMessage: (msg: string) => Promise<void> } | null): void {
  _activeVoiceSession = session;
}

export function getActiveVoiceSession(): { injectSystemMessage: (msg: string) => Promise<void> } | null {
  return _activeVoiceSession;
}

/**
 * Reset demo session to start fresh.
 */
export function resetDemoSession(): void {
  const trips = demoSession.trips;
  Object.keys(demoSession).forEach((key) => {
    delete (demoSession as any)[key];
  });
  demoSession.trips = trips?.length ? [] : [];
}

let tripCounter = 0;

export function addTrip(data: Omit<Trip, "id" | "createdAt">): Trip {
  const trip: Trip = {
    ...data,
    id: `trip-${++tripCounter}`,
    createdAt: new Date().toISOString(),
  };
  demoSession.trips.push(trip);
  return trip;
}

export function deleteTrip(id: string): boolean {
  const idx = demoSession.trips.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  demoSession.trips.splice(idx, 1);
  return true;
}

export function updateTripStatus(id: string, status: TripStatus): Trip | null {
  const trip = demoSession.trips.find((t) => t.id === id);
  if (!trip) return null;
  trip.status = status;
  return trip;
}
