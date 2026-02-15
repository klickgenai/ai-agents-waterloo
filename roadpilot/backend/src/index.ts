import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { Mastra } from "@mastra/core";
import { WavesClient, Configuration } from "smallestai";
import { WebSocketServer, WebSocket } from "ws";
import { roadpilotAgent } from "./agents/roadpilot-agent.js";
import { loadBookingWorkflow } from "./workflows/load-booking.js";
import { brokerNegotiationWorkflow } from "./workflows/broker-negotiation.js";
import { fillerCache } from "./voice/filler-cache.js";
import { VoiceSession, type SessionSummary } from "./voice/voice-session.js";
import type { ActionItem } from "./voice/action-extractor.js";
import { db, schema } from "./db/index.js";
import { eq } from "drizzle-orm";
import { getSession, getSessionByCallId } from "./services/twilio-call-service.js";
import { demoSession, setActiveVoiceSession, deleteTrip } from "./tools/demo-session.js";
import { reverseGeocode } from "./services/geo-service.js";

// Default driver UUID — used when no real driver is logged in
const DEFAULT_DRIVER_ID = "00000000-0000-0000-0000-000000000001";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Mastra
const mastra = new Mastra({
  agents: { roadpilot: roadpilotAgent },
  workflows: {
    "load-booking": loadBookingWorkflow,
    "broker-negotiation": brokerNegotiationWorkflow,
  },
});

// Express server
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const PORT = parseInt(process.env.PORT || "3000", 10);

// Create HTTP server (needed for WebSocket attachment)
const server = http.createServer(app);

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "roadpilot-backend", timestamp: new Date().toISOString() });
});

// ─── Frontend Config ─────────────────────────────────────────────────────────
app.get("/api/config", (_req, res) => {
  res.json({
    voiceEnabled: !!process.env.SMALLEST_API_KEY,
  });
});

// ─── Agent Chat Endpoint ─────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  try {
    const { message, threadId } = req.body;

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const agent = mastra.getAgent("roadpilot");
    const response = await agent.generate([
      { role: "user", content: message },
    ], {
      maxSteps: 10,
    });

    res.json({
      text: response.text,
      threadId: threadId || undefined,
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Failed to process chat request" });
  }
});

