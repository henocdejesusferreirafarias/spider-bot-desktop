import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "patchright";
import type { AutomationAction } from "@spider-bot/licensing-contracts";
import { AutomationRuntimeService } from "../src/main/services/automation-runtime.js";
import type {
  AutomationRecord,
  ProfileSummary
} from "../src/shared/contracts.js";

type RemoteExecutionContext = {
  registrationPhoneNumber?: string;
};

type RuntimeHarness = {
  completeRegistrationFields(
    runId: string,
    profile: ProfileSummary,
    page: Page,
    context: RemoteExecutionContext
  ): Promise<void>;
  executeRemoteAction(
    runId: string,
    automation: AutomationRecord,
    profile: ProfileSummary,
    page: Page,
    action: AutomationAction,
    targets: Map<string, Locator>,
    allowedOrigins: Set<string>,
    context: RemoteExecutionContext,
    trustedNavigationOrigins: Set<string>,
    workflowId: string
  ): Promise<void>;
};

type DepositRuntimeHarness = {
  executeLocalManualDeposit(
    runId: string,
    profile: ProfileSummary,
    page: Page,
    depositAmount: string
  ): Promise<void>;
  prepareLocalDepositAfterSuccessfulRegistration(
    runId: string,
    page: Page,
    profile: ProfileSummary,
    startUrl: string,
    depositAmount?: string
  ): Promise<void>;
};

type RegistrationRuntimeHarness = RuntimeHarness & {
  executeAccountRegistration(
    runId: string,
    automation: AutomationRecord,
    profile: ProfileSummary,
    page: Page,
    settings: Record<string, unknown>
  ): Promise<void>;
  fastAcceptRegistrationTerms(runId: string, page: Page): Promise<boolean>;
  fastFillRegistrationOptionalFields(
    runId: string,
    page: Page,
    values: { cpf?: string; phoneNumber?: string; realName?: string }
  ): Promise<{ cpf: boolean; phone: boolean; realName: boolean }>;
};

