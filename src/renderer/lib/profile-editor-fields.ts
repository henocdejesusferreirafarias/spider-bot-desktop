import type { ProfileAccountRecord } from "../../shared/contracts.js";

export function profileEditorPixKeyValue(account?: Pick<ProfileAccountRecord, "pixPhoneKey">): string {
  return account?.pixPhoneKey ?? "";
}
