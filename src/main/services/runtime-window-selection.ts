import type {
  RuntimeControlTargetSelection,
  RuntimeWindowTarget
} from "../../shared/contracts.js";

export function resolveRuntimeWindowTargetsStrict(
  selection: RuntimeControlTargetSelection,
  runtimeWindows: RuntimeWindowTarget[]
): RuntimeWindowTarget[] {
  const sortedWindows = [...runtimeWindows].sort((left, right) => left.slotNumber - right.slotNumber);
  if (selection.mode === "all") {
    if (sortedWindows.length === 0) {
      throw new Error("Nenhuma janela ativa encontrada.");
    }
    return sortedWindows;
  }

  if (selection.windows.length === 0) {
    throw new Error("Nenhuma janela selecionada.");
  }

  const windowsBySlot = new Map(sortedWindows.map((windowTarget) => [windowTarget.slotNumber, windowTarget]));
  const seen = new Set<string>();
  const resolved: RuntimeWindowTarget[] = [];
  for (const windowRef of [...selection.windows].sort((left, right) => left.slotNumber - right.slotNumber)) {
    const key = `${windowRef.slotNumber}:${windowRef.profileId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const current = windowsBySlot.get(windowRef.slotNumber);
    if (!current || current.profileId !== windowRef.profileId) {
      throw new Error("A selecao de janelas ficou desatualizada. Aplique a selecao novamente.");
    }
    resolved.push(current);
  }

  if (resolved.length === 0) {
    throw new Error("Nenhuma janela selecionada.");
  }

  return resolved;
}
