export type PixPhoneKeyAttemptResult =
  | "confirmed"
  | "rejected"
  | "pending"
  | "conflict"
  | "error";

export async function retryRejectedPixPhoneKeys<T>(
  initialKey: T,
  attempt: (key: T) => Promise<PixPhoneKeyAttemptResult>,
  reserveNext: () => T | undefined,
): Promise<{ key: T; result: PixPhoneKeyAttemptResult; rejectedAttempts: number }> {
  let key = initialKey;
  let rejectedAttempts = 0;

  for (;;) {
    const result = await attempt(key);
    if (result !== "rejected") {
      return { key, result, rejectedAttempts };
    }

    rejectedAttempts += 1;
    const next = reserveNext();
    if (!next) {
      return { key, result: "error", rejectedAttempts };
    }
    key = next;
  }
}
