import { useEffect } from "react";

const EDITABLE_SELECTOR = "input, select, textarea, [contenteditable='true']";
const PASSIVE_INPUT_TYPES = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

function isDisabledEditable(element: HTMLElement): boolean {
  return (
    ("disabled" in element && Boolean(element.disabled)) ||
    element.getAttribute("aria-disabled") === "true"
  );
}

function shouldForceFocus(element: HTMLElement): boolean {
  if (isDisabledEditable(element)) {
    return false;
  }

  if (element instanceof HTMLInputElement) {
    return !PASSIVE_INPUT_TYPES.has(element.type);
  }

  return true;
}

export function useEditableFocusGuard(): void {
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const editable = event.target instanceof Element
        ? event.target.closest<HTMLElement>(EDITABLE_SELECTOR)
        : null;

      if (!editable || !shouldForceFocus(editable)) {
        return;
      }

      window.requestAnimationFrame(() => {
        if (document.activeElement !== editable && document.contains(editable)) {
          editable.focus({ preventScroll: true });
        }
      });
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, []);
}
