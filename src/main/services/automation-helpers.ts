export interface PollOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_INITIAL_DELAY_MS = 150;
const DEFAULT_MAX_DELAY_MS = 600;
const ACCOUNT_REGISTRATION_WORKFLOW_ID = "account-registration";
const ACCOUNT_REGISTRATION_NAVIGATION_TIMEOUT_MS = 90_000;
const ACCOUNT_REGISTRATION_ACTION_TIMEOUT_MS = 60_000;
const ACCOUNT_REGISTRATION_STEP_TIMEOUT_MS = 5 * 60_000;

export function resolveRemoteNavigationTimeoutMs(workflowId: string): number {
  return workflowId === ACCOUNT_REGISTRATION_WORKFLOW_ID
    ? ACCOUNT_REGISTRATION_NAVIGATION_TIMEOUT_MS
    : 30_000;
}

export function resolveRemoteActionTimeoutMs(
  workflowId: string,
  configuredTimeoutMs: number
): number {
  return workflowId === ACCOUNT_REGISTRATION_WORKFLOW_ID
    ? Math.max(configuredTimeoutMs, ACCOUNT_REGISTRATION_ACTION_TIMEOUT_MS)
    : configuredTimeoutMs;
}

export function resolveRemoteStepTimeoutMs(
  workflowId: string,
  configuredTimeoutMs: number
): number {
  return workflowId === ACCOUNT_REGISTRATION_WORKFLOW_ID
    ? Math.max(configuredTimeoutMs, ACCOUNT_REGISTRATION_STEP_TIMEOUT_MS)
    : configuredTimeoutMs;
}

export function resolveAutomationOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Protocolo de automacao nao permitido: ${parsed.protocol}`);
  }
  return parsed.origin;
}

export function trustRedirectedAutomationOrigin(
  allowedOrigins: Set<string>,
  requestedUrl: string,
  currentUrl: string
): string {
  const requestedOrigin = resolveAutomationOrigin(requestedUrl);
  if (!allowedOrigins.has(requestedOrigin)) {
    throw new Error(`Origem remota nao autorizada: ${requestedOrigin}.`);
  }

  const redirectedOrigin = resolveAutomationOrigin(currentUrl);
  allowedOrigins.add(redirectedOrigin);
  return redirectedOrigin;
}

export function trustCurrentAutomationOrigin(
  trustedNavigationOrigins: Set<string>,
  currentUrl: string
): string {
  if (trustedNavigationOrigins.size === 0) {
    throw new Error("Nenhuma navegacao autorizada iniciou a cadeia atual.");
  }

  const currentOrigin = resolveAutomationOrigin(currentUrl);
  trustedNavigationOrigins.add(currentOrigin);
  return currentOrigin;
}

export async function pollForLabelResult(
  attempt: () => Promise<string | undefined>,
  sleep: (ms: number) => Promise<void>,
  options: PollOptions = {}
): Promise<string | undefined> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);

  for (let index = 0; index < maxAttempts; index += 1) {
    const result = await attempt();
    if (result) {
      return result;
    }
    if (index < maxAttempts - 1) {
      const delay = Math.min(maxDelayMs, initialDelayMs * Math.pow(1.5, index));
      await sleep(delay);
    }
  }

  return undefined;
}