// ─── Streaming Chat Endpoint ─────────────────────────────────────────────────
app.post("/api/chat/stream", async (req, res) => {
  try {
    const { message, threadId } = req.body;

    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const agent = mastra.getAgent("roadpilot");
    const stream = await agent.stream([
      { role: "user", content: message },
    ], {
      maxSteps: 10,
    });

    for await (const chunk of stream.textStream) {
      res.write(`data: ${JSON.stringify({ type: "text", content: chunk })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (error) {
    console.error("Stream error:", error);
    res.status(500).json({ error: "Failed to process stream request" });
  }
});

// ─── Workflow Endpoints ──────────────────────────────────────────────────────

app.post("/api/workflows/load-booking", async (req, res) => {
  try {
    const workflow = mastra.getWorkflow("load-booking");
    const run = await workflow.createRun();
    const result = await run.start({ inputData: req.body });

    res.json({
      status: result.status,
      result: "result" in result ? result.result : undefined,
      steps: result.steps,
    });
  } catch (error) {
    console.error("Load booking workflow error:", error);
    res.status(500).json({ error: "Workflow execution failed" });
  }
});

app.post("/api/workflows/broker-negotiation", async (req, res) => {
  try {
    const workflow = mastra.getWorkflow("broker-negotiation");
    const run = await workflow.createRun();
    const result = await run.start({ inputData: req.body });

    res.json({
      status: result.status,
      result: "result" in result ? result.result : undefined,
      steps: result.steps,
    });
  } catch (error) {
    console.error("Broker negotiation workflow error:", error);
    res.status(500).json({ error: "Workflow execution failed" });
  }
});

// ─── Direct Tool Endpoints ───────────────────────────────────────────────────

app.post("/api/tools/:toolId", async (req, res) => {
  try {
    const agent = mastra.getAgent("roadpilot");
    const tools = await agent.listTools() as Record<string, any>;
    const tool = tools[req.params.toolId];

    if (!tool) {
      res.status(404).json({ error: `Tool '${req.params.toolId}' not found` });
      return;
    }

    const result = await tool.execute(req.body);
    res.json(result);
  } catch (error) {
    console.error(`Tool ${req.params.toolId} error:`, error);
    res.status(500).json({ error: "Tool execution failed" });
  }
});

// ─── Driver Profile Endpoints ────────────────────────────────────────────────

app.get("/api/drivers/:driverId", async (req, res) => {
  try {
    const { getDriverProfile } = await import("./memory/driver-profile.js");
    const profile = await getDriverProfile(req.params.driverId);

    if (!profile) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }

    res.json(profile);
  } catch (error) {
    console.error("Driver profile error:", error);
    res.status(500).json({ error: "Failed to fetch driver profile" });
  }
});

app.get("/api/drivers/:driverId/preferences", async (req, res) => {
  try {
    const { getDriverPreferences } = await import("./memory/driver-profile.js");
    const prefs = await getDriverPreferences(req.params.driverId);
    res.json(prefs);
  } catch (error) {
    console.error("Preferences error:", error);
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

// ─── Text-to-Speech (Smallest AI Waves) ─────────────────────────────────────

const wavesClient = process.env.SMALLEST_API_KEY
  ? new WavesClient(new Configuration({ accessToken: process.env.SMALLEST_API_KEY }))
  : null;

// List available voices for the frontend
app.get("/api/voices", async (_req, res) => {
  try {
    if (!wavesClient) {
      res.status(503).json({ error: "TTS not configured" });
      return;
    }
    const response = await wavesClient.getWavesVoices("lightning-large" as any);
    const data = (response as any).data ?? response;
    res.json(data);
  } catch (error) {
    console.error("Voices error:", error);
    res.status(500).json({ error: "Failed to fetch voices" });
  }
});

app.post("/api/tts", async (req, res) => {
  try {
    const { text, voiceId = "emily", speed = 1.0, enhancement = 1, consistency = 0.5, similarity = 0 } = req.body;

    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    if (!wavesClient) {
      res.status(503).json({ error: "TTS not configured — SMALLEST_API_KEY missing" });
      return;
    }

    // Split long text into small chunks — lightning-large has ~150 char limit
    const sentences = text.match(/[^.!?,;]+[.!?,;]+|[^.!?,;]+$/g) || [text];
    const chunks: string[] = [];
    let current = "";
    for (const s of sentences) {
      if ((current + s).length > 120) {
        if (current) chunks.push(current.trim());
        current = s;
      } else {
        current += s;
      }
    }
    if (current.trim()) chunks.push(current.trim());

    // Synthesize each chunk sequentially to avoid rate limits
    const audioBuffers: Buffer[] = [];
    for (const chunk of chunks) {
      const audioResponse = await wavesClient.synthesize("lightning-large", {
        text: chunk,
        voice_id: voiceId,
        sample_rate: 24000,
        speed,
        enhancement,
        consistency,
        similarity,
        add_wav_header: false,
      });
      const rawData = (audioResponse as any).data ?? audioResponse;
      audioBuffers.push(Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData as ArrayBuffer));
    }

    // Combine raw PCM chunks and add WAV header
    const combined = Buffer.concat(audioBuffers);
    const wavefile = await import("wavefile");
    const WaveFile = (wavefile as any).WaveFile || (wavefile as any).default?.WaveFile || wavefile;
    const wav = new WaveFile();
    wav.fromScratch(1, 24000, "16", new Int16Array(combined.buffer, combined.byteOffset, combined.length / 2));
    const audioBuffer = Buffer.from(wav.toBuffer());

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", audioBuffer.length.toString());
    res.send(audioBuffer);
  } catch (error) {
    console.error("TTS error:", error);
    res.status(500).json({ error: "Text-to-speech failed" });
  }
});

// ─── Reverse Geocode ─────────────────────────────────────────────────────────

app.get("/api/reverse-geocode", async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    if (isNaN(lat) || isNaN(lng)) {
      res.status(400).json({ error: "lat and lng are required" });
      return;
    }
    const result = await reverseGeocode(lat, lng);
    res.json(result);
  } catch (error) {
    console.error("Reverse geocode error:", error);
    res.status(500).json({ error: "Reverse geocode failed" });
  }
});

// ─── Trip Endpoints ──────────────────────────────────────────────────────────

app.get("/api/trips/:driverId", (_req, res) => {
  res.json({ trips: demoSession.trips || [] });
});

app.delete("/api/trips/:id", (req, res) => {
  const deleted = deleteTrip(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Trip not found" });
    return;
  }
  res.json({ ok: true });
});

// ─── Dashboard API ───────────────────────────────────────────────────────────

app.get("/api/dashboard/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);

    // Use real coords if provided, otherwise fallback to "current"
    const hasCoords = !isNaN(lat) && !isNaN(lng);
    const fuelLocation = hasCoords ? `${lat},${lng}` : "current";
    const parkingLocation = hasCoords ? `${lat},${lng}` : "current";

    // Update demoSession location if coords provided
    if (hasCoords) {
      if (!demoSession.driverLocation) {
        demoSession.driverLocation = { city: "", state: "", lat, lng };
      } else {
        demoSession.driverLocation.lat = lat;
        demoSession.driverLocation.lng = lng;
      }
    }

    const agent = mastra.getAgent("roadpilot");
    const tools = (await agent.listTools()) as Record<string, any>;

    // Fetch dashboard data in parallel
    const [hosResult, fuelResult, parkingResult, pendingActions] = await Promise.allSettled([
      tools.getHOSStatus?.execute({ driverId }),
      tools.searchFuelPrices?.execute({ location: fuelLocation, radius: 20 }),
      tools.searchParking?.execute({ location: parkingLocation, radius: 30 }),
      db
        .select()
        .from(schema.actionItems)
        .where(eq(schema.actionItems.driverId, driverId))
        .limit(20),
    ]);

    res.json({
      hos: hosResult.status === "fulfilled" ? hosResult.value : null,
      fuel: fuelResult.status === "fulfilled" ? fuelResult.value : null,
      parking: parkingResult.status === "fulfilled" ? parkingResult.value : null,
      actionItems:
        pendingActions.status === "fulfilled" ? pendingActions.value : [],
      trips: demoSession.trips || [],
      driverLocation: demoSession.driverLocation || null,
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

app.get("/api/sessions/:driverId", async (req, res) => {
  try {
    const sessions = await db
      .select()
      .from(schema.voiceSessions)
      .where(eq(schema.voiceSessions.driverId, req.params.driverId))
      .limit(20);
    res.json(sessions);
  } catch (error) {
    console.error("Sessions error:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

app.get("/api/sessions/:id/actions", async (req, res) => {
  try {
    const actions = await db
      .select()
      .from(schema.actionItems)
      .where(eq(schema.actionItems.sessionId, req.params.id));
    res.json(actions);
  } catch (error) {
    console.error("Session actions error:", error);
    res.status(500).json({ error: "Failed to fetch session actions" });
  }
});

app.post("/api/actions/:id/complete", async (req, res) => {
  try {
    await db
      .update(schema.actionItems)
      .set({ status: "completed" })
      .where(eq(schema.actionItems.id, req.params.id));
    res.json({ ok: true });
  } catch (error) {
    console.error("Action complete error:", error);
    res.status(500).json({ error: "Failed to complete action" });
  }
});

app.post("/api/actions/:id/dismiss", async (req, res) => {
  try {
    await db
      .update(schema.actionItems)
      .set({ status: "dismissed" })
      .where(eq(schema.actionItems.id, req.params.id));
    res.json({ ok: true });
  } catch (error) {
    console.error("Action dismiss error:", error);
    res.status(500).json({ error: "Failed to dismiss action" });
  }
});

// ─── Twilio Call Status Webhook ──────────────────────────────────────────────

app.use(express.urlencoded({ extended: false }));

app.post("/api/twilio/call-status", (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`[Twilio Status] Call ${CallSid}: ${CallStatus}`);

  const session = getSession(CallSid);
  if (session) {
    session.handleStatusUpdate(CallStatus);
  }

  res.status(200).send("OK");
});

// ─── WebSocket Servers (manual upgrade routing) ─────────────────────────────

const wss = new WebSocketServer({ noServer: true });
const twilioWss = new WebSocketServer({ noServer: true });

// Route WebSocket upgrades by path
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;

  if (pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else if (pathname === "/twilio-media") {
    twilioWss.handleUpgrade(request, socket, head, (ws) => {
      twilioWss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ─── Twilio Media Stream Handler ────────────────────────────────────────────

twilioWss.on("connection", (ws) => {
  console.log("[TwilioMedia] WebSocket connected");

  let callId: string | null = null;
  let sessionLinked = false;
  const bufferedMessages: string[] = [];

  ws.on("message", (data) => {
    const raw = data.toString();

    // If session is already linked, it handles its own messages
    if (sessionLinked) return;

    try {
      const msg = JSON.parse(raw);

      // Buffer all messages until we find callId and link to session
      bufferedMessages.push(raw);

      if (msg.event === "start" && msg.start?.customParameters?.callId) {
        callId = msg.start.customParameters.callId;
        console.log(`[TwilioMedia] Stream started for call ${callId}`);

        const session = getSessionByCallId(callId!);
        if (session) {
          sessionLinked = true;
          // Pass the ws to session — it will register its own handlers
          // and we replay all buffered messages so it sees the "start" event
          session.handleMediaStream(ws, bufferedMessages);
        } else {
          console.error(`[TwilioMedia] No session found for callId ${callId}`);
        }
      }
    } catch {
      // Non-JSON message, ignore
    }
  });

  ws.on("close", () => {
    console.log(`[TwilioMedia] WebSocket closed for call ${callId}`);
  });
});

// ─── WebSocket Voice Server ──────────────────────────────────────────────────
const activeSessions = new Map<WebSocket, VoiceSession>();

wss.on("connection", (ws) => {
  console.log("[WS] Client connected");

  ws.on("message", async (data, isBinary) => {
    // Binary data = PCM audio from mic
    if (isBinary) {
      const session = activeSessions.get(ws);
      if (session && session.getState() !== "idle") {
        session.feedAudio(Buffer.from(data as ArrayBuffer));
      }
      return;
    }

    // JSON messages
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case "start_session": {
          const driverId = msg.driverId || DEFAULT_DRIVER_ID;

          // Set driver location from client GPS if available
          if (typeof msg.lat === "number" && typeof msg.lng === "number") {
            if (!demoSession.driverLocation) {
              demoSession.driverLocation = { city: "", state: "", lat: msg.lat, lng: msg.lng };
            } else {
              demoSession.driverLocation.lat = msg.lat;
              demoSession.driverLocation.lng = msg.lng;
            }
            // Reverse geocode in background
            reverseGeocode(msg.lat, msg.lng).then((geo) => {
              if (demoSession.driverLocation) {
                demoSession.driverLocation.city = geo.city;
                demoSession.driverLocation.state = geo.state;
              }
            }).catch(() => {});
            console.log(`[WS] Session started with GPS: ${msg.lat.toFixed(4)}, ${msg.lng.toFixed(4)}`);
          }

          const session = new VoiceSession(driverId, mastra, {
            onStateChange: (state) => {
              sendJSON(ws, { type: "state_change", state });
            },
            onTranscript: (role, text) => {
              sendJSON(ws, { type: "transcript", role, text });
            },
            onFillerAudio: (audioBuffer, text) => {
              sendJSON(ws, {
                type: "filler_audio",
                data: audioBuffer.toString("base64"),
                text,
              });
            },
            onAudioChunk: (audioBuffer, sentenceText) => {
              sendJSON(ws, {
                type: "audio_chunk",
                data: audioBuffer.toString("base64"),
                text: sentenceText,
              });
            },
            onActionItem: (item) => {
              sendJSON(ws, { type: "action_item", item });
            },
            onSessionEnded: async (summary) => {
              // Save session to DB
              await saveSession(summary);
              sendJSON(ws, { type: "session_ended", summary: { sessionId: summary.sessionId, actionItems: summary.actionItems } });
            },
            onMicStatus: (status) => {
              sendJSON(ws, { type: "mic_status", status });
            },
            onError: (error) => {
              sendJSON(ws, { type: "error", message: error.message });
            },
          });

          activeSessions.set(ws, session);

          // Register as active voice session for post-call notifications
          setActiveVoiceSession(session);

          // Pre-fetch context
          const context = await session.preFetch();

          // Start listening (connect STT)
          await session.startListening();

          sendJSON(ws, {
            type: "session_started",
            sessionId: session.sessionId,
            context,
          });
          break;
        }

        case "speech_start": {
          const session = activeSessions.get(ws);
          if (session) {
            session.onSpeechStart().catch((err) => {
              console.error("[WS] speech_start error:", err);
              sendJSON(ws, { type: "error", message: err.message });
            });
          }
          break;
        }

        case "speech_end": {
          const session = activeSessions.get(ws);
          if (session) {
            session.onSpeechEnd().catch((err) => {
              console.error("[WS] speech_end error:", err);
              sendJSON(ws, { type: "error", message: err.message });
            });
          }
          break;
        }

        case "interrupt": {
          const session = activeSessions.get(ws);
          if (session) {
            session.interrupt();
          }
          break;
        }

        case "update_location": {
          const lat = msg.lat;
          const lng = msg.lng;
          if (typeof lat === "number" && typeof lng === "number") {
            if (!demoSession.driverLocation) {
              demoSession.driverLocation = { city: "", state: "", lat, lng };
            } else {
              demoSession.driverLocation.lat = lat;
              demoSession.driverLocation.lng = lng;
            }
            // Reverse geocode in background
            reverseGeocode(lat, lng).then((geo) => {
              if (demoSession.driverLocation) {
                demoSession.driverLocation.city = geo.city;
                demoSession.driverLocation.state = geo.state;
              }
            }).catch(() => {});
          }
          break;
        }

        case "end_session": {
          const session = activeSessions.get(ws);
          if (session) {
            session.end();
            activeSessions.delete(ws);
            setActiveVoiceSession(null);
          }
          break;
        }
      }
    } catch (err) {
      console.error("[WS] Message parse error:", err);
    }
  });

  ws.on("close", () => {
    const session = activeSessions.get(ws);
    if (session) {
      session.end();
      activeSessions.delete(ws);
    }
    console.log("[WS] Client disconnected");
  });
});

function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

async function saveSession(summary: SessionSummary): Promise<void> {
  try {
    // Ensure default driver exists
    const existing = await db
      .select({ id: schema.driverProfiles.id })
      .from(schema.driverProfiles)
      .where(eq(schema.driverProfiles.id, summary.driverId))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(schema.driverProfiles).values({
        id: summary.driverId,
        name: "Driver",
      });
    }

    // Save voice session
    await db.insert(schema.voiceSessions).values({
      id: summary.sessionId,
      driverId: summary.driverId,
      startedAt: new Date(summary.startedAt),
      endedAt: new Date(summary.endedAt),
      transcript: summary.transcript,
      summary: summary.transcript.map((t) => `${t.role}: ${t.text}`).join("\n"),
    });

    // Save action items
    for (const item of summary.actionItems) {
      await db.insert(schema.actionItems).values({
        sessionId: summary.sessionId,
        driverId: summary.driverId,
        type: item.type,
        title: item.title,
        summary: item.summary,
        data: item.data,
        actionButtons: item.actionButtons,
        status: "pending",
      });
    }
  } catch (err) {
    console.error("[DB] Failed to save session:", err);
  }
}

// ─── Start Server ────────────────────────────────────────────────────────────

// Initialize filler cache at startup (non-blocking)
fillerCache.initialize().catch((err) => {
  console.error("[FillerCache] Init error:", err);
});

server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         RoadPilot Backend v0.2.0         ║
  ║──────────────────────────────────────────║
  ║  Server:    http://localhost:${PORT}         ║
  ║  WebSocket: ws://localhost:${PORT}/ws        ║
  ║  Agent:     RoadPilot (Claude + 16 tools)║
  ║  Voice:     Pulse STT + Waves TTS        ║
  ║  Workflows: load-booking,                ║
  ║             broker-negotiation           ║
  ╚══════════════════════════════════════════╝
  `);
});

export { mastra, app, server };