test("serializes slow registration bootstrap until the entry form is ready", async () => {
  const database = {
    getOrCreateProfileAccount: () => ({
      password: "safe-password",
      registeredOrigins: [],
      username: "test-user"
    })
  };
  const browserRuntime = {
    setPageAutoClosePopups: async () => undefined
  };
  const runtime = new AutomationRuntimeService(
    database as never,
    browserRuntime as never,
    () => undefined
  ) as unknown as RegistrationRuntimeHarness & Record<string, unknown>;
  const page = {
    goto: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined
  } as unknown as Page;
  const automation = {
    params: { autoCaptchaSolverEnabled: "" },
    startUrl: "https://platform.example"
  } as AutomationRecord;
  const settings = {};
  let activeBootstraps = 0;
  let bootstrapEntries = 0;
  let peakBootstraps = 0;
  let activeFormFills = 0;
  let peakFormFills = 0;
  const logMessages: string[] = [];

  runtime.createLoggedPage = () => page;
  runtime.waitForPlatformLoadingToClear = async () => undefined;
  runtime.normalizeRegistrationEntryPage = async () => undefined;
  runtime.dismissInitialPopupsBeforeRegistration = async () => undefined;
  runtime.ensureRegistrationDialogOpen = async () => {
    bootstrapEntries += 1;
    activeBootstraps += 1;
    peakBootstraps = Math.max(peakBootstraps, activeBootstraps);
    await new Promise((resolve) => setTimeout(resolve, 15));
    activeBootstraps -= 1;
  };
  runtime.getRequiredVisibleInputByHints = async () => ({} as Locator);
  runtime.getRequiredRegistrationSubmitControl = async () => ({} as Locator);
  runtime.fastFillRegistrationMainFields = async () => {
    activeFormFills += 1;
    peakFormFills = Math.max(peakFormFills, activeFormFills);
    await new Promise((resolve) => setTimeout(resolve, 40));
    activeFormFills -= 1;
    throw new Error("stop-after-bootstrap");
  };
  runtime.disposeGeetestInterception = () => undefined;
  runtime.log = (...args: unknown[]) => {
    logMessages.push(String(args.at(-1)));
  };

  const profileA = { ...profile, id: "profile-a", name: "Profile A" };
  const profileB = { ...profile, id: "profile-b", name: "Profile B" };

  const firstBootstrap = runtime.executeAccountRegistration(
    "run-a",
    automation,
    profileA,
    page,
    settings
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondBootstrap = runtime.executeAccountRegistration(
    "run-b",
    automation,
    profileB,
    page,
    settings
  );
  await Promise.allSettled([firstBootstrap, secondBootstrap]);

  assert.equal(
    peakBootstraps,
    1,
    "a slow registration bootstrap must hold back the next profile until its entry form is ready"
  );
  assert.equal(bootstrapEntries, 2, "a completed bootstrap must release the next queued profile");
  assert.equal(
    peakFormFills,
    2,
    "the coordinator must release each profile once its entry form is actionable"
  );
  assert.ok(logMessages.some((message) => /Aguardando capacidade/.test(message)));
  assert.ok(logMessages.some((message) => /Capacidade liberada/.test(message)));
});

type GeetestRuntimeHarness = {
  autoCaptchaSolverRuns: Set<string>;
  geetestCapturedData: Map<string, { captchaId: string; baseUrl: string; riskType?: string }>;
  applyGeetestAutoSolveMask(page: Page): Promise<void>;
  createGeetestClient(page: Page, baseUrl: string): unknown;
  detectCaptchaChallenge(page: Page): Promise<{ active: boolean; label: string }>;
  restoreGeetestAutoSolveMask(page: Page): Promise<void>;
  solveLoadedNineChallenge(client: unknown, captchaId: string, data: unknown): Promise<unknown>;
  tryAutoSolveGeetestCaptcha(runId: string, page: Page, profileName: string): Promise<boolean>;
  resolveGeetestWithPageBridge(page: Page, solution: unknown): Promise<{ resolved: boolean }>;
  waitForCaptchaChallenge(runId: string, page: Page, timeoutMs: number): Promise<{ active: boolean; label: string }>;
  waitForGeetestDismissal(runId: string, page: Page, maxMs?: number): Promise<boolean>;
  waitForManualCaptchaIfPresent(runId: string, page: Page, profileName: string, stage: string): Promise<boolean>;
  confirmRegistrationCompleted(
    runId: string,
    page: Page,
    options: { timeoutMs: number },
  ): Promise<{ registered: boolean; via: string; reason?: string }>;
  waitForRegistrationOrCaptcha(
    runId: string,
    page: Page,
    profileName: string,
    timeoutMs: number,
  ): Promise<{
    handledCaptcha: boolean;
    outcome: { registered: boolean; via: string; reason?: string };
  }>;
  waitForRunDelay(runId: string, page: Page, delayMs: number): Promise<void>;
  ensureRunActive(runId: string): void;
  nowMs(): number;
  log(...args: unknown[]): void;
};

function createRuntime(accountPhoneNumber = "", browserRuntime: Record<string, unknown> = {}) {
  const persisted: string[] = [];
  const database = {
    getOrCreateProfileAccount: () => ({
      cpf: "12345678909",
      phoneNumber: accountPhoneNumber,
      realName: "Maria de Teste"
    }),
    updateProfileAccountPhoneNumber: (_profileId: string, phoneNumber: string) => {
      persisted.push(phoneNumber);
    }
  };
  const runtime = new AutomationRuntimeService(
    database as never,
    browserRuntime as never,
    () => undefined
  );
  return {
    persisted,
    runtime: runtime as unknown as RegistrationRuntimeHarness & DepositRuntimeHarness & Record<string, unknown>
  };
}

const profile = {
  id: "profile-1",
  name: "Teste",
  homeUrl: "https://platform.example"
} as ProfileSummary;

function geetestChallenge(captchaType: string, suffix: string) {
  return {
    lot_number: `lot-${suffix}`,
    pow_detail: { hashfunc: "md5", version: "1", bits: 0, datetime: "2026-07-16" },
    pt: "0",
    captcha_type: captchaType,
    payload: `payload-${suffix}`,
    process_token: `process-${suffix}`,
    imgs: "grid.jpg",
    ques: ["ques.png"],
    nine_nums: 3
  };
}

function createPageWithoutCheckbox(): Page {
  return {
    locator: () => ({
      first: () => ({
        count: async () => 0
      })
    })
  } as unknown as Page;
}

test("registration completion fills visible empty phone, name and CPF fields", async () => {
  const { runtime } = createRuntime();
  const filledValues: Array<{ field: string; value: string }> = [];
  runtime.generateRegistrationPhoneNumber = () => "11987654321";
  runtime.fastFillRegistrationOptionalFields = async (_runId, _page, values) => {
    filledValues.push(
      { field: "celular do cadastro", value: values.phoneNumber ?? "" },
      { field: "nome real do cadastro", value: values.realName ?? "" },
      { field: "CPF do cadastro", value: values.cpf ?? "" }
    );
    return { cpf: true, phone: true, realName: true };
  };
  runtime.fastAcceptRegistrationTerms = async () => false;
  runtime.log = () => undefined;
  const context: RemoteExecutionContext = {};

  await runtime.completeRegistrationFields(
    "run-1",
    profile,
    createPageWithoutCheckbox(),
    context
  );

  assert.deepEqual(filledValues, [
    { field: "celular do cadastro", value: "11987654321" },
    { field: "nome real do cadastro", value: "Maria de Teste" },
    { field: "CPF do cadastro", value: "12345678909" }
  ]);
  assert.equal(context.registrationPhoneNumber, "11987654321");
});

test("registration completion preserves fields that already have values", async () => {
  const { runtime } = createRuntime();
  let filled = false;
  runtime.fastFillRegistrationOptionalFields = async () => {
    filled = true;
    return { cpf: false, phone: false, realName: false };
  };
  runtime.fastAcceptRegistrationTerms = async () => false;

  await runtime.completeRegistrationFields(
    "run-1",
    profile,
    createPageWithoutCheckbox(),
    {}
  );

  assert.equal(filled, true);
});

test("remote registration submit uses the semantic form control locator", async () => {
  const { runtime } = createRuntime();
  const submit = {
    waitFor: async () => undefined
  } as Locator;
  let semanticLookupCalled = false;
  runtime.getVisibleRegistrationSubmitControl = async () => {
    semanticLookupCalled = true;
    return submit;
  };
  const page = {
    url: () => "https://platform.example/register",
    getByRole: () => {
      throw new Error("generic role lookup should not run");
    }
  } as unknown as Page;
  const targets = new Map<string, Locator>();

  await runtime.executeRemoteAction(
    "run-1",
    {} as AutomationRecord,
    profile,
    page,
    {
      type: "findControl",
      target: "registration.submit",
      role: "button",
      labels: ["Register"],
      optional: false,
      timeoutMs: 1000
    },
    targets,
    new Set(["https://platform.example"]),
    {},
    new Set(),
    "account-registration"
  );

  assert.equal(semanticLookupCalled, true);
  assert.equal(targets.get("registration.submit"), submit);
});

test("manual deposit starts directly from the loaded SPA without opening Profile", async () => {
  const page = {
    isClosed: () => true,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined
  } as unknown as Page;
  const browserRuntime = {
    clearLayoutViewportOverride: async () => undefined,
    setPageAutoClosePopups: async () => undefined
  };
  const { runtime } = createRuntime("", browserRuntime);
  const deposits: Array<{ amount: string; profileName: string }> = [];

  runtime.resolveDepositFlowPage = async () => page;
  runtime.ensurePlatformHomeLoaded = async () => undefined;
  runtime.normalizeRegistrationEntryPage = async () => undefined;
  runtime.ensureRunActive = () => undefined;
  runtime.log = () => undefined;
  runtime.fillDepositAmountAndGenerateQr = async (
    _runId: string,
    _page: Page,
    profileName: string,
    amount: string
  ) => {
    deposits.push({ amount, profileName });
  };
  runtime.tryOpenProfileViaRoute = async () => {
    throw new Error("manual deposit must not navigate to Profile");
  };
  runtime.clickProfileEntryPoint = async () => {
    throw new Error("manual deposit must not click Profile");
  };
  runtime.openDepositFromProfileArea = async () => {
    throw new Error("manual deposit must not depend on the Profile surface");
  };

  await runtime.executeLocalManualDeposit("run-deposit", profile, page, "25");

  assert.deepEqual(deposits, [{ amount: "25", profileName: "Teste" }]);
});

test("post-registration deposit with an amount bypasses Profile navigation", async () => {
  const page = {
    isClosed: () => true,
    waitForTimeout: async () => undefined
  } as unknown as Page;
  const browserRuntime = {
    setPageAutoClosePopups: async () => undefined
  };
  const { runtime } = createRuntime("", browserRuntime);
  const deposits: Array<{ amount: string; profileName: string }> = [];

  runtime.resolveDepositFlowPage = async () => page;
  runtime.dismissPostRegistrationPopups = async () => undefined;
  runtime.ensureRunActive = () => undefined;
  runtime.log = () => undefined;
  runtime.fillDepositAmountAndGenerateQr = async (
    _runId: string,
    _page: Page,
    profileName: string,
    amount: string
  ) => {
    deposits.push({ amount, profileName });
  };
  runtime.tryOpenProfileViaRoute = async () => {
    throw new Error("post-registration deposit must not navigate to Profile");
  };
  runtime.clickProfileEntryPoint = async () => {
    throw new Error("post-registration deposit must not click Profile");
  };
  runtime.openDepositFromProfileArea = async () => {
    throw new Error("post-registration deposit with an amount must not use Profile");
  };

  await runtime.prepareLocalDepositAfterSuccessfulRegistration(
    "run-post-registration",
    page,
    profile,
    profile.homeUrl,
    "30"
  );

  assert.deepEqual(deposits, [{ amount: "30", profileName: "Teste" }]);
});

test("Geetest runtime shares ten rerolls across rejected nine answers", async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  let loads = 0;
  let answers = 0;
  const messages: string[] = [];
  const fakeClient = {
    async load() {
      loads += 1;
      return geetestChallenge(loads === 10 ? "nine" : "icon", String(loads));
    }
  };
  geetest.geetestCapturedData.set("run-1", {
    captchaId: "0123456789abcdef0123456789abcdef",
    baseUrl: "https://gcaptcha4.geevisit.com"
  });
  geetest.createGeetestClient = () => fakeClient;
  geetest.solveLoadedNineChallenge = async () => {
    answers += 1;
    return null;
  };
  geetest.waitForRunDelay = async () => undefined;
  geetest.ensureRunActive = () => undefined;
  geetest.nowMs = () => 0;
  geetest.log = (...args) => { messages.push(String(args.at(-1))); };

  const solved = await geetest.tryAutoSolveGeetestCaptcha("run-1", {} as Page, "Teste");

  assert.equal(solved, false);
  assert.equal(loads, 11);
  assert.equal(answers, 1);
  assert.ok(messages.some((message) => /Resposta nine rejeitada/.test(message)));
  assert.match(messages.at(-1) ?? "", /10 reroll/);
});

