import { io } from "socket.io-client";

const DEFAULT_SIGNALING_URL = "https://shadowroom.onrender.com";
const CONNECT_WAIT_MS = 8000;
const RESPONSE_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message || "Request timed out.")), ms)
    ),
  ]);
}

export function createSignalingClient({ url = DEFAULT_SIGNALING_URL } = {}) {
  const socket = io(url, {
    transports: ["websocket", "polling"],
    autoConnect: true,
  });

  const on = (event, handler) => {
    socket.on(event, handler);
    return () => socket.off(event, handler);
  };

  const once = (event) =>
    new Promise((resolve) => {
      socket.once(event, resolve);
    });

  const connectionErrorMessage = (err) => {
    const msg = (err?.message || "").toLowerCase();
    if (msg.includes("websocket") || msg.includes("connection") || msg.includes("refused") || msg.includes("failed")) {
      return `Can't connect to the signaling server at ${url}. Start it in a terminal: cd server && npm run dev`;
    }
    return err?.message || "Connection failed.";
  };

  const waitForConnect = () =>
    new Promise((resolve, reject) => {
      if (socket.connected) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        socket.off("connect", onConnect);
        socket.off("connect_error", onErr);
        reject(new Error("Could not reach the signaling server. Is it running? Start it: cd server && npm run dev"));
      }, CONNECT_WAIT_MS);
      const onConnect = () => {
        clearTimeout(t);
        socket.off("connect_error", onErr);
        resolve();
      };
      const onErr = (err) => {
        clearTimeout(t);
        socket.off("connect", onConnect);
        reject(new Error(connectionErrorMessage(err)));
      };
      socket.once("connect", onConnect);
      socket.once("connect_error", onErr);
    });

  const createPin = async () => {
    await waitForConnect();
    socket.emit("pin:create");
    const res = await withTimeout(
      once("pin:created"),
      RESPONSE_TIMEOUT_MS,
      "Server did not respond. Try again."
    );
    return res;
  };

  const joinPin = async (pin) => {
    await waitForConnect();
    socket.emit("pin:join", { pin });
    const res = await withTimeout(
      once("pin:join:result"),
      RESPONSE_TIMEOUT_MS,
      "Server did not respond. Check the PIN and try again."
    );
    return res;
  };

  const sendSignal = ({ pin, data }) => {
    socket.emit("webrtc:signal", { pin, data });
  };

  return {
    socket,
    on,
    createPin,
    joinPin,
    sendSignal,
    disconnect: () => socket.disconnect(),
    connect: () => socket.connect(),
    url,
  };
}

