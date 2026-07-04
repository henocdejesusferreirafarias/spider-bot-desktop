import { Modal } from "./Modal.js";

export function AlertDialog({
  open,
  title,
  message,
  actionLabel = "OK",
  onClose
}: {
  open: boolean;
  title: string;
  message: string;
  actionLabel?: string;
  onClose: () => void;
}) {
  return (
    <Modal
      footer={
        <button className="primary-button" onClick={onClose} type="button">
          {actionLabel}
        </button>
      }
      onClose={onClose}
      open={open}
      panelClassName="alert-dialog-panel"
      title={title}
    >
      <div className="alert-dialog-body">
        <p>{message}</p>
      </div>
    </Modal>
  );
}
