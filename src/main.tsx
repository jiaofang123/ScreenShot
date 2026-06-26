import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import OverlayApp from "./OverlayApp";
import "./App.css";

const mode = new URLSearchParams(window.location.search).get("mode");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{mode === "overlay" ? <OverlayApp /> : <App />}</StrictMode>,
);
