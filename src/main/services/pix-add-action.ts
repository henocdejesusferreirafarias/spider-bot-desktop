import type { SpaHandle } from "./spa-navigation.js";

const MAIN_WORLD = false;

export interface PixAddActionResult {
  ok: boolean;
  actionAttempted: boolean;
  actionRejected: boolean;
  reason?:
    | "pix-add-action-absent"
    | "pix-add-action-ambiguous"
    | "pix-add-listener-failed";
  diag?: string;
}

type PixAddActionSource = {
  ok: boolean;
  key?: string;
  reason?: PixAddActionResult["reason"];
  diag?: string;
};

async function inspectPixAddActionSource(spa: SpaHandle): Promise<PixAddActionSource> {
  return spa.evaluate((): PixAddActionSource => {
    type Rec = Record<PropertyKey, unknown>;
    type RuntimeElement = Rec & {
      getBoundingClientRect?: () => { width: number; height: number };
      parentElement?: RuntimeElement | null;
      textContent?: string | null;
    };
    const isObject = (value: unknown): value is Rec => Boolean(value) && (typeof value === "object" || typeof value === "function");
    const read = (target: unknown, key: PropertyKey): unknown => {
      if (!isObject(target)) return undefined;
      try { return target[key]; } catch { return undefined; }
    };
    const normalize = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (element: RuntimeElement) => {
      const rect = element.getBoundingClientRect?.();
      return !rect || (rect.width > 8 && rect.height > 8);
    };
    const runtime = globalThis as unknown as { document: { querySelectorAll: (selector: string) => ArrayLike<RuntimeElement> } };
    const semantic = Array.from(runtime.document.querySelectorAll("body, body *")).filter((element) => {
      const label = normalize(element.textContent);
      return visible(element) && label.length > 0 && label.length <= 100 && /pix/.test(label) && /adicionar|add|vincular|cadastrar/.test(label);
    });
    const listeners = new Set<unknown>();
    for (const semanticElement of semantic) {
      let element: RuntimeElement | null | undefined = semanticElement;
      for (let depth = 0; element && depth < 7; depth += 1) {
        let listener: unknown;
        for (const key of Reflect.ownKeys(element)) {
          const holder = read(element, key);
          const onClick = read(holder, "onClick") ?? read(holder, "onclick");
          if (typeof onClick === "function") { listener = read(onClick, "value") ?? onClick; break; }
        }
        if (listener === undefined && typeof read(element, "onclick") === "function") listener = read(element, "onclick");
        if (typeof listener === "function") { listeners.add(listener); break; }
        element = element.parentElement;
      }
    }
    if (listeners.size > 1 || (listeners.size === 0 && semantic.length > 1)) {
      return { ok: false, reason: "pix-add-action-ambiguous", diag: `listeners=${listeners.size} controls=${semantic.length}` };
    }
    if (listeners.size === 0 && semantic.length === 0) {
      return { ok: false, reason: "pix-add-action-absent", diag: "listeners=0 controls=0" };
    }
    return { ok: true, key: `listeners=${listeners.size};controls=${semantic.length}` };
  }, undefined, MAIN_WORLD).catch((error): PixAddActionSource => ({
    ok: false,
    reason: "pix-add-listener-failed",
    diag: `inspect-error=${String(error)}`,
  }));
}

async function waitForStablePixAddActionSource(spa: SpaHandle): Promise<PixAddActionSource> {
  const deadline = Date.now() + 4000;
  let previous: PixAddActionSource | undefined;
  let latest: PixAddActionSource | undefined;
  while (Date.now() < deadline) {
    const current = await inspectPixAddActionSource(spa);
    latest = current;
    if (!current.ok) return current;
    if (previous?.ok && previous.key === current.key) return current;
    previous = current;
    await spa.waitForTimeout(180).catch(() => undefined);
  }
  return { ok: false, reason: "pix-add-action-absent", diag: `source-not-stable; ${latest?.diag ?? "source-unavailable"}` };
}

