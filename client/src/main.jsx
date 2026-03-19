import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("App error:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "2rem", fontFamily: "sans-serif", maxWidth: "600px" }}>
          <h1 style={{ color: "#ef4444" }}>Something went wrong</h1>
          <pre style={{ background: "#1e293b", color: "#e2e8f0", padding: "1rem", overflow: "auto" }}>
            {this.state.error?.message || String(this.state.error)}
          </pre>
          <p>Check the browser console (F12) for details.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) {
  document.body.innerHTML = "<p>Root element #root not found.</p>";
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

