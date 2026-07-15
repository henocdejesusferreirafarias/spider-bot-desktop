import { useEffect, useState } from "react";
import type {
  PixPhoneKeyImportResult,
  PixPhoneKeyRecord,
  ProfileSummary
} from "../../shared/contracts.js";
import { formatRelativeTime } from "../lib/format.js";
import { canManagePixKey, pixKeyStatusLabel } from "../lib/pix-key-status.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";

function formatPhoneNumber(value: string): string {
  const digits = value.replace(/\D+/g, "");
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }

  return value;
}

function normalizePhoneText(value: string): string {
  const digits = value.replace(/\D+/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    return digits.slice(2);
  }

  return digits;
}

function isLikelyPhone(value: string): boolean {
  return /^[1-9]{2}(?:9\d{8}|\d{8})$/.test(normalizePhoneText(value));
}

function PixKeyModal({
  open,
  editingKey,
  busy,
  onAdd,
  onUpdate,
  onClose
}: {
  open: boolean;
  editingKey?: PixPhoneKeyRecord;
  busy: boolean;
  onAdd: (input: string) => Promise<PixPhoneKeyImportResult>;
  onUpdate: (pixKeyId: string, phoneNumber: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [lastResult, setLastResult] = useState<PixPhoneKeyImportResult>();
  const [error, setError] = useState("");
  const editing = Boolean(editingKey);
  const canSubmit = editing ? isLikelyPhone(input) && !busy : input.trim().length > 0 && !busy;

  useEffect(() => {
    if (!open) {
      setInput("");
      setLastResult(undefined);
      setError("");
      return;
    }

    setInput(editingKey?.phoneNumber ?? "");
    setLastResult(undefined);
    setError("");
  }, [editingKey?.id, editingKey?.phoneNumber, open]);

  const resetAndClose = () => {
    setInput("");
    setLastResult(undefined);
    setError("");
    onClose();
  };

  const submit = async () => {
    if (!canSubmit) {
      return;
    }

    setError("");
    try {
      if (editingKey) {
        await onUpdate(editingKey.id, input);
        resetAndClose();
        return;
      }

      const result = await onAdd(input);
      setLastResult(result);
      if (result.created.length > 0 && result.invalid.length === 0 && result.skipped.length === 0) {
        resetAndClose();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nao foi possivel salvar a chave PIX.");
    }
  };

  return (
    <Modal
      footer={
        <>
          <button className="ghost-button" onClick={resetAndClose} type="button">
            Voltar
          </button>
          <button className="primary-button" disabled={!canSubmit} onClick={() => void submit()} type="button">
            {busy ? "Salvando..." : editing ? "Salvar chave" : "Cadastrar"}
          </button>
        </>
      }
      onClose={resetAndClose}
      open={open}
      subtitle={editing ? formatPhoneNumber(editingKey?.phoneNumber ?? "") : "Telefones separados por linha, virgula ou ponto e virgula."}
      title={editing ? "Editar Chave PIX" : "Cadastrar Chaves PIX"}
    >
      <div className="pix-key-modal-body">
        <label>
          <span>{editing ? "Telefone" : "Chaves PIX telefone"}</span>
          {editing ? (
            <input
              onChange={(event) => setInput(event.target.value)}
              placeholder="11999999999"
              value={input}
            />
          ) : (
            <textarea
              onChange={(event) => setInput(event.target.value)}
              placeholder={"11999999999\n(11) 98888-7777"}
              rows={4}
              value={input}
            />
          )}
        </label>

        {lastResult ? (
          <div className="pix-key-result">
            <span className="status-pill success">+{lastResult.created.length}</span>
            <span className="status-pill warning">{lastResult.skipped.length} ignorada(s)</span>
            <span className="status-pill danger">{lastResult.invalid.length} invalida(s)</span>
          </div>
        ) : null}

        {error ? <p className="modal-error">{error}</p> : null}
      </div>
    </Modal>
  );
}

export function PixKeysPanel({
  pixKeys,
  profiles,
  busyAction,
  onAdd,
  onUpdate,
  onDelete
}: {
  pixKeys: PixPhoneKeyRecord[];
  profiles: ProfileSummary[];
  busyAction?: string;
  onAdd: (input: string) => Promise<PixPhoneKeyImportResult>;
  onUpdate: (pixKeyId: string, phoneNumber: string) => Promise<unknown>;
  onDelete: (pixKeyId: string) => Promise<unknown>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<PixPhoneKeyRecord>();
  const [deleteTarget, setDeleteTarget] = useState<PixPhoneKeyRecord>();
  const busy = busyAction === "pix-keys:add" || busyAction === "pix-keys:update";
  const deleting = busyAction === "pix-keys:delete";
  const profileNames = new Map(profiles.map((profile) => [profile.id, profile.name]));

  const openCreateModal = () => {
    setEditingKey(undefined);
    setModalOpen(true);
  };

  const openEditModal = (pixKey: PixPhoneKeyRecord) => {
    if (!canManagePixKey(pixKey.status)) return;
    setEditingKey(pixKey);
    setModalOpen(true);
  };

  return (
    <div className="manager-stack pix-keys-panel">
      <div className="manager-toolbar">
        <span>
          {pixKeys.filter((key) => key.status === "available").length} disponível(is) de {pixKeys.length} chave(s)
        </span>
        <div className="manager-toolbar-actions">
          <button className="primary-button" onClick={openCreateModal} type="button">
            <Icon name="plus" size={14} />
            Cadastrar Chaves PIX
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="profiles-table pix-keys-table">
          <thead>
            <tr>
              <th style={{ width: 44 }}>#</th>
              <th>Chave PIX</th>
              <th style={{ width: 100 }}>Status</th>
              <th style={{ width: 140 }}>Vínculo</th>
              <th style={{ width: 120 }}>Atualização</th>
              <th style={{ width: 110 }}>Acoes</th>
            </tr>
          </thead>
          <tbody>
            {pixKeys.map((pixKey, index) => (
              <tr key={pixKey.id}>
                <td className="token">{index + 1}</td>
                <td className="token" style={{ userSelect: "text" }}>{formatPhoneNumber(pixKey.phoneNumber)}</td>
                <td>
                  <span className={`status-pill ${pixKey.status === "available" ? "success" : pixKey.status === "used" ? "warning" : "neutral"}`}>
                    {pixKeyStatusLabel(pixKey.status)}
                  </span>
                </td>
                <td>
                  {profileNames.get(pixKey.pendingProfileId ?? pixKey.assignedProfileId ?? pixKey.usedProfileId ?? "") ?? "—"}
                </td>
                <td>{formatRelativeTime(pixKey.usedAt ?? pixKey.pendingAt ?? pixKey.assignedAt ?? pixKey.createdAt)}</td>
                <td>
                  {canManagePixKey(pixKey.status) ? (
                    <div className="act-cell">
                      <button className="table-action-button" onClick={() => openEditModal(pixKey)} type="button">
                        Editar
                      </button>
                      <button
                        className="table-action-button danger"
                        disabled={deleting}
                        onClick={() => setDeleteTarget(pixKey)}
                        type="button"
                      >
                        Excluir
                      </button>
                    </div>
                  ) : "—"}
                </td>
              </tr>
            ))}
            {!pixKeys.length ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state inline" style={{ minHeight: 88 }}>
                    <Icon name="pixKeys" size={18} />
                    <p>Nenhuma chave PIX cadastrada ainda.</p>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <PixKeyModal
        busy={busy}
        editingKey={editingKey}
        onAdd={onAdd}
        onClose={() => {
          setModalOpen(false);
          setEditingKey(undefined);
        }}
        onUpdate={onUpdate}
        open={modalOpen}
      />

      <ConfirmDialog
        busy={deleting}
        confirmLabel="Sim, excluir chave"
        message={`A chave PIX "${formatPhoneNumber(deleteTarget?.phoneNumber ?? "")}" sera removida permanentemente.`}
        onCancel={() => setDeleteTarget(undefined)}
        onConfirm={() => {
          if (deleteTarget) void onDelete(deleteTarget.id);
          setDeleteTarget(undefined);
        }}
        open={Boolean(deleteTarget)}
        title="Excluir chave PIX"
      />
    </div>
  );
}