test("Geetest runtime logs pipeline failures separately from rejected answers", async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  let loads = 0;
  const messages: string[] = [];
  geetest.geetestCapturedData.set("run-1", {
    captchaId: "0123456789abcdef0123456789abcdef",
    baseUrl: "https://gcaptcha4.geevisit.com"
  });
  geetest.createGeetestClient = () => ({
    async load() {
      loads += 1;
      return geetestChallenge("nine", String(loads));
    }
  });
  geetest.solveLoadedNineChallenge = async () => {
    throw new Error("inference failed");
  };
  geetest.waitForRunDelay = async () => undefined;
  geetest.ensureRunActive = () => undefined;
  geetest.nowMs = () => 0;
  geetest.log = (...args) => { messages.push(String(args.at(-1))); };

  const solved = await geetest.tryAutoSolveGeetestCaptcha("run-1", {} as Page, "Teste");

  assert.equal(solved, false);
  assert.equal(loads, 5);
  assert.ok(messages.some((message) => /inference failed/.test(message)));
  assert.equal(messages.some((message) => /Resposta nine rejeitada/.test(message)), false);
});

test("Geetest runtime searches for nine from a captured GeeTest request", async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  let loads = 0;
  let answers = 0;
  geetest.geetestCapturedData.set("run-1", {
    captchaId: "0123456789abcdef0123456789abcdef",
    baseUrl: "https://gcaptcha4.geevisit.com"
  });
  geetest.createGeetestClient = () => ({
    async load() {
      loads += 1;
      return {
        lot_number: "lot-1",
        pow_detail: { hashfunc: "md5", version: "1", bits: 0, datetime: "2026-07-16" },
        pt: "0",
        captcha_type: "nine",
        payload: "payload-1",
        process_token: "process-1",
        imgs: "grid.jpg",
        ques: ["ques.png"],
        nine_nums: 3
      };
    }
  });
  geetest.solveLoadedNineChallenge = async () => {
    answers += 1;
    return { lot_number: "lot-1", pass_token: "pass-1" };
  };
  geetest.resolveGeetestWithPageBridge = async () => ({ resolved: true });
  geetest.waitForRunDelay = async () => undefined;
  geetest.ensureRunActive = () => undefined;
  geetest.nowMs = () => 0;
  geetest.log = () => undefined;

  const solved = await geetest.tryAutoSolveGeetestCaptcha("run-1", {} as Page, "Teste");

  assert.equal(solved, true);
  assert.equal(loads, 1);
  assert.equal(answers, 1);
});

