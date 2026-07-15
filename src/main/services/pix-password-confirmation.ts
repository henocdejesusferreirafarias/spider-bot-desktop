import { getCurrentRoute, type RouteInfo, type SpaHandle } from "./spa-navigation.js";

const WITHDRAWAL_PASSWORD_MAIN_WORLD = false;
const CONFIRM_LABELS = new Set(["proximo", "confirmar", "next", "continue"]);

export type PixPasswordConfirmationReason =
  | "source-invalid"
  | "confirm-action-absent"
  | "confirm-action-ambiguous"
  | "confirm-action-failed"
  | "destination-not-confirmed";

export interface PixPasswordConfirmationResult {
  ok: boolean;
  reason?: PixPasswordConfirmationReason;
  diag?: string;
}

export interface PixAddFormSignals {
  routeActive10: boolean;
  visiblePinGrids: number;
  visibleKeyboards: number;
  visibleDialogs: number;
  visibleInputs: number;
  visibleSelectors: number;
  enabledPrimaryActions: number;
  hasPixSemantic: boolean;
  ready: boolean;
}

interface SourceActionInspection {
  sourceModals: number;
  sourceActions: number;
  modalIndex?: number;
  buttonIndex?: number;
}

function sourceDiagnostics(inspection: SourceActionInspection): string {
  return `sourceModals=${inspection.sourceModals} sourceActions=${inspection.sourceActions}`;
}

async function inspectSourceAction(surface: SpaHandle): Promise<SourceActionInspection> {
  return surface.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
    };
    const normalize = (value: string | null | undefined) => (value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const roots = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-popup.ui-dialog"))
      .filter((root) => visible(root));
    const sources = roots.flatMap((root, modalIndex) => {
      const grids = Array.from(root.querySelectorAll<HTMLElement>(".ui-password-input"))
        .filter((grid) => visible(grid));
      if (grids.length !== 1) return [];
      const cells = Array.from(grids[0]!.querySelectorAll<HTMLElement>(".ui-password-input__item"));
      const filledCells = cells.filter((cell) => {
        if (cell.textContent?.trim()) return true;
        const marker = cell.querySelector<HTMLElement>("i");
        return Boolean(marker && globalThis.getComputedStyle(marker).visibility !== "hidden");
      }).length;
      if (cells.length !== 6 || filledCells !== 6) return [];
      const actions = Array.from(root.querySelectorAll<HTMLElement>(".ui-button"))
        .filter((action) => visible(action))
        .filter((action) => !action.hasAttribute("disabled"))
        .filter((action) => CONFIRM_LABELS.has(normalize(action.textContent)));
      return [{ modalIndex, actionIndexes: actions.map((action) =>
        Array.from(root.querySelectorAll<HTMLElement>(".ui-button")).indexOf(action),
      ) }];
    });
    const sourceActions = sources.reduce((count, source) => count + source.actionIndexes.length, 0);
    if (sources.length !== 1 || sources[0]!.actionIndexes.length !== 1) {
      return { sourceModals: sources.length, sourceActions };
    }
    return {
      sourceModals: 1,
      sourceActions: 1,
      modalIndex: sources[0]!.modalIndex,
      buttonIndex: sources[0]!.actionIndexes[0],
    };
  }, undefined, WITHDRAWAL_PASSWORD_MAIN_WORLD).catch(() => ({ sourceModals: 0, sourceActions: 0 }));
}

export async function confirmExistingWithdrawalPassword(
  surface: SpaHandle,
): Promise<PixPasswordConfirmationResult> {
  const inspection = await inspectSourceAction(surface);
  if (inspection.sourceModals !== 1) {
    return { ok: false, reason: "source-invalid", diag: sourceDiagnostics(inspection) };
  }
  if (inspection.sourceActions === 0) {
    return { ok: false, reason: "confirm-action-absent", diag: sourceDiagnostics(inspection) };
  }
  if (inspection.sourceActions !== 1 || inspection.modalIndex === undefined || inspection.buttonIndex === undefined) {
    return { ok: false, reason: "confirm-action-ambiguous", diag: sourceDiagnostics(inspection) };
  }

  try {
    await surface
      .locator(".ui-popup.ui-dialog")
      .nth(inspection.modalIndex)
      .locator(".ui-button")
      .nth(inspection.buttonIndex)
      .click({ timeout: 1_500 });
    return { ok: true };
  } catch {
    return { ok: false, reason: "confirm-action-failed", diag: sourceDiagnostics(inspection) };
  }
}

export async function inspectPixAddForm(
  surface: SpaHandle,
  routeActive10: boolean,
): Promise<PixAddFormSignals> {
  return surface.evaluate((active10: boolean) => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
    };
    const normalize = (value: string | null | undefined) => (value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const dialogs = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-popup.ui-dialog"))
      .filter((dialog) => visible(dialog));
    const visiblePinGrids = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-password-input"))
      .filter((grid) => visible(grid)).length;
    const visibleKeyboards = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-number-keyboard"))
      .filter((keyboard) => visible(keyboard)).length;
    const dialog = dialogs.length === 1 ? dialogs[0]! : undefined;
    const visibleInputs = dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>("input")).filter((input) => visible(input)).length
      : 0;
    const visibleSelectors = dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>(".ui-select__reference")).filter((selector) => visible(selector)).length
      : 0;
    const enabledPrimaryActions = dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>(".ui-button"))
        .filter((action) => visible(action) && !action.hasAttribute("disabled")).length
      : 0;
    const hasPixSemantic = Boolean(dialog && normalize(dialog.textContent).includes("pix"));
    const ready = active10
      && visiblePinGrids === 0
      && visibleKeyboards === 0
      && dialogs.length === 1
      && visibleInputs === 2
      && visibleSelectors >= 1
      && enabledPrimaryActions >= 1
      && hasPixSemantic;
    return {
      routeActive10: active10,
      visiblePinGrids,
      visibleKeyboards,
      visibleDialogs: dialogs.length,
      visibleInputs,
      visibleSelectors,
      enabledPrimaryActions,
      hasPixSemantic,
      ready,
    };
  }, routeActive10, WITHDRAWAL_PASSWORD_MAIN_WORLD).catch(() => ({
    routeActive10,
    visiblePinGrids: 0,
    visibleKeyboards: 0,
    visibleDialogs: 0,
    visibleInputs: 0,
    visibleSelectors: 0,
    enabledPrimaryActions: 0,
    hasPixSemantic: false,
    ready: false,
  }));
}

function isWithdrawalActive10(route: RouteInfo | null): boolean {
  if (!route || route.query.active !== "10") return false;
  return route.name === "withdraw" || route.path === "/home/withdraw";
}

export async function waitForPixAddForm(
  surface: SpaHandle,
  timeoutMs: number,
): Promise<PixAddFormSignals> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const signals = await inspectPixAddForm(surface, isWithdrawalActive10(await getCurrentRoute(surface)));
    if (signals.ready) return signals;
    await surface.waitForTimeout(180).catch(() => undefined);
  }
  return inspectPixAddForm(surface, isWithdrawalActive10(await getCurrentRoute(surface)));
}
