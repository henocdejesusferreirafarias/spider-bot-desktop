import type { RuntimeStatus } from "../../shared/contracts.js";

/**
 * Reconciles the persisted profile state with the runtime's live window handles.
 * A stale "active" or "running-automation" state must never make a closed window
 * look like it is still running.
 */
export function resolveProfileWindowStatus(
  profileStatus: RuntimeStatus,
  windowIsOpen: boolean
): RuntimeStatus {
  if (profileStatus === "error" || profileStatus === "launching") {
    return profileStatus;
  }

  if (!windowIsOpen) {
    return "idle";
  }

  if (profileStatus === "running-automation" || profileStatus === "stopping") {
    return profileStatus;
  }

  return "active";
}
