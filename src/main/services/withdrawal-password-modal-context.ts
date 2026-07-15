import type { Page } from "patchright";
import type { SpaHandle } from "./spa-navigation.js";

const WITHDRAWAL_PASSWORD_MAIN_WORLD = false;

export interface WithdrawalPasswordModalSurfaceInspection {
  visibleGrids: number;
  gridCells: number;
  filledCells: number;
  focusedCells: number;
  visibleKeyboards: number;
  keyboardKeys: number;
  evaluateError?: boolean;
}

export interface WithdrawalPasswordModalSurfaceCandidate {
  surface: SpaHandle;
  inspection: WithdrawalPasswordModalSurfaceInspection;
}

export type WithdrawalPasswordModalSurfaceResolution =
  | { ok: true; surface: SpaHandle }
  | {
    ok: false;
    reason: "surface-absent" | "surface-ambiguous";
    diag: string;
  };

function isEligible(inspection: WithdrawalPasswordModalSurfaceInspection): boolean {
  return inspection.visibleGrids === 1
    && inspection.gridCells === 6
    && inspection.filledCells === 0
    && inspection.focusedCells === 1
    && inspection.visibleKeyboards >= 1
    && inspection.keyboardKeys >= 10;
}

function diagnostics(candidates: WithdrawalPasswordModalSurfaceCandidate[]): string {
  const eligible = candidates.filter((candidate) => isEligible(candidate.inspection)).length;
  const errors = candidates.filter((candidate) => candidate.inspection.evaluateError).length;
  return `surfaces=${candidates.length} eligible=${eligible} evaluateErrors=${errors}`;
}

export function selectUniqueWithdrawalPasswordModalSurface(
  candidates: WithdrawalPasswordModalSurfaceCandidate[],
): WithdrawalPasswordModalSurfaceResolution {
  const eligible = candidates.filter((candidate) => isEligible(candidate.inspection));
  if (eligible.length === 1) {
    return { ok: true, surface: eligible[0]!.surface };
  }

  return eligible.length === 0
    ? { ok: false, reason: "surface-absent", diag: diagnostics(candidates) }
    : { ok: false, reason: "surface-ambiguous", diag: diagnostics(candidates) };
}

export async function inspectWithdrawalPasswordModalSurface(
  surface: SpaHandle,
): Promise<WithdrawalPasswordModalSurfaceInspection> {
  return surface.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = globalThis.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
    };
    const fields = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-password-input"))
      .filter((element): element is HTMLElement => visible(element));
    const cells = fields.flatMap((field) => Array.from(
      field.querySelectorAll<HTMLElement>(".ui-password-input__item"),
    ));
    const filledCells = cells.filter((cell) => {
      if (cell.textContent?.trim()) return true;
      const marker = cell.querySelector<HTMLElement>("i");
      return Boolean(marker && globalThis.getComputedStyle(marker).visibility !== "hidden");
    }).length;
    const focusedCells = cells.filter((cell) => cell.classList.contains("ui-password-input__item--focus")).length;
    const keyboards = Array.from(globalThis.document.querySelectorAll<HTMLElement>(".ui-number-keyboard"))
      .filter((element): element is HTMLElement => visible(element));
    const keyboardKeys = Math.max(
      0,
      ...keyboards.map((keyboard) => keyboard.querySelectorAll(".ui-number-keyboard-key__wrapper").length),
    );

    return {
      visibleGrids: fields.length,
      gridCells: cells.length,
      filledCells,
      focusedCells,
      visibleKeyboards: keyboards.length,
      keyboardKeys,
    };
  }, undefined, WITHDRAWAL_PASSWORD_MAIN_WORLD).catch(() => ({
    visibleGrids: 0,
    gridCells: 0,
    filledCells: 0,
    focusedCells: 0,
    visibleKeyboards: 0,
    keyboardKeys: 0,
    evaluateError: true,
  }));
}

async function scanWithdrawalPasswordModalSurfaces(
  page: Page,
): Promise<WithdrawalPasswordModalSurfaceCandidate[]> {
  const surfaces: SpaHandle[] = [
    page,
    ...page.frames().filter((frame) => frame !== page.mainFrame()),
  ];
  return Promise.all(surfaces.map(async (surface) => ({
    surface,
    inspection: await inspectWithdrawalPasswordModalSurface(surface),
  })));
}

export async function waitForUniqueWithdrawalPasswordModalSurface(
  page: Page,
  timeoutMs: number,
): Promise<WithdrawalPasswordModalSurfaceResolution> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const resolution = selectUniqueWithdrawalPasswordModalSurface(
      await scanWithdrawalPasswordModalSurfaces(page),
    );
    if (resolution.ok) return resolution;
    await page.waitForTimeout(180).catch(() => undefined);
  }

  return selectUniqueWithdrawalPasswordModalSurface(
    await scanWithdrawalPasswordModalSurfaces(page),
  );
}