export async function programmaticPixAddAction(
  spa: SpaHandle,
): Promise<PixAddActionResult> {
  const source = await waitForStablePixAddActionSource(spa);
  if (!source.ok) {
    return { ok: false, actionAttempted: false, actionRejected: false, reason: source.reason, diag: source.diag };
  }
  return spa
    .evaluate(() => {
      type Rec = Record<PropertyKey, unknown>;
      type RuntimeElement = Rec & {
        dispatchEvent?: (event: unknown) => boolean;
        getBoundingClientRect?: () => { width: number; height: number };
        parentElement?: RuntimeElement | null;
        textContent?: string | null;
      };
      const isObject = (value: unknown): value is Rec =>
        Boolean(value) && (typeof value === "object" || typeof value === "function");
      const read = (target: unknown, key: PropertyKey): unknown => {
        if (!isObject(target)) return undefined;
        try {
          return target[key];
        } catch {
          return undefined;
        }
      };
      const normalize = (value: unknown) =>
        String(value ?? "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const isVisible = (element: RuntimeElement) => {
        const rect = element.getBoundingClientRect?.();
        return !rect || (rect.width > 8 && rect.height > 8);
      };
      const isPixAddLabel = (label: string) =>
        /pix/.test(label) && /adicionar|add|vincular|cadastrar/.test(label);
      const runtime = globalThis as unknown as {
        MouseEvent?: new (
          type: string,
          init: { bubbles: boolean; cancelable: boolean; view: unknown },
        ) => unknown;
        document: { querySelectorAll: (selector: string) => ArrayLike<RuntimeElement> };
      };
      const semanticElements = Array.from(
        runtime.document.querySelectorAll("body, body *"),
      ).filter((element) => {
        const label = normalize(element.textContent);
        return isVisible(element) && label.length > 0 && label.length <= 100 && isPixAddLabel(label);
      });
      const candidates: Array<{
        element: RuntimeElement;
        label: string;
        listener: (...args: unknown[]) => unknown;
        listenerKey: string;
        score: number;
      }> = [];

      for (const semanticElement of semanticElements) {
        const label = normalize(semanticElement.textContent);
        let element: RuntimeElement | null | undefined = semanticElement;
        for (let depth = 0; element && depth < 7; depth += 1) {
          let listener: unknown;
          let listenerKey: string | undefined;
          for (const key of Reflect.ownKeys(element)) {
            const holder = read(element, key);
            const onClick = read(holder, "onClick") ?? read(holder, "onclick");
            if (typeof onClick === "function") {
              listener = read(onClick, "value") ?? onClick;
              listenerKey = String(key);
              break;
            }
          }
          if (listener === undefined && typeof read(element, "onclick") === "function") {
            listener = read(element, "onclick");
            listenerKey = "onclick";
          }
          if (typeof listener === "function") {
            candidates.push({
              element,
              label,
              listener: listener as (...args: unknown[]) => unknown,
              listenerKey: listenerKey ?? "onClick",
              score: /^pix\s+(?:adicionar|add|vincular|cadastrar)$/.test(label) ? 300 : 200,
            });
            break;
          }
          element = element.parentElement;
        }
      }

      const highestScore = candidates.reduce(
        (score, candidate) => Math.max(score, candidate.score),
        0,
      );
      const best = Array.from(
        new Map(
          candidates
            .filter((candidate) => candidate.score === highestScore)
            .map((candidate) => [candidate.listener, candidate]),
        ).values(),
      );
      if (best.length > 1) {
        return {
          ok: false,
          actionAttempted: false,
          actionRejected: false,
          reason: "pix-add-action-ambiguous" as const,
          diag: `candidates=${best.length} labels=${best.map((candidate) => candidate.label).join("|")}`,
        };
      }

      const event = runtime.MouseEvent
        ? new runtime.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            view: globalThis,
          })
        : { type: "click" };
      const candidate = best[0];
      if (candidate) {
        try {
          Reflect.apply(candidate.listener, candidate.element, [event]);
          return {
          ok: true,
          actionAttempted: true,
          actionRejected: false,
            diag: `vue-listener=${candidate.listenerKey} label=${candidate.label}`,
          };
        } catch (error) {
          return {
            ok: true,
            actionAttempted: true,
            actionRejected: true,
            diag: `action-rejected=${String(error).length > 0}`,
          };
        }
      }

      if (semanticElements.length !== 1) {
        return {
          ok: false,
          actionAttempted: false,
          actionRejected: false,
          reason: semanticElements.length > 1
            ? "pix-add-action-ambiguous"
            : "pix-add-action-absent",
          diag: `controls=${semanticElements.length}`,
        };
      }
      const fallback = semanticElements[0];
      if (!fallback || typeof fallback.dispatchEvent !== "function") {
        return {
          ok: false,
          actionAttempted: false,
          actionRejected: false,
          reason: "pix-add-action-absent",
          diag: "listener=ausente fallback=indisponivel",
        };
      }
      try {
        fallback.dispatchEvent(event);
        return { ok: true, actionAttempted: true, actionRejected: false, diag: "semantic-dom-click" };
      } catch (error) {
        return {
          ok: true,
          actionAttempted: true,
          actionRejected: true,
          diag: `action-rejected=${String(error).length > 0}`,
        };
      }
    }, undefined, MAIN_WORLD)
    .catch((error) => ({
      ok: false,
      actionAttempted: false,
      actionRejected: false,
      reason: "pix-add-listener-failed" as const,
      diag: String(error),
    })) as Promise<PixAddActionResult>;
}
