# RoadPilot

**AI-Powered Freight Dispatch Assistant for Truck Drivers**

RoadPilot is a voice-first dispatch system where drivers talk to "Tasha" — an AI dispatcher powered by Claude who handles load searching, broker negotiation via real phone calls, HOS tracking, fuel/parking lookups, invoicing, and more. Built with the Mastra agent framework, Smallest AI for voice, and Twilio for outbound broker calls.

> "Hey, it's Tasha. What can I help you with?"

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Voice Pipeline](#voice-pipeline)
- [Agent Tools](#agent-tools)
- [Broker Calling](#broker-calling)
- [API Reference](#api-reference)
- [WebSocket Protocol](#websocket-protocol)
- [Database Schema](#database-schema)
- [Dashboard](#dashboard)
- [iOS App](#ios-app)
- [Workflows](#workflows)
- [Development](#development)

---

## Features

### Voice Conversation
- **Natural speech interface** — drivers talk to Tasha like a real dispatcher
- **Real-time STT/TTS** — Smallest AI Pulse (speech-to-text) + Waves (text-to-speech)
- **Low-latency streaming** — first audio response in ~160ms, sentence-level TTS streaming
- **Barge-in support** — driver can interrupt Tasha mid-sentence
- **Smart filler phrases** — "Alright, let me check that..." while processing (50+ pre-cached phrases)
- **Client-side VAD** — Voice Activity Detection runs in-browser with adaptive noise floor

### Load Management
- **Load board search** — searches Direct Freight API or dynamic market data
- **Profitability analysis** — calculates fuel costs, deadhead, tolls, operating costs, net profit
- **Smart ranking** — loads sorted by profit per mile, not just rate
- **HOS-aware** — won't suggest loads the driver can't legally complete

### Broker Negotiation (Real Phone Calls)
- **AI-powered outbound calls** — Tasha calls brokers via Twilio and negotiates rates
- **Real-time negotiation** — Claude handles the conversation, Pulse STT transcribes, Waves TTS speaks
- **Configurable strategy** — firm, moderate, or flexible negotiation styles
- **Auto-reporting** — Tasha tells the driver the outcome when the call finishes

### Hours of Service
- **ELD integration** — real-time drive time, on-duty time, cycle time tracking
- **Break planning** — calculates optimal rest stops for remaining route
- **Violation alerts** — proactive warnings before HOS violations occur

### Fuel & Parking
- **Real-time GPS tracking** — uses driver's actual location via browser geolocation
- **Diesel price search** — finds cheapest fuel nearby with distance/price comparison
- **Route fuel planning** — optimal fuel stops for entire trip
- **Truck parking search** — availability, amenities, reservations
- **Parking scarcity alerts** — warns when parking is tight in the area

### Invoicing & Documentation
- **PDF invoice generation** — professional invoices with all required fields
- **Bill of Lading (BOL)** — generate and track BOL documents
- **IFTA fuel tracking** — log fuel purchases by state for tax reporting
- **Email delivery** — send invoices directly to brokers

### Dashboard
- **Real-time stats** — HOS remaining, weekly revenue, cheapest fuel, parking availability
- **Trip management** — view, track, and delete trips with status tracking
- **Action items** — actionable cards from voice sessions (accept loads, review calls, etc.)
- **GPS location display** — current city/state with reverse geocoding
- **Glassmorphism UI** — premium dark theme with translucent glass effects

---

## Architecture

### High-Level System Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        BROWSER (SPA)                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │   VAD    │  │  Audio   │  │Dashboard │  │  Trip Panel   │  │
│  │(mic→PCM) │  │ Playback │  │  Stats   │  │  Management   │  │
│  └────┬─────┘  └────▲─────┘  └────▲─────┘  └───────▲───────┘  │
│       │PCM 16kHz    │WAV         │REST           │REST        │
└───────┼─────────────┼────────────┼───────────────┼────────────┘
        │ WebSocket   │            │               │
┌───────▼─────────────┴────────────┴───────────────┴────────────┐
│                     EXPRESS SERVER                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   VoiceSession                            │  │
│  │  ┌─────────┐    ┌──────────┐    ┌────────────────────┐   │  │
│  │  │Pulse STT│───▶│  Claude  │───▶│TTSSentencePipeline │   │  │
│  │  │(16kHz)  │    │ (Mastra) │    │  (Waves 24kHz)     │   │  │
│  │  └─────────┘    │ 16 tools │    │  Chunk streaming   │   │  │
│  │                 └────┬─────┘    └────────────────────┘   │  │
│  │                      │ tool call                          │  │
│  │         ┌────────────▼────────────┐                       │  │
│  │         │   initiate_broker_call  │                       │  │
│  │         └────────────┬────────────┘                       │  │
│  └──────────────────────┼────────────────────────────────────┘  │
│                         │                                       │
│  ┌──────────────────────▼────────────────────────────────────┐  │
│  │              TwilioCallSession                             │  │
│  │  Twilio REST → Outbound Call → Media Stream WebSocket      │  │
│  │  Broker audio: mulaw 8kHz ↔ PCM 16kHz (Pulse STT)         │  │
│  │  AI response: Claude → Waves TTS 24kHz → mulaw 8kHz       │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Voice Pipeline Detail

```
Browser Mic (PCM 16kHz, 16-bit mono)
       │
       ▼
VAD (Web Audio API, adaptive noise floor)
       │ speech_start
       ▼
WebSocket binary frames → VoiceSession
       │
       ├─→ Audio buffer (while Pulse connects)
       │
       ▼
PulseSTTPipeline (wss://waves-api.smallest.ai)
       │ transcript
       ▼
Claude Agent (Mastra, streamed response)
       │ text-delta tokens
       ▼
TTSSentencePipeline
       │ split on sentence boundaries (.!?)
       ▼
TTSWebSocket (Waves, shared per session)
       │ PCM 24kHz chunks
       ├─→ Batch: 1 chunk first (~160ms), then 3 chunks (~480ms)
       ├─→ Add WAV header
       ▼
WebSocket → Browser AudioContext playback
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js + TypeScript (ES2022, ESM) |
| **Agent Framework** | [Mastra](https://mastra.ai) (`@mastra/core`) |
| **LLM** | Claude Sonnet 4.5 (primary), Haiku 4.5 (rate-limit fallback) |
| **Voice STT** | [Smallest AI Pulse](https://smallest.ai) — real-time speech-to-text |
| **Voice TTS** | [Smallest AI Waves](https://smallest.ai) — streaming text-to-speech |
| **Phone Calls** | [Twilio](https://twilio.com) — REST API + Media Streams WebSocket |
| **Web Server** | Express + WebSocket (`ws`) |
| **Database** | PostgreSQL + [Drizzle ORM](https://orm.drizzle.team) |
| **Validation** | Zod |
| **Testing** | Vitest |
| **Frontend** | Vanilla HTML/CSS/JS (single-page app, no build step) |
| **iOS** | Swift + URLSession + WebSocket (companion app) |

---

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL (optional — demo mode works without it)
- API keys (see [Environment Variables](#environment-variables))

### Setup

```bash
# Clone the repo
git clone https://github.com/klickgenai/ai-agents-waterloo.git
cd ai-agents-waterloo/roadpilot/backend

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your API keys (at minimum: ANTHROPIC_API_KEY + SMALLEST_API_KEY)

# Start development server
npm run dev
```

The server starts at **http://localhost:3000** with hot reload via `tsx watch`.

### For Broker Calling (Twilio)

```bash
# In a separate terminal, start ngrok
ngrok http 3000

# Copy the ngrok URL and set it in .env
# NGROK_URL=https://abc123.ngrok.io
```

### Verify

```bash
# Health check
curl http://localhost:3000/health

# Open the dashboard
open http://localhost:3000
```

---

## Environment Variables

Create a `.env` file in `roadpilot/backend/`:

```env
# ─── Required ─────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...          # Claude API key
SMALLEST_API_KEY=...                   # Smallest AI (Pulse STT + Waves TTS)

# ─── Twilio (for broker calling) ──────────────────────
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...             # Your Twilio phone number
NGROK_URL=https://abc123.ngrok.io     # Public URL for Twilio webhooks
DEMO_BROKER_PHONE=+16479377325        # All broker calls route here (trial limitation)

# ─── Database ─────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@localhost:5432/roadpilot

# ─── Optional API Keys ───────────────────────────────
DAT_API_KEY=...                        # DAT load board
TRUCKER_CLOUD_API_KEY=...             # ELD/HOS integration

# ─── Server ───────────────────────────────────────────
PORT=3000                              # Default: 3000
NODE_ENV=development
```

**Minimum to run:** `ANTHROPIC_API_KEY` + `SMALLEST_API_KEY` — voice works, tools use simulated data.

---

## Project Structure

```
roadpilot/
├── backend/
│   ├── src/
│   │   ├── index.ts                          # Express server, WS handlers, 18 API routes
│   │   ├── agents/
│   │   │   └── roadpilot-agent.ts            # Mastra agent "Tasha" — Claude + 16 tools
│   │   ├── tools/                            # Agent tool implementations
│   │   │   ├── load-search.ts                # Load board search + dynamic pricing
│   │   │   ├── hos-tracker.ts                # HOS status, breaks, violations
│   │   │   ├── fuel-finder.ts                # Diesel prices, route fuel planning
│   │   │   ├── parking-finder.ts             # Truck parking search + reservations
│   │   │   ├── broker-caller.ts              # Broker call initiation + status polling
│   │   │   ├── invoice-generator.ts          # PDF invoices, BOL, IFTA tracking
│   │   │   ├── demo-session.ts               # In-memory demo state (trips, location)
│   │   │   └── index.ts                      # Tool exports
│   │   ├── services/
│   │   │   ├── twilio-call-service.ts        # Outbound calls (Twilio → STT → Claude → TTS)
│   │   │   ├── geo-service.ts                # Geocoding + reverse geocoding (Nominatim)
│   │   │   ├── fuel-service.ts               # Regional diesel pricing
│   │   │   ├── places-service.ts             # Overpass API (OpenStreetMap POI)
│   │   │   └── direct-freight-service.ts     # DAT Freight API integration
│   │   ├── voice/
│   │   │   ├── voice-session.ts              # Session orchestrator (STT → Claude → TTS)
│   │   │   ├── stt-pipeline.ts               # Pulse STT WebSocket wrapper
│   │   │   ├── tts-pipeline.ts               # Sentence-level TTS streaming pipeline
│   │   │   ├── tts-synthesize.ts             # Waves TTS WebSocket client
│   │   │   ├── audio-convert.ts              # mulaw ↔ PCM, resample 8k/16k/24k
│   │   │   ├── filler-cache.ts               # Pre-cached filler phrases (50+)
│   │   │   └── action-extractor.ts           # Extract action items from tool results
│   │   ├── workflows/
│   │   │   ├── load-booking.ts               # Search → rank → HOS check → present
│   │   │   └── broker-negotiation.ts         # Validate → call → process outcome
│   │   ├── db/
│   │   │   ├── schema.ts                     # Drizzle ORM table definitions (8 tables)
│   │   │   ├── index.ts                      # Database connection + helpers
│   │   │   └── migrate.ts                    # Migration runner
│   │   ├── data/
│   │   │   └── seed-data.ts                  # Freight lanes, truck stops, brokers, prices
│   │   └── memory/
│   │       └── driver-profile.ts             # Driver profile persistence
│   ├── public/
│   │   ├── index.html                        # Full SPA (dashboard + voice + trips)
│   │   ├── styles.css                        # Glassmorphism dark theme (1,675 lines)
│   │   ├── manifest.json                     # PWA manifest
│   │   └── sw.js                             # Service worker
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── drizzle.config.ts
│
└── ios/RoadPilot/                            # iOS companion app (Swift)
    ├── Models/                               # Data models (ChatMessage, Load, HOS, etc.)
    ├── Network/                              # REST client + WebSocket manager
    └── Voice/                                # On-device VAD + STT/TTS pipeline
```

---

## Voice Pipeline

### How It Works

1. **Browser captures audio** — `AudioContext` at 16kHz, 16-bit PCM mono, via `getUserMedia()`
2. **Client-side VAD** — Web Audio API analyzes volume against adaptive noise floor
3. **On `speech_start`** — Server opens fresh Pulse STT WebSocket, buffers audio while connecting
4. **Audio streams** — binary PCM frames sent via WebSocket, forwarded to Pulse
5. **On `speech_end`** — Pulse returns final transcript, passed to Claude agent
6. **Claude streams response** — Mastra agent with 16 tools, streamed text-delta tokens
7. **Sentence splitting** — `TTSSentencePipeline` splits on `.!?` boundaries
8. **TTS streaming** — Each sentence synthesized via shared Waves WebSocket
9. **Chunk batching** — First PCM chunk sent immediately (~160ms), subsequent batches of 3 (~480ms)
10. **Browser playback** — WAV header added, base64-encoded, decoded and played via `AudioContext`

### Audio Formats

| Component | Format | Sample Rate |
|-----------|--------|-------------|
| Browser mic → Server | PCM 16-bit signed LE, mono | 16 kHz |
| Server → Pulse STT | PCM 16-bit signed LE, mono | 16 kHz |
| Waves TTS → Server | PCM 16-bit signed LE, mono | 24 kHz |
| Server → Browser | WAV (PCM + header), base64 | 24 kHz |
| Twilio → Server | mulaw 8-bit, base64 | 8 kHz |
| Server → Twilio | mulaw 8-bit, base64 | 8 kHz |

### VAD Configuration

```javascript
NOISE_MULTIPLIER = 2.5          // Speech threshold = noise floor * this
MIN_SPEECH_THRESHOLD = 0.003    // Minimum volume to trigger speech
MAX_SPEECH_THRESHOLD = 0.05     // Cap for noisy environments
VAD_SILENCE_DURATION = 1200     // ms of silence before speech_end
MIN_SPEECH_DURATION = 400       // ms minimum to count as speech
CONFIRM_FRAMES = 3              // Consecutive frames above threshold
```

### Latency Optimizations

- **Audio buffering** — audio frames queued while Pulse STT connects, flushed once ready
- **Shared TTS WebSocket** — single persistent connection reused across all responses in a session
- **First-chunk priority** — first TTS chunk sent immediately (~160ms), not batched
- **Sentence-level TTS** — synthesis starts before Claude finishes full response
- **Smart fillers** — pre-cached audio plays during tool execution ("Let me check on that...")
- **endUtterance timeout** — only 100ms wait for Pulse finals after speech_end

---

## Agent Tools

Tasha has access to 16 tools organized into 6 categories:

### Load Management

| Tool | Description |
|------|-------------|
| `searchLoads` | Search load boards by origin/destination, equipment type, rate, weight |
| `calculateProfitability` | Analyze load profit after fuel, deadhead, tolls, operating costs |

### Hours of Service

| Tool | Description |
|------|-------------|
| `getHOSStatus` | Current drive time, on-duty time, cycle time from ELD |
| `planBreaks` | Calculate optimal rest stops for remaining route |
| `alertHOSViolation` | Proactive warnings before HOS violations |

### Fuel & Parking

| Tool | Description |
|------|-------------|
| `searchFuelPrices` | Find diesel/DEF prices near GPS location |
| `calculateRouteFuel` | Plan optimal fuel stops for entire trip |
| `searchParking` | Find truck parking with availability and amenities |
| `reserveSpot` | Reserve a parking spot at supported locations |

### Invoicing & Documentation

| Tool | Description |
|------|-------------|
| `generateInvoice` | Generate PDF invoice for completed load |
| `sendInvoice` | Email invoice to broker |
| `generateBOL` | Generate Bill of Lading document |
| `trackIFTA` | Log fuel purchase by state for IFTA tax reporting |

### Broker Negotiation

| Tool | Description |
|------|-------------|
| `initiateBrokerCall` | Place outbound phone call to broker via Twilio |
| `getBrokerCallStatus` | Poll status and outcome of ongoing broker call |
| `confirmLoad` | Confirm and book a negotiated load |

---

## Broker Calling

### How AI-Powered Broker Calls Work

When a driver asks Tasha to negotiate, the system places a real phone call:

```
1. Driver: "Call the broker and get me three eighty-five a mile"
   ↓
2. Claude triggers: initiate_broker_call(targetRate: 3.85, minimumRate: 3.75, ...)
   ↓
3. TwilioCallSession created with negotiation parameters
   ↓
4. Twilio REST API → outbound call to broker phone number
   ↓
5. Twilio connects Media Stream WebSocket (/twilio-media)
   ↓
6. Real-time negotiation loop:
   ├── Broker speaks → mulaw 8kHz → upsample to PCM 16kHz → Pulse STT → transcript
   ├── Transcript → Claude (with negotiation context) → response
   ├── Response → Waves TTS (24kHz) → downsample to 8kHz → mulaw → Twilio
   └── Twilio plays AI audio to broker
   ↓
7. Call ends → outcome extracted (agreed rate, transcript, next steps)
   ↓
8. VoiceSession.injectSystemMessage() → Tasha reports to driver:
   "Alright, good news. They agreed to three eighty-five a mile.
    Rate confirmation is being sent over."
```

### Negotiation Styles

| Style | Behavior |
|-------|----------|
| `firm` | Holds close to target rate, limited concessions |
| `moderate` | Willing to negotiate but pushes for target |
| `flexible` | More willing to compromise within range |

### Rate Limit Handling

The broker call service falls back from Claude Sonnet 4.5 to Haiku 4.5 on API rate limits, ensuring calls don't drop mid-negotiation.

---

## API Reference

### Health & Config

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check |
| `GET` | `/api/config` | Voice configuration (enabled status) |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | Send message to agent, get full response |
| `POST` | `/api/chat/stream` | SSE streaming chat with agent |

**Request body:**
```json
{
  "message": "Find loads from Dallas to Chicago",
  "driverId": "driver-1",
  "threadId": "optional-thread-id"
}
```

### Dashboard

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard/:driverId` | Full dashboard data |
| `GET` | `/api/dashboard/:driverId?lat=32.7&lng=-96.8` | Dashboard with GPS location |

**Response includes:** HOS status, fuel prices, parking, trips, action items, driver location.

### Trips

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trips/:driverId` | Get driver's trips |
| `DELETE` | `/api/trips/:id` | Delete a trip |

### Action Items

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/action-items/:driverId` | Get pending action items |
| `POST` | `/api/actions/:id/complete` | Mark action as completed |
| `POST` | `/api/actions/:id/dismiss` | Dismiss action item |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions/:driverId` | List voice sessions (limit 20) |
| `GET` | `/api/sessions/:id/actions` | Get session's action items |

### Tools & Workflows

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/tools/:toolId` | Execute any tool directly |
| `POST` | `/api/workflows/load-booking` | Run load booking workflow |
| `POST` | `/api/workflows/broker-negotiation` | Run broker negotiation workflow |

### Drivers

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/drivers/:driverId` | Get driver profile |
| `GET` | `/api/drivers/:driverId/preferences` | Get driver preferences |

### Voice & Location

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/voices` | List available TTS voices |
| `POST` | `/api/tts` | Synthesize text to WAV audio |
| `GET` | `/api/reverse-geocode?lat=X&lng=Y` | Reverse geocode coordinates |

### Twilio Webhooks

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/twilio/call-status` | Twilio call status callback |

---

## WebSocket Protocol

### Voice Session (`/ws`)

#### Client → Server

| Message Type | Description | Payload |
|-------------|-------------|---------|
| `start_session` | Initialize voice session | `{ type, driverId? }` |
| `speech_start` | VAD detected speech | `{ type }` |
| `audio` | PCM 16kHz audio frame | Binary (raw PCM) |
| `speech_end` | VAD detected silence | `{ type }` |
| `interrupt` | User barged in during TTS | `{ type }` |
| `update_location` | GPS coordinates update | `{ type, lat, lng }` |
| `end_session` | Close session | `{ type }` |

#### Server → Client

| Message Type | Description | Payload |
|-------------|-------------|---------|
| `session_started` | Session ready | `{ type, sessionId, context }` |
| `state_change` | State transition | `{ type, state: "listening"\|"thinking"\|"speaking"\|"idle" }` |
| `transcript` | STT or assistant text | `{ type, role: "user"\|"assistant", text }` |
| `audio_chunk` | TTS audio (base64 WAV) | `{ type, data, text }` |
| `filler_audio` | Filler phrase audio | `{ type, data, text }` |
| `action_item` | Actionable item from tool use | `{ type, item: ActionItem }` |
| `session_ended` | Session closed | `{ type, summary }` |
| `error` | Error message | `{ type, message }` |

### Twilio Media Stream (`/twilio-media`)

Handles real-time audio for outbound broker calls. Twilio sends `start`, `media` (mulaw 8kHz base64), and `stop` events. Server responds with `playback` events containing synthesized AI audio.

---

## Database Schema

8 tables managed by Drizzle ORM:

### Tables

| Table | Purpose |
|-------|---------|
| `driver_profiles` | Driver info (name, MC#, DOT#, CDL, equipment, preferences) |
| `loads` | Load records with full lifecycle tracking (searching → paid) |
| `hos_logs` | Hours of service duty status entries |
| `fuel_purchases` | IFTA fuel purchase tracking by state |
| `broker_calls` | Broker call records (target/agreed rate, transcript, outcome) |
| `driver_preferences` | Learned driver preferences (inferred or explicit) |
| `voice_sessions` | Voice session records with full transcripts |
| `action_items` | Actionable items extracted from voice sessions |

### Enums

```
equipment_type: dry_van | reefer | flatbed | step_deck | other
load_status:    searching | negotiating | booked | in_transit | delivered | invoiced | paid | cancelled
duty_status:    driving | on_duty | sleeper_berth | off_duty
action_status:  pending | completed | dismissed
```

### Migrations

```bash
# Run migrations
npm run db:migrate

# Generate migrations (after schema changes)
npx drizzle-kit generate
```

---

## Dashboard

The dashboard is a single-page application served from `public/index.html` with no build step.

### Components

- **Greeting banner** — time-aware greeting + GPS city/state with pulsing location dot
- **Stat cards** — HOS remaining (green), weekly revenue (amber), cheapest fuel (cyan), parking (blue)
- **Active trip** — current in-transit load with route, ETA, progress bar
- **My Trips** — trip cards with route visualization, status badges, rates, delete button
- **Action items** — pending items from voice sessions with accept/dismiss buttons
- **Voice overlay** — floating mic button, real-time transcript, state indicator

### Trip Status Badges

| Status | Color | Description |
|--------|-------|-------------|
| `searching` | Blue | Load search in progress |
| `negotiating` | Amber | Broker call active |
| `booked` | Green | Load confirmed |
| `in_transit` | Cyan | Currently hauling |
| `delivered` | Gray | Load delivered |

### Design

- Dark theme (`#080c14` background)
- Glassmorphism with `backdrop-filter: blur` and gradient borders
- Cyan (`#00d4ff`) and purple (`#a855f7`) accent colors
- Responsive: desktop sidebar (1024px+), mobile header
- PWA-ready with manifest and service worker

---

## iOS App

The `roadpilot/ios/` directory contains a Swift companion app scaffold:

| File | Purpose |
|------|---------|
| `VoicePipelineManager.swift` | On-device STT (Apple SFSpeechRecognizer) + TTS + VAD |
| `BackendClient.swift` | REST API client (loads, HOS, chat, profiles) |
| `WebSocketManager.swift` | WebSocket voice session connection |
| `Models/*.swift` | Data models (ChatMessage, Load, HOSStatus, DriverProfile) |

The iOS app is designed as a native companion to the web dashboard, with on-device voice processing capability (Apple Speech framework) and a RunAnywhere SDK placeholder for offline LLM inference.

---

## Workflows

### Load Booking Workflow

Three-step automated pipeline:

```
Step 1: Search Loads
  → Query load boards with origin, destination, equipment type
  → Return matching loads with rates and details

Step 2: Calculate Profitability
  → For each load: compute fuel cost, operating cost, net profit
  → Rank by profit per mile
  → Tag: "Excellent" (≥$1.50/mi), "Good" (≥$1.00/mi), "Average" (<$1.00/mi)

Step 3: Check HOS Feasibility
  → Estimate drive hours for each load
  → Verify driver has enough time on clock
  → Flag infeasible loads
  → Present ranked, feasible loads to driver
```

### Broker Negotiation Workflow

Three-step automated pipeline:

```
Step 1: Validate Negotiation
  → Verify minimum rate ≤ target rate
  → Fetch market rate context for the lane
  → Return validation status + call parameters

Step 2: Initiate Call
  → Create TwilioCallSession with negotiation parameters
  → Place outbound call via Twilio REST API
  → Return call ID and status

Step 3: Process Outcome
  → Poll for call completion
  → Extract agreed rate, transcript, next steps
  → Return full negotiation outcome
```

---

## Development

### Scripts

```bash
npm run dev          # Development server with hot reload (tsx watch)
npm run build        # TypeScript compile to dist/
npm run start        # Production server (node dist/index.js)
npm run test         # Run tests (Vitest)
npm run test:watch   # Watch mode tests
npm run db:migrate   # Run database migrations
```

### Key Notes

- **Frontend is a single HTML file** — `public/index.html` with all JS inline, no build step needed
- **Demo session is in-memory** — `demo-session.ts` state resets on server restart
- **Twilio trial** — only calls verified numbers; all broker calls route to `DEMO_BROKER_PHONE`
- **`NGROK_URL` required** for Twilio to reach local WebSocket endpoints
- **No auth** — single driver demo mode (driver ID hardcoded)
- **`tsx watch`** auto-restarts on `.ts` changes; static files in `public/` don't need restart
- **Pulse STT URL parameters** — only `language`, `sample_rate`, and `encoding` are supported; additional params may break the connection

### Testing

```bash
# Run all tests
npm run test

# Run specific test file
npx vitest run src/tools/load-search.test.ts

# Watch mode
npm run test:watch
```

Test files exist for: `load-search`, `fuel-finder`, `parking-finder`, `hos-tracker`, `invoice-generator`.

---

## License

This project is proprietary. All rights reserved.

---

Built with Claude by [Klickgen AI](https://github.com/klickgenai)
