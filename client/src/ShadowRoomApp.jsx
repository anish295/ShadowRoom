import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  lazy,
  Suspense,
} from "react";
import { motion } from "framer-motion";
import { Moon, Sun, Smile } from "lucide-react";
import { io } from "socket.io-client";
import axios from "axios";
import { sendFileP2P, setupFileReceiver, triggerDownload } from "./services/fileTransfer.js";
import logo from "./android-chrome-512x512.png";

// Lazy-load heavy animation component for smaller initial bundle
const HeroGeometric = lazy(() => import("./components/ui/HeroGeometric.jsx"));

const API_BASE = import.meta.env.VITE_SIGNALING_URL || "https://shadowroom.onrender.com";
const SESSION_KEY = "shadowroom-session";
const QUICK_EMOJIS = [
  "😂", "❤️", "🔥", "💯", "👍", "🙏", "💀", "😭",
  "✨", "👀", "🤔", "🫡", "🫠", "🙌", "✅", "❌",
  "🕵️", "🛡️", "🔒", "🚀", "⚡", "🤖", "📎", "🎯",
];

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // ignore
  }
}

/* ==================== HELPERS ==================== */
function isImageMime(mime) {
  return typeof mime === "string" && mime.startsWith("image/");
}

function getFileIcon(name) {
  if (!name) return "fa-file";
  const ext = name.split(".").pop().toLowerCase();
  const iconMap = {
    pdf: "fa-file-pdf",
    doc: "fa-file-word",
    docx: "fa-file-word",
    xls: "fa-file-excel",
    xlsx: "fa-file-excel",
    ppt: "fa-file-powerpoint",
    pptx: "fa-file-powerpoint",
    zip: "fa-file-archive",
    rar: "fa-file-archive",
    "7z": "fa-file-archive",
    mp3: "fa-file-audio",
    wav: "fa-file-audio",
    ogg: "fa-file-audio",
    mp4: "fa-file-video",
    avi: "fa-file-video",
    mkv: "fa-file-video",
    js: "fa-file-code",
    ts: "fa-file-code",
    jsx: "fa-file-code",
    py: "fa-file-code",
    html: "fa-file-code",
    css: "fa-file-code",
    txt: "fa-file-alt",
    md: "fa-file-alt",
  };
  return iconMap[ext] || "fa-file";
}