test("Geetest runtime stops searching at the 60 second deadline", async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  let now = 0;
  let loads = 0;
  geetest.geetestCapturedData.set("run-1", {
    captchaId: "0123456789abcdef0123456789abcdef",
    baseUrl: "https://gcaptcha4.geevisit.com"
  });
  geetest.createGeetestClient = () => ({
    async load() {
      loads += 1;
      now += 30_000;
      return {
        lot_number: `lot-${loads}`,
        pow_detail: { hashfunc: "md5", version: "1", bits: 0, datetime: "2026-07-16" },
        pt: "0",
        captcha_type: "icon"
      };
    }
  });
  geetest.waitForRunDelay = async () => undefined;
  geetest.ensureRunActive = () => undefined;
  geetest.nowMs = () => now;
  geetest.log = () => undefined;

  const solved = await geetest.tryAutoSolveGeetestCaptcha("run-1", {} as Page, "Teste");

  assert.equal(solved, false);
  assert.equal(loads, 2);
});

test("Geetest runtime settles a successful solve conditionally", async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  const delays: number[] = [];
  let settleCalls = 0;
  geetest.autoCaptchaSolverRuns.add("run-1");
  geetest.waitForCaptchaChallenge = async () => ({ active: true, label: "Geetest" });
  geetest.applyGeetestAutoSolveMask = async () => undefined;
  geetest.tryAutoSolveGeetestCaptcha = async () => true;
  geetest.waitForGeetestDismissal = async () => {
    settleCalls += 1;
    return true;
  };
  geetest.restoreGeetestAutoSolveMask = async () => undefined;
  geetest.detectCaptchaChallenge = async () => ({ active: false, label: "" });
  geetest.waitForRunDelay = async (_runId, _page, delayMs) => {
    delays.push(delayMs);
  };
  geetest.log = () => undefined;

  const solved = await geetest.waitForManualCaptchaIfPresent(
    "run-1",
    {} as Page,
    "Teste",
    "cadastro",
  );

  assert.equal(solved, true);
  assert.equal(settleCalls, 1);
  assert.deepEqual(delays, []);
});

