import { Modal } from "./Modal.js";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Sim, excluir",
  busy,
  variant = "danger",
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  variant?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal onClose={onCancel} open={open} title={title}>
      <div className="confirm-dialog-body">
        <p>{message}</p>
        <div className="confirm-dialog-actions">
          <button className="ghost-button" disabled={busy} onClick={onCancel} type="button">
            Cancelar
          </button>
          <button
            className={variant === "danger" ? "danger-button" : "primary-button"}
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? "Aguarde..." : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
