import {
  pgTable,
  text,
  varchar,
  integer,
  decimal,
  boolean,
  timestamp,
  jsonb,
  uuid,
  pgEnum,
} from "drizzle-orm/pg-core";

// Enums
export const equipmentTypeEnum = pgEnum("equipment_type", [
  "dry_van",
  "reefer",
  "flatbed",
  "step_deck",
  "other",
]);

export const loadStatusEnum = pgEnum("load_status", [
  "searching",
  "negotiating",
  "booked",
  "in_transit",
  "delivered",
  "invoiced",
  "paid",
  "cancelled",
]);

export const dutyStatusEnum = pgEnum("duty_status", [
  "driving",
  "on_duty",
  "sleeper_berth",
  "off_duty",
]);

// Driver Profiles
export const driverProfiles = pgTable("driver_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 20 }),
  mcNumber: varchar("mc_number", { length: 20 }),
  dotNumber: varchar("dot_number", { length: 20 }),
  cdlNumber: varchar("cdl_number", { length: 50 }),
  cdlState: varchar("cdl_state", { length: 2 }),
  equipmentType: equipmentTypeEnum("equipment_type").default("dry_van"),
  truckYear: integer("truck_year"),
  truckMake: varchar("truck_make", { length: 50 }),
  truckModel: varchar("truck_model", { length: 50 }),
  tankCapacity: integer("tank_capacity").default(150),
  avgMPG: decimal("avg_mpg", { precision: 4, scale: 1 }).default("6.5"),
  preferredLanes: jsonb("preferred_lanes").$type<
    Array<{ origin: string; destination: string; minRate: number }>
  >(),
  avoidStates: jsonb("avoid_states").$type<string[]>(),
  maxWeight: integer("max_weight").default(45000),
  hasHazmat: boolean("has_hazmat").default(false),
  hasTWIC: boolean("has_twic").default(false),
  hasTankerEndorsement: boolean("has_tanker_endorsement").default(false),
  homeBase: varchar("home_base", { length: 100 }),
  minRatePerMile: decimal("min_rate_per_mile", { precision: 5, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Loads (booked/completed)
export const loads = pgTable("loads", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: varchar("external_id", { length: 100 }),
  driverId: uuid("driver_id").references(() => driverProfiles.id),
  status: loadStatusEnum("status").default("searching"),
  originCity: varchar("origin_city", { length: 100 }).notNull(),
  originState: varchar("origin_state", { length: 2 }),
  originZip: varchar("origin_zip", { length: 10 }),
  destinationCity: varchar("destination_city", { length: 100 }).notNull(),
  destinationState: varchar("destination_state", { length: 2 }),
  destinationZip: varchar("destination_zip", { length: 10 }),
  distance: integer("distance"),
  rate: decimal("rate", { precision: 10, scale: 2 }),
  ratePerMile: decimal("rate_per_mile", { precision: 6, scale: 2 }),
  weight: integer("weight"),
  equipmentType: equipmentTypeEnum("equipment_type"),
  hazmat: boolean("hazmat").default(false),
  brokerName: varchar("broker_name", { length: 255 }),
  brokerPhone: varchar("broker_phone", { length: 20 }),
  brokerEmail: varchar("broker_email", { length: 255 }),
  pickupDate: timestamp("pickup_date"),
  deliveryDate: timestamp("delivery_date"),
  actualPickupDate: timestamp("actual_pickup_date"),
  actualDeliveryDate: timestamp("actual_delivery_date"),
  rateConNumber: varchar("rate_con_number", { length: 100 }),
  bolNumber: varchar("bol_number", { length: 100 }),
  invoiceNumber: varchar("invoice_number", { length: 100 }),
  detention: decimal("detention", { precision: 8, scale: 2 }).default("0"),
  lumper: decimal("lumper", { precision: 8, scale: 2 }).default("0"),
  fuelSurcharge: decimal("fuel_surcharge", { precision: 8, scale: 2 }).default(
    "0"
  ),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// HOS Logs
export const hosLogs = pgTable("hos_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  driverId: uuid("driver_id")
    .references(() => driverProfiles.id)
    .notNull(),
  status: dutyStatusEnum("status").notNull(),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time"),
  latitude: decimal("latitude", { precision: 10, scale: 6 }),
  longitude: decimal("longitude", { precision: 10, scale: 6 }),
  location: varchar("location", { length: 255 }),
  odometerStart: integer("odometer_start"),
  odometerEnd: integer("odometer_end"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Fuel Purchases (for IFTA)
export const fuelPurchases = pgTable("fuel_purchases", {
  id: uuid("id").primaryKey().defaultRandom(),
  driverId: uuid("driver_id")
    .references(() => driverProfiles.id)
    .notNull(),
  state: varchar("state", { length: 2 }).notNull(),
  gallons: decimal("gallons", { precision: 8, scale: 2 }).notNull(),
  pricePerGallon: decimal("price_per_gallon", { precision: 6, scale: 3 }),
  totalCost: decimal("total_cost", { precision: 10, scale: 2 }).notNull(),
  truckStopName: varchar("truck_stop_name", { length: 255 }),
  receiptNumber: varchar("receipt_number", { length: 100 }),
  odometerReading: integer("odometer_reading"),
  purchaseDate: timestamp("purchase_date").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Broker Calls
export const brokerCalls = pgTable("broker_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  driverId: uuid("driver_id").references(() => driverProfiles.id),
  loadId: uuid("load_id").references(() => loads.id),
  externalCallId: varchar("external_call_id", { length: 100 }),
  brokerName: varchar("broker_name", { length: 255 }),
  brokerPhone: varchar("broker_phone", { length: 20 }),
  targetRate: decimal("target_rate", { precision: 6, scale: 2 }),
  minimumRate: decimal("minimum_rate", { precision: 6, scale: 2 }),
  agreedRate: decimal("agreed_rate", { precision: 6, scale: 2 }),
  status: varchar("status", { length: 50 }),
  duration: integer("duration"),
  transcript: text("transcript"),
  outcome: jsonb("outcome"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Driver Preferences / Memory
export const driverPreferences = pgTable("driver_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  driverId: uuid("driver_id")
    .references(() => driverProfiles.id)
    .notNull(),
  key: varchar("key", { length: 100 }).notNull(),
  value: jsonb("value").notNull(),
  source: varchar("source", { length: 50 }).default("inferred"),
  confidence: decimal("confidence", { precision: 3, scale: 2 }).default("0.5"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Voice Sessions
export const voiceSessions = pgTable("voice_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  driverId: uuid("driver_id")
    .references(() => driverProfiles.id)
    .notNull(),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  transcript: jsonb("transcript").$type<
    Array<{ role: string; text: string; timestamp: number }>
  >(),
  summary: text("summary"),
});

// Action Items (from voice sessions)
export const actionItemStatusEnum = pgEnum("action_item_status", [
  "pending",
  "completed",
  "dismissed",
]);

export const actionItems = pgTable("action_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").references(() => voiceSessions.id),
  driverId: uuid("driver_id")
    .references(() => driverProfiles.id)
    .notNull(),
  type: varchar("type", { length: 50 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  summary: text("summary"),
  data: jsonb("data").$type<Record<string, unknown>>(),
  actionButtons: jsonb("action_buttons").$type<
    Array<{ label: string; action: string; data?: Record<string, unknown> }>
  >(),
  status: actionItemStatusEnum("status").default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
});
