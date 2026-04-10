import http from "http";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { Server as SocketIOServer } from "socket.io";
import { PinStore } from "./pinStore.js";
import { createLogger } from "./logger.js";
import { registerSocketHandlers } from "./socket.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "https://shadowroom-chat.netlify.app";
const PIN_TTL_MS = process.env.PIN_TTL_MS ? Number(process.env.PIN_TTL_MS) : 10 * 60 * 1000;

const logger = createLogger();
const app = express();

const corsCredentials = CLIENT_ORIGIN !== "*";

app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: corsCredentials,
  })
);
app.use(express.json({ limit: "1mb" }));

// Rate limiting: prevent abuse on room creation
const roomLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 rooms per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." },
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// In-memory room store for demo purposes.
const roomsByCode = new Map(); // code -> { id, code, name, adminName }

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

app.post("/api/rooms", roomLimiter, (req, res) => {
  const { adminName, roomName } = req.body || {};
  if (!adminName || !roomName) {
    return res.status(400).json({ message: "adminName and roomName are required" });
  }

  const id = generateId();
  let code;
  for (let i = 0; i < 10; i++) {
    const candidate = generateRoomCode();
    if (!roomsByCode.has(candidate)) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return res.status(500).json({ message: "Could not generate room code" });
  }

  const room = { id, code, name: roomName, adminName, createdAt: Date.now() };
  roomsByCode.set(code, room);

  logger.info("room created", { code, id, roomName, adminName });
  res.json({ roomId: id, code, roomName });
});

app.post("/api/rooms/join", roomLimiter, (req, res) => {
  const { roomCode, userName } = req.body || {};
  if (!roomCode || !userName) {
    return res.status(400).json({ message: "roomCode and userName are required" });
  }

  const code = String(roomCode).toUpperCase();
  const room = roomsByCode.get(code);
  if (!room) {
    return res.status(404).json({ message: "Room not found" });
  }

  logger.info("room joined", { code, userName });
  res.json({ roomId: room.id, roomName: room.name });
});

const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: CLIENT_ORIGIN, // Use the variable from your .env or Render settings
    methods: ["GET", "POST"],
    credentials: true
  }
});

const pinStore = new PinStore({ ttlMs: PIN_TTL_MS });
registerSocketHandlers(io, { pinStore, logger, roomsByCode });

// Cleanup expired PINs periodically.
setInterval(() => pinStore.cleanupExpired(), 30 * 1000).unref?.();

// Cleanup abandoned rooms (no socket users) older than 1 hour
const ROOM_TTL_MS = process.env.ROOM_TTL_MS ? Number(process.env.ROOM_TTL_MS) : 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of roomsByCode.entries()) {
    if (now - (room.createdAt || 0) > ROOM_TTL_MS) {
      roomsByCode.delete(code);
    }
  }
}, 5 * 60 * 1000).unref?.();

server.listen(PORT, () => {
  logger.info("signaling server listening", { port: PORT, clientOrigin: CLIENT_ORIGIN });
});
