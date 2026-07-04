

// Helpers puros de valor de deposito (parse/format BRL).

export function parseDepositNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return undefined;
  }

  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

export function parseBrlToNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[R$\s.]/g, "").replace(",", ".").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function isDepositAmountPlausible(pageAmount: string, expectedAmount: string): boolean {
  const page = parseBrlToNumber(pageAmount);
  const expected = parseBrlToNumber(expectedAmount) ?? parseDepositNumber(expectedAmount);
  if (page === undefined || expected === undefined) return false;
  const ratio = page / expected;
  return ratio >= 0.95 && ratio <= 1.05;
}

// Formata um valor de deposito em BRL. Aceita "16", "16,00", "16.00" ou ja "R$ 16,00".
export function formatDepositAmount(value: string): string {
  const parsed = parseDepositNumber(value);
  if (typeof parsed === "number") {
    return parsed.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  const trimmed = (value || "").trim();
  return trimmed.startsWith("R$") ? trimmed : `R$ ${trimmed}`;
}
