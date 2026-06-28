import type {
  RuntimeControlSelectionState,
  RuntimeWindowTarget
} from "../../shared/contracts.js";

export interface RuntimeWindowSelectionParseResult {
  input: string;
  message: string;
  state: RuntimeControlSelectionState;
}

function formatSlotList(slots: number[]): string {
  return slots.join(", ");
}

function formatAllWindows(windows: RuntimeWindowTarget[]): string {
  const slots = windows.map((windowTarget) => windowTarget.slotNumber);
  return slots.length > 0 ? `Todas: ${formatSlotList(slots)}` : "Nenhuma janela ativa";
}

export function parseRuntimeWindowSelection(
  input: string,
  runtimeWindows: RuntimeWindowTarget[]
): RuntimeWindowSelectionParseResult {
  const trimmed = input.trim();
  const windowsBySlot = new Map(runtimeWindows.map((windowTarget) => [windowTarget.slotNumber, windowTarget]));

  if (runtimeWindows.length === 0) {
    return {
      input,
      message: "Nenhuma janela ativa",
      state: { mode: "none", reason: "Nenhuma janela ativa encontrada." }
    };
  }

  if (!trimmed) {
    return {
      input,
      message: formatAllWindows(runtimeWindows),
      state: { mode: "all" }
    };
  }

  const requestedSlots = new Set<number>();
  for (const piece of trimmed.split(/[,;\s]+/)) {
    if (!piece) {
      continue;
    }

    const rangeMatch = piece.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const rangeStart = Number(rangeMatch[1]);
      const rangeEnd = Number(rangeMatch[2]);
      if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart <= 0 || rangeEnd <= 0) {
        return {
          input,
          message: "Use apenas numeros de telas ativas.",
          state: { mode: "none", reason: "Selecao de janelas invalida." }
        };
      }
      const start = Math.min(rangeStart, rangeEnd);
      const end = Math.max(rangeStart, rangeEnd);
      for (let slotNumber = start; slotNumber <= end; slotNumber += 1) {
        requestedSlots.add(slotNumber);
      }
      continue;
    }

    if (!/^\d+$/.test(piece)) {
      return {
        input,
        message: "Use apenas numeros, virgulas e intervalos como 1-3.",
        state: { mode: "none", reason: "Selecao de janelas invalida." }
      };
    }

    const slotNumber = Number(piece);
    if (!Number.isInteger(slotNumber) || slotNumber <= 0) {
      return {
        input,
        message: "Use apenas numeros de telas ativas.",
        state: { mode: "none", reason: "Selecao de janelas invalida." }
      };
    }
    requestedSlots.add(slotNumber);
  }

  const slots = [...requestedSlots].sort((left, right) => left - right);
  if (slots.length === 0) {
    return {
      input,
      message: formatAllWindows(runtimeWindows),
      state: { mode: "all" }
    };
  }

  const missingSlot = slots.find((slotNumber) => !windowsBySlot.has(slotNumber));
  if (missingSlot !== undefined) {
    return {
      input,
      message: `Tela ${missingSlot} nao esta ativa.`,
      state: { mode: "none", reason: `Tela ${missingSlot} nao esta ativa.` }
    };
  }

  return {
    input,
    message: `Selecionadas: ${formatSlotList(slots)}`,
    state: {
      mode: "windows",
      windows: slots.map((slotNumber) => {
        const windowTarget = windowsBySlot.get(slotNumber)!;
        return {
          profileId: windowTarget.profileId,
          slotNumber
        };
      })
    }
  };
}

export function validateRuntimeWindowSelection(
  selection: RuntimeControlSelectionState,
  runtimeWindows: RuntimeWindowTarget[]
): RuntimeControlSelectionState {
  if (selection.mode === "none") {
    return selection;
  }
  if (runtimeWindows.length === 0) {
    return { mode: "none", reason: "Nenhuma janela ativa encontrada." };
  }
  if (selection.mode === "all") {
    return selection;
  }

  const windowsBySlot = new Map(runtimeWindows.map((windowTarget) => [windowTarget.slotNumber, windowTarget]));
  for (const windowRef of selection.windows) {
    const current = windowsBySlot.get(windowRef.slotNumber);
    if (!current || current.profileId !== windowRef.profileId) {
      return {
        mode: "none",
        reason: "A selecao de janelas ficou desatualizada. Aplique a selecao novamente."
      };
    }
  }

  return selection;
}

export function isTargetSelection(
  selection: RuntimeControlSelectionState
): selection is Exclude<RuntimeControlSelectionState, { mode: "none" }> {
  return selection.mode !== "none";
}
