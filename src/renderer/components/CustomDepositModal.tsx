import { useEffect, useState } from "react";
import type { CustomDepositAmountRecord } from "../../shared/contracts.js";
import { Modal } from "./Modal.js";

function normalizeDepositAmountText(value: string): string | undefined {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return undefined;
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function parseDepositAmountInput(input: string): string[] {
  return Array.from(input.matchAll(/\d+(?:[,.]\d{1,2})?/g))
    .map((match) => normalizeDepositAmountText(match[0] ?? ""))
    .filter((amount): amount is string => Boolean(amount));
}

function createCustomDepositAmount(
  amount: string,
  source: CustomDepositAmountRecord["source"]
): CustomDepositAmountRecord {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `deposit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    amount,
    source,
    createdAt: new Date().toISOString()
  };
}

function randomIntInclusive(min: number, max: number): number {
  const safeMin = Math.trunc(Math.min(min, max));
  const safeMax = Math.trunc(Math.max(min, max));
  return safeMin + Math.floor(Math.random() * (safeMax - safeMin + 1));
}

export function CustomDepositModal({
  open,
  amounts,
  busy,
  onSave,
  onClose
}: {
  open: boolean;
  amounts: CustomDepositAmountRecord[];
  busy: boolean;
  onSave: (amounts: CustomDepositAmountRecord[]) => Promise<unknown>;
  onClose: () => void;
}) {
  const [manualInput, setManualInput] = useState("");
  const [rangeMin, setRangeMin] = useState("10");
  const [rangeMax, setRangeMax] = useState("100");
  const [generateCount, setGenerateCount] = useState("5");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setManualInput("");
      setError("");
    }
  }, [open]);

  const save = async (nextAmounts: CustomDepositAmountRecord[]) => {
    setError("");
    try {
      await onSave(nextAmounts);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nao foi possivel salvar os valores.");
    }
  };

  const addManual = async () => {
    const parsed = parseDepositAmountInput(manualInput);
    if (parsed.length === 0) {
      setError("Digite pelo menos um valor valido.");
      return;
    }

    await save([...amounts, ...parsed.map((amount) => createCustomDepositAmount(amount, "manual"))]);
    setManualInput("");
  };

  const generateRandom = async () => {
    const min = Number(normalizeDepositAmountText(rangeMin));
    const max = Number(normalizeDepositAmountText(rangeMax));
    const count = Math.max(1, Math.min(100, Math.trunc(Number(generateCount) || 1)));

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      setError("Intervalo invalido.");
      return;
    }

    const safeMin = Math.max(1, Math.trunc(Math.min(min, max)));
    const safeMax = Math.max(safeMin, Math.trunc(Math.max(min, max)));
    const generated = Array.from({ length: count }, () =>
      createCustomDepositAmount(String(randomIntInclusive(safeMin, safeMax)), "generated")
    );
    await save([...amounts, ...generated]);
  };

  return (
    <Modal
      footer={
        <>
          <button className="ghost-button" onClick={onClose} type="button">
            Voltar
          </button>
          <button className="danger-button" disabled={busy || amounts.length === 0} onClick={() => void save([])} type="button">
            Limpar
          </button>
        </>
      }
      onClose={onClose}
      open={open}
      panelClassName="custom-deposit-modal-panel"
      subtitle="Valores usados quando a opcao Usar personalizados estiver ativa."
      title="Depósitos Personalizados"
    >
      <div className="custom-deposit-modal-body">
        <label>
          <span>Digitar valores</span>
          <textarea
            onChange={(event) => setManualInput(event.target.value)}
            placeholder={"20\n35\n50"}
            rows={3}
            value={manualInput}
          />
        </label>
        <button className="primary-button stretch" disabled={busy || !manualInput.trim()} onClick={() => void addManual()} type="button">
          Adicionar valores
        </button>

        <div className="custom-deposit-generator">
          <label>
            <span>Min</span>
            <input inputMode="numeric" onChange={(event) => setRangeMin(event.target.value)} value={rangeMin} />
          </label>
          <label>
            <span>Max</span>
            <input inputMode="numeric" onChange={(event) => setRangeMax(event.target.value)} value={rangeMax} />
          </label>
          <label>
            <span>Qtd</span>
            <input inputMode="numeric" onChange={(event) => setGenerateCount(event.target.value)} value={generateCount} />
          </label>
          <button className="ghost-button" disabled={busy} onClick={() => void generateRandom()} type="button">
            Gerar
          </button>
        </div>

        <div className="link-table-wrap custom-deposit-table-wrap">
          <table className="links-table custom-deposit-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Valor</th>
                <th>Origem</th>
                <th>Del</th>
              </tr>
            </thead>
            <tbody>
              {amounts.map((amount, index) => (
                <tr key={amount.id}>
                  <td>{index + 1}</td>
                  <td>{amount.amount}</td>
                  <td>{amount.source === "generated" ? "Aleatorio" : "Manual"}</td>
                  <td>
                    <button
                      className="table-delete-button"
                      disabled={busy}
                      onClick={() => void save(amounts.filter((entry) => entry.id !== amount.id))}
                      type="button"
                    >
                      x
                    </button>
                  </td>
                </tr>
              ))}
              {!amounts.length ? (
                <tr>
                  <td colSpan={4}>Nenhum valor personalizado cadastrado.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {error ? <p className="modal-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
