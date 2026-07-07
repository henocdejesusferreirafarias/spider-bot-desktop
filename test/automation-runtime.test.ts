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
  fastAcceptRegistrationTerms(runId: string, page: Page): Promise<boolean>;
  fastFillRegistrationOptionalFields(
    runId: string,
    page: Page,
    values: { cpf?: string; phoneNumber?: string; realName?: string }
  ): Promise<{ cpf: boolean; phone: boolean; realName: boolean }>;
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
