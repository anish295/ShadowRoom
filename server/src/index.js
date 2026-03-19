import http from "http";
import express from "express";
import cors from "cors";
import multer from "multer";
import { Server as SocketIOServer } from "socket.io";
import { PinStore } from "./pinStore.js";
import { createLogger } from "./logger.js";
import { registerSocketHandlers } from "./socket.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// In-memory room + file stores for demo purposes.
const roomsByCode = new Map(); // code -> { id, code, name, adminName }
const filesById = new Map(); // id -> { buffer, mime, name, size }

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

app.post("/api/rooms", (req, res) => {
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

app.post("/api/rooms/join", (req, res) => {
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

const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/upload", upload.single("file"), (req, res) => {
  const file = req.file;
  const { roomCode, userName } = req.body || {};
  if (!file || !roomCode) {
    return res.status(400).json({ message: "file and roomCode are required" });
  }

  const id = generateId();
  const info = {
    id,
    name: file.originalname,
    size: file.size,
    mime: file.mimetype,
    url: `/files/${id}/${encodeURIComponent(file.originalname)}`,
    uploadedBy: userName || "unknown",
    uploadedAt: Date.now(),
    roomCode: String(roomCode).toUpperCase(),
  };

  filesById.set(id, {
    buffer: file.buffer,
    mime: file.mimetype,
    name: file.originalname,
    size: file.size,
  });

  // NOTE: Socket broadcast is handled by the client via "file-shared" socket event
  // This avoids the double-render issue where the HTTP response and socket event both add the file.

  logger.info("file uploaded", { id, name: info.name, roomCode: info.roomCode, size: info.size });
  res.json(info);
});

app.get("/files/:id/:name", (req, res) => {
  const { id } = req.params;
  const stored = filesById.get(id);
  if (!stored) {
    return res.status(404).send("File not found");
  }

  res.setHeader("Content-Type", stored.mime || "application/octet-stream");
  res.setHeader("Content-Length", stored.size);
  res.setHeader("Content-Disposition", `inline; filename="${stored.name}"`);
  res.send(stored.buffer);
});

const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
    credentials: corsCredentials,
  },
});

const pinStore = new PinStore({ ttlMs: PIN_TTL_MS });
registerSocketHandlers(io, { pinStore, logger });

// Cleanup expired PINs periodically.
setInterval(() => pinStore.cleanupExpired(), 30 * 1000).unref?.();

server.listen(PORT, () => {
  logger.info("signaling server listening", { port: PORT, clientOrigin: CLIENT_ORIGIN });
});

