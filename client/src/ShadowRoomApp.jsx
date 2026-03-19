import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { io } from "socket.io-client";
import axios from "axios";
import logo from "./Logo.png";

const API_BASE = "https://shadowroom.onrender.com";
const SESSION_KEY = "shadowroom-session";

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
  const [uploadProgress, setUploadProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Theme
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem("shadowroom-theme");
    return saved !== "light";
  });

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
  const [fileModalOpen, setFileModalOpen] = useState(false);

  // Users sidebar
  const [usersSidebarVisible, setUsersSidebarVisible] = useState(true);
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);

  // Toasts
  const [toasts, setToasts] = useState([]);

  // File upload
  const [selectedFile, setSelectedFile] = useState(null);
  const fileInputRef = useRef(null);
  const uploadFileInputRef = useRef(null);

  const messagesEndRef = useRef(null);
  const messageInputRef = useRef(null);

const socket = useMemo(
  () =>
    io(API_BASE, {
      autoConnect: false,
      transports: ["websocket", "polling"], // Added for stability on Render
      withCredentials: true,
    }),
  [API_BASE]
);

  const socketConnectedRef = useRef(false);
  const typingTimeoutRef = useRef(null);
  const isTypingRef = useRef(false);

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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Theme toggle
  const toggleTheme = useCallback(() => {
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

  // ==================== SOCKET ====================
  useEffect(() => {
    socket.on("connect", () => {
      socketConnectedRef.current = true;
    });
    socket.on("disconnect", () => {
      socketConnectedRef.current = false;
    });

    // Receive messages from OTHER users (sender already added theirs optimistically)
    socket.on("receive-message", (payload) => {
      setMessages((prev) => [...prev, payload]);
    });

    // Receive file uploads (from ALL users including self via io.to())
    socket.on("file-uploaded", (fileInfo) => {
      // Add as a chat message of type "file"
      setMessages((prev) => {
        // Deduplicate: if we already added this file optimistically (self upload), skip
        const exists = prev.some(
          (m) => m.type === "file" && m.fileId === fileInfo.id,
        );
        if (exists) return prev;
        return [
          ...prev,
          {
            type: "file",
            fileId: fileInfo.id,
            fileName: fileInfo.name,
            fileSize: fileInfo.size,
            fileMime: fileInfo.mime,
            fileUrl: fileInfo.url,
            userName: fileInfo.uploadedBy,
            ts: fileInfo.uploadedAt,
            roomCode: fileInfo.roomCode,
            self: false,
          },
        ];
      });
    });

    // Users list updates
    socket.on("users-updated", (users) => {
      setConnectedUsers(users);
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
      socket.off("file-uploaded");
      socket.off("users-updated");
      socket.off("user-typing");
      socket.off("user-stop-typing");
      socket.disconnect();
    };
  }, [socket]);

  // Join the socket room when entering chat view
  useEffect(() => {
    if (
      currentView === "chat" &&
      sessionData?.roomCode &&
      socketConnectedRef.current
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

  // Scroll to bottom on new messages
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

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
      setCreateModalOpen(false);
      setCurrentView("chat");
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
        roomCode: roomCodeInput.trim(),
        roomId,
        userName: userName.trim(),
        roomName: joinedRoomName,
        role: "participant",
      });
      setJoinModalOpen(false);
      setCurrentView("chat");
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

    const payload = {
      text: messageText.trim(),
      roomCode: sessionData.roomCode,
      userName: sessionData.userName,
      ts: Date.now(),
    };

    // Optimistically add to local state (server won't echo back to sender)
    setMessages((prev) => [...prev, { ...payload, self: true }]);
    setMessageText("");

    // Stop typing indicator
    if (isTypingRef.current) {
      isTypingRef.current = false;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      socket.emit("stop-typing", { roomCode: sessionData.roomCode });
    }

    socket.emit("send-message", payload);
  };

  const handleFileUpload = async (file) => {
    if (!file || !sessionData?.roomCode) return;

    setError("");
    setUploadProgress(0);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("roomCode", sessionData.roomCode);
      formData.append("userName", sessionData.userName);

      const res = await axios.post(`${API_BASE}/api/upload`, formData, {
        onUploadProgress: (evt) => {
          if (!evt.total) return;
          setUploadProgress(evt.loaded / evt.total);
        },
      });

      const uploaded = res.data;

      // Add as a chat message (self)
      setMessages((prev) => [
        ...prev,
        {
          type: "file",
          fileId: uploaded.id,
          fileName: uploaded.name,
          fileSize: uploaded.size,
          fileMime: uploaded.mime,
          fileUrl: uploaded.url,
          userName: sessionData.userName,
          ts: uploaded.uploadedAt,
          roomCode: uploaded.roomCode,
          self: true,
        },
      ]);

      // Tell the server to notify OTHER users (socket.to() excludes sender)
      socket.emit("file-shared", uploaded);

      setUploadProgress(null);
      setFileModalOpen(false);
      setSelectedFile(null);
      showToast("File Sent", "Your file has been shared securely", "success");
    } catch (err) {
      setUploadProgress(null);
      showToast(
        "Error",
        err?.response?.data?.message || err?.message || "File upload failed.",
        "error",
      );
    }
  };

  const handleLeaveRoom = () => {
    socket.emit("leave-room");
    setMessages([]);
    setConnectedUsers([]);
    setTypingUsers([]);
    setSessionData(null);
    localStorage.removeItem(SESSION_KEY);
    setCurrentView("auth");
    setLeaveModalOpen(false);
    showToast("Left Room", "You have left the room", "info");
  };

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

  // ==================== FILE MESSAGE BUBBLE ====================
  const renderFileMessage = (m) => {
    const fullUrl = m.fileUrl?.startsWith("http")
      ? m.fileUrl
      : `${API_BASE}${m.fileUrl}`;
    const isImage = isImageMime(m.fileMime);

    return (
      <a
        href={fullUrl}
        target="_blank"
        rel="noreferrer"
        className="file-bubble-link"
      >
        {isImage ? (
          <div className="file-bubble-image">
            <img src={fullUrl} alt={m.fileName} loading="lazy" />
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
                {m.fileSize ? `${(m.fileSize / 1024).toFixed(1)} KB` : ""}
              </div>
            </div>
            <div className="file-bubble-doc-download">
              <i className="fas fa-download"></i>
            </div>
          </div>
        )}
      </a>
    );
  };

  // ==================== AUTH VIEW (Landing Page) ====================
  const renderAuthView = () => (
    <div className="page landing-page active" style={{ position: "relative" }}>
      {/* Navbar */}
      <nav className="navbar">
        <div className="logo">
          <div className="logo-icon">
            <img src={logo} alt="ShadowRoom Logo" />
          </div>
          <span>ShadowRoom</span>
        </div>
        <div className="nav-actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title="Toggle Theme"
          >
            <i className={`fas ${isDarkMode ? "fa-moon" : "fa-sun"}`}></i>
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero">
        <div className="hero-content">
          <div className="hero-badge">
            <i className="fas fa-shield-alt"></i>
            End-to-End Encrypted
          </div>
          <h1 className="hero-title">
            Chat Securely.
            <br />
            Share <span className="gradient-text">Privately.</span>
          </h1>
          <p className="hero-subtitle">
            Anonymous, real-time chat rooms with encrypted file sharing. No
            sign-up required. Just create a room and start communicating
            securely.
          </p>
          <div className="hero-actions">
            <button
              className="btn btn-primary btn-lg"
              onClick={() => setCreateModalOpen(true)}
            >
              <i className="fas fa-plus-circle"></i>
              Create Room
            </button>
            <button
              className="btn btn-secondary btn-lg"
              onClick={() => setJoinModalOpen(true)}
            >
              <i className="fas fa-sign-in-alt"></i>
              Join Room
            </button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="features-section">
        <h2 className="section-title">Why ShadowRoom?</h2>
        <p className="section-subtitle">
          Built with security and privacy as the core foundation
        </p>
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-lock"></i>
            </div>
            <h3 className="feature-title">AES Encryption</h3>
            <p className="feature-desc">
              All messages and files are encrypted with military-grade AES
              encryption before transmission.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-user-secret"></i>
            </div>
            <h3 className="feature-title">Complete Anonymity</h3>
            <p className="feature-desc">
              No registration, no email, no tracking. Your identity remains
              completely anonymous.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-bolt"></i>
            </div>
            <h3 className="feature-title">Real-Time Communication</h3>
            <p className="feature-desc">
              Instant messaging powered by WebSocket technology for zero-latency
              communication.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-file-shield"></i>
            </div>
            <h3 className="feature-title">Secure File Sharing</h3>
            <p className="feature-desc">
              Share encrypted documents, images, and files safely within your
              private room.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-users"></i>
            </div>
            <h3 className="feature-title">Multi-user Support</h3>
            <p className="feature-desc">
              Multiple participants can join the same room and communicate
              simultaneously with real-time updates.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <i className="fas fa-clock"></i>
            </div>
            <h3 className="feature-title">Temporary Sessions</h3>
            <p className="feature-desc">
              Chat rooms exist only during active sessions, ensuring that
              conversations and shared files are not permanently stored.
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
            <img src={logo} alt="ShadowRoom Logo" />
          </div>
          <div className="room-details">
            <h3>{sessionData?.roomName || "ShadowRoom"}</h3>
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
            className="theme-toggle"
            onClick={toggleTheme}
            title="Toggle Theme"
            style={{ width: 45, height: 45 }}
          >
            <i className={`fas ${isDarkMode ? "fa-moon" : "fa-sun"}`}></i>
          </button>
          <button
            className="header-btn danger"
            onClick={() => setLeaveModalOpen(true)}
            title="Leave Room"
          >
            <i className="fas fa-sign-out-alt"></i>
          </button>
        </div>
      </header>

      {/* Chat Main */}
      <div className="chat-main">
        {/* Users Sidebar (LEFT) */}
        <aside
          className={`users-sidebar ${usersSidebarVisible ? "" : "hidden"}`}
        >
          <div className="sidebar-header">
            <div className="sidebar-title">
              <i className="fas fa-users"></i>
              Online Users
            </div>
            <span className="online-count">{connectedUsers.length}</span>
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
                    {user.userName === sessionData?.userName && (
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
                {user.userName === sessionData?.userName &&
                  sessionData?.role === "admin" && (
                    <span className="user-badge">Admin</span>
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
          <div className="messages-container custom-scrollbar">
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

            {messages.map((m, idx) => (
              <div
                key={`${m.ts}-${idx}`}
                className={`message ${m.self ? "own" : ""}`}
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
                  </div>
                  {m.type === "file" ? (
                    <div className="message-bubble file-message-bubble">
                      {renderFileMessage(m)}
                    </div>
                  ) : (
                    <div className="message-bubble">{m.text}</div>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

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
            {uploadProgress !== null && (
              <div style={{ marginBottom: "0.75rem" }}>
                <div className="sr-progress">
                  <div
                    className="sr-progress-fill"
                    style={{ width: `${Math.round(uploadProgress * 100)}%` }}
                  />
                </div>
                <div
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--text-muted)",
                    marginTop: "0.25rem",
                  }}
                >
                  Uploading... {Math.round(uploadProgress * 100)}%
                </div>
              </div>
            )}
            <form onSubmit={handleSendMessage} className="chat-input-container">
              <div className="input-actions">
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
                  className="message-input"
                  placeholder="Type your message..."
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
              Share File
            </h2>
            <button
              className="modal-close"
              onClick={() => setFileModalOpen(false)}
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
                const file = e.dataTransfer.files[0];
                if (file) {
                  setSelectedFile(file);
                }
              }}
            >
              <div className="upload-icon">
                <i className="fas fa-cloud-upload-alt"></i>
              </div>
              <p className="upload-text">
                <strong>Click to upload</strong> or drag and drop
              </p>
              <p className="upload-hint">
                PDF, DOCX, TXT, Images, ZIP (Max 10MB)
              </p>
            </div>
            <input
              ref={uploadFileInputRef}
              type="file"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) setSelectedFile(file);
                e.target.value = "";
              }}
            />

            {selectedFile && (
              <div className="file-preview-box active">
                <div className="preview-icon">
                  <i className="fas fa-file"></i>
                </div>
                <div className="preview-info">
                  <div className="preview-name">{selectedFile.name}</div>
                  <div className="preview-size">
                    {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                  </div>
                </div>
                <button
                  className="remove-file-btn"
                  onClick={() => setSelectedFile(null)}
                >
                  <i className="fas fa-trash"></i>
                </button>
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button
              className="btn btn-secondary"
              onClick={() => {
                setFileModalOpen(false);
                setSelectedFile(null);
              }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!selectedFile}
              onClick={() => {
                if (selectedFile) {
                  handleFileUpload(selectedFile);
                }
              }}
            >
              <i className="fas fa-paper-plane"></i>
              Send File
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
      {currentView === "auth" ? renderAuthView() : renderChatView()}
      {renderModals()}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </>
  );
}
