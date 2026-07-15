import type { SpaHandle } from "./spa-navigation.js";

const MAIN_WORLD = false;

export interface PixAddActionResult {
  ok: boolean;
  reason?:
    | "pix-add-action-absent"
    | "pix-add-action-ambiguous"
    | "pix-add-listener-failed";
  diag?: string;
}

export async function programmaticPixAddAction(
  spa: SpaHandle,
): Promise<PixAddActionResult> {
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
            diag: `vue-listener=${candidate.listenerKey} label=${candidate.label}`,
          };
        } catch (error) {
          return {
            ok: false,
            reason: "pix-add-listener-failed" as const,
            diag: String(error),
          };
        }
      }

      if (semanticElements.length !== 1) {
        return {
          ok: false,
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
          reason: "pix-add-action-absent",
          diag: "listener=ausente fallback=indisponivel",
        };
      }
      try {
        fallback.dispatchEvent(event);
        return { ok: true, diag: "semantic-dom-click" };
      } catch (error) {
        return {
          ok: false,
          reason: "pix-add-listener-failed",
          diag: String(error),
        };
      }
    }, undefined, MAIN_WORLD)
    .catch((error) => ({
      ok: false,
      reason: "pix-add-listener-failed" as const,
      diag: String(error),
    })) as Promise<PixAddActionResult>;
}

