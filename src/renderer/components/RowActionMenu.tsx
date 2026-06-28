import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProfileSummary } from "../../shared/contracts.js";
import { Icon } from "./Icon.js";

interface RowActionMenuProps {
  profile: ProfileSummary;
  onDetail: (profile: ProfileSummary) => void;
  onEdit: (profile: ProfileSummary) => void;
  onDelete: (profileId: string) => void;
}

const POPOVER_WIDTH = 150;
const POPOVER_GAP = 6;

export function RowActionMenu({
  profile,
  onDetail,
  onEdit,
  onDelete
}: RowActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const left = Math.max(8, Math.min(viewportWidth - POPOVER_WIDTH - 8, rect.right - POPOVER_WIDTH));
      setPosition({ top: rect.bottom + POPOVER_GAP, left });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (trigger && event.target instanceof Node && trigger.contains(event.target)) return;
      if (popover && event.target instanceof Node && popover.contains(event.target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="row-action-menu">
      <button
        aria-label={`Acoes para ${profile.name}`}
        className="row-action-trigger"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <Icon name="more" size={14} />
      </button>
      {open && position
        ? createPortal(
            <div
              className="row-action-popover"
              ref={popoverRef}
              role="menu"
              style={{ top: position.top, left: position.left }}
            >
              <button
                className="row-action-item"
                onClick={() => {
                  onDetail(profile);
                  close();
                }}
                type="button"
              >
                Detalhar
              </button>
              <button
                className="row-action-item"
                onClick={() => {
                  onEdit(profile);
                  close();
                }}
                type="button"
              >
                Editar
              </button>
              <button
                className="row-action-item danger"
                onClick={() => {
                  onDelete(profile.id);
                  close();
                }}
                type="button"
              >
                Excluir
              </button>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