/* ==================== TOAST SYSTEM ==================== */
let toastId = 0;
function ToastContainer({ toasts, onRemove }) {
  return (
    <div className="toast-container" id="toastContainer">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type} ${t.show ? "show" : ""}`}>
          <div className="toast-icon">
            <i
              className={`fas ${t.type === "success" ? "fa-check-circle" : t.type === "error" ? "fa-exclamation-circle" : "fa-info-circle"}`}
            ></i>
          </div>
          <div className="toast-content">
            <div className="toast-title">{t.title}</div>
            <div className="toast-message">{t.message}</div>
          </div>
          <button className="toast-close" onClick={() => onRemove(t.id)}>
            <i className="fas fa-times"></i>
          </button>
        </div>
      ))}
    </div>
  );
}

export function ShadowRoomApp() {
  const [currentView, setCurrentView] = useState(() =>
    loadSession() ? "chat" : "auth",
  );
  const [sessionData, setSessionData] = useState(() => loadSession());

  const [adminName, setAdminName] = useState("");
  const [roomName, setRoomName] = useState("");
  const [userName, setUserName] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");

  const [messages, setMessages] = useState([]);
  const [messageText, setMessageText] = useState("");
  const [busy, setBusy] = useState(false);

  // P2P file transfer state
  // Maps transferId -> { direction, fileName, fileSize, progress, status, cancel? }
  const [activeTransfers, setActiveTransfers] = useState({});
  // Maps transferId -> { name, size, type, url, blob }
  const [receivedFiles, setReceivedFiles] = useState({});
  const activeTransferCancelRef = useRef({});

  // Pending file offers awaiting Accept/Decline
  // Array of { transferId, fileName, fileSize, fileType, senderName, senderSocketId, expiresAt }
  const [pendingOffers, setPendingOffers] = useState([]);
  const fileReceiverRef = useRef(null); // holds { acceptOffer, declineOffer }
  const [error, setError] = useState("");

  // Theme
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem("shadowroom-theme");
    return saved !== "light";
  });
  const [themeFlipDeg, setThemeFlipDeg] = useState(0);

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
  const [fileModalOpen, setFileModalOpen] = useState(false);

  // Users sidebar
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= 768;
  });

  const [usersSidebarVisible, setUsersSidebarVisible] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth > 768;
  });
  const [mobileActionsVisible, setMobileActionsVisible] = useState(false);
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [adminId, setAdminId] = useState(null);
  const [typingUsers, setTypingUsers] = useState([]);
  const [showGoToBottom, setShowGoToBottom] = useState(false);
  const [unreadWhileScrolled, setUnreadWhileScrolled] = useState(0);

  // Toasts
  const [toasts, setToasts] = useState([]);

  // File upload (batch multi-file)
  const [selectedFiles, setSelectedFiles] = useState([]);
  const fileInputRef = useRef(null);
  const uploadFileInputRef = useRef(null);

  // Reply / tagging state
  const [replyingTo, setReplyingTo] = useState(null);

  // User-join detection uses a previous socketId snapshot to prevent duplicate notices.
  const prevUserSocketIdsRef = useRef(new Set());
  const currentViewRef = useRef(currentView);
  currentViewRef.current = currentView;
  const sessionDataRef = useRef(sessionData);
  sessionDataRef.current = sessionData;

  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const messageInputRef = useRef(null);
  const emojiPickerRef = useRef(null);
  const modalSendBtnRef = useRef(null);

  const socket = useMemo(
    () =>
      io(API_BASE, {
        autoConnect: false,
      }),
    [],
  );

  const socketConnectedRef = useRef(false);
  const typingTimeoutRef = useRef(null);
  const isTypingRef = useRef(false);

  const rotatingTitles = useMemo(
    () => [
      "Private Sharing",
      "Signal-Proof Rooms",
      "Serverless SCTP Mesh",
      "Zero-Knowledge Sessions",
    ],
    [],
  );
  const [titleIndex, setTitleIndex] = useState(0);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);

  // ==================== HELPERS ====================
  const showToast = useCallback((title, message, type = "success") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, title, message, type, show: false }]);
    setTimeout(() => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, show: true } : t)),
      );
    }, 10);
    setTimeout(() => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, show: false } : t)),
      );
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 300);
    }, 5000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, show: false } : t)),
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  }, []);

  const updateSession = (patch) => {
    setSessionData((prev) => {
      const next = { ...(prev || {}), ...patch };
      saveSession(next);
      return next;
    });
  };

  const scrollToBottom = useCallback(() => {
    setUnreadWhileScrolled(0);
    setShowGoToBottom(false);
    isNearBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Theme toggle
  const toggleTheme = useCallback(() => {
    setThemeFlipDeg((prev) => prev + 180);
    setIsDarkMode((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("light", !next);
      localStorage.setItem("shadowroom-theme", next ? "dark" : "light");
      return next;
    });
  }, []);

  // Apply theme on mount
  useEffect(() => {
    document.documentElement.classList.toggle("light", !isDarkMode);
  }, []);

  // On first load, allow direct join via roomCode query and keep auth if no session.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const roomCodeParam = params.get("roomCode");
    if (roomCodeParam) {
      setRoomCodeInput(String(roomCodeParam).trim().toUpperCase());
      setJoinModalOpen(true);
    }

    const onBeforeUnload = () => {
      try {
        socket.emit("leave-room");
      } catch {
        // ignore
      }
      localStorage.removeItem(SESSION_KEY);
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onBeforeUnload);
    };
  }, [socket]);

  // Auto toggle sidebar depending on screen size
  useEffect(() => {
    const updateLayout = () => {
      const mobile = window.innerWidth <= 768;
      setIsMobile(mobile);
      setUsersSidebarVisible(!mobile);
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, []);

  // ==================== SOCKET ====================
  useEffect(() => {
    const interval = setInterval(() => {
      setTitleIndex((prev) => (prev + 1) % rotatingTitles.length);
    }, 2600);
    return () => clearInterval(interval);
  }, [rotatingTitles.length]);

  useEffect(() => {
    socket.on("connect", () => {
      socketConnectedRef.current = true;
    });
    socket.on("disconnect", () => {
      socketConnectedRef.current = false;
    });

    // Receive messages from OTHER users (sender already added theirs optimistically)
    socket.on("receive-message", (payload) => {
      setMessages((prev) => [
        ...prev,
        { ...payload, msgId: payload.msgId || crypto.randomUUID() },
      ]);
    });

    socket.on("system-message", ({ text, ts }) => {
      if (!text) return;
      setMessages((prev) => [
        ...prev,
        {
          type: "system",
          text,
          ts: ts || Date.now(),
          msgId: crypto.randomUUID(),
        },
      ]);
    });

    // Users list updates + join detection by socketId diff to avoid join-message spam.
    socket.on("users-updated", (users) => {
      const prevIds = prevUserSocketIdsRef.current;
      const nextIds = new Set(users.map((u) => u.socketId).filter(Boolean));

      if (currentViewRef.current === "chat" && prevIds.size > 0 && users.length > 0) {
        const newJoiners = users.filter((u) => u.socketId && !prevIds.has(u.socketId));
        for (const u of newJoiners) {
          if (u.userName === sessionDataRef.current?.userName) continue;
          setMessages((prev) => [
            ...prev,
            {
              type: "system",
              text: `${u.userName} joined the room.`,
              ts: Date.now(),
              msgId: crypto.randomUUID(),
            },
          ]);
        }
      }

      prevUserSocketIdsRef.current = nextIds;
      setConnectedUsers(users);

      const activeAdmin = users.find((u) => u.isAdmin);
      setAdminId(activeAdmin?.socketId || null);
    });

    socket.on("admin-changed", ({ adminId: nextAdminId, adminName } = {}) => {
      const normalizedAdminId = nextAdminId || null;
      setAdminId((prevAdminId) => {
        if (normalizedAdminId === socket.id && prevAdminId !== normalizedAdminId) {
          showToast("Admin Baton", "You are now the room admin.", "info");
        }
        return normalizedAdminId;
      });

      setSessionData((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          role: normalizedAdminId === socket.id ? "admin" : "participant",
        };
        saveSession(next);
        return next;
      });

      if (adminName && normalizedAdminId !== socket.id) {
        showToast("Admin Changed", `${adminName} is now the admin.`, "info");
      }
    });

    socket.on("kicked", ({ kickedBy } = {}) => {
      setMessages([]);
      setConnectedUsers([]);
      setTypingUsers([]);
      setAdminId(null);
      setUnreadWhileScrolled(0);
      setShowGoToBottom(false);
      setSessionData(null);
      localStorage.removeItem(SESSION_KEY);
      window.history.replaceState(null, "", "/");
      setCurrentView("auth");
      prevUserSocketIdsRef.current = new Set();
      showToast("Removed", `You were removed by ${kickedBy || "the admin"}.`, "error");
    });

    // Server-side room join errors (e.g., room deleted after link created)
    socket.on("join-room-error", ({ message }) => {
      showToast("Error", message || "Unable to join room.", "error");
      handleLeaveRoom();
    });

    // Typing indicators
    socket.on("user-typing", ({ userName }) => {
      setTypingUsers((prev) => {
        if (prev.includes(userName)) return prev;
        return [...prev, userName];
      });
    });

    socket.on("user-stop-typing", ({ userName }) => {
      setTypingUsers((prev) => prev.filter((u) => u !== userName));
    });

    socket.connect();

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("receive-message");
      socket.off("system-message");
      socket.off("users-updated");
      socket.off("admin-changed");
      socket.off("kicked");
      socket.off("join-room-error");
      socket.off("user-typing");
      socket.off("user-stop-typing");
      socket.disconnect();
    };
  }, [socket, showToast]);

  // Join the socket room when entering chat view
  useEffect(() => {
    if (
      currentView === "chat" &&
      sessionData?.roomCode
    ) {
      socket.emit("join-room", {
        roomCode: sessionData.roomCode,
        userName: sessionData.userName,
      });
    }
  }, [currentView, sessionData?.roomCode, socket]);

  // Also join when socket connects (in case view is already "chat")
  useEffect(() => {
    const handleConnect = () => {
      if (currentView === "chat" && sessionData?.roomCode) {
        socket.emit("join-room", {
          roomCode: sessionData.roomCode,
          userName: sessionData.userName,
        });
      }
    };
    socket.on("connect", handleConnect);
    return () => socket.off("connect", handleConnect);
  }, [currentView, sessionData, socket]);

  // Restore session on load
  useEffect(() => {
    const existing = loadSession();
    if (!existing) return;
    setSessionData(existing);
    setCurrentView("chat");
  }, []);

  // Smart autoscroll: only pin to bottom if the viewer is already near it.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;

    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distanceFromBottom <= 200;
      isNearBottomRef.current = nearBottom;
      setShowGoToBottom(!nearBottom);
      if (nearBottom) setUnreadWhileScrolled(0);
    };

    onScroll();
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [currentView]);

  useEffect(() => {
    const currentCount = messages.length;
    const hadNewMessage = currentCount > prevMessageCountRef.current;
    const wasReset = currentCount === 0 && prevMessageCountRef.current > 0;

    if (wasReset) {
      prevMessageCountRef.current = 0;
      setUnreadWhileScrolled(0);
      setShowGoToBottom(false);
      return;
    }

    if (!hadNewMessage) {
      prevMessageCountRef.current = currentCount;
      return;
    }

    const latest = messages[currentCount - 1];
    const shouldForceScroll = Boolean(latest?.self) || prevMessageCountRef.current === 0;

    if (isNearBottomRef.current || shouldForceScroll) {
      scrollToBottom();
    } else {
      setShowGoToBottom(true);
      setUnreadWhileScrolled((prev) => prev + 1);
    }

    prevMessageCountRef.current = currentCount;
  }, [messages, scrollToBottom]);

  // (Join detection is handled directly inside the socket "users-updated" handler above)

  // Close emoji picker when clicking outside or pressing Escape.
  useEffect(() => {
    const onPointerDown = (event) => {
      if (!emojiPickerRef.current) return;
      if (!emojiPickerRef.current.contains(event.target)) {
        setEmojiPickerOpen(false);
      }
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setEmojiPickerOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (fileModalOpen) {
      modalSendBtnRef.current?.focus();
    }
  }, [fileModalOpen]);

  // ==================== TYPING INDICATOR ====================
  const handleTyping = useCallback(() => {
    if (!sessionData?.roomCode) return;

    if (!isTypingRef.current) {
      isTypingRef.current = true;
      socket.emit("typing", { roomCode: sessionData.roomCode });
    }

    // Reset the timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false;
      socket.emit("stop-typing", { roomCode: sessionData.roomCode });
    }, 2000);
  }, [sessionData?.roomCode, socket]);

  // ==================== ROOM OPERATIONS ====================
  const handleCreateRoom = async (e) => {
    e?.preventDefault();
    setError("");
    if (!adminName.trim() || !roomName.trim()) {
      showToast("Error", "Admin name and room name are required.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await axios.post(`${API_BASE}/api/rooms`, {
        adminName: adminName.trim(),
        roomName: roomName.trim(),
      });
      const { code, roomId, roomName: serverRoomName } = res.data;
      updateSession({
        roomCode: code,
        roomId,
        userName: adminName.trim(),
        roomName: serverRoomName || roomName.trim(),
        role: "admin",
      });
      window.history.replaceState(null, "", `/?roomCode=${code}`);
      setCreateModalOpen(false);
      setCurrentView("chat");
      // Reset join tracker on room lifecycle transitions.
      prevUserSocketIdsRef.current = new Set();
      setMessages([{
        type: "system",
        text: "You created this room.",
        ts: Date.now(),
        msgId: crypto.randomUUID(),
      }]);
      showToast("Room Created", `Room ${code} is ready`, "success");
    } catch (err) {
      showToast(
        "Error",
        err?.response?.data?.message ||
        err?.message ||
        "Failed to create room.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleJoinRoom = async (e) => {
    e?.preventDefault();
    setError("");
    if (!userName.trim() || !roomCodeInput.trim()) {
      showToast("Error", "Name and room code are required.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await axios.post(`${API_BASE}/api/rooms/join`, {
        roomCode: roomCodeInput.trim(),
        userName: userName.trim(),
      });
      const { roomId, roomName: joinedRoomName } = res.data;
      updateSession({
        roomCode: roomCodeInput.trim().toUpperCase(),
        roomId,
        userName: userName.trim(),
        roomName: joinedRoomName,
        role: "participant",
      });
      window.history.replaceState(null, "", `/?roomCode=${roomCodeInput.trim().toUpperCase()}`);
      setJoinModalOpen(false);
      setCurrentView("chat");
      prevUserSocketIdsRef.current = new Set();
      setMessages([{
        type: "system",
        text: "You joined this room.",
        ts: Date.now(),
        msgId: crypto.randomUUID(),
      }]);
      showToast(
        "Joined Room",
        `Welcome to ${joinedRoomName || roomCodeInput.trim()}`,
        "success",
      );
    } catch (err) {
      showToast(
        "Error",
        err?.response?.data?.message || err?.message || "Failed to join room.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSendMessage = async (e) => {
    e?.preventDefault();
    if (!messageText.trim() || !sessionData?.roomCode) return;
    if (!socketConnectedRef.current) {
      showToast(
        "Error",
        "Socket not connected yet. Please wait a moment.",
        "error",
      );
      return;
    }

    const msgId = crypto.randomUUID();
    const payload = {
      msgId,
      text: messageText.trim(),
      roomCode: sessionData.roomCode,
      userName: sessionData.userName,
      userId: socket.id,
      ts: Date.now(),
      ...(replyingTo ? { replyTo: replyingTo } : {}),
    };

    // Optimistically add to local state (server won't echo back to sender)
    setMessages((prev) => [...prev, { ...payload, self: true }]);
    setMessageText("");
    setReplyingTo(null);

    // Re-focus the message input after sending
    messageInputRef.current?.focus();

    // Stop typing indicator
    if (isTypingRef.current) {
      isTypingRef.current = false;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      socket.emit("stop-typing", { roomCode: sessionData.roomCode });
    }

    socket.emit("send-message", payload);
  };

  // ==================== P2P FILE RECEIVER SETUP ====================
  useEffect(() => {
    if (!socket || currentView !== "chat") return;

    const receiver = setupFileReceiver(socket, {
      onFileOffer: ({ transferId, fileName, fileSize, fileType, senderName, senderSocketId }) => {
        // Add to pending offers with 30s expiry and checked=true by default
        const expiresAt = Date.now() + 30_000;
        setPendingOffers((prev) => [
          ...prev,
          { transferId, fileName, fileSize, fileType, senderName, senderSocketId, expiresAt, checked: true },
        ]);
      },
      onReceiveStart: ({ transferId, fileName, fileSize, senderName }) => {
        setActiveTransfers((prev) => ({
          ...prev,
          [transferId]: {
            direction: "in",
            fileName,
            fileSize,
            progress: 0,
            status: "receiving",
          },
        }));
        // Add incoming message with actual sender name
        setMessages((prev) => [
          ...prev,
          {
            type: "file-incoming",
            transferId,
            fileName,
            fileSize,
            userName: senderName || "Peer",
            ts: Date.now(),
            self: false,
          },
        ]);
      },
      onProgress: (transferId, receivedBytes, totalBytes) => {
        setActiveTransfers((prev) => ({
          ...prev,
          [transferId]: {
            ...prev[transferId],
            progress: totalBytes > 0 ? receivedBytes / totalBytes : 0,
            status: "receiving",
          },
        }));
      },
      onComplete: (transferId, { name, size, type, blob, url, savedToDisk }) => {
        // Store received file for download
        setReceivedFiles((prev) => ({
          ...prev,
          [transferId]: { name, size, type, url, blob, savedToDisk },
        }));
        // Update transfer status
        setActiveTransfers((prev) => {
          const updated = { ...prev };
          delete updated[transferId];
          return updated;
        });
        // Update the incoming message to show as completed file
        setMessages((prev) =>
          prev.map((m) =>
            m.transferId === transferId
              ? {
                ...m,
                type: "file",
                fileUrl: url || null,
                fileMime: type,
                self: false,
                savedToDisk: !!savedToDisk,
              }
              : m,
          ),
        );
        showToast(
          "File Received",
          savedToDisk ? `"${name}" saved to disk` : `"${name}" downloaded`,
          "success",
        );
      },
      onError: (transferId, err) => {
        setActiveTransfers((prev) => {
          const updated = { ...prev };
          delete updated[transferId];
          return updated;
        });
        showToast("Transfer Failed", err?.message || "File transfer failed", "error");
      },
      onStorageError: (transferId, { message }) => {
        showToast("Insufficient Storage", message, "error");
      },
    });

    fileReceiverRef.current = receiver;
    return () => {
      receiver.destroy();
      fileReceiverRef.current = null;
    };
  }, [socket, currentView, showToast]);

  // ==================== PENDING OFFER COUNTDOWN ====================
  useEffect(() => {
    if (pendingOffers.length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setPendingOffers((prev) => {
        const still = [];
        for (const offer of prev) {
          if (now >= offer.expiresAt) {
            // Auto-decline on timeout
            fileReceiverRef.current?.declineOffer(offer.transferId);
            socket.emit("file-timeout", {
              senderSocketId: offer.senderSocketId,
              transferId: offer.transferId,
            });
          } else {
            still.push(offer);
          }
        }
        return still;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [pendingOffers.length, socket]);

  const handleAcceptOffer = useCallback((transferId) => {
    fileReceiverRef.current?.acceptOffer(transferId);
    setPendingOffers((prev) => prev.filter((o) => o.transferId !== transferId));
  }, []);

  const handleDeclineOffer = useCallback((transferId) => {
    fileReceiverRef.current?.declineOffer(transferId);
    setPendingOffers((prev) => prev.filter((o) => o.transferId !== transferId));
  }, []);

  // Toggle checkbox on a pending offer (Download List Modal)
  const toggleOfferCheck = useCallback((transferId) => {
    setPendingOffers((prev) =>
      prev.map((o) =>
        o.transferId === transferId ? { ...o, checked: !o.checked } : o,
      ),
    );
  }, []);

  // Accept checked offers SEQUENTIALLY so each showSaveFilePicker prompt
  // gets its own user-gesture context (browsers block concurrent pickers)
  const handleDownloadSelected = useCallback(async () => {
    const offersSnapshot = [...pendingOffers];
    setPendingOffers([]);
    for (const offer of offersSnapshot) {
      if (offer.checked) {
        // acceptOffer is async (awaits showSaveFilePicker) — must finish before next
        await fileReceiverRef.current?.acceptOffer(offer.transferId);
      } else {
        fileReceiverRef.current?.declineOffer(offer.transferId);
      }
    }
  }, [pendingOffers]);

  // Decline every pending offer
  const handleDeclineAll = useCallback(() => {
    for (const offer of pendingOffers) {
      fileReceiverRef.current?.declineOffer(offer.transferId);
    }
    setPendingOffers([]);
  }, [pendingOffers]);

  // ==================== P2P FILE SEND ====================
  const handleFileShare = useCallback((file) => {
    if (!file || !sessionData?.roomCode) return;
    // NOTE: modal is already closed by handleFilesShare before calling this
    setError("");

    const { cancel, transferId } = sendFileP2P(
      socket,
      sessionData.roomCode,
      sessionData.userName,
      file,
      {
        onPeerProgress: (_receiverSocketId, sentBytes, totalBytes) => {
          setActiveTransfers((prev) => ({
            ...prev,
            [transferId]: {
              ...prev[transferId],
              progress: totalBytes > 0 ? sentBytes / totalBytes : 0,
              status: "sending",
            },
          }));
        },
        onComplete: () => {
          setActiveTransfers((prev) => {
            const updated = { ...prev };
            delete updated[transferId];
            return updated;
          });
          delete activeTransferCancelRef.current[transferId];
          showToast("File Sent", "Peer confirmed receipt (ACK)", "success");
        },
        onError: (err) => {
          setActiveTransfers((prev) => {
            const updated = { ...prev };
            delete updated[transferId];
            return updated;
          });
          delete activeTransferCancelRef.current[transferId];
          if (err?.message !== "Transfer cancelled") {
            showToast("Error", err?.message || "File transfer failed", "error");
          }
        },
        onDeclined: () => {
          showToast("Info", "Peer declined the file transfer", "info");
        },
      },
    );

    // Store cancel function
    activeTransferCancelRef.current[transferId] = cancel;

    // Track transfer
    setActiveTransfers((prev) => ({
      ...prev,
      [transferId]: {
        direction: "out",
        fileName: file.name,
        fileSize: file.size,
        progress: 0,
        status: "waiting",
      },
    }));

    // Add as chat message (self)
    setMessages((prev) => [
      ...prev,
      {
        type: "file",
        transferId,
        fileId: transferId,
        fileName: file.name,
        fileSize: file.size,
        fileMime: file.type || "application/octet-stream",
        userName: sessionData.userName,
        ts: Date.now(),
        roomCode: sessionData.roomCode,
        self: true,
      },
    ]);
  }, [socket, sessionData, showToast]);

  // Send multiple files sequentially — each gets its own P2P transfer
  const handleFilesShare = useCallback((files) => {
    if (!files?.length || !sessionData?.roomCode) return;
    setFileModalOpen(false);
    setSelectedFiles([]);
    setError("");
    for (const file of files) {
      handleFileShare(file);
    }
  }, [handleFileShare, sessionData?.roomCode]);

  const handleEmojiClick = useCallback((emoji) => {
    setMessageText((prev) => `${prev}${emoji}`);
    setEmojiPickerOpen(false);
    messageInputRef.current?.focus();
  }, []);

  const handleKick = useCallback((targetSocketId) => {
    if (!sessionData?.roomCode || !targetSocketId) return;
    if (adminId !== socket.id) return;
    socket.emit("kick-user", {
      roomCode: sessionData.roomCode,
      targetSocketId,
    });
  }, [adminId, sessionData?.roomCode, socket]);

  const handlePaste = useCallback((event) => {
    const clipboardItems = Array.from(event.clipboardData?.items || []);
    const pastedFiles = clipboardItems
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);

    if (pastedFiles.length === 0) return;

    event.preventDefault();
    setSelectedFiles((prev) => [...prev, ...pastedFiles]);
    setFileModalOpen(true);
    showToast(
      "File Detected",
      `Added ${pastedFiles.length} pasted file${pastedFiles.length > 1 ? "s" : ""} for review.`,
      "info",
    );
  }, [showToast]);

  const handleLeaveRoom = () => {
    socket.emit("leave-room");
    setMessages([]);
    setConnectedUsers([]);
    setTypingUsers([]);
    setAdminId(null);
    setUnreadWhileScrolled(0);
    setShowGoToBottom(false);
    setSessionData(null);
    localStorage.removeItem(SESSION_KEY);
    window.history.replaceState(null, "", "/");
    setCurrentView("auth");
    prevUserSocketIdsRef.current = new Set();
    setLeaveModalOpen(false);
    showToast("Left Room", "You have left the room", "info");
  };

  const currentUserIsAdmin = adminId === socket.id;

  const handleCopyRoomCode = () => {
    if (!sessionData?.roomCode) return;
    const code = sessionData.roomCode;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(code)
        .then(() => {
          showToast("Copied", "Room code copied to clipboard", "info");
        })
        .catch(() => {
          fallbackCopy(code);
        });
    } else {
      fallbackCopy(code);
    }
  };

  const fallbackCopy = (text) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand("copy");
      showToast("Copied", "Room code copied to clipboard", "info");
    } catch {
      showToast("Error", "Failed to copy room code", "error");
    }
    document.body.removeChild(textArea);
  };

  const formatTime = (ts) => {
    return new Date(ts || Date.now()).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  };

  const getInitial = (name) => (name || "?")[0].toUpperCase();

  const avatarColors = ["purple", "green", "orange", "pink"];
  const getAvatarColor = (name) => {
    if (!name) return avatarColors[0];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return avatarColors[Math.abs(hash) % avatarColors.length];
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    let count = Number(bytes);
    let index = 0;
    while (count >= 1024 && index < sizes.length - 1) {
      count /= 1024;
      index += 1;
    }
    return `${count.toFixed(2)} ${sizes[index]}`;
  };

  // ==================== FILE MESSAGE BUBBLE ====================
  const renderFileMessage = (m) => {
    const isImage = isImageMime(m.fileMime);
    const sizeLabel = m.fileSize ? formatBytes(m.fileSize) : "";
    const blobUrl = m.fileUrl;
    const transferProgress = m.transferId ? activeTransfers[m.transferId] : null;

    // In-progress incoming transfer
    if (m.type === "file-incoming" && transferProgress) {
      const pct = Math.round((transferProgress.progress || 0) * 100);
      return (
        <div className="file-bubble-container">
          <div className="file-bubble-doc">
            <div className="file-bubble-doc-icon">
              <i className={`fas ${getFileIcon(m.fileName)}`}></i>
            </div>
            <div className="file-bubble-doc-info">
              <div className="file-bubble-doc-name">{m.fileName}</div>
              <div className="file-bubble-doc-size">
                {sizeLabel} · <span style={{ color: "var(--accent)" }}>{transferProgress.status === "connecting" ? "Connecting..." : `Receiving ${pct}%`}</span>
              </div>
            </div>
          </div>
          <div className="sr-progress" style={{ marginTop: "0.5rem" }}>
            <div className="sr-progress-fill" style={{ width: `${pct}%`, background: "var(--gradient-2)" }} />
          </div>
        </div>
      );
    }

    const openFile = () => {
      if (blobUrl) window.open(blobUrl, "_blank", "noopener,noreferrer");
    };

    const downloadFile = () => {
      if (blobUrl) triggerDownload(blobUrl, m.fileName);
    };

    return (
      <div className="file-bubble-container">
        {isImage && blobUrl ? (
          <div className="file-bubble-image" onClick={openFile}>
            <img src={blobUrl} alt={m.fileName} loading="lazy" />
            <div className="file-bubble-image-overlay">
              <i className="fas fa-expand-alt"></i>
            </div>
          </div>
        ) : (
          <div className="file-bubble-doc">
            <div className="file-bubble-doc-icon">
              <i className={`fas ${getFileIcon(m.fileName)}`}></i>
            </div>
            <div className="file-bubble-doc-info">
              <div className="file-bubble-doc-name">{m.fileName}</div>
              <div className="file-bubble-doc-size">
                {sizeLabel}
                {m.self && <span style={{ marginLeft: "0.5rem", color: "var(--accent)", fontSize: "0.75rem" }}>
                  <i className="fas fa-check-circle" style={{ marginRight: "0.2rem" }}></i>Sent via P2P
                </span>}
              </div>
            </div>
          </div>
        )}

        <div className="file-bubble-actions">
          {/* After download — disk mode (no blob URL) */}
          {!blobUrl && !m.self && m.savedToDisk && (
            <span style={{ fontSize: "0.8rem", color: "var(--success, #22c55e)", display: "flex", alignItems: "center", gap: "0.3rem" }}>
              <i className="fas fa-check-double" style={{ fontSize: "0.7rem" }}></i>
              Saved to your chosen location
            </span>
          )}
          {/* Blob URL available — show Open File */}
          {blobUrl && (
            <button type="button" className="file-action-btn" onClick={openFile}>
              <i className="fas fa-external-link-alt"></i>
              Open File
            </button>
          )}
          {!blobUrl && m.self && (
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "0.3rem" }}>
              <i className="fas fa-paper-plane" style={{ fontSize: "0.7rem" }}></i>
              Sent to peers
            </span>
          )}
        </div>
      </div>
    );
  };

  // ==================== AUTH VIEW (Landing Page) ====================
  const renderAuthView = () => (
    <div className="page landing-page active" style={{ position: "relative" }}>
      {/* Navbar */}
      <nav className="navbar">
        <div className="logo logo-left-corner">
          <div className="logo-icon">
            <img
              src={logo}
              alt="ShadowRoom Logo"
              className="logo-mark"
            />
          </div>
          <span>ShadowRoom</span>
        </div>
        <div className="nav-actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title="Toggle Theme"
          >
            <motion.span
              className="theme-icon-wrap"
              animate={{ rotateY: themeFlipDeg }}
              transition={{ duration: 0.45, ease: "easeInOut" }}
              style={{ transformStyle: "preserve-3d" }}
            >
              {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
            </motion.span>
          </button>
        </div>
      </nav>

      {/* Hero — Geometric animated section */}
      <Suspense
        fallback={
          <section
            className="hero"
            style={{
              minHeight: "100vh",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div className="hero-content" style={{ textAlign: "center" }}>
              <h1 className="hero-title" style={{ color: "#fff" }}>
                ShadowRoom
              </h1>
            </div>
          </section>
        }
      >
        <HeroGeometric
          title1="The Future of"
          title2={rotatingTitles[titleIndex]}
          onCreateRoom={() => setCreateModalOpen(true)}
          onJoinRoom={() => setJoinModalOpen(true)}
        />
      </Suspense>

      {/* Features */}
      <section className="features-section">
        <h2 className="section-title">Why ShadowRoom?</h2>
        <p className="section-subtitle">
          Built with security and privacy as the core foundation
        </p>
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-network-wired"></i>
            </div>
            <h3 className="feature-title">WebRTC Direct Transfer</h3>
            <p className="feature-desc">
              Files travel peer-to-peer over SCTP data channels — your data
              never touches our servers. Raw speed, zero middlemen.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-eye-slash"></i>
            </div>
            <h3 className="feature-title">Zero-Knowledge Privacy</h3>
            <p className="feature-desc">
              No accounts, no email, no tracking pixels. The server knows
              nothing about who you are or what you send.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-ghost"></i>
            </div>
            <h3 className="feature-title">Volatile Sessions</h3>
            <p className="feature-desc">
              Rooms exist only in memory. When the last peer disconnects, every
              message and file reference is permanently erased.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-shield-alt"></i>
            </div>
            <h3 className="feature-title">E2E Encrypted Relay</h3>
            <p className="feature-desc">
              Chat messages are AES-encrypted client-side before reaching the
              signaling layer. Only participants hold the key.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-satellite-dish"></i>
            </div>
            <h3 className="feature-title">Peer-to-Peer File Beam</h3>
            <p className="feature-desc">
              Direct Browser-to-Browser SCTP Channels (Serverless). No relay
              payloads, no data persistence, no surveillance surface.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-bolt"></i>
            </div>
            <h3 className="feature-title">Serverless Signaling</h3>
            <p className="feature-desc">
              Direct Browser-to-Browser SCTP Channels (Serverless). Signaling only
              bootstraps peers, then payloads remain end-to-end in-browser.
            </p>
          </div>
        </div>
      </section>

      {/* How it Works */}
      <section className="how-section">
        <h2 className="section-title">How It Works</h2>
        <p className="section-subtitle">Get started in three simple steps</p>
        <div className="steps-container">
          <div className="step-card">
            <div className="step-number">
              <i className="fas fa-plus"></i>
            </div>
            <h3 className="step-title">Create Room</h3>
            <p className="step-desc">
              Generate a unique secure room code instantly
            </p>
          </div>
          <div className="step-card">
            <div className="step-number">
              <i className="fas fa-share-alt"></i>
            </div>
            <h3 className="step-title">Share Code</h3>
            <p className="step-desc">
              Send the room code to people you want to chat with
            </p>
          </div>
          <div className="step-card">
            <div className="step-number">
              <i className="fas fa-comments"></i>
            </div>
            <h3 className="step-title">Start Chatting</h3>
            <p className="step-desc">
              Communicate securely with end-to-end encryption
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <p className="footer-text">© 2026, ShadowRoom</p>
        <p className="footer-text">
          Made with <i className="fas fa-heart"></i> by NSUTians
        </p>
      </footer>
    </div>
  );

  // ==================== CHAT VIEW ====================
  const renderChatView = () => (
    <div
      className="chat-page"
      style={{ position: "relative", opacity: 1, visibility: "visible" }}
    >
      {/* Chat Header */}
      <header className="chat-header">
        <div className="chat-room-info">
          <div className="room-avatar">
            <img src={logo} alt="ShadowRoom Logo" className="logo-mark" />
          </div>
          <div className="room-details">
            <h3>ShadowRoom</h3>
            <div
              className="room-code-badge"
              style={{ cursor: "pointer" }}
              onClick={handleCopyRoomCode}
              title="Click to copy room code"
            >
              <i className="fas fa-key"></i>
              <span>{sessionData?.roomCode || "------"}</span>
              <i
                className="fas fa-copy"
                style={{
                  marginLeft: "0.35rem",
                  fontSize: "0.8rem",
                  opacity: 0.7,
                }}
              ></i>
            </div>
          </div>
        </div>
        <div className="chat-header-actions">
          {isMobile ? (
            <div className="mobile-options">
              <button
                className="header-btn"
                title="Actions"
                onClick={() => setMobileActionsVisible((prev) => !prev)}
              >
                <i className="fas fa-bars"></i>
              </button>
              {mobileActionsVisible && (
                <div className="mobile-actions-dropdown">
                  <button
                    className="dropdown-btn"
                    onClick={() => {
                      setUsersSidebarVisible((prev) => !prev);
                      setMobileActionsVisible(false);
                    }}
                  >
                    <i className="fas fa-users"></i>
                    Users
                  </button>
                  <button
                    className="dropdown-btn"
                    onClick={() => {
                      toggleTheme();
                      setMobileActionsVisible(false);
                    }}
                  >
                    <span className="theme-icon-wrap">
                      {isDarkMode ? <Sun size={16} /> : <Moon size={16} />}
                    </span>
                    Theme
                  </button>
                  <button
                    className="dropdown-btn danger"
                    onClick={() => {
                      setLeaveModalOpen(true);
                      setMobileActionsVisible(false);
                    }}
                  >
                    <i className="fas fa-sign-out-alt"></i>
                    Leave
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <button
                className="header-btn"
                onClick={() => setUsersSidebarVisible(!usersSidebarVisible)}
                title="Toggle Users Panel"
              >
                <i className="fas fa-users"></i>
                {connectedUsers.length > 0 && (
                  <span className="badge">{connectedUsers.length}</span>
                )}
              </button>
              <button
                className="header-btn"
                onClick={toggleTheme}
                title="Toggle Theme"
              >
                <motion.span
                  className="theme-icon-wrap"
                  animate={{ rotateY: themeFlipDeg }}
                  transition={{ duration: 0.45, ease: "easeInOut" }}
                  style={{ transformStyle: "preserve-3d" }}
                >
                  {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
                </motion.span>
              </button>
              <button
                className="header-btn danger"
                onClick={() => setLeaveModalOpen(true)}
                title="Leave Room"
              >
                <i className="fas fa-sign-out-alt"></i>
              </button>
            </>
          )}
        </div>
      </header>

      {/* Chat Main */}
      <div className="chat-main">
        {isMobile && usersSidebarVisible && (
          <div
            className="sidebar-overlay"
            onClick={() => setUsersSidebarVisible(false)}
          />
        )}

        {/* Users Sidebar (LEFT) */}
        <aside
          className={`users-sidebar ${usersSidebarVisible ? "" : "hidden"}`}
        >
          <div className="sidebar-header">
            <div className="sidebar-title">
              <i className="fas fa-users"></i>
              {sessionData?.roomName
                ? `${sessionData.roomName.slice(0, 12)}${sessionData.roomName.length > 12 ? "..." : ""}`
                : "Online Users"}
            </div>
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <span className="online-count">{connectedUsers.length}</span>
              <button
                className="sidebar-close-btn"
                onClick={() => setUsersSidebarVisible(false)}
                title="Close"
              >
                <i className="fas fa-times"></i>
              </button>
            </div>
          </div>
          <div className="users-list custom-scrollbar">
            {connectedUsers.length === 0 && (
              <div
                style={{
                  fontSize: "0.9rem",
                  color: "var(--text-muted)",
                  textAlign: "center",
                  padding: "2rem 0",
                }}
              >
                <i
                  className="fas fa-user-clock"
                  style={{
                    fontSize: "2rem",
                    marginBottom: "0.5rem",
                    display: "block",
                    opacity: 0.3,
                  }}
                ></i>
                No users connected yet.
              </div>
            )}
            {connectedUsers.map((user) => (
              <div key={user.socketId} className="user-item">
                <div className={`user-avatar ${getAvatarColor(user.userName)}`}>
                  {getInitial(user.userName)}
                  <span className="online-indicator"></span>
                </div>
                <div className="user-info">
                  <div className="user-name">
                    {user.userName}
                    {user.socketId === socket.id && (
                      <span
                        className="user-badge"
                        style={{ marginLeft: "0.5rem" }}
                      >
                        You
                      </span>
                    )}
                  </div>
                  <div className="user-status-text">
                    {typingUsers.includes(user.userName) ? (
                      <span style={{ color: "var(--accent)" }}>
                        <i
                          className="fas fa-keyboard"
                          style={{ marginRight: "0.25rem" }}
                        ></i>
                        Typing...
                      </span>
                    ) : (
                      <span>
                        <i
                          className="fas fa-circle"
                          style={{ fontSize: "0.5rem", marginRight: "0.25rem" }}
                        ></i>
                        Online
                      </span>
                    )}
                  </div>
                </div>
                {user.isAdmin && <span className="user-badge">Admin</span>}
                {currentUserIsAdmin && user.socketId !== socket.id && !user.isAdmin && (
                  <button
                    type="button"
                    className="kick-user-btn"
                    title={`Remove ${user.userName}`}
                    onClick={() => handleKick(user.socketId)}
                  >
                    <i className="fas fa-user-slash" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Typing indicator at bottom of sidebar */}
          {typingUsers.length > 0 && (
            <div className="sidebar-typing-indicator">
              <div className="typing-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <span>
                {typingUsers.length === 1
                  ? `${typingUsers[0]} is typing...`
                  : `${typingUsers.length} people are typing...`}
              </span>
            </div>
          )}
        </aside>

        <div className="chat-messages-area">
          {/* Messages */}
          <div ref={messagesContainerRef} className="messages-container custom-scrollbar">
            {/* System welcome message */}
            <div className="system-message">
              <div className="system-message-content">
                <i className="fas fa-shield-alt"></i>
                Room created. All messages are encrypted.
              </div>
            </div>

            {messages.length === 0 && (
              <div className="system-message">
                <div className="system-message-content">
                  <i className="fas fa-info-circle"></i>
                  No messages yet. Say hi!
                </div>
              </div>
            )}

            {messages.map((m, idx) => {
              // ── System messages ──────────────────────────────────────
              if (m.type === "system") {
                return (
                  <div
                    key={m.msgId || `sys-${m.ts}-${idx}`}
                    className="system-message"
                  >
                    <div className="system-message-content">
                      <i className="fas fa-info-circle" />
                      {m.text}
                    </div>
                  </div>
                );
              }

              const isFile = m.type === "file" || m.type === "file-incoming";
              return (
                <div
                  key={m.msgId || `${m.ts}-${idx}`}
                  className={`message ${m.self ? "own" : ""}`}
                  data-msg-id={m.msgId}
                >
                  <div
                    className="message-avatar"
                    style={{
                      background: m.self
                        ? "var(--gradient-2)"
                        : "var(--gradient-1)",
                    }}
                  >
                    {getInitial(m.userName || sessionData?.userName)}
                  </div>
                  <div className="message-content-wrapper">
                    <div className="message-header">
                      <span className="message-sender">
                        {m.self ? "You" : m.userName || "Anon"}
                      </span>
                      <span className="message-time">{formatTime(m.ts)}</span>
                      {/* Reply button — only on text messages */}
                      {!isFile && (
                        <button
                          className="reply-btn"
                          title="Reply"
                          onClick={() => {
                            setReplyingTo({
                              msgId: m.msgId,
                              userId: m.userId || (m.self ? socket.id : null),
                              userName: m.self
                                ? sessionData?.userName || "You"
                                : m.userName || "Anon",
                              snippet: (m.text || "").slice(0, 120),
                            });
                            messageInputRef.current?.focus();
                          }}
                        >
                          <i className="fas fa-reply" />
                        </button>
                      )}
                    </div>
                    {isFile ? (
                      <div className="message-bubble file-message-bubble">
                        {renderFileMessage(m)}
                      </div>
                    ) : (
                      <div className="message-bubble">
                        {/* Quoted reply box */}
                        {m.replyTo && (
                          <div
                            className="reply-quote"
                            onClick={() => {
                              const el = document.querySelector(
                                `[data-msg-id="${m.replyTo.msgId}"]`,
                              );
                              if (el) {
                                el.scrollIntoView({
                                  behavior: "smooth",
                                  block: "center",
                                });
                                el.classList.add("message-highlight");
                                setTimeout(
                                  () =>
                                    el.classList.remove("message-highlight"),
                                  1600,
                                );
                              }
                            }}
                          >
                            <span className="reply-quote-author">
                              {m.replyTo.userId === socket.id ? "You" : m.replyTo.userName}
                            </span>
                            <span className="reply-quote-text">
                              {m.replyTo.snippet}
                            </span>
                          </div>
                        )}
                        {m.text}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {showGoToBottom && (
            <button
              type="button"
              className="go-bottom-btn"
              onClick={scrollToBottom}
              title="Go to latest message"
            >
              <i className="fas fa-arrow-down"></i>
              {unreadWhileScrolled > 0 && <span className="go-bottom-dot" />}
            </button>
          )}

          {/* Typing indicator above input */}
          {typingUsers.length > 0 && (
            <div className="typing-indicator active">
              <div className="typing-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
              {typingUsers.length === 1
                ? `${typingUsers[0]} is typing...`
                : `${typingUsers.length} people are typing...`}
            </div>
          )}

          {/* Chat Input */}
          <div className="chat-input-area">
            {/* Active P2P transfer progress indicators */}
            {Object.entries(activeTransfers)
              .filter(([, t]) => t.direction === "out")
              .map(([tid, t]) => {
                const pct = Math.round((t.progress || 0) * 100);
                return (
                  <div
                    key={tid}
                    className="transfer-glass"
                    style={{ marginBottom: "0.75rem", position: "relative" }}
                  >
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-muted)",
                        marginBottom: "0.25rem",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                      }}
                    >
                      <i
                        className="fas fa-exchange-alt"
                        style={{ color: "var(--accent)", fontSize: "0.75rem" }}
                      ></i>
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {t.status === "waiting"
                          ? "Waiting for peer..."
                          : `Sending “${t.fileName}” — ${pct}%`}
                      </span>
                    </div>
                    <div className="sr-progress">
                      <div
                        className="sr-progress-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <button
                      type="button"
                      className="upload-cancel-btn"
                      onClick={() => {
                        activeTransferCancelRef.current[tid]?.();
                        setActiveTransfers((prev) => {
                          const updated = { ...prev };
                          delete updated[tid];
                          return updated;
                        });
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            {/* Reply preview strip */}
            {replyingTo && (
              <div className="reply-preview-strip">
                <div className="reply-preview-content">
                  <i
                    className="fas fa-reply"
                    style={{ color: "var(--accent)", flexShrink: 0 }}
                  />
                  <span className="reply-preview-author">
                    Replying to {replyingTo.userId === socket.id ? "You" : replyingTo.userName}
                  </span>
                  <span className="reply-preview-snippet">
                    · {replyingTo.snippet}
                  </span>
                </div>
                <button
                  className="reply-preview-close"
                  onClick={() => {
                    setReplyingTo(null);
                    messageInputRef.current?.focus();
                  }}
                  title="Cancel reply"
                >
                  <i className="fas fa-times" />
                </button>
              </div>
            )}
            <form onSubmit={handleSendMessage} className="chat-input-container">
              <div className="input-actions">
                <div className="emoji-picker-wrap" ref={emojiPickerRef}>
                  <button
                    type="button"
                    className="input-btn emoji-trigger"
                    onClick={() => setEmojiPickerOpen((prev) => !prev)}
                    title="Emoji"
                  >
                    <Smile size={18} />
                  </button>
                  {emojiPickerOpen && (
                    <div
                      className="emoji-picker-panel bg-[#0F111D] shadow-[4px_4px_0px_0px_#F7D569]"
                      role="dialog"
                      aria-label="Emoji picker"
                    >
                      <div className="emoji-picker-header">Stealth Console</div>
                      <div className="emoji-grid">
                        {QUICK_EMOJIS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            className="emoji-cell"
                            onClick={() => handleEmojiClick(emoji)}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="input-btn"
                  onClick={() => setFileModalOpen(true)}
                  title="Attach File"
                >
                  <i className="fas fa-paperclip"></i>
                </button>
              </div>
              <div className="message-input-wrapper">
                <input
                  ref={messageInputRef}
                  onPaste={handlePaste}
                  className={`message-input bg-slate-900/40 backdrop-blur-md border-2 border-transparent transition-all duration-300 focus:border-[#F7D569] focus:shadow-[0_0_15px_rgba(247,213,105,0.3)] focus:outline-none ${replyingTo ? "border-[#F7D569] shadow-[0_0_15px_rgba(247,213,105,0.3)]" : ""}`}
                  placeholder={replyingTo ? `Replying to ${replyingTo.userId === socket.id ? "You" : replyingTo.userName}...` : "Type a secure message..."}
                  value={messageText}
                  onChange={(e) => {
                    setMessageText(e.target.value);
                    if (e.target.value.trim()) {
                      handleTyping();
                    }
                  }}
                  style={{ resize: "none" }}
                />
              </div>
              <button
                type="submit"
                className="send-btn"
                disabled={!messageText.trim()}
                title="Send"
              >
                <i className="fas fa-paper-plane"></i>
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );

  // ==================== MODALS ====================
  const renderModals = () => (
    <>
      {/* Create Room Modal */}
      <div
        className={`modal-overlay ${createModalOpen ? "active" : ""}`}
        onClick={(e) =>
          e.target === e.currentTarget && setCreateModalOpen(false)
        }
      >
        <div className="modal">
          <div className="modal-header">
            <h2 className="modal-title">
              <i className="fas fa-plus-circle"></i>
              Create New Room
            </h2>
            <button
              className="modal-close"
              onClick={() => setCreateModalOpen(false)}
            >
              <i className="fas fa-times"></i>
            </button>
          </div>
          <form onSubmit={handleCreateRoom}>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">
                  <i className="fas fa-user"></i>
                  Your Display Name
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  placeholder="Enter your name"
                  maxLength={20}
                />
              </div>
              <div className="form-group">
                <label className="form-label">
                  <i className="fas fa-door-open"></i>
                  Room Name
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="Team standup, Design sync..."
                  maxLength={40}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setCreateModalOpen(false)}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? (
                  <>
                    <i className="fas fa-spinner fa-spin"></i> Creating…
                  </>
                ) : (
                  <>
                    <i className="fas fa-rocket"></i> Create & Enter
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Join Room Modal */}
      <div
        className={`modal-overlay ${joinModalOpen ? "active" : ""}`}
        onClick={(e) => e.target === e.currentTarget && setJoinModalOpen(false)}
      >
        <div className="modal">
          <div className="modal-header">
            <h2 className="modal-title">
              <i className="fas fa-sign-in-alt"></i>
              Join Room
            </h2>
            <button
              className="modal-close"
              onClick={() => setJoinModalOpen(false)}
            >
              <i className="fas fa-times"></i>
            </button>
          </div>
          <form onSubmit={handleJoinRoom}>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">
                  <i className="fas fa-user"></i>
                  Your Display Name
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="Enter your name"
                  maxLength={20}
                />
              </div>
              <div className="form-group">
                <label className="form-label">
                  <i className="fas fa-key"></i>
                  Room Code
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={roomCodeInput}
                  onChange={(e) =>
                    setRoomCodeInput(e.target.value.toUpperCase())
                  }
                  placeholder="Enter room code"
                  style={{
                    textTransform: "uppercase",
                    fontFamily: "'Courier New', monospace",
                  }}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setJoinModalOpen(false)}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? (
                  <>
                    <i className="fas fa-spinner fa-spin"></i> Joining…
                  </>
                ) : (
                  <>
                    <i className="fas fa-door-open"></i> Join Room
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* File Upload Modal */}
      <div
        className={`modal-overlay ${fileModalOpen ? "active" : ""}`}
        onClick={(e) => e.target === e.currentTarget && setFileModalOpen(false)}
      >
        <div className="modal">
          <div className="modal-header">
            <h2 className="modal-title">
              <i className="fas fa-cloud-upload-alt"></i>
              Share Files
            </h2>
            <button
              className="modal-close"
              onClick={() => { setFileModalOpen(false); setSelectedFiles([]); }}
            >
              <i className="fas fa-times"></i>
            </button>
          </div>
          <div className="modal-body">
            <div
              className="upload-zone"
              onClick={() => uploadFileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add("drag-over");
              }}
              onDragLeave={(e) => {
                e.currentTarget.classList.remove("drag-over");
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove("drag-over");
                const dropped = Array.from(e.dataTransfer.files);
                if (dropped.length) {
                  setSelectedFiles((prev) => [...prev, ...dropped]);
                }
              }}
            >
              <div className="upload-icon">
                <i className="fas fa-cloud-upload-alt"></i>
              </div>
              <p className="upload-text">
                <strong>Click to add files</strong> or drag and drop
              </p>
              <p className="upload-hint">
                PDF, DOCX, TXT, Images, ZIP (Max 2 GB per file)
              </p>
            </div>
            <input
              ref={uploadFileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length) setSelectedFiles((prev) => [...prev, ...files]);
                e.target.value = "";
              }}
            />

            {selectedFiles.length > 0 && (
              <div className="selected-files-list">
                {selectedFiles.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="selected-file-item">
                    <i className={`fas ${getFileIcon(f.name)} selected-file-item-icon`} />
                    <div className="selected-file-item-info">
                      <div className="selected-file-item-name" title={f.name}>{f.name}</div>
                      <div className="selected-file-item-size">
                        {(f.size / 1024 / 1024).toFixed(2)} MB
                      </div>
                    </div>
                    <button
                      className="selected-file-remove"
                      type="button"
                      title="Remove"
                      onClick={() =>
                        setSelectedFiles((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      <i className="fas fa-times" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button
              className="btn btn-secondary"
              onClick={() => { setFileModalOpen(false); setSelectedFiles([]); }}
            >
              Cancel
            </button>
            <button
              ref={modalSendBtnRef}
              className="btn btn-primary"
              disabled={selectedFiles.length === 0}
              onClick={() => handleFilesShare(selectedFiles)}
            >
              <i className="fas fa-paper-plane"></i>
              {selectedFiles.length > 1
                ? `Send ${selectedFiles.length} Files`
                : "Send File"}
            </button>
          </div>
        </div>
      </div>

      {/* Leave Confirmation Modal */}
      <div
        className={`modal-overlay ${leaveModalOpen ? "active" : ""}`}
        onClick={(e) =>
          e.target === e.currentTarget && setLeaveModalOpen(false)
        }
      >
        <div className="modal" style={{ maxWidth: 400 }}>
          <div className="confirm-modal-content">
            <div className="confirm-icon">
              <i className="fas fa-sign-out-alt"></i>
            </div>
            <h3 className="confirm-title">Leave Room?</h3>
            <p className="confirm-text">
              Are you sure you want to leave this room? You'll need the room
              code to rejoin.
            </p>
            <div className="confirm-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setLeaveModalOpen(false)}
              >
                Stay
              </button>
              <button className="btn btn-danger" onClick={handleLeaveRoom}>
                <i className="fas fa-sign-out-alt"></i>
                Leave
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      <div className="shadow-app">
        {currentView === "auth" ? renderAuthView() : renderChatView()}
        {renderModals()}

      {/* ─── Incoming File Offer Accept/Decline ─── */}
      {pendingOffers.length > 0 && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(15,17,29,0.65)", backdropFilter: "blur(24px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 10000, padding: "1rem",
        }}>
          <div style={{
            background: isDarkMode ? "#0F111D" : "#FFFFFF",
            border: "2px solid #0F111D",
            borderRadius: 22, padding: "2rem", maxWidth: 460, width: "100%",
            boxShadow: `4px 4px 0px ${isDarkMode ? "#F7D569" : "#0F111D"}`,
            color: isDarkMode ? "#FFFFFF" : "#0F111D",
            backdropFilter: "blur(40px)",
          }}>
            {/* Header */}
            <div className="download-list-header">
              <div style={{
                width: 52, height: 52, borderRadius: 15, margin: "0 auto 1rem",
                background: "var(--accent-glow, rgba(99,102,241,0.15))",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "1.4rem", color: "var(--accent, #6366f1)",
              }}>
                <i className="fas fa-file-download" />
              </div>
              <div
                className="download-list-title"
                style={{ color: isDarkMode ? "#FFFFFF" : "#0F111D" }}
              >
                Incoming {pendingOffers.length === 1 ? "File" : `${pendingOffers.length} Files`}
              </div>
              <div
                className="download-list-subtitle"
                style={{ color: isDarkMode ? "#94A3B8" : "#475569" }}
              >
                from <strong style={{ color: isDarkMode ? "#94A3B8" : "#475569" }}>
                  {pendingOffers[0]?.senderName}
                </strong> · select which to download
              </div>
            </div>

            {/* Countdown (smallest remaining time) */}
            {(() => {
              const secsLeft = Math.max(
                0,
                Math.ceil((Math.min(...pendingOffers.map((o) => o.expiresAt)) - Date.now()) / 1000),
              );
              return (
                <div
                  className="download-list-countdown"
                  style={{
                    color: isDarkMode
                      ? (secsLeft <= 5 ? "#FB923C" : "#F7C25A")
                      : (secsLeft <= 5 ? "#EA580C" : "#2563EB"),
                  }}
                >
                  <i className="fas fa-clock" style={{ marginRight: "0.3rem" }} />
                  Auto-decline in {secsLeft}s
                </div>
              );
            })()}

            {/* File checkboxes */}
            <div className="download-list-files">
              {pendingOffers.map((offer) => (
                <div
                  key={offer.transferId}
                  className={`download-list-item ${offer.checked ? "checked" : ""}`}
                  onClick={() => toggleOfferCheck(offer.transferId)}
                >
                  <div className="download-list-checkbox">
                    {offer.checked && <i className="fas fa-check" />}
                  </div>
                  <i className={`fas ${getFileIcon(offer.fileName)} download-list-file-icon`} />
                  <div className="download-list-file-info">
                    <div className="download-list-file-name" title={offer.fileName}>
                      {offer.fileName}
                    </div>
                    <div
                      className="download-list-file-size"
                      style={{ color: isDarkMode ? "#94A3B8" : "#475569" }}
                    >
                      {(offer.fileSize / 1024 / 1024).toFixed(2)} MB
                      {offer.fileType && ` · ${offer.fileType.split("/")[1] || offer.fileType}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="download-list-actions">
              <button
                className="btn"
                style={{
                  flex: 1,
                  padding: "0.75rem",
                  borderRadius: 12,
                  fontWeight: 600,
                  background: isDarkMode ? "transparent" : "#F1F5F9",
                  color: isDarkMode ? "#FFFFFF" : "#0F172A",
                  border: "2px solid #0F111D",
                  boxShadow: `4px 4px 0px ${isDarkMode ? "#F7D569" : "#0F111D"}`,
                }}
                onClick={handleDeclineAll}
              >
                <i className="fas fa-times" style={{ marginRight: "0.4rem" }} />
                Decline All
              </button>
              <button
                className="btn"
                style={{
                  flex: 1,
                  padding: "0.75rem",
                  borderRadius: 12,
                  fontWeight: 600,
                  background: "#F7D569",
                  color: "#0F111D",
                  border: "2px solid #0F111D",
                  boxShadow: `4px 4px 0px ${isDarkMode ? "#F7D569" : "#0F111D"}`,
                }}
                disabled={!pendingOffers.some((o) => o.checked)}
                onClick={handleDownloadSelected}
              >
                <i className="fas fa-download" style={{ marginRight: "0.4rem" }} />
                Download Selected
              </button>
            </div>
          </div>
        </div>
      )}

        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </div>
    </>
  );
}
