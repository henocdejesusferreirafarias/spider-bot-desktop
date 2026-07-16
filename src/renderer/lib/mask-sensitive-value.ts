export function maskPixPhoneKey(value?: string): string {
  const digits = value?.replace(/\D+/g, "") ?? "";
  if (!digits) {
    return "—";
  }

  return digits.length >= 5 ? `${digits.slice(0, 2)}***${digits.slice(-3)}` : "***";
}
