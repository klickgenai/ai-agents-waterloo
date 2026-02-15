# AI Agents Waterloo — CLAUDE.md

## Project: RoadPilot

AI-powered freight dispatch assistant for truck drivers. Voice-first design — drivers talk to "Tasha" (AI dispatcher) who handles load searching, broker negotiation (via real phone calls), HOS tracking, fuel/parking, and invoicing.

## Quick Start

```bash
cd roadpilot/backend
npm install
npm run dev          # tsx watch on src/index.ts → http://localhost:3000
```

For broker calling (Twilio outbound calls), also run ngrok:
```bash
ngrok http 3000
# Then set NGROK_URL in .env
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js + TypeScript (ES2022, ESM) |
| Agent Framework | Mastra (`@mastra/core`) |
| LLM | Anthropic Claude Sonnet 4.5 (primary), Haiku 4.5 (fallback on rate limit) |
| Voice STT | Smallest AI Pulse (`smallestai` SDK) |
| Voice TTS | Smallest AI Waves (`smallestai` SDK) |
| Phone Calls | Twilio (REST API + Media Streams WebSocket) |
| Web Server | Express + WebSocket (`ws`) |
| Database | PostgreSQL + Drizzle ORM |
| Validation | Zod |
| Testing | Vitest |
| Frontend | Vanilla HTML/CSS/JS (served as static from `public/`) |

## Key Directory Structure

```
roadpilot/backend/
├── src/
│   ├── index.ts                     # Express server, WebSocket handlers, API routes
│   ├── agents/roadpilot-agent.ts    # Main Mastra agent ("Tasha") — Claude + 16 tools
│   ├── services/
│   │   └── twilio-call-service.ts   # Outbound broker calls (Twilio → STT → Claude → TTS → Twilio)
│   ├── tools/                       # Agent tools (load-search, hos, fuel, parking, broker-caller, invoice, etc.)
│   │   ├── broker-caller.ts         # initiate_broker_call, get_broker_call_status, confirm_load
│   │   └── demo-session.ts          # In-memory demo state
│   ├── voice/
│   │   ├── voice-session.ts         # WebSocket voice session (STT → Claude stream → TTS pipeline)
│   │   ├── stt-pipeline.ts          # Pulse STT WebSocket wrapper
│   │   ├── tts-pipeline.ts          # Waves TTS sentence pipeline
│   │   ├── audio-convert.ts         # mulaw 8kHz ↔ PCM 16kHz/24kHz converters
│   │   └── filler-cache.ts          # Pre-generated filler phrases for natural conversation
│   └── workflows/                   # Mastra workflows (load-booking, broker-negotiation)
├── public/
│   ├── index.html                   # Full SPA — dashboard + voice overlay + all JS
│   └── styles.css                   # Premium glassmorphism UI
└── package.json
```

## Environment Variables

```env
# Required
ANTHROPIC_API_KEY=           # Claude API
SMALLEST_API_KEY=            # Pulse STT + Waves TTS

# Twilio (for broker calling)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=         # Your Twilio number
NGROK_URL=                   # Public URL for Twilio webhooks (e.g. https://abc123.ngrok.io)
DEMO_BROKER_PHONE=+16479377325  # All broker calls route here (Twilio trial limitation)

# Database
DATABASE_URL=postgresql://...

# Optional API keys
DAT_API_KEY=                 # Load board
TRUCKER_CLOUD_API_KEY=       # ELD/HOS
```

## Architecture — Key Flows

### Voice Conversation (Driver ↔ Tasha)
```
Browser mic → PCM 16kHz → WebSocket → Pulse STT → transcript
  → Claude agent (Mastra, streamed) → TTS sentence pipeline (Waves)
  → WAV audio chunks → WebSocket → Browser playback
```
- VAD (Voice Activity Detection) runs client-side with adaptive noise floor
- Barge-in support: user speech during TTS stops playback + Claude stream, captures new input
- Filler phrases pre-cached for natural latency masking

### Broker Phone Call (AI calls broker)
```
Claude tool call → initiate_broker_call → TwilioCallSession.startCall()
  → Twilio REST API → outbound call → Media Stream WebSocket (/twilio-media)
  → Broker audio: mulaw 8kHz → PCM 16kHz → Pulse STT → Claude negotiation → Waves TTS → mulaw 8kHz → Twilio
  → On complete: voiceSession.injectSystemMessage() → Tasha reports result to driver
```
- Rate limit fallback: Sonnet 4.5 → Haiku 4.5 (in `twilio-call-service.ts`)
- Demo mode: all calls hardcoded to DEMO_BROKER_PHONE

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/dashboard/:driverId` | Dashboard data (HOS, loads, fuel, parking) |
| GET | `/api/action-items/:driverId` | Action items from voice sessions |
| POST | `/api/chat` | Text chat with agent |
| POST | `/api/chat/stream` | Streaming chat |
| POST | `/api/twilio/call-status` | Twilio status webhook |
| WS | `/ws` | Voice session WebSocket |
| WS | `/twilio-media` | Twilio Media Stream WebSocket |

## WebSocket Messages (Voice Session)

**Client → Server:**
- `start_session` — Initialize voice session
- `speech_start` — VAD detected speech
- `audio` — PCM 16kHz audio frame (base64)
- `speech_end` — VAD detected silence
- `interrupt` — User barged in during TTS playback
- `end_session` — Close session

**Server → Client:**
- `session_started` — Session ready
- `state` — State change (listening/thinking/speaking)
- `transcript` — User or assistant text
- `filler_audio` / `audio` — TTS audio chunks (base64 WAV)
- `action_item` — Extracted action from tool use

## Important Notes

- **Frontend is a single HTML file** (`public/index.html`) with all JS inline — no build step
- **Demo session state is in-memory** (`demo-session.ts`) — not persisted across restarts
- **Twilio trial account** only calls verified numbers — all broker calls route to DEMO_BROKER_PHONE
- **NGROK_URL must be set** for Twilio to reach local WebSocket endpoints for media streaming
- **No auth** — single driver demo mode (driver ID hardcoded)
- **`tsx watch`** auto-restarts on `.ts` file changes; static files (`public/`) don't need restart

## Scripts

```bash
npm run dev        # Development server with hot reload
npm run build      # TypeScript compile to dist/
npm run start      # Production server
npm run test       # Vitest
npm run db:migrate # Drizzle migrations
```
