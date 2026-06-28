import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles/app.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Spider BOT root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
