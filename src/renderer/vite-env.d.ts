/// <reference types="vite/client" />

import type { PredatorApi } from "../shared/contracts.js";

declare global {
  interface Window {
    predator: PredatorApi;
  }
}

export {};
