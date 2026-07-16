export type PixReceivingAccount = {
  kind: "pix-phone" | "other";
  maskedPhone?: string;
};

export type PixPhonePreflightDecision =
  | "clean"
  | "manual-account"
  | "profile-used"
  | "resume-pending"
  | "pending-used"
  | "conflict"
  | "insufficient-evidence";

export type PixPhonePreflightInput = {
  persistedPhoneNumber?: string;
  pendingKeyId?: string;
  phoneNumber?: string;
  accounts: readonly PixReceivingAccount[];
};

export type PixPhonePreflightResult =
  | { reservation: "reserve" }
  | { reservation: "resume-pending" }
  | { status: "pix_already_registered"; reservation: "none" }
  | { status: "pix_key_registered"; reservation: "none" }
  | { status: "pix_key_registered"; reservation: "consume-pending" }
  | { status: "pix_key_conflict"; reservation: "keep-pending" };

function maskEvidence(mask: string): { prefix: string; suffix: string } | undefined {
  if (!mask.includes("*")) {
    return undefined;
  }

  const chunks = mask
    .split("*")
    .map((chunk) => chunk.replace(/\D/g, ""))
    .filter(Boolean);
  const prefix = chunks[0];
  const suffix = chunks.at(-1);
  if (!prefix || !suffix || prefix.length < 2 || suffix.length < 3) {
    return undefined;
  }

  return { prefix, suffix };
}

export function matchesMaskedPixPhone(mask: string, phoneNumber: string): boolean {
  const evidence = maskEvidence(mask);
  if (!evidence) {
    return false;
  }

  return phoneNumber.startsWith(evidence.prefix) && phoneNumber.endsWith(evidence.suffix);
}

export function decidePixPhonePreflight(input: PixPhonePreflightInput): PixPhonePreflightDecision {
  if (input.persistedPhoneNumber) {
    if (!input.accounts.length) {
      return "insufficient-evidence";
    }

    const phoneAccounts = input.accounts.filter((account) => account.kind === "pix-phone");
    if (!phoneAccounts.length) {
      return "conflict";
    }

    if (phoneAccounts.some((account) => account.maskedPhone && matchesMaskedPixPhone(account.maskedPhone, input.persistedPhoneNumber!))) {
      return "profile-used";
    }

    return phoneAccounts.some((account) => !account.maskedPhone || !maskEvidence(account.maskedPhone))
      ? "insufficient-evidence"
      : "conflict";
  }

  if (!input.pendingKeyId) {
    return input.accounts.length ? "manual-account" : "clean";
  }

  if (!input.phoneNumber) {
    return "insufficient-evidence";
  }

  if (!input.accounts.length) {
    return "resume-pending";
  }

  const phoneAccounts = input.accounts.filter((account) => account.kind === "pix-phone");
  if (!phoneAccounts.length) {
    return "conflict";
  }

  let hasInsufficientEvidence = false;
  for (const account of phoneAccounts) {
    if (!account.maskedPhone || !maskEvidence(account.maskedPhone)) {
      hasInsufficientEvidence = true;
      continue;
    }
    if (matchesMaskedPixPhone(account.maskedPhone, input.phoneNumber)) {
      return "pending-used";
    }
  }

  return hasInsufficientEvidence ? "insufficient-evidence" : "conflict";
}

export function pixResultForPreflight(decision: PixPhonePreflightDecision): PixPhonePreflightResult {
  switch (decision) {
    case "clean":
      return { reservation: "reserve" };
    case "resume-pending":
      return { reservation: "resume-pending" };
    case "manual-account":
      return { status: "pix_already_registered", reservation: "none" };
    case "profile-used":
      return { status: "pix_key_registered", reservation: "none" };
    case "pending-used":
      return { status: "pix_key_registered", reservation: "consume-pending" };
    case "conflict":
    case "insufficient-evidence":
      return { status: "pix_key_conflict", reservation: "keep-pending" };
  }
}
