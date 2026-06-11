import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { POS_APP_NAME, POS_BUILD_VERSION_LABEL } from "./buildInfo";
import "./styles/app.css";

const errorToMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const renderBootErrorScreen = (error: unknown) => {
  const target = document.getElementById("root") ?? document.body;
  target.innerHTML = "";

  const screen = document.createElement("main");
  screen.setAttribute("role", "alert");
  screen.style.cssText = [
    "min-height:100vh",
    "box-sizing:border-box",
    "display:flex",
    "flex-direction:column",
    "gap:14px",
    "justify-content:center",
    "padding:28px",
    "background:#191d24",
    "color:#fff",
    "font-family:Arial,Tahoma,sans-serif"
  ].join(";");

  const title = document.createElement("h1");
  title.textContent = POS_APP_NAME;
  title.style.cssText = "margin:0;font-size:28px;line-height:1.2";

  const version = document.createElement("p");
  version.textContent = POS_BUILD_VERSION_LABEL;
  version.style.cssText = "margin:0;color:#d7dde8;font-size:18px";

  const message = document.createElement("pre");
  message.textContent = errorToMessage(error) || "Unknown boot error";
  message.style.cssText = [
    "margin:8px 0 0",
    "white-space:pre-wrap",
    "word-break:break-word",
    "font-size:15px",
    "line-height:1.45",
    "background:#0f1218",
    "border:1px solid #3a4250",
    "border-radius:8px",
    "padding:14px",
    "max-height:55vh",
    "overflow:auto"
  ].join(";");

  screen.append(title, version, message);
  target.appendChild(screen);
};

let appStarted = false;

window.addEventListener("error", (event) => {
  if (!appStarted || !document.querySelector(".app-shell")) {
    renderBootErrorScreen(event.error ?? event.message);
  }
});

window.addEventListener("unhandledrejection", (event) => {
  if (!appStarted || !document.querySelector(".app-shell")) {
    renderBootErrorScreen(event.reason);
  }
});

try {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Missing #root element");
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  appStarted = true;
} catch (error) {
  renderBootErrorScreen(error);
}
