import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal.js";

export interface IndicationLink {
  id: string;
  label: string;
  url: string;
  selected: boolean;
}

interface LinkDraft {
  label: string;
  url: string;
}

const emptyDraft: LinkDraft = {
  label: "",
  url: ""
};

function createId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function LinkManagerModal({
  open,
  links,
  onChange,
  onClose
}: {
  open: boolean;
  links: IndicationLink[];
  onChange: (links: IndicationLink[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<LinkDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string>();
  const [batchText, setBatchText] = useState("");
  const selectedCount = useMemo(() => links.filter((link) => link.selected).length, [links]);

  useEffect(() => {
    if (!open) {
      setEditingId(undefined);
      setDraft(emptyDraft);
      setBatchText("");
    }
  }, [open]);

  const saveDraft = () => {
    const url = normalizeUrl(draft.url);
    if (!url) {
      return;
    }

    if (editingId) {
      onChange(
        links.map((link) =>
          link.id === editingId
            ? {
                ...link,
                label: draft.label.trim() || link.label || url,
                url
              }
            : link
        )
      );
    } else {
      onChange([
        ...links,
        {
          id: createId(),
          label: draft.label.trim() || `Link ${links.length + 1}`,
          url,
          selected: true
        }
      ]);
    }

    setEditingId(undefined);
    setDraft(emptyDraft);
  };

  const editLink = (link: IndicationLink) => {
    setEditingId(link.id);
    setDraft({
      label: link.label,
      url: link.url
    });
  };

  const deleteLink = (linkId: string) => {
    onChange(links.filter((link) => link.id !== linkId));
    if (editingId === linkId) {
      setEditingId(undefined);
      setDraft(emptyDraft);
    }
  };

  const addBatch = () => {
    const urls = batchText
      .split(/\r?\n|,/)
      .map(normalizeUrl)
      .filter(Boolean);

    if (!urls.length) {
      return;
    }

    onChange([
      ...links,
      ...urls.map((url, index) => ({
        id: createId(),
        label: `Link ${links.length + index + 1}`,
        url,
        selected: true
      }))
    ]);
    setBatchText("");
  };

  return (
    <Modal
      footer={
        <>
          <button className="ghost-button" onClick={onClose} type="button">
            Voltar
          </button>
          <button className="primary-button" onClick={saveDraft} type="button">
            {editingId ? "Salvar link" : "Adicionar"}
          </button>
        </>
      }
      onClose={onClose}
      open={open}
      subtitle={`${selectedCount}/${links.length} link(s) selecionado(s) para abertura automatica.`}
      title="Gerenciador de Links de Indicacao"
    >
      <div className="link-manager-toolbar">
        <label className="factory-checkbox">
          <input
            checked={links.length > 0 && selectedCount === links.length}
            onChange={(event) => onChange(links.map((link) => ({ ...link, selected: event.target.checked })))}
            type="checkbox"
          />
          <span>Selecionar todos</span>
        </label>
        <button
          className="danger-button"
          disabled={selectedCount === 0}
          onClick={() => onChange(links.filter((link) => !link.selected))}
          type="button"
        >
          Excluir Sel.
        </button>
        <button className="ghost-button" disabled={!links.length} onClick={() => onChange([])} type="button">
          Limpar
        </button>
      </div>

      <div className="link-editor-grid">
        <label>
          <span>Nome / Descricao</span>
          <input
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
            placeholder="Campanha, afiliado, origem..."
            value={draft.label}
          />
        </label>
        <label>
          <span>Link de Indicacao</span>
          <input
            onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
            placeholder="https://..."
            value={draft.url}
          />
        </label>
      </div>

      <div className="link-table-wrap">
        <table className="links-table">
          <thead>
            <tr>
              <th />
              <th>#</th>
              <th>Nome / Descricao</th>
              <th>Link de Indicacao</th>
              <th>Edit</th>
              <th>Del</th>
            </tr>
          </thead>
          <tbody>
            {links.map((link, index) => (
              <tr className={link.selected ? "selected" : ""} key={link.id}>
                <td>
                  <input
                    checked={link.selected}
                    onChange={(event) =>
                      onChange(
                        links.map((entry) =>
                          entry.id === link.id ? { ...entry, selected: event.target.checked } : entry
                        )
                      )
                    }
                    type="checkbox"
                  />
                </td>
                <td>{index + 1}</td>
                <td>{link.label || "-"}</td>
                <td>{link.url}</td>
                <td>
                  <button className="table-link-button" onClick={() => editLink(link)} type="button">
                    Edit
                  </button>
                </td>
                <td>
                  <button className="table-delete-button" onClick={() => deleteLink(link.id)} type="button">
                    x
                  </button>
                </td>
              </tr>
            ))}
            {!links.length ? (
              <tr>
                <td colSpan={6}>Nenhum link cadastrado ainda.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="link-batch-row">
        <label>
          <span>Adicionar em lote</span>
          <textarea
            onChange={(event) => setBatchText(event.target.value)}
            placeholder="Um link por linha ou separados por virgula"
            rows={2}
            value={batchText}
          />
        </label>
        <button className="ghost-button" onClick={addBatch} type="button">
          Em lote
        </button>
      </div>
    </Modal>
  );
}