test("Geetest dismissal polling returns after the challenge disappears", async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  let now = 0;
  let detections = 0;
  const delays: number[] = [];
  geetest.nowMs = () => now;
  geetest.detectCaptchaChallenge = async () => ({
    active: detections++ === 0,
    label: "Geetest",
  });
  geetest.waitForRunDelay = async (_runId, _page, delayMs) => {
    delays.push(delayMs);
    now += delayMs;
  };

  const dismissed = await geetest.waitForGeetestDismissal(
    "run-1",
    {} as Page,
  );

  assert.equal(dismissed, true);
  assert.equal(now, 100);
  assert.deepEqual(delays, [100]);
});

test("registration observes a captcha that appears just after the initial detection window", async () => {
  const { runtime } = createRuntime();
  const geetest = runtime as unknown as GeetestRuntimeHarness;
  let now = 0;
  let registered = false;
  let captchaChecks = 0;

  geetest.nowMs = () => now;
  geetest.ensureRunActive = () => undefined;
  geetest.waitForManualCaptchaIfPresent = async () => {
    captchaChecks += 1;
    if (now < 2700) return false;
    registered = true;
    return true;
  };
  geetest.confirmRegistrationCompleted = async () => {
    now += 350;
    return registered
      ? { registered: true, via: "sessao-ativa" }
      : { registered: false, via: "timeout-formulario-presente" };
  };

  const result = await geetest.waitForRegistrationOrCaptcha(
    "run-1",
    {} as Page,
    "Teste",
    25_000,
  );

  assert.deepEqual(result, {
    handledCaptcha: true,
    outcome: { registered: true, via: "sessao-ativa" },
  });
  assert.ok(captchaChecks > 1);
  assert.ok(now < 5000, `captcha was only observed after ${now} ms`);
});
