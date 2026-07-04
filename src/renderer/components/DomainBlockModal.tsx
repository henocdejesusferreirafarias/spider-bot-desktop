import { useEffect, useState } from "react";
import { Modal } from "./Modal.js";

// Limpa uma entrada de dominio: tira protocolo/caminho/porta, normaliza caixa e pontas,
// exige ao menos um ponto (dominio real). Espelha a normalizacao do backend (database.ts).
function normalizeDomain(value: string): string {
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  if (!domain || !domain.includes(".") || /\s/.test(domain)) {
    return "";
  }
  return domain;
}

function mergeDomains(current: string[], additions: string[]): string[] {
  const seen = new Set(current);
  const result = [...current];
  for (const raw of additions) {
    const domain = normalizeDomain(raw);
    if (domain && !seen.has(domain)) {
      seen.add(domain);
      result.push(domain);
    }
  }
  return result;
}

export function DomainBlockModal({
  open,
  domains,
  onChange,
  onClose
}: {
  open: boolean;
  domains: string[];
  onChange: (domains: string[]) => void;
  onClose: () => void;
}) {
  const [batchText, setBatchText] = useState("");

  useEffect(() => {
    if (!open) {
      setBatchText("");
    }
  }, [open]);

  const addBatch = () => {
    const additions = batchText.split(/\r?\n|,|;|\s+/).filter(Boolean);
    const next = mergeDomains(domains, additions);
    if (next.length !== domains.length) {
      onChange(next);
    }
    setBatchText("");
  };

  const deleteDomain = (domain: string) => {
    onChange(domains.filter((entry) => entry !== domain));
  };

  return (
    <Modal
      footer={
        <>
          <button className="ghost-button" onClick={onClose} type="button">
            Voltar
          </button>
          <button className="primary-button" disabled={!batchText.trim()} onClick={addBatch} type="button">
            Adicionar
          </button>
        </>
      }
      onClose={onClose}
      open={open}
      subtitle={`${domains.length} dominio(s) bloqueado(s). Casa o dominio e seus subdominios.`}
      title="Dominios Bloqueados"
    >
      <div className="link-batch-row">
        <label>
          <span>Adicionar dominios</span>
          <textarea
            onChange={(event) => setBatchText(event.target.value)}
            placeholder="Um dominio por linha (ex.: live.exemplo.com). Tambem aceita virgula/espaco."
            rows={3}
            value={batchText}
          />
        </label>
        <button className="ghost-button" disabled={!batchText.trim()} onClick={addBatch} type="button">
          Em lote
        </button>
      </div>

      <div className="link-manager-toolbar">
        <span className="control-feedback">
          Bloqueia transmissoes ao vivo e recursos de fundo que drenam o proxy.
        </span>
      </div>

      <div className="link-table-wrap">
        <table className="links-table domains-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Dominio</th>
              <th aria-label="Remover" />
            </tr>
          </thead>
          <tbody>
            {domains.map((domain, index) => (
              <tr key={domain}>
                <td>{index + 1}</td>
                <td>{domain}</td>
                <td>
                  <button className="table-delete-button" onClick={() => deleteDomain(domain)} type="button">
                    x
                  </button>
                </td>
              </tr>
            ))}
            {!domains.length ? (
              <tr>
                <td colSpan={3}>Nenhum dominio bloqueado ainda.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
