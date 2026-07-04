import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Modal({
  open,
  title,
  subtitle,
  children,
  footer,
  onClose,
  panelClassName
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  panelClassName?: string;
}) {
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const timer = window.setTimeout(() => {
      const firstField = panelRef.current?.querySelector<
        HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >(
        "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])"
      );
      firstField?.focus();
      if (firstField instanceof HTMLInputElement || firstField instanceof HTMLTextAreaElement) {
        firstField.select?.();
      }
    }, 30);

    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-label={title}
        aria-modal="true"
        className={["modal-panel", panelClassName].filter(Boolean).join(" ")}
        onMouseDown={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
      >
        <header className="modal-header">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button aria-label="Fechar modal" className="icon-button" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <div className="modal-body">{children}</div>

        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </section>
    </div>,
    document.body
  );
}
