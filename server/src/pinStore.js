const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isSixDigitPin(pin) {
  return typeof pin === "string" && /^[0-9]{6}$/.test(pin);
}

function generatePin() {
  // 000000–999999 (string), but avoid leading zeros looking "short"
  const n = Math.floor(Math.random() * 1_000_000);
  return String(n).padStart(6, "0");
}

export class PinStore {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    /** @type {Map<string, {createdAt:number, sockets:Set<string>}>} */
    this.pins = new Map();
  }

  createPin({ socketId }) {
    // Try a few times to avoid collisions.
    for (let i = 0; i < 20; i++) {
      const pin = generatePin();
      if (!this.pins.has(pin)) {
        this.pins.set(pin, { createdAt: Date.now(), sockets: new Set([socketId]) });
        return pin;
      }
    }
    return null;
  }

  has(pin) {
    return this.pins.has(pin);
  }

  validate(pin) {
    if (!isSixDigitPin(pin)) return { ok: false, reason: "INVALID_FORMAT" };
    const room = this.pins.get(pin);
    if (!room) return { ok: false, reason: "NOT_FOUND" };
    if (Date.now() - room.createdAt > this.ttlMs) {
      this.pins.delete(pin);
      return { ok: false, reason: "EXPIRED" };
    }
    return { ok: true, room };
  }

  join(pin, { socketId }) {
    const v = this.validate(pin);
    if (!v.ok) return { ok: false, reason: v.reason };

    const { room } = v;
    if (room.sockets.has(socketId)) return { ok: true, status: "ALREADY_JOINED" };
    if (room.sockets.size >= 2) return { ok: false, reason: "ROOM_FULL" };

    room.sockets.add(socketId);
    return { ok: true, status: "JOINED" };
  }

  leaveBySocketId(socketId) {
    /** @type {string[]} */
    const affectedPins = [];

    for (const [pin, room] of this.pins.entries()) {
      if (room.sockets.delete(socketId)) {
        affectedPins.push(pin);
        if (room.sockets.size === 0) {
          this.pins.delete(pin);
        }
      }
    }
    return affectedPins;
  }

  getPeerSocketId(pin, socketId) {
    const v = this.validate(pin);
    if (!v.ok) return null;
    const ids = [...v.room.sockets];
    return ids.find((id) => id !== socketId) ?? null;
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [pin, room] of this.pins.entries()) {
      if (now - room.createdAt > this.ttlMs) {
        this.pins.delete(pin);
      }
    }
  }
}

