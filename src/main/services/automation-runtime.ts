import type { Locator, Page } from "patchright";
import { ACCOUNT_REGISTRATION_KIND } from "../../shared/contracts.js";
import type {
  ActivityLevel,
  AppSettings,
  AutomationRecord,
  AutomationRunRecord,
  ManualDepositControlResult,
  PixKeyRegistrationControlResult,
  PixRegistrationType,
  ProfileSummary,
  RuntimeEvent,
  WithdrawalPreparationControlResult,
} from "../../shared/contracts.js";
import type {
  AutomationAction,
  AutomationReceipt,
  AutomationStep,
  WorkflowLocalPrimitive,
} from "@spider-bot/licensing-contracts";
import { PredatorDatabase } from "./database.js";
import { BrowserRuntimeService } from "./browser-runtime.js";
import { GeetestSolverService } from "./geetest-solver.js";
import { AsyncSemaphore } from "./async-semaphore.js";
import type { GeetestCaptchaData, GeetestSolution } from "./geetest-solver.js";
import {
  resolveRemoteActionTimeoutMs,
  resolveRemoteNavigationTimeoutMs,
  resolveRemoteStepTimeoutMs,
  resolveAutomationOrigin,
  trustCurrentAutomationOrigin,
  trustRedirectedAutomationOrigin,
} from "./automation-helpers.js";
import type { LicenseService } from "./license-service.js";
import {
  detectPlatformDescriptor,
  describeSpaState,
  waitForSpaRouter,
  programmaticDeposit,
  programmaticPixUiAction,
  programmaticWithdrawalManagementAction,
  resolvePlatformDescriptor,
  resolveRouteTarget,
  routerPush,
} from "./spa-navigation.js";
import type { PlatformDescriptor } from "./spa-navigation.js";
import { fillWithdrawalPasswordSetup } from "./withdrawal-password-setup.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  PATCHRIGHT_MAIN_WORLD,
  resolveContentFrame,
  type BrowserRuntimeElement,
  type BrowserRuntimeInputElement,
  type BrowserRuntimeRect,
  type BrowserRuntimeWindow,
} from "./automation-dom.js";
import {
  hasActiveSession,
  isLoginFormVisible,
  detectLoginErrorMessage,
  detectRegistrationErrorMessage,
  hasWithdrawalPasswordSetupSurface,
  hasWithdrawalPasswordRequiredCallToAction,
  hasVisibleNumberKeyboard,
  detectRegistrationUiFamily,
  decideRegistrationCompletion,
  isDetachedDepositRouteState,
} from "./screen-detection.js";
import {
  waitForLoginSuccess,
  waitForWithdrawalOrPasswordSignal,
  waitForWithdrawalRequestSurface,
  waitForVisibleNumberKeyboard,
  waitForDepositSurface,
  waitForProfileSurface,
  waitForWithdrawalManagementDestination,
} from "./screen-waits.js";
import {
  extractQrCode,
  detectQrSignature,
  qrOverlayTheme,
  QR_DETECT_SELECTOR,
} from "./qr-dom.js";

const GEETEST_AUTO_SOLVE_ATTEMPTS = 5;

export function isPlausibleQrImageDimensions(
  width: number,
  height: number,
): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return false;
  }
  if (width < 40 || height < 40 || width > 1200 || height > 1200) {
    return false;
  }
  const aspect = width / Math.max(1, height);
  return aspect >= 0.72 && aspect <= 1.38;
}

function readPngDimensions(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  if (
    buffer.length < 24 ||
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    return undefined;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

type Broadcast = (event: RuntimeEvent) => void;
type RemoteSecretRef = Extract<
  AutomationAction,
  { type: "typeSecretRef" }
>["secretRef"];
const LOGIN_WORKFLOW_ID = "login";
const POST_REGISTRATION_DEPOSIT_WORKFLOW_ID = "post-registration-deposit";
const MANUAL_DEPOSIT_WORKFLOW_ID = "manual-deposit";

// Etapas do cadastro PIX PHONE. Uma falha carrega a etapa onde ocorreu para que o
// log da rotina/suporte veja um motivo acionavel em vez de um texto solto.
export type PixRegistrationStep =
  | "router"
  | "withdrawalPassword"
  | "receivingTab"
  | "openModal"
  | "selectPhone"
  | "fillForm"
  | "submit"
  | "confirm"
  | "persistenceCheck";

export class PixRegistrationError extends Error {
  constructor(
    readonly step: PixRegistrationStep,
    readonly reason: string,
    readonly diag?: string,
    readonly code = step,
  ) {
    super(`[pix:${step}] ${reason}`);
    this.name = "PixRegistrationError";
  }
}

// Multiplicador unico para os deadlines do caminho critico do PIX. Em maquinas de
// clientes muito lentas, exportar SPIDERBOT_PIX_SLOWNESS=1.5/2 estica todos os prazos
// de uma vez sem tocar cada literal. Padrao 1 = comportamento identico ao anterior.
const PIX_SLOWNESS = (() => {
  const parsed = Number(process.env.SPIDERBOT_PIX_SLOWNESS);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 6 ? parsed : 1;
})();
const PIX_MS = (base: number): number => Math.round(base * PIX_SLOWNESS);

// Decide qual prompt de senha de saque tratar quando ambos/nenhum podem estar na tela.
// ENTRAR (modal existente) tem prioridade sobre DEFINIR: o modal "Inserir PIN" e
// inequivoco, enquanto a heuristica de DEFINIR ja deu falso-positivo somando o campo
// inline da tela de saque com o do modal. Funcao pura -> testavel sem browser.
export function classifyWithdrawalPasswordPrompt(input: {
  hasEnterModal: boolean;
  hasSetupSurface: boolean;
}): "enter" | "setup" | "done" {
  if (input.hasEnterModal) return "enter";
  if (input.hasSetupSurface) return "setup";
  return "done";
}

export interface PixFormInputDescriptor {
  index: number;
  placeholder: string;
  name: string;
  id: string;
  className: string;
  precedesSelector: boolean;
  followsSelector: boolean;
  writable: boolean;
  hasSelector: boolean;
}

// Resolve quais inputs sao nome / chave PIX / CPF a partir dos metadados coletados na
// pagina. Estrutura comum das skins Pinia: nome ANTES do seletor `.ui-popover__wrapper`;
// chave PIX e CPF, nessa ordem, DEPOIS dele. Placeholders/name/id entram so como fallback
// (variam por traducao e skin). Puro -> testavel com descritores fake.
export function resolvePixFormFieldRoles(descriptors: PixFormInputDescriptor[]): {
  nameIndex?: number;
  pixIndex?: number;
  cpfIndex?: number;
} {
  const normalize = (value: string) =>
    (value || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const attrs = (d: PixFormInputDescriptor) =>
    normalize(`${d.placeholder} ${d.name} ${d.id} ${d.className}`);
  const writable = descriptors.filter((d) => d.writable);
  const hasSelector = descriptors.some((d) => d.hasSelector);
  const beforeSelector = hasSelector
    ? descriptors.filter((d) => d.precedesSelector)
    : [];
  const afterWritable = hasSelector
    ? descriptors.filter((d) => d.followsSelector && d.writable)
    : [];

  const nameInput =
    beforeSelector.at(-1) ??
    writable.find((d) => /nome|name|titular|beneficiario/.test(attrs(d)));
  const pixInput =
    afterWritable[0] ?? writable.find((d) => /chave do pix|pix/.test(attrs(d)));
  const cpfInput =
    afterWritable[1] ??
    writable.find((d) => d !== pixInput && /cpf|11 digitos/.test(attrs(d)));

  return {
    nameIndex: nameInput?.index,
    pixIndex: pixInput?.index,
    cpfIndex: cpfInput?.index,
  };
}

// Payload/retorno da etapa de preenchimento do form PIX (avaliada na pagina em 2 fases).
type PixFormFillPayload =
  | { mode: "gather" }
  | {
      mode: "set";
      roles: { nameIndex?: number; pixIndex?: number; cpfIndex?: number };
      pixPhone: string;
      cpfValue: string;
      realNameValue: string;
    };

interface PixFormStepResult {
  phase: "gather" | "set" | "error";
  descriptors: PixFormInputDescriptor[];
  pix: boolean;
  cpf: boolean;
  nameFilled: boolean;
  debug: unknown;
}

interface RemoteExecutionContext {
  depositAmount?: string;
  postRegistrationDepositEnabled?: boolean;
  pixPhoneNumber?: string;
  pixType?: PixRegistrationType;
  registrationPhoneNumber?: string;
  startUrl?: string;
}

interface ActiveRun {
  run: AutomationRunRecord;
  cancelRequested: boolean;
  interruptPage: () => Promise<void>;
}

interface CaptchaChallengeInfo {
  active: boolean;
  label: string;
}

interface ManualCaptchaOptions {
  appearanceTimeoutMs?: number;
  solvedTimeoutMs?: number;
}

interface GeetestBridgeResult {
  resolved: boolean;
  callbacks: number;
  fired: number;
  instances: number;
  hasInstance: boolean;
  reason?: string;
}

export class AutomationRuntimeService {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly activeAutomationIds = new Set<string>();
  private readonly activeProfileIds = new Set<string>();
  private geetestSolver: GeetestSolverService | undefined;
  private readonly geetestCapturedData = new Map<string, GeetestCaptchaData>();
  // Guarda a ref do listener de `request` por run para poder fazer page.off no dispose.
  // Sem isto o listener vazava: as janelas ficam abertas entre execucoes e cada run
  // empilhava mais um listener rodando regex em TODA requisicao de rede.
  private readonly geetestRequestListeners = new Map<
    string,
    { page: Page; listener: (...args: unknown[]) => void }
  >();
  private readonly autoCaptchaSolverRuns = new Set<string>();
  // Runs que de fato aqueceram o worker do solver (lazy): begin so ocorre no 1o sinal de
  // rede geetest; usamos isto para liberar o warm-session de forma balanceada no finally.
  private readonly warmedSolverRuns = new Set<string>();

  // --- Interacao adaptativa (generica p/ QUALQUER plataforma; sem regras por dominio) ---
  // Plataformas lentas levam ate 10s+ para deixar um ponto realmente acionavel (medido
  // empiricamente, ainda pior com 5+ telas simultaneas). Por isso esperamos actionability
  // REAL (visivel + habilitado) ate um budget generoso, com retry + backoff exponencial,
  // em vez de timeouts curtos e fixos que engoliam a falha silenciosamente. Nada aqui e
  // especifico de plataforma: e o tempo real de prontidao do elemento que manda.
  private static readonly ACTIONABLE_BUDGET_MS = 12000;
  // Budget menor para taps de "probe-and-retry" em loops apertados (ex.: teclado virtual),
  // onde o elemento ja foi confirmado visivel e uma espera longa so atrasaria o retry.
  private static readonly ACTION_PROBE_BUDGET_MS = 2500;
  private static readonly ACTION_ATTEMPTS = 3;
  private static readonly ACTION_BACKOFF_BASE_MS = 250;

  constructor(
    private readonly database: PredatorDatabase,
    private readonly browserRuntime: BrowserRuntimeService,
    private readonly broadcast: Broadcast,
    private readonly ensureLicensed: () => void = () => undefined,
    private readonly remoteAutomation?: Pick<
      LicenseService,
      "startAutomationRun" | "nextAutomationRun" | "abortAutomationRun"
    >,
    private readonly allowLocalAutomationFallback = true,
  ) {}

  async shutdown(timeoutMs = 5000): Promise<void> {
    for (const active of this.activeRuns.values()) {
      active.cancelRequested = true;
      await active.interruptPage().catch(() => undefined);
    }

    const deadline = Date.now() + timeoutMs;
    while (this.activeRuns.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async runAutomation(
    automationId: string,
    settings: AppSettings,
  ): Promise<AutomationRunRecord> {
    this.ensureLicensed();
    const automation = this.database.getAutomation(automationId);
    const profile = this.database.getProfile(automation.profileId);

    if (
      this.activeAutomationIds.has(automation.id) ||
      this.activeProfileIds.has(profile.id)
    ) {
      throw new Error(`Ja existe uma rotina em execucao para ${profile.name}.`);
    }

    this.activeAutomationIds.add(automation.id);
    this.activeProfileIds.add(profile.id);
    const run = this.database.createRun(automation.id, profile.id);

    this.database.markAutomationStatus(automation.id, "running");
    this.database.markProfileAutomation(profile.id);
    this.database.updateProfileStatus(profile.id, "running-automation");
    this.log(run.id, "info", `🤖 Rotina ${automation.name} iniciada.`);

    let session:
      | Awaited<ReturnType<BrowserRuntimeService["getAutomationSession"]>>
      | undefined;
    let closeBrowserOnRelease = false;

    try {
      session = await this.browserRuntime.getAutomationSession(
        profile,
        settings,
      );
      await this.browserRuntime.setPageAutoClosePopups(session.page, true);
      this.activeRuns.set(run.id, {
        run,
        cancelRequested: false,
        interruptPage: async () => {
          await session?.page.keyboard.press("Escape").catch(() => null);
        },
      });

      await this.ensureLoggedIn(run.id, profile, session.page);
      await this.executeAutomation(
        run.id,
        automation,
        profile,
        session.page,
        settings,
      );

      const finalRun = this.database.updateRun(run.id, {
        status: this.activeRuns.get(run.id)?.cancelRequested
          ? "cancelled"
          : "succeeded",
        finishedAt: new Date().toISOString(),
        metrics: {
          durationMs: Date.now() - new Date(run.startedAt).getTime(),
        },
      });
      const finalStatus =
        finalRun.status === "cancelled" ? "draft" : "succeeded";
      this.database.markAutomationStatus(automation.id, finalStatus);
      this.database.updateProfileStatus(profile.id, "active");
      this.database.logActivity({
        id: crypto.randomUUID(),
        scope: "automation",
        scopeId: automation.id,
        level: finalRun.status === "cancelled" ? "warning" : "success",
        message:
          finalRun.status === "cancelled"
            ? `⏹️ Rotina ${automation.name} interrompida.`
            : `✅ Rotina ${automation.name} concluída.`,
        createdAt: new Date().toISOString(),
      });

      this.broadcast({
        type: "run-status-changed",
        payload: {
          runId: finalRun.id,
          status: finalRun.status,
        },
      });

      return finalRun;
    } catch (error) {
      const isBrowserGone =
        error instanceof Error &&
        /target closed|browser.*closed|browser.*disconnected|context.*destroyed/i.test(
          error.message,
        );
      closeBrowserOnRelease = isBrowserGone;
      const failedRun = this.database.updateRun(run.id, {
        status: this.activeRuns.get(run.id)?.cancelRequested
          ? "cancelled"
          : "failed",
        finishedAt: new Date().toISOString(),
        metrics: {
          durationMs: Date.now() - new Date(run.startedAt).getTime(),
        },
      });
      this.database.markAutomationStatus(
        automation.id,
        failedRun.status === "cancelled" ? "draft" : "failed",
      );
      this.database.updateProfileStatus(profile.id, "error");
      this.log(
        run.id,
        "error",
        error instanceof Error
          ? `🚨 ${error.message}`
          : "🚨 A rotina parou por um erro inesperado.",
      );
      this.database.logActivity({
        id: crypto.randomUUID(),
        scope: "automation",
        scopeId: automation.id,
        level: "error",
        message: `🚨 Rotina ${automation.name} parou com erro.`,
        details: {
          runId: failedRun.id,
        },
        createdAt: new Date().toISOString(),
      });
      return failedRun;
    } finally {
      if (session) {
        await this.browserRuntime
          .setPageAutoClosePopups(session.page, undefined)
          .catch(() => undefined);
      }
      await session
        ?.release({ closeBrowser: closeBrowserOnRelease })
        .catch(() => undefined);
      this.activeRuns.delete(run.id);
      this.activeAutomationIds.delete(automation.id);
      this.activeProfileIds.delete(profile.id);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      return;
    }

    active.cancelRequested = true;
    this.log(runId, "warning", "⏹️ Parada solicitada pelo usuário.");
    await active.interruptPage();
  }

  // Parada DURA: cancela TODOS os runs em andamento (cadastro/deposito/PIX/saque) — marca
  // cancelRequested (o proximo ensureRunActive aborta o run) e interrompe a pagina (Escape
  // p/ destravar esperas). NAO espera o drain (diferente de shutdown), para nao bloquear o
  // IPC do Stop; cada run encerra sozinho como "cancelled". Usado pelo cancel-batch.
  async cancelActiveRuns(): Promise<void> {
    for (const active of this.activeRuns.values()) {
      active.cancelRequested = true;
      await active.interruptPage().catch(() => undefined);
    }
  }

  async runAutoLogin(profileId: string, settings: AppSettings): Promise<void> {
    const profile = this.database.getProfile(profileId);
    const account = this.database.getOrCreateProfileAccount(profile.id);
    if (
      account.status !== "registered" ||
      !account.username ||
      !account.password
    ) {
      return;
    }

    if (this.activeProfileIds.has(profile.id)) {
      return;
    }

    this.activeProfileIds.add(profile.id);
    const automation = this.database.getSystemAutomationForProfile(profile.id);
    const run = this.database.createRun(automation.id, profile.id);
    let session:
      | Awaited<ReturnType<BrowserRuntimeService["getAutomationSession"]>>
      | undefined;

    try {
      session = await this.browserRuntime.getAutomationSession(
        profile,
        settings,
      );
      this.activeRuns.set(run.id, {
        run,
        cancelRequested: false,
        interruptPage: async () => {
          await session?.page.keyboard.press("Escape").catch(() => null);
        },
      });

      await this.ensureLoggedIn(run.id, profile, session.page);

      this.database.updateRun(run.id, {
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        metrics: {
          durationMs: Date.now() - new Date(run.startedAt).getTime(),
          autoLogin: true,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "erro inesperado";
      this.log(
        run.id,
        "error",
        `[${profile.name}] Auto-login falhou: ${message}`,
      );
      this.database.updateRun(run.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        metrics: {
          durationMs: Date.now() - new Date(run.startedAt).getTime(),
          autoLogin: true,
        },
      });
    } finally {
      await session?.release();
      this.activeRuns.delete(run.id);
      this.activeProfileIds.delete(profile.id);
    }
  }

  async runManualDeposit(
    profileIds: string[],
    depositAmounts: string[],
    settings: AppSettings,
  ): Promise<ManualDepositControlResult[]> {
    const amounts = this.normalizeManualDepositAmounts(depositAmounts);
    if (amounts.length === 0) {
      throw new Error("Informe pelo menos um valor de deposito valido.");
    }

    const uniqueProfileIds = Array.from(new Set(profileIds));
    if (uniqueProfileIds.length === 0) {
      throw new Error(
        "Nenhuma janela ativa encontrada para executar deposito.",
      );
    }

    const settled = await Promise.allSettled(
      uniqueProfileIds.map((profileId, index) =>
        this.runManualDepositForProfile(
          profileId,
          amounts[index % amounts.length] as string,
          settings,
        ),
      ),
    );

    return settled.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }

      const profileId = uniqueProfileIds[index] ?? "";
      const profile = profileId
        ? this.database.getProfile(profileId)
        : undefined;
      return {
        amount: amounts[index % amounts.length] ?? amounts[0] ?? "",
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        profileId,
        profileName: profile?.name ?? "Perfil",
        status: "failed",
      };
    });
  }

  async runManualPixKeyRegistration(
    profileIds: string[],
    pixType: PixRegistrationType,
    settings: AppSettings,
  ): Promise<PixKeyRegistrationControlResult[]> {
    if (pixType !== "PHONE") {
      throw new Error(
        "Somente cadastro PIX PHONE esta disponivel neste fluxo.",
      );
    }

    const uniqueProfileIds = Array.from(new Set(profileIds));
    if (uniqueProfileIds.length === 0) {
      throw new Error(
        "Nenhuma janela ativa encontrada para cadastrar chave PIX.",
      );
    }

    const semaphore = new AsyncSemaphore(2);
    const settled = await Promise.allSettled(
      uniqueProfileIds.map(async (profileId) => {
        const release = await semaphore.acquire();
        try {
          return await this.runPixWithdrawalEntryForProfile(profileId, pixType, settings);
        } finally {
          release();
        }
      }),
    );

    return settled.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }

      const profileId = uniqueProfileIds[index] ?? "";
      const profile = profileId
        ? this.database.getProfile(profileId)
        : undefined;
      return {
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        pixType,
        profileId,
        profileName: profile?.name ?? "Perfil",
        status: "failed",
      };
    });
  }

  async runWithdrawalPreparation(
    profileIds: string[],
    settings: AppSettings,
  ): Promise<WithdrawalPreparationControlResult[]> {
    const uniqueProfileIds = Array.from(new Set(profileIds));
    if (uniqueProfileIds.length === 0) {
      throw new Error("Nenhuma janela ativa encontrada para abrir saques.");
    }

    const settled = await Promise.allSettled(
      uniqueProfileIds.map((profileId) =>
        this.runWithdrawalPreparationForProfile(profileId, settings),
      ),
    );

    return settled.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }

      const profileId = uniqueProfileIds[index] ?? "";
      const profile = profileId
        ? this.database.getProfile(profileId)
        : undefined;
      return {
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        profileId,
        profileName: profile?.name ?? "Perfil",
        status: "failed",
      };
    });
  }

  private async runWithdrawalPreparationForProfile(
    profileId: string,
    settings: AppSettings,
  ): Promise<WithdrawalPreparationControlResult> {
    const profile = this.database.getProfile(profileId);
    if (this.activeProfileIds.has(profile.id)) {
      throw new Error(`Ja existe uma rotina em execucao para ${profile.name}.`);
    }

    this.activeProfileIds.add(profile.id);
    const automation = this.database.getSystemAutomationForProfile(profile.id);
    const run = this.database.createRun(automation.id, profile.id);
    let session:
      | Awaited<ReturnType<BrowserRuntimeService["getAutomationSession"]>>
      | undefined;

    this.database.updateProfileStatus(profile.id, "running-automation");
    this.log(run.id, "info", `[${profile.name}] Abrindo tela de saques.`);

    try {
      session = await this.browserRuntime.getAutomationSession(
        profile,
        settings,
      );
      await this.browserRuntime.setPageAutoClosePopups(session.page, true);
      this.activeRuns.set(run.id, {
        run,
        cancelRequested: false,
        interruptPage: async () => {
          await session?.page.keyboard.press("Escape").catch(() => null);
        },
      });

      await this.ensureLoggedIn(run.id, profile, session.page);
      await this.executeWithdrawalPreparation(run.id, profile, session.page);

      const finalRun = this.database.updateRun(run.id, {
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        metrics: {
          durationMs: Date.now() - new Date(run.startedAt).getTime(),
          manual: true,
          withdrawalScreenReady: true,
        },
      });
      this.database.updateProfileStatus(profile.id, "active");
      this.database.logActivity({
        id: crypto.randomUUID(),
        scope: "automation",
        scopeId: automation.id,
        level: "success",
        message: `[${profile.name}] Tela de saques pronta para preenchimento manual.`,
        details: {
          runId: finalRun.id,
        },
        createdAt: new Date().toISOString(),
      });

      return {
        profileId: profile.id,
        profileName: profile.name,
        status: "succeeded",
      };
    } catch (error) {
      const failedRun = this.database.updateRun(run.id, {
        status: this.activeRuns.get(run.id)?.cancelRequested
          ? "cancelled"
          : "failed",
        finishedAt: new Date().toISOString(),
        metrics: {
          durationMs: Date.now() - new Date(run.startedAt).getTime(),
          manual: true,
          withdrawalScreenReady: false,
        },
      });
      this.database.updateProfileStatus(profile.id, "active");
      const message =
        error instanceof Error ? error.message : "erro inesperado";
      this.log(
        run.id,
        "error",
        `[${profile.name}] Abertura de saques falhou: ${message}`,
      );
      this.database.logActivity({
        id: crypto.randomUUID(),
        scope: "automation",
        scopeId: automation.id,
        level: "error",
        message: `[${profile.name}] Nao foi possivel abrir a tela de saques.`,
        details: {
          runId: failedRun.id,
        },
        createdAt: new Date().toISOString(),
      });

      return {
        error: message,
        profileId: profile.id,
        profileName: profile.name,
        status: "failed",
      };
    } finally {
      if (session) {
        await this.browserRuntime.setPageAutoClosePopups(
          session.page,
          undefined,
        );
      }
      await session?.release();
      this.activeRuns.delete(run.id);
      this.activeProfileIds.delete(profile.id);
    }
  }

  private async runPixWithdrawalEntryForProfile(
    profileId: string,
    pixType: PixRegistrationType,
    settings: AppSettings,
  ): Promise<PixKeyRegistrationControlResult> {
    const profile = this.database.getProfile(profileId);
    if (this.activeProfileIds.has(profile.id)) {
      throw new Error(`Ja existe uma rotina em execucao para ${profile.name}.`);
    }

    this.activeProfileIds.add(profile.id);
    const automation = this.database.getSystemAutomationForProfile(profile.id);
    const run = this.database.createRun(automation.id, profile.id);
    let session: Awaited<ReturnType<BrowserRuntimeService["getAutomationSession"]>> | undefined;
    let step: "profile" | "withdrawal-management" | "withdrawal-password" = "profile";

    try {
      this.database.updateProfileStatus(profile.id, "running-automation");
      this.log(run.id, "info", `[${profile.name}] Preparando entrada do cadastro PIX.`);
      session = await this.browserRuntime.getAutomationSession(profile, settings);
      this.activeRuns.set(run.id, {
        run,
        cancelRequested: false,
        interruptPage: async () => {
          await session?.page.keyboard.press("Escape").catch(() => null);
        },
      });
      await this.ensureLoggedIn(run.id, profile, session.page);

      const spa = resolveContentFrame(session.page);
      if (!(await waitForSpaRouter(spa, PIX_MS(8000)))) {
        throw new Error(`router ausente (${await describeSpaState(spa)})`);
      }
      const descriptor = await detectPlatformDescriptor(spa, profile.homeUrl) ?? resolvePlatformDescriptor(profile.homeUrl);
      const profileTarget = await resolveRouteTarget(spa, "profile", descriptor);
      if (!profileTarget || !(await routerPush(spa, profileTarget))) {
        throw new Error(`rota de perfil indisponivel (${await describeSpaState(spa)})`);
      }
      if (!(await waitForProfileSurface(session.page, PIX_MS(10000)))) {
        throw new Error(`superficie de perfil nao confirmada (${await describeSpaState(spa)})`);
      }

      step = "withdrawal-management";
      let management = await programmaticWithdrawalManagementAction(spa);
      const managementDeadline = Date.now() + PIX_MS(8000);
      while (
        !management.ok &&
        management.reason === "management-action-absent" &&
        Date.now() < managementDeadline
      ) {
        await session.page.waitForTimeout(200).catch(() => undefined);
        management = await programmaticWithdrawalManagementAction(spa);
      }
      if (!management.ok) {
        throw new Error(`gestao de saques indisponivel: ${management.reason ?? "desconhecido"} (${management.diag ?? "sem diagnostico"})`);
      }
      const entryDestination = await waitForWithdrawalManagementDestination(session.page, PIX_MS(12000));
      if (entryDestination === "unknown") {
        throw new Error(`destino de saque nao confirmado (${await describeSpaState(spa)})`);
      }
      let resultStatus: "needs_withdrawal_password" | "withdrawal_password_filled" | "withdrawal_ready" = entryDestination;
      if (resultStatus === "needs_withdrawal_password") {
        step = "withdrawal-password";
        const withdrawalPassword = this.database.ensureProfileWithdrawalPassword(profile.id);
        const checkpoint = async (passwordStage: "reserved" | "first-field-filled" | "second-field-filled") => {
          this.database.updateRun(run.id, {
            metrics: { manual: true, pixType, pixWithdrawalEntry: entryDestination, pixWithdrawalPasswordStage: passwordStage }
          });
        };
        await checkpoint("reserved");
        const filled = await fillWithdrawalPasswordSetup(spa, withdrawalPassword, checkpoint);
        if (!filled.ok || !filled.firstFieldFilled || !filled.secondFieldFilled) {
          throw new Error(`senha de saque nao confirmou preenchimento (${filled.reason ?? "desconhecido"}${filled.diag ? `; ${filled.diag}` : ""})`);
        }
        resultStatus = "withdrawal_password_filled";
      }

      this.database.updateRun(run.id, {
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        metrics: { manual: true, pixType, pixWithdrawalEntry: resultStatus, durationMs: Date.now() - new Date(run.startedAt).getTime() },
      });
      this.database.updateProfileStatus(profile.id, "active");
      this.log(run.id, "success", `[${profile.name}] Entrada PIX confirmada: ${resultStatus}.`);
      return { pixType, profileId: profile.id, profileName: profile.name, status: resultStatus };
    } catch (error) {
      const message = error instanceof Error ? error.message : "erro inesperado";
      this.database.updateRun(run.id, { status: "failed", finishedAt: new Date().toISOString(), metrics: { manual: true, pixType, pixWithdrawalEntry: "failed", durationMs: Date.now() - new Date(run.startedAt).getTime() } });
      this.database.updateProfileStatus(profile.id, "active");
      this.log(run.id, "error", `[${profile.name}] Preparacao PIX falhou na etapa ${step}: ${message}`);
      return { error: message, pixType, profileId: profile.id, profileName: profile.name, status: "failed", step };
    } finally {
      await session?.release();
      this.activeRuns.delete(run.id);
      this.activeProfileIds.delete(profile.id);
    }
  }

  private async runManualDepositForProfile(
    profileId: string,
    depositAmount: string,
    settings: AppSettings,
  ): Promise<ManualDepositControlResult> {
    const profile = this.database.getProfile(profileId);
    if (this.activeProfileIds.has(profile.id)) {
      throw new Error(`Ja existe uma rotina em execucao para ${profile.name}.`);
    }

    this.activeProfileIds.add(profile.id);
    const automation = this.database.getSystemAutomationForProfile(profile.id);
    const run = this.database.createRun(automation.id, profile.id);
    let session:
      | Awaited<ReturnType<BrowserRuntimeService["getAutomationSession"]>>
      | undefined;

    this.database.updateProfileStatus(profile.id, "running-automation");
    this.log(
      run.id,
      "info",
      `[${profile.name}] Deposito manual iniciado para ${depositAmount}.`,
    );

    try {
      session = await this.browserRuntime.getAutomationSession(
        profile,
        settings,
      );
      await this.browserRuntime.setPageAutoClosePopups(session.page, true);
      this.activeRuns.set(run.id, {
        run,
        cancelRequested: false,
        interruptPage: async () => {
          await session?.page.keyboard.press("Escape").catch(() => null);
        },
      });

      await this.ensureLoggedIn(run.id, profile, session.page);
      await this.executeManualDeposit(
        run.id,
        profile,
        session.page,
        depositAmount,
      );

      const finalRun = this.database.updateRun(run.id, {
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        metrics: {
          depositAmount,
          durationMs: Date.now() - new Date(run.startedAt).getTime(),
          manual: true,
        },
      });
      this.database.updateProfileStatus(profile.id, "active");
      this.database.logActivity({
        id: crypto.randomUUID(),
        scope: "automation",
        scopeId: automation.id,
        level: "success",
        message: `[${profile.name}] Deposito manual gerado para ${depositAmount}.`,
        details: {
          runId: finalRun.id,
        },
        createdAt: new Date().toISOString(),
      });

      return {
        amount: depositAmount,
        profileId: profile.id,
        profileName: profile.name,
        status: "succeeded",
      };
    } catch (error) {
      const failedRun = this.database.updateRun(run.id, {
        status: this.activeRuns.get(run.id)?.cancelRequested
          ? "cancelled"
          : "failed",
        finishedAt: new Date().toISOString(),
        metrics: {
          depositAmount,
          durationMs: Date.now() - new Date(run.startedAt).getTime(),
          manual: true,
        },
      });
      this.database.updateProfileStatus(profile.id, "active");
      const message =
        error instanceof Error ? error.message : "erro inesperado";
      this.log(
        run.id,
        "error",
        `[${profile.name}] Deposito manual falhou: ${message}`,
      );
      this.database.logActivity({
        id: crypto.randomUUID(),
        scope: "automation",
        scopeId: automation.id,
        level: "error",
        message: `[${profile.name}] Deposito manual falhou.`,
        details: {
          runId: failedRun.id,
        },
        createdAt: new Date().toISOString(),
      });

      return {
        amount: depositAmount,
        error: message,
        profileId: profile.id,
        profileName: profile.name,
        status: "failed",
      };
    } finally {
      if (session) {
        await this.browserRuntime.setPageAutoClosePopups(
          session.page,
          undefined,
        );
      }
      await session?.release();
      this.activeRuns.delete(run.id);
      this.activeProfileIds.delete(profile.id);
    }
  }

  private async executeAutomation(
    runId: string,
    automation: AutomationRecord,
    profile: ProfileSummary,
    page: Page,
    settings: AppSettings,
  ): Promise<void> {
    if (automation.kind === ACCOUNT_REGISTRATION_KIND) {
      const postRegistrationDepositEnabled =
        this.isPostRegistrationDepositEnabled(automation, settings);
      if (this.remoteAutomation) {
        const trustedNavigationOrigins = new Set<string>();
        try {
          await this.executeRemoteAutomation(
            runId,
            ACCOUNT_REGISTRATION_KIND,
            automation,
            profile,
            page,
            { postRegistrationDepositEnabled },
            trustedNavigationOrigins,
          );
          if (postRegistrationDepositEnabled) {
            await this.executeRemoteAutomation(
              runId,
              POST_REGISTRATION_DEPOSIT_WORKFLOW_ID,
              automation,
              profile,
              page,
              {
                depositAmount: this.resolveDepositAmount(automation.params),
                postRegistrationDepositEnabled,
                startUrl: profile.homeUrl,
              },
              trustedNavigationOrigins,
            ).catch((error) => {
              this.log(
                runId,
                "warning",
                `[${profile.name}] Cadastro remoto concluido, mas nao consegui abrir automaticamente o deposito: ${
                  error instanceof Error ? error.message : "erro inesperado"
                }`,
              );
            });
          }
          return;
        } catch (error) {
          if (!this.allowLocalAutomationFallback) {
            throw error;
          }
          this.log(
            runId,
            "warning",
            `Workflow remoto indisponivel em desenvolvimento; usando fluxo local: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      await this.executeAccountRegistration(
        runId,
        automation,
        profile,
        page,
        settings,
      );
      return;
    }

    throw new Error(`Tipo de rotina nao suportado: ${automation.kind}.`);
  }

  private async executeRemoteAutomation(
    runId: string,
    workflowId: string,
    automation: AutomationRecord,
    profile: ProfileSummary,
    page: Page,
    context: RemoteExecutionContext = {},
    trustedNavigationOrigins = new Set<string>(),
  ): Promise<void> {
    const remote = this.remoteAutomation;
    if (!remote) {
      throw new Error("Cliente de automacao remota indisponivel.");
    }
    let checkpoint = await remote.startAutomationRun(workflowId);
    const targets = new Map<string, Locator>();
    try {
      while (!checkpoint.complete) {
        this.ensureRunActive(runId);
        this.ensureLicensed();
        if (
          !checkpoint.step ||
          !checkpoint.stepSha256 ||
          !checkpoint.stepNonce
        ) {
          throw new Error("Servidor retornou checkpoint sem etapa assinada.");
        }
        const step = checkpoint.step;
        await this.executeRemoteStep(
          runId,
          automation,
          profile,
          page,
          step,
          targets,
          context,
          trustedNavigationOrigins,
        );
        const receipt: AutomationReceipt = {
          runNonce: checkpoint.runNonce,
          stepNonce: checkpoint.stepNonce,
          sequence: step.sequence,
          stepSha256: checkpoint.stepSha256,
          status: "succeeded",
          observations: {
            checkpoint: step.checkpoint,
          },
        };
        checkpoint = await remote.nextAutomationRun(checkpoint.runId, receipt);
      }
      if (workflowId === ACCOUNT_REGISTRATION_KIND) {
        if (context.registrationPhoneNumber) {
          this.database.updateProfileAccountPhoneNumber(
            profile.id,
            context.registrationPhoneNumber,
          );
        }
        this.database.updateProfileAccountStatus(profile.id, "registered", {
          registeredAt: new Date().toISOString(),
          registeredOrigin: page.url(),
        });
        this.log(
          runId,
          "success",
          `[${profile.name}] Workflow remoto de cadastro concluido.`,
        );
      }
    } catch (error) {
      await remote
        .abortAutomationRun(
          checkpoint.runId,
          error instanceof Error
            ? error.message.slice(0, 240)
            : "Falha no executor local.",
        )
        .catch(() => undefined);
      throw error;
    }
  }

  private async executeRemoteStep(
    runId: string,
    automation: AutomationRecord,
    profile: ProfileSummary,
    page: Page,
    step: AutomationStep,
    targets: Map<string, Locator>,
    context: RemoteExecutionContext,
    trustedNavigationOrigins: Set<string>,
  ): Promise<void> {
    const startedAt = Date.now();
    const stepTimeoutMs = resolveRemoteStepTimeoutMs(
      step.workflowId,
      step.maxDurationMs,
    );
    const allowedOrigins = new Set(
      step.allowedOrigins.map((value) =>
        value === "$profile.homeUrl"
          ? resolveAutomationOrigin(profile.homeUrl)
          : resolveAutomationOrigin(value),
      ),
    );
    for (const origin of trustedNavigationOrigins) {
      allowedOrigins.add(origin);
    }
    this.syncTrustedCurrentOrigin(
      page,
      allowedOrigins,
      trustedNavigationOrigins,
    );
    for (const action of step.actions) {
      this.ensureRunActive(runId);
      this.ensureLicensed();
      if (Date.now() - startedAt > stepTimeoutMs) {
        throw new Error(
          `Checkpoint remoto '${step.checkpoint}' excedeu o tempo maximo.`,
        );
      }
      await this.executeRemoteAction(
        runId,
        automation,
        profile,
        page,
        action,
        targets,
        allowedOrigins,
        context,
        trustedNavigationOrigins,
        step.workflowId,
      );
    }
  }

  private async executeRemoteAction(
    runId: string,
    automation: AutomationRecord,
    profile: ProfileSummary,
    page: Page,
    action: AutomationAction,
    targets: Map<string, Locator>,
    allowedOrigins: Set<string>,
    context: RemoteExecutionContext,
    trustedNavigationOrigins: Set<string>,
    workflowId: string,
  ): Promise<void> {
    if (action.type === "navigate") {
      if (Boolean(action.url) === Boolean(action.urlRef)) {
        throw new Error("Acao navigate remota invalida.");
      }
      const targetUrl = action.url ?? profile.homeUrl;
      const origin = resolveAutomationOrigin(targetUrl);
      if (!allowedOrigins.has(origin)) {
        throw new Error(`Origem remota nao autorizada: ${origin}.`);
      }
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: resolveRemoteNavigationTimeoutMs(workflowId),
      });
      const redirectedOrigin = trustRedirectedAutomationOrigin(
        allowedOrigins,
        targetUrl,
        page.url(),
      );
      trustedNavigationOrigins.add(redirectedOrigin);
      return;
    }

    this.syncTrustedCurrentOrigin(
      page,
      allowedOrigins,
      trustedNavigationOrigins,
    );
    this.assertCurrentOriginAllowed(page, allowedOrigins);
    if (action.type === "findField") {
      const actionTimeoutMs = resolveRemoteActionTimeoutMs(
        workflowId,
        action.timeoutMs,
      );
      const locator = await this.getVisibleInputByHints(
        runId,
        page,
        action.target,
        action.hints,
        {
          optional: action.optional,
          rejectHints: action.rejectHints,
          timeoutMs: actionTimeoutMs,
        },
      );
      if (!locator && !action.optional) {
        throw new Error(`Campo remoto '${action.target}' nao encontrado.`);
      }
      if (locator) {
        targets.set(action.target, locator);
      }
      return;
    }
    if (action.type === "findControl") {
      const actionTimeoutMs = resolveRemoteActionTimeoutMs(
        workflowId,
        action.timeoutMs,
      );
      const isRegistrationSubmit =
        workflowId === ACCOUNT_REGISTRATION_KIND &&
        action.target === "registration.submit";
      const locator = isRegistrationSubmit
        ? await this.getVisibleRegistrationSubmitControl(runId, page, {
            timeoutMs: actionTimeoutMs,
          })
        : page
            .getByRole(action.role, {
              name: new RegExp(
                action.labels
                  .map((label) => this.escapeRegExp(label))
                  .join("|"),
                "i",
              ),
            })
            .first();
      const visible = locator
        ? await locator
            .waitFor({ state: "visible", timeout: actionTimeoutMs })
            .then(() => true)
            .catch(() => false)
        : false;
      if (!visible && !action.optional) {
        throw new Error(`Controle remoto '${action.target}' nao encontrado.`);
      }
      if (visible && locator) {
        targets.set(action.target, locator);
      }
      return;
    }
    if (action.type === "typeSecretRef") {
      const locator = targets.get(action.target);
      if (!locator) {
        throw new Error(`Alvo remoto '${action.target}' nao foi localizado.`);
      }
      const secret = this.resolveRemoteSecret(
        action.secretRef,
        automation,
        profile,
        context,
      );
      if (!secret) {
        throw new Error(`Segredo local '${action.secretRef}' indisponivel.`);
      }
      await this.humanTypeField(runId, page, locator, secret);
      return;
    }
    if (action.type === "click") {
      const locator = targets.get(action.target);
      if (!locator) {
        throw new Error(`Alvo remoto '${action.target}' nao foi localizado.`);
      }
      if (
        workflowId === ACCOUNT_REGISTRATION_KIND &&
        action.target === "registration.submit"
      ) {
        await this.completeRegistrationFields(runId, profile, page, context);
      }
      await this.humanMouseClick(runId, page, locator);
      return;
    }
    if (action.type === "waitFor") {
      const actionTimeoutMs = resolveRemoteActionTimeoutMs(
        workflowId,
        action.timeoutMs,
      );
      if (
        action.state === "network-idle" ||
        action.state === "dom-content-loaded"
      ) {
        await page.waitForLoadState(
          action.state === "network-idle" ? "networkidle" : "domcontentloaded",
          { timeout: actionTimeoutMs },
        );
        return;
      }
      const locator = action.target ? targets.get(action.target) : undefined;
      if (!locator) {
        throw new Error(
          `Alvo remoto '${action.target ?? ""}' nao foi localizado.`,
        );
      }
      await locator.waitFor({ state: action.state, timeout: actionTimeoutMs });
      return;
    }
    if (action.type === "pauseForManualAction") {
      const actionTimeoutMs = resolveRemoteActionTimeoutMs(
        workflowId,
        action.timeoutMs,
      );
      if (action.reason === "captcha") {
        await this.waitForManualCaptchaIfPresent(
          runId,
          page,
          profile.name,
          "workflow remoto",
          {
            appearanceTimeoutMs: actionTimeoutMs,
          },
        );
        return;
      }
      this.log(
        runId,
        "warning",
        `[${profile.name}] Acao manual necessaria: ${action.reason}.`,
      );
      await this.waitForRunDelay(runId, page, actionTimeoutMs);
      return;
    }
    if (action.type === "findText") {
      const actionTimeoutMs = resolveRemoteActionTimeoutMs(
        workflowId,
        action.timeoutMs,
      );
      const locator = this.locatorByTextHints(page, action.labels).first();
      const visible = await locator
        .waitFor({ state: "visible", timeout: actionTimeoutMs })
        .then(() => true)
        .catch(() => false);
      if (!visible && !action.optional) {
        throw new Error(`Texto remoto '${action.target}' nao encontrado.`);
      }
      if (visible) {
        targets.set(action.target, locator);
      }
      return;
    }
    if (action.type === "clickText") {
      const actionTimeoutMs = resolveRemoteActionTimeoutMs(
        workflowId,
        action.timeoutMs,
      );
      const locator = this.locatorByTextHints(page, action.labels).first();
      const visible = await locator
        .waitFor({ state: "visible", timeout: actionTimeoutMs })
        .then(() => true)
        .catch(() => false);
      if (!visible && !action.optional) {
        throw new Error("Texto clicavel remoto nao encontrado.");
      }
      if (visible) {
        await this.humanMouseClick(runId, page, locator);
      }
      return;
    }
    if (action.type === "localPrimitive") {
      try {
        await this.executeRemoteLocalPrimitive(
          runId,
          automation,
          profile,
          page,
          action.primitive,
          context,
        );
      } catch (error) {
        if (!action.optional) {
          throw error;
        }
      }
    }
  }

  private async completeRegistrationFields(
    runId: string,
    profile: ProfileSummary,
    page: Page,
    context: RemoteExecutionContext,
  ): Promise<void> {
    const account = this.database.getOrCreateProfileAccount(profile.id);
    const filledFields: string[] = [];
    const phoneNumber =
      context.registrationPhoneNumber ||
      account.phoneNumber ||
      this.generateRegistrationPhoneNumber();

    const fastFilled = await this.fastFillRegistrationOptionalFields(
      runId,
      page,
      {
        cpf: account.cpf,
        phoneNumber,
        realName: account.realName,
      },
    );

    if (fastFilled.phone) {
      context.registrationPhoneNumber = phoneNumber;
      filledFields.push("celular");
    }

    if (fastFilled.realName) {
      filledFields.push("nome");
    }

    if (fastFilled.cpf) {
      filledFields.push("CPF");
    }

    if (await this.fastAcceptRegistrationTerms(runId, page)) {
      filledFields.push("termos");
    }
  }

  private assertCurrentOriginAllowed(
    page: Page,
    allowedOrigins: Set<string>,
  ): void {
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === "about:blank") {
      return;
    }
    const origin = resolveAutomationOrigin(currentUrl);
    if (!allowedOrigins.has(origin)) {
      throw new Error(`Pagina atual fora das origens permitidas: ${origin}.`);
    }
  }

  private syncTrustedCurrentOrigin(
    page: Page,
    allowedOrigins: Set<string>,
    trustedNavigationOrigins: Set<string>,
  ): void {
    const currentUrl = page.url();
    if (
      trustedNavigationOrigins.size === 0 ||
      !currentUrl ||
      currentUrl === "about:blank"
    ) {
      return;
    }

    const currentOrigin = trustCurrentAutomationOrigin(
      trustedNavigationOrigins,
      currentUrl,
    );
    allowedOrigins.add(currentOrigin);
  }

  private resolveRemoteSecret(
    secretRef: RemoteSecretRef,
    automation: AutomationRecord,
    profile: ProfileSummary,
    context: RemoteExecutionContext,
  ): string | undefined {
    const account = this.database.getOrCreateProfileAccount(profile.id);
    const values: Record<string, string | undefined> = {
      "account.username": account.username,
      "account.password": account.password,
      "account.phoneNumber": account.phoneNumber,
      "account.realName": account.realName,
      "account.cpf": account.cpf,
      "account.withdrawalPassword": account.withdrawalPassword,
      "pix.phoneNumber": context.pixPhoneNumber,
      "deposit.amount":
        context.depositAmount ?? this.resolveDepositAmount(automation.params),
    };
    return values[secretRef];
  }

  private locatorByTextHints(page: Page, labels: string): Locator;
  private locatorByTextHints(page: Page, labels: string[]): Locator;
  private locatorByTextHints(page: Page, labels: string | string[]): Locator {
    const hints = Array.isArray(labels) ? labels : [labels];
    const labelPattern = new RegExp(
      hints.map((label) => this.escapeRegExp(label)).join("|"),
      "i",
    );
    return page.getByText(labelPattern);
  }

  private async executeRemoteLocalPrimitive(
    runId: string,
    automation: AutomationRecord,
    profile: ProfileSummary,
    page: Page,
    primitive: WorkflowLocalPrimitive,
    context: RemoteExecutionContext,
  ): Promise<void> {
    if (primitive === "loginFlow") {
      await this.executeLocalLoginFlow(runId, profile, page);
      return;
    }
    if (primitive === "postRegistrationDepositFlow") {
      if (context.postRegistrationDepositEnabled === false) {
        return;
      }
      await this.prepareLocalDepositAfterSuccessfulRegistration(
        runId,
        page,
        profile,
        context.startUrl ?? profile.homeUrl,
        context.depositAmount ?? this.resolveDepositAmount(automation.params),
      );
      return;
    }
    if (primitive === "manualDepositFlow") {
      const depositAmount = context.depositAmount;
      if (!depositAmount) {
        throw new Error("Valor de deposito ausente para workflow remoto.");
      }
      await this.executeLocalManualDeposit(runId, profile, page, depositAmount);
      return;
    }
    if (primitive === "pixPhoneRegistrationFlow") {
      throw new Error(
        "O workflow remoto de cadastro PIX foi removido. Use a preparacao de entrada PIX.",
      );
    }
    if (primitive === "withdrawalPreparationFlow") {
      await this.executeLocalWithdrawalPreparation(runId, profile, page);
      return;
    }
    throw new Error(`Primitiva remota nao suportada: ${primitive}.`);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ---------------------------------------------------------------------------
  // Auto-login: garante que o perfil esta logado antes de qualquer automacao.
  // ---------------------------------------------------------------------------

  private async ensureLoggedIn(
    runId: string,
    profile: ProfileSummary,
    page: Page,
  ): Promise<void> {
    // Todo fluxo (login, navegacao, slots, chave PIX, saque, deposito) passa por aqui
    // antes de interagir com a pagina. Encerra qualquer overlay de QR remanescente de
    // um deposito anterior para que ele nao intercepte os cliques deste fluxo. O
    // deposito reabre o seu proprio overlay logo depois (novo watcher supera este stop).
    await this.stopQrOverlay(page);
    const account = this.database.getOrCreateProfileAccount(profile.id);
    if (
      account.status !== "registered" ||
      !account.username ||
      !account.password
    ) {
      return;
    }
    if (this.remoteAutomation) {
      try {
        await this.executeRemoteAutomation(
          runId,
          LOGIN_WORKFLOW_ID,
          this.database.getSystemAutomationForProfile(profile.id),
          profile,
          page,
        );
        return;
      } catch (error) {
        if (!this.allowLocalAutomationFallback) {
          throw error;
        }
        this.log(
          runId,
          "warning",
          `Workflow remoto de login indisponivel em desenvolvimento; usando fluxo local: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await this.executeLocalLoginFlow(runId, profile, page);
  }

  private async executeLocalLoginFlow(
    runId: string,
    profile: ProfileSummary,
    page: Page,
  ): Promise<void> {
    const account = this.database.getOrCreateProfileAccount(profile.id);
    if (
      account.status !== "registered" ||
      !account.username ||
      !account.password
    ) {
      return;
    }

    const startUrl = profile.homeUrl.trim();
    if (!startUrl) {
      return;
    }

    const loggedPage = this.createLoggedPage(runId, page);

    // Anti-refresh: se a sessao ja esta ativa na pagina atual, pula o login SEM
    // recarregar. O goto(home) + waitForLoading + fecha-popups abaixo era o "refresh"
    // pesado que aparecia ao iniciar a automacao mesmo com a conta ja logada (recem
    // usada em registro/deposito). hasActiveSession e a mesma checagem autoritativa
    // usada logo adiante, entao pula com seguranca.
    if (await hasActiveSession(page).catch(() => false)) {
      return;
    }

    await loggedPage.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await this.waitForPlatformLoadingToClear(runId, loggedPage, {
      retryWithReload: true,
    });
    await loggedPage
      .waitForLoadState("networkidle", { timeout: 3000 })
      .catch(() => null);
    await this.normalizeRegistrationEntryPage(
      runId,
      loggedPage,
      profile.name,
    ).catch(() => undefined);
    await loggedPage.waitForTimeout(400).catch(() => undefined);

    if (await hasActiveSession(loggedPage)) {
      return;
    }

    this.log(
      runId,
      "info",
      `[${profile.name}] Sessao expirada — iniciando login automatico para ${account.username}.`,
    );

    await this.dismissInitialPopupsBeforeRegistration(
      runId,
      loggedPage,
      profile.name,
    );

    if (await hasActiveSession(loggedPage)) {
      return;
    }

    const loginDialogState = await this.ensureLoginDialogOpen(
      runId,
      loggedPage,
      profile.name,
    );
    if (loginDialogState === "active-session") {
      return;
    }

    const accountInput = await this.getVisibleInputByHints(
      runId,
      loggedPage,
      "conta (login)",
      [
        "Digite o Numero do Celular/Conta",
        "Digite o Celular/Conta",
        "Digite o Conta",
        "Conta",
        "account",
        "usuario",
        "usuário",
        "username",
        "celular",
        "phone",
        "mobile",
      ],
      { timeoutMs: 8000 },
    );
    if (!accountInput) {
      throw new Error("Campo de conta nao encontrado no formulario de login.");
    }

    const passwordInput = await this.getVisibleInputByHints(
      runId,
      loggedPage,
      "senha (login)",
      ["Insira a senha", "senha", "password", "userpass"],
      { timeoutMs: 4000 },
    );
    if (!passwordInput) {
      throw new Error("Campo de senha nao encontrado no formulario de login.");
    }

    await this.humanTypeField(runId, page, accountInput, account.username);
    await this.humanTypeField(runId, page, passwordInput, account.password);

    const submitButton = await this.getVisibleLoginSubmitControl(
      runId,
      loggedPage,
      { timeoutMs: 4000 },
    );
    if (!submitButton) {
      throw new Error("Botao de login nao encontrado no formulario.");
    }

    this.ensureRunActive(runId);
    await this.humanPause(runId, page, 8, 20);
    await this.humanMouseClick(runId, page, submitButton);

    let handledCaptcha = await this.waitForManualCaptchaIfPresent(
      runId,
      page,
      profile.name,
      "login",
      {
        appearanceTimeoutMs: 2500,
      },
    );

    const loginSucceeded = await waitForLoginSuccess(
      loggedPage,
      handledCaptcha ? 15000 : 20000,
    );

    if (!loginSucceeded && !handledCaptcha) {
      handledCaptcha = await this.waitForManualCaptchaIfPresent(
        runId,
        page,
        profile.name,
        "login",
        {
          appearanceTimeoutMs: 1200,
        },
      );
      if (handledCaptcha) {
        const retrySucceeded = await waitForLoginSuccess(loggedPage, 15000);
        if (!retrySucceeded) {
          const errorMsg = await detectLoginErrorMessage(loggedPage);
          await this.dismissPlatformErrorDialog(loggedPage).catch(
            () => undefined,
          );
          throw new Error(
            errorMsg || "login nao confirmou apos resolver captcha",
          );
        }
        this.log(
          runId,
          "success",
          `[${profile.name}] Login automatico concluido.`,
        );
        return;
      }
    }

    if (!loginSucceeded) {
      const errorMsg = await detectLoginErrorMessage(loggedPage);
      await this.dismissPlatformErrorDialog(loggedPage).catch(() => undefined);
      throw new Error(errorMsg || "login nao confirmou apos o envio");
    }

    this.log(runId, "success", `[${profile.name}] Login automatico concluido.`);
  }

  private async ensureLoginDialogOpen(
    runId: string,
    page: Page,
    profileName: string,
  ): Promise<"form" | "active-session"> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      this.ensureRunActive(runId);

      if (await hasActiveSession(page)) {
        return "active-session";
      }

      if (await isLoginFormVisible(page)) {
        return "form";
      }

      await this.dismissInitialPopupsBeforeRegistration(
        runId,
        page,
        profileName,
      );

      if (await hasActiveSession(page)) {
        return "active-session";
      }

      if (await isLoginFormVisible(page)) {
        return "form";
      }

      const clicked = await this.clickLoginEntryPoint(runId, page);
      if (!clicked) {
        await page.waitForTimeout(300);
        continue;
      }

      await page.waitForTimeout(800);

      if (await hasActiveSession(page)) {
        return "active-session";
      }

      if (await isLoginFormVisible(page)) {
        return "form";
      }

      await this.dismissInitialPopupsBeforeRegistration(
        runId,
        page,
        profileName,
      );
    }

    throw new Error(
      "Formulario de login nao abriu apos fechar popups e clicar em Login.",
    );
  }

  private async clickLoginEntryPoint(
    runId: string,
    page: Page,
  ): Promise<string | undefined> {
    this.ensureRunActive(runId);
    const targetToken = `login-entry-${Date.now()}-${this.randomInt(1000, 9999)}`;
    const label = await resolveContentFrame(page)
      .evaluate((token) => {
        type RuntimeElement = {
          closest?: (selector: string) => RuntimeElement | null;
          getAttribute?: (name: string) => string | null;
          getBoundingClientRect: () => {
            bottom: number;
            height: number;
            left: number;
            right: number;
            top: number;
            width: number;
          };
          setAttribute?: (name: string, value: string) => void;
          textContent?: string | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: {
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
          };
          getComputedStyle: (element: RuntimeElement) => {
            display: string;
            opacity: string;
            visibility: string;
          };
          innerHeight: number;
          innerWidth: number;
        };
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const readAttrs = (el: RuntimeElement) =>
          normalize(
            [
              el.getAttribute?.("id"),
              el.getAttribute?.("class"),
              el.getAttribute?.("href"),
              el.getAttribute?.("to"),
              el.getAttribute?.("data-name"),
              el.getAttribute?.("data-route"),
              el.getAttribute?.("data-testid"),
              el.getAttribute?.("aria-label"),
              el.getAttribute?.("title"),
            ].join(" "),
          );
        const isVisible = (el: RuntimeElement) => {
          const style = runtimeWindow.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 8 &&
            rect.height > 8 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < runtimeWindow.innerWidth &&
            rect.top < runtimeWindow.innerHeight
          );
        };
        const clickSelector =
          "button,a,[role='button'],[role='tab'],.ui-tabbar-item,[id*='login' i],[id*='signin' i]," +
          "[class*='login' i],[class*='signin' i],[class*='sign-in' i],[class*='navItem' i]," +
          "[class*='menu-item' i],[class*='menuItem' i],[class*='itemContent' i],[class*='item_' i]";
        const candidates = new Map<
          RuntimeElement,
          { element: RuntimeElement; label: string; score: number; y: number }
        >();

        for (const el of runtimeWindow.document.querySelectorAll(
          "button,a,[role='button'],[role='tab'],div,span",
        )) {
          const clickable = el.closest?.(clickSelector) ?? el;
          if (!isVisible(clickable)) continue;

          const rect = clickable.getBoundingClientRect();
          const area = rect.width * rect.height;
          const viewportArea =
            runtimeWindow.innerWidth * runtimeWindow.innerHeight;
          const text = normalize(
            `${el.textContent || ""} ${clickable.textContent || ""}`,
          );
          const attrs = `${readAttrs(el)} ${readAttrs(clickable)}`;
          const haystack = normalize(`${text} ${attrs}`);
          const exact =
            /^(login|entrar|sign in|signin|iniciar sessao|acessar|log in)$/i.test(
              text,
            );
          const contains =
            /login|entrar|sign in|signin|iniciar sessao|acessar|log in/.test(
              haystack,
            );
          const strongAttr =
            /(^|\s|_|-|\/)(login|signin|sign-in|entrar|acessar)(\s|_|-|\/|$)|loginclick|loginmodal/.test(
              attrs,
            );

          if (
            /tenho mais de 18|termos|terms|agreement|suporte|download|cadastro|registro|registrar|sign up|signup|register/.test(
              haystack,
            )
          )
            continue;
          if (/checkbox|footer|dating-img|agreement|terms/.test(attrs))
            continue;

          if (!exact && !contains && !strongAttr) continue;

          let score = 0;
          if (strongAttr) score += 100;
          if (exact) score += 92;
          else if (contains) score += 55;
          if (
            /button|btn|tabbar|navitem|menu-item|menuitem|primary/.test(
              haystack,
            )
          )
            score += 22;
          if (
            rect.top < runtimeWindow.innerHeight * 0.35 ||
            rect.top > runtimeWindow.innerHeight * 0.62
          )
            score += 10;
          if (
            /deposit|deposito|recarga|saque|withdraw|bonus|promocao|promotion|close|fechar|captcha/.test(
              haystack,
            )
          )
            score -= 85;
          if (area > viewportArea * 0.3 || text.length > 90) score -= 60;
          if (score < 45) continue;

          const lbl = text || attrs.split(" ")[0] || "login";
          const existing = candidates.get(clickable);
          if (!existing || score > existing.score) {
            candidates.set(clickable, {
              element: clickable,
              label: lbl,
              score,
              y: rect.top + rect.height / 2,
            });
          }
        }

        const best = Array.from(candidates.values()).sort(
          (a, b) => b.score - a.score || a.y - b.y,
        )[0];
        best?.element.setAttribute?.("data-predator-login-entry-target", token);
        return best?.label;
      }, targetToken)
      .catch(() => undefined);

    if (!label) return undefined;

    const target = page
      .locator(`[data-predator-login-entry-target="${targetToken}"]`)
      .first();
    await this.withPopupPageGuard(page, async () => {
      await this.humanMouseClick(runId, page, target).catch(async () => {
        await target.click({ timeout: 1200, force: true }).catch(async () => {
          await target
            .evaluate((el) => {
              (el as unknown as { click: () => void }).click();
            })
            .catch(() => undefined);
        });
      });
    }).catch(() => undefined);
    await target
      .evaluate((el) => el.removeAttribute("data-predator-login-entry-target"))
      .catch(() => undefined);

    return label;
  }

  private async getVisibleLoginSubmitControl(
    runId: string,
    page: Page,
    options?: { timeoutMs?: number },
  ): Promise<Locator | undefined> {
    const timeoutMs = options?.timeoutMs ?? 8000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      this.ensureRunActive(runId);

      const targetToken = `login-submit-${Date.now()}-${this.randomInt(1000, 9999)}`;
      const match = await resolveContentFrame(page)
        .evaluate((token) => {
          type RuntimeElement = {
            closest?: (selector: string) => RuntimeElement | null;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
            setAttribute?: (name: string, value: string) => void;
            textContent?: string | null;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              body: RuntimeElement;
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
            };
            innerHeight: number;
            innerWidth: number;
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[̀-ͯ]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const readAttrs = (el: RuntimeElement) =>
            normalize(
              [
                el.getAttribute?.("id"),
                el.getAttribute?.("class"),
                el.getAttribute?.("name"),
                el.getAttribute?.("role"),
                el.getAttribute?.("type"),
                el.getAttribute?.("aria-label"),
                el.getAttribute?.("title"),
              ].join(" "),
            );
          const isRendered = (el: RuntimeElement) => {
            const style = runtimeWindow.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8
            );
          };
          const inputType = (el: RuntimeElement) =>
            normalize(el.getAttribute?.("type"));
          const sectionSelector =
            "form,.ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true']," +
            ".modal,.popup,.dialog,.m_sign_in,.sign_in_body,.login_content,.form_box";
          const sections = Array.from(
            new Set([
              runtimeWindow.document.body,
              ...Array.from(
                runtimeWindow.document.querySelectorAll(sectionSelector),
              ),
            ]),
          )
            .filter(isRendered)
            .map((section) => {
              const inputs = Array.from(
                section.querySelectorAll?.("input") ?? [],
              ).filter(isRendered);
              const passwordInputs = inputs.filter(
                (i) => inputType(i) === "password",
              );
              const text = normalize(section.textContent).slice(0, 2500);
              const rect = section.getBoundingClientRect();
              let score = 0;
              if (passwordInputs.length === 1) score += 100;
              if (/login|entrar|sign in|iniciar sessao|acessar/.test(text))
                score += 45;
              if (/senha|password/.test(text)) score += 20;
              if (passwordInputs.length >= 2) score -= 60;
              return {
                area: rect.width * rect.height,
                element: section,
                passwordBottom: Math.max(
                  0,
                  ...passwordInputs.map(
                    (i) => i.getBoundingClientRect().bottom,
                  ),
                ),
                score,
              };
            })
            .filter((s) => s.score >= 100)
            .sort((a, b) => b.score - a.score || a.area - b.area);

          const roots =
            sections.length > 0
              ? sections
              : [{ element: runtimeWindow.document.body, passwordBottom: 0 }];
          const clickSelector =
            "button,a,[role='button'],input[type='submit'],input[type='button'],.sing_btn,.login_sign_btn," +
            ".submit,.btn,.primary,[class*='submit' i],[class*='login' i],[id*='submit' i],[id*='login' i]";
          const candidates = new Map<
            RuntimeElement,
            { element: RuntimeElement; label: string; score: number; y: number }
          >();

          for (const root of roots) {
            for (const el of Array.from(
              root.element.querySelectorAll?.(
                "button,a,input,[role='button'],div,span",
              ) ?? [],
            )) {
              const clickable = el.closest?.(clickSelector) ?? el;
              if (!isRendered(clickable)) continue;

              const rect = clickable.getBoundingClientRect();
              const viewportArea =
                runtimeWindow.innerWidth * runtimeWindow.innerHeight;
              const elText = normalize(el.textContent);
              const clickableText = normalize(clickable.textContent);
              const label = clickableText || elText || "login";
              const attrs = `${readAttrs(el)} ${readAttrs(clickable)}`;
              const haystack = normalize(`${label} ${attrs}`);
              const exactSubmit =
                /^(login|entrar|sign in|signin|acessar|log in|iniciar sessao)$/i.test(
                  label,
                ) ||
                /^(login|entrar|sign in|signin|acessar|log in|iniciar sessao)$/i.test(
                  elText,
                );
              const containsSubmit =
                /login|entrar|sign in|signin|acessar|log in/.test(haystack);
              const strongSubmit =
                /login_sign_btn|sing_btn|submit|primary|(^|\s)btn(\s|$)/.test(
                  attrs,
                );

              if (!exactSubmit && !containsSubmit && !strongSubmit) continue;

              let score = 0;
              if (strongSubmit) score += 55;
              if (exactSubmit) score += 92;
              else if (containsSubmit) score += 38;
              if (root.passwordBottom > 0)
                score += rect.top >= root.passwordBottom - 8 ? 70 : -100;
              if (/tab|van-tab|sing_type_item/.test(attrs)) score -= 80;
              if (/checkbox|radio|switch|icon|img|image/.test(attrs))
                score -= 120;
              if (!strongSubmit && (rect.width < 80 || rect.height < 24))
                score -= 70;
              if (
                /registro|registrar|cadastro|cadastrar|sign up|signup|register|suporte|download|termos/.test(
                  label,
                )
              )
                score -= 75;
              if (
                rect.width * rect.height > viewportArea * 0.45 ||
                label.length > 90
              )
                score -= 70;
              if (score < 55) continue;

              const existing = candidates.get(clickable);
              if (!existing || score > existing.score) {
                candidates.set(clickable, {
                  element: clickable,
                  label,
                  score,
                  y: rect.top + rect.height / 2,
                });
              }
            }
          }

          const best = Array.from(candidates.values()).sort(
            (a, b) => b.score - a.score || b.y - a.y,
          )[0];
          best?.element.setAttribute?.(
            "data-predator-login-submit-target",
            token,
          );
          return best ? { label: best.label, score: best.score } : undefined;
        }, targetToken)
        .catch(() => undefined);

      if (match) {
        const target = page
          .locator(`[data-predator-login-submit-target="${targetToken}"]`)
          .first();
        if (await target.isVisible({ timeout: 300 }).catch(() => false)) {
          return target;
        }
      }

      await page.waitForTimeout(120);
    }

    return undefined;
  }

  private async dismissPlatformErrorDialog(page: Page): Promise<boolean> {
    return resolveContentFrame(page)
      .evaluate(() => {
        type RuntimeOverlay = {
          getAttribute: (name: string) => string | null;
          querySelector: (selector: string) => { click?: () => void } | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: {
            querySelectorAll: (selector: string) => Iterable<RuntimeOverlay>;
          };
          getComputedStyle: (element: unknown) => {
            display: string;
            zIndex: string;
          };
        };
        for (const overlay of runtimeWindow.document.querySelectorAll(
          ".ui-overlay",
        )) {
          const style = runtimeWindow.getComputedStyle(overlay);
          if (style.display === "none") continue;
          const z = parseInt(style.zIndex || "0");
          if (z <= 2001) continue;
          if (overlay.getAttribute("data-hidden") === "1") continue;
          const close = overlay.querySelector(".ui-dialog-close-box");
          if (close?.click) {
            close.click();
            return true;
          }
        }
        return false;
      })
      .catch(() => false);
  }

  private async executeAccountRegistration(
    runId: string,
    automation: AutomationRecord,
    profile: ProfileSummary,
    page: Page,
    settings: AppSettings,
  ): Promise<void> {
    const account = this.database.getOrCreateProfileAccount(profile.id);
    const startUrl = (profile.homeUrl || automation.startUrl || "").trim();
    if (!startUrl) {
      throw new Error(
        "Configure um link inicial no perfil antes de executar o cadastro.",
      );
    }
    const loggedPage = this.createLoggedPage(runId, page);
    const autoCaptchaSolverEnabled =
      automation.params.autoCaptchaSolverEnabled === "true";
    if (autoCaptchaSolverEnabled) {
      this.autoCaptchaSolverRuns.add(runId);
      // Worker do solver sobe SOB DEMANDA (lazy): so ao ver o 1o trafego de rede geetest
      // (em setupGeetestInterception). Evita carregar CLIP/torch no inicio de TODO run e
      // disputar CPU com a abertura dos navegadores quando a plataforma nem tem captcha.
      this.setupGeetestInterception(runId, page);
      await this.installGeetestBridge(page).catch(() => undefined);
    } else {
      await this.geetestSolver?.stopIfIdle().catch(() => undefined);
    }

    this.log(
      runId,
      "info",
      `[${profile.name}] Preparando cadastro da plataforma para ${account.username}.`,
    );

    await loggedPage.goto(startUrl, {
      waitUntil: "domcontentloaded",
    });
    await this.browserRuntime.setPageAutoClosePopups(loggedPage, true);
    await this.waitForPlatformLoadingToClear(runId, loggedPage, {
      retryWithReload: true,
    });
    await loggedPage
      .waitForLoadState("networkidle", { timeout: 3000 })
      .catch(() => null);
    await this.normalizeRegistrationEntryPage(runId, loggedPage, profile.name);
    await loggedPage.waitForTimeout(250);

    await this.dismissInitialPopupsBeforeRegistration(
      runId,
      loggedPage,
      profile.name,
    );

    await this.ensureRegistrationDialogOpen(runId, loggedPage, profile.name);

    const accountInput = await this.getRequiredVisibleInputByHints(
      runId,
      loggedPage,
      "conta",
      ["Digite o Conta", "Conta", "account", "usuario", "usuário"],
    );
    const passwordInput = await this.getRequiredVisibleInputByHints(
      runId,
      loggedPage,
      "senha",
      ["Insira a senha", "senha", "userpass", "password"],
    );
    const confirmPasswordInput = await this.getRequiredVisibleInputByHints(
      runId,
      loggedPage,
      "confirmacao de senha",
      [
        "Confirmar senha",
        "confirme a senha",
        "confirmacao senha",
        "confirmar",
        "confirmPassword",
        "confirm password",
      ],
    );

    const fastMainFieldsFilled = await this.fastFillRegistrationMainFields(
      runId,
      page,
      [
        { fieldName: "conta", locator: accountInput, value: account.username },
        { fieldName: "senha", locator: passwordInput, value: account.password },
        {
          fieldName: "confirmacao de senha",
          locator: confirmPasswordInput,
          value: account.password,
        },
      ],
    );
    if (!fastMainFieldsFilled) {
      await this.humanTypeField(runId, page, accountInput, account.username);
      await this.humanTypeField(runId, page, passwordInput, account.password);
      await this.humanTypeField(
        runId,
        page,
        confirmPasswordInput,
        account.password,
      );
    }

    const submitButton = await this.getRequiredRegistrationSubmitControl(
      runId,
      loggedPage,
    );

    const registrationContext: RemoteExecutionContext = {};
    try {
      await this.completeRegistrationFields(
        runId,
        profile,
        loggedPage,
        registrationContext,
      );
      await this.browserRuntime.setPageAutoClosePopups(loggedPage, false);

      this.ensureRunActive(runId);
      await this.fastClickControl(runId, page, submitButton);

      try {
        let handledCaptcha = await this.waitForManualCaptchaIfPresent(
          runId,
          page,
          profile.name,
          "cadastro",
          {
            appearanceTimeoutMs: 2500,
          },
        );
        // Confirmacao por SINAL ESTRUTURAL (nao por espera fixa nem pelo simples
        // "campo de conta sumiu"): so consideramos cadastrada quando a tela de
        // cadastro realmente saiu (campos de conta/senha ausentes) E a sessao
        // logada apareceu -- ou, sem sessao explicita, o formulario ficou ausente
        // de forma estavel. Erro da plataforma encerra na hora.
        let outcome = await this.confirmRegistrationCompleted(runId, page, {
          timeoutMs: handledCaptcha ? 15000 : 25000,
        });

        // O captcha pode so ter aparecido AGORA (PC lento): tenta trata-lo e
        // reconfirma. Nao reesperamos quando ja houve erro definitivo da plataforma.
        if (
          !outcome.registered &&
          outcome.via !== "erro-plataforma" &&
          !handledCaptcha
        ) {
          handledCaptcha = await this.waitForManualCaptchaIfPresent(
            runId,
            page,
            profile.name,
            "cadastro",
            {
              appearanceTimeoutMs: 1200,
            },
          );
          if (handledCaptcha) {
            outcome = await this.confirmRegistrationCompleted(runId, page, {
              timeoutMs: 15000,
            });
          }
        }

        if (
          !outcome.registered &&
          outcome.via !== "erro-plataforma" &&
          handledCaptcha &&
          (await submitButton.isVisible().catch(() => false))
        ) {
          await this.fastClickControl(runId, page, submitButton);
          await this.waitForManualCaptchaIfPresent(
            runId,
            page,
            profile.name,
            "confirmacao do cadastro",
            {
              appearanceTimeoutMs: 1800,
            },
          );
          outcome = await this.confirmRegistrationCompleted(runId, page, {
            timeoutMs: 20000,
          });
        }

        if (!outcome.registered) {
          const reason = outcome.reason || "cadastro nao confirmou apos o envio";
          // Loga QUAL sinal nao chegou em vez de falhar silenciosamente.
          this.log(
            runId,
            "warning",
            `[${profile.name}] Cadastro nao confirmado (${outcome.via}): ${reason}`,
          );
          if (outcome.via === "erro-plataforma") {
            await this.dismissPlatformErrorDialog(page).catch(() => undefined);
          }
          throw new Error(reason);
        }

        this.log(
          runId,
          "info",
          `[${profile.name}] Cadastro confirmado por sinal estrutural (${outcome.via}).`,
        );

        if (registrationContext.registrationPhoneNumber) {
          this.database.updateProfileAccountPhoneNumber(
            profile.id,
            registrationContext.registrationPhoneNumber,
          );
        }
        this.database.updateProfileAccountStatus(profile.id, "registered", {
          registeredAt: new Date().toISOString(),
          registeredOrigin: startUrl,
        });
        this.log(
          runId,
          "success",
          `[${profile.name}] Conta ${account.username} registrada na plataforma.`,
        );
        if (this.isPostRegistrationDepositEnabled(automation, settings)) {
          await this.prepareDepositAfterSuccessfulRegistration(
            runId,
            page,
            profile,
            startUrl,
            this.resolveDepositAmount(automation.params),
          ).catch((error) => {
            this.log(
              runId,
              "warning",
              `[${profile.name}] Cadastro concluido, mas nao consegui abrir automaticamente o deposito: ${
                error instanceof Error ? error.message : "erro inesperado"
              }`,
            );
          });
        }
        return;
      } catch (error) {
        // Preserva o motivo REAL ja apurado por confirmRegistrationCompleted (qual
        // sinal estrutural nao chegou / erro da plataforma) em vez de re-derivar um
        // motivo generico do texto da pagina. So caimos no scan do corpo quando o
        // erro nao carrega mensagem util.
        const thrownReason =
          error instanceof Error && error.message ? error.message.trim() : "";
        const pageText = await loggedPage
          .locator("body")
          .innerText()
          .catch(() => "");
        const knownErrors = [
          "Conta ja existe",
          "Conta já existe",
          "telefone",
          "Celular",
          "senha",
          "erro",
          "inválido",
          "invalido",
        ].find((snippet) =>
          pageText.toLowerCase().includes(snippet.toLowerCase()),
        );
        const reason =
          thrownReason ||
          knownErrors ||
          "Nao foi possivel confirmar o sucesso do cadastro apos o envio do formulario.";

        this.database.updateProfileAccountStatus(
          profile.id,
          account.registeredOrigins.length > 0 ? "registered" : "failed",
          {
            lastError: reason,
          },
        );
        throw new Error(reason);
      }
    } finally {
      this.disposeGeetestInterception(runId);
      this.autoCaptchaSolverRuns.delete(runId);
      // Libera o warm-session apenas se realmente aquecemos (lazy). Sem isto, plataformas
      // sem captcha — que nunca dao begin — fariam um release indevido no contador.
      if (this.warmedSolverRuns.delete(runId)) {
        this.geetestSolver?.releaseWarmSession();
      }
    }
  }

  // Confirma a conclusao do cadastro por SINAL ESTRUTURAL, endurecendo o antigo
  // "assumir cadastrada quando o campo de conta some" -- que dava falso-positivo
  // em lote/PC lento (a tela re-renderizava e o campo sumia sem o cadastro ter
  // concluido, marcando a conta como registrada no vazio). Aqui fazemos polling
  // dos sinais reais e so confirmamos quando o estado esperado aparece:
  //  - erro da plataforma -> falha imediata com o motivo;
  //  - campos de conta/senha ainda presentes -> a tela de cadastro nao saiu (pendente);
  //  - sessao logada visivel -> cadastrada (sinal forte);
  //  - formulario ausente de forma ESTAVEL, sem erro -> cadastrada (fallback).
  // No timeout, retorna o motivo dizendo QUAL sinal nao chegou (nunca falha calado).
  private async confirmRegistrationCompleted(
    runId: string,
    page: Page,
    options: { timeoutMs: number },
  ): Promise<{ registered: boolean; via: string; reason?: string }> {
    const startedAt = Date.now();
    let consecutiveFormAbsences = 0;

    while (Date.now() - startedAt < options.timeoutMs) {
      this.ensureRunActive(runId);

      const platformError = await detectRegistrationErrorMessage(page).catch(
        () => undefined,
      );
      const registrationFormPresent =
        (await this.countVisibleRegistrationPasswordInputs(page)) >= 2;
      consecutiveFormAbsences = registrationFormPresent
        ? 0
        : consecutiveFormAbsences + 1;
      // So pagamos o custo do scan de sessao (varre todos os frames) quando o
      // formulario ja saiu e nao ha erro -- o caso comum "ainda carregando"
      // resolve barato com a contagem de campos.
      const activeSession =
        !registrationFormPresent && !platformError
          ? await hasActiveSession(page)
          : false;

      const decision = decideRegistrationCompletion({
        platformError: platformError || undefined,
        registrationFormPresent,
        activeSession,
        consecutiveFormAbsences,
      });

      if (decision.status === "registered") {
        return { registered: true, via: decision.via };
      }
      if (decision.status === "failed") {
        return {
          registered: false,
          via: decision.via,
          reason: decision.reason,
        };
      }

      await page.waitForTimeout(350).catch(() => null);
    }

    // Teto esgotado: reporta QUAL sinal estrutural nao chegou.
    const stillPresent =
      (await this.countVisibleRegistrationPasswordInputs(page).catch(() => 0)) >=
      2;
    return {
      registered: false,
      via: stillPresent ? "timeout-formulario-presente" : "timeout-sem-sessao",
      reason: stillPresent
        ? "cadastro nao confirmou: os campos de conta/senha continuam visiveis apos o envio (a tela de cadastro nao saiu)"
        : "cadastro nao confirmou: a tela pos-cadastro nao carregou (sem sessao ativa e sem mensagem de erro apos o envio)",
    };
  }

  private async executeManualDeposit(
    runId: string,
    profile: ProfileSummary,
    page: Page,
    depositAmount: string,
  ): Promise<void> {
    if (this.remoteAutomation) {
      try {
        await this.executeRemoteAutomation(
          runId,
          MANUAL_DEPOSIT_WORKFLOW_ID,
          this.database.getSystemAutomationForProfile(profile.id),
          profile,
          page,
          { depositAmount },
        );
        return;
      } catch (error) {
        if (!this.allowLocalAutomationFallback) {
          throw error;
        }
        this.log(
          runId,
          "warning",
          `Workflow remoto de deposito indisponivel em desenvolvimento; usando fluxo local: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await this.executeLocalManualDeposit(runId, profile, page, depositAmount);
  }

  private async executeLocalManualDeposit(
    runId: string,
    profile: ProfileSummary,
    page: Page,
    depositAmount: string,
  ): Promise<void> {
    const startUrl = profile.homeUrl.trim();
    if (!startUrl) {
      throw new Error("Perfil sem link inicial para executar deposito manual.");
    }

    const depositPage = await this.resolveDepositFlowPage(
      runId,
      page,
      profile,
      startUrl,
    );
    await this.browserRuntime.setPageAutoClosePopups(depositPage, false);
    await this.browserRuntime
      .clearLayoutViewportOverride(depositPage)
      .catch(() => undefined);

    try {
      await this.browserRuntime.setPageAutoClosePopups(depositPage, false);
      await this.ensurePlatformHomeLoaded(
        runId,
        depositPage,
        profile,
        startUrl,
      );
      await depositPage
        .waitForLoadState("networkidle", { timeout: 3000 })
        .catch(() => null);
      await this.normalizeRegistrationEntryPage(
        runId,
        depositPage,
        profile.name,
      ).catch(() => undefined);
      await waitForProfileSurface(depositPage, 6000).catch(() => false);

      this.ensureRunActive(runId);
      await this.fillDepositAmountAndGenerateQr(
        runId,
        depositPage,
        profile.name,
        depositAmount,
      );
      // Usa armQrOverlayObserverForManualDeposit que observa o DOM e aplica a overlay
      // quando o QR code aparece (mais robusto para depositos manuais)
      this.armQrOverlayObserverForManualDeposit(
        runId,
        depositPage,
        depositAmount,
      ).catch(() => undefined);
    } finally {
      await this.browserRuntime
        .clearLayoutViewportOverride(depositPage)
        .catch(() => undefined);
    }
  }

  private async executeWithdrawalPreparation(
    runId: string,
    profile: ProfileSummary,
    page: Page,
  ): Promise<void> {
    await this.executeLocalWithdrawalPreparation(runId, profile, page);
  }

  private async openWithdrawalViaRoute(
    runId: string,
    page: Page,
    profile: ProfileSummary,
    startUrl: string,
  ): Promise<PlatformDescriptor | undefined> {
    await this.browserRuntime
      .setPageAutoClosePopups(page, false)
      .catch(() => undefined);

    let spa = resolveContentFrame(page);
    this.ensureRunActive(runId);
    let routerReady = await waitForSpaRouter(spa, 5000);
    this.ensureRunActive(runId);

    if (!routerReady) {
      await this.ensurePlatformHomeLoaded(runId, page, profile, startUrl);
      spa = resolveContentFrame(page);
      this.ensureRunActive(runId);
      routerReady = await waitForSpaRouter(spa, 10000);
      this.ensureRunActive(runId);
    }

    if (!routerReady) {
      throw new Error("SPA sem router acessivel para abrir a tela de saque.");
    }

    await this.dismissPostRegistrationPopups(runId, page);
    const descriptor = await detectPlatformDescriptor(
      spa,
      page.url() || startUrl,
    );
    const withdrawalTarget = await resolveRouteTarget(
      spa,
      "withdrawal",
      descriptor,
    );
    if (!withdrawalTarget) {
      throw new Error(
        `nao consegui resolver a rota de saque (${await describeSpaState(spa)})`,
      );
    }

    this.ensureRunActive(runId);
    if (descriptor?.id === "777clube-outlier") {
      await this.selectOutlierWithdrawalRequestTab(
        runId,
        page,
        profile.name,
        1200,
      ).catch(() => undefined);
    }
    await routerPush(spa, withdrawalTarget);
    if (descriptor?.id === "777clube-outlier") {
      await this.selectOutlierWithdrawalRequestTab(
        runId,
        page,
        profile.name,
        5000,
      );
    } else {
      await waitForWithdrawalOrPasswordSignal(page, 8000);
    }
    return descriptor;
  }

  private async executeLocalWithdrawalPreparation(
    runId: string,
    profile: ProfileSummary,
    page: Page,
  ): Promise<void> {
    const startUrl = profile.homeUrl.trim();
    if (!startUrl) {
      throw new Error("Perfil sem link inicial para abrir saques.");
    }

    const withdrawalPage = await this.resolveDepositFlowPage(
      runId,
      page,
      profile,
      startUrl,
    );
    await this.browserRuntime.setPageAutoClosePopups(withdrawalPage, false);
    await this.ensurePlatformHomeLoaded(
      runId,
      withdrawalPage,
      profile,
      startUrl,
    );
    await withdrawalPage
      .waitForLoadState("networkidle", { timeout: 3000 })
      .catch(() => null);
    await this.normalizeRegistrationEntryPage(
      runId,
      withdrawalPage,
      profile.name,
    ).catch(() => undefined);
    await waitForProfileSurface(withdrawalPage, 6000).catch(() => false);

    this.ensureRunActive(runId);
    const descriptor = await this.openWithdrawalViaRoute(
      runId,
      withdrawalPage,
      profile,
      startUrl,
    );

    if (
      (await hasWithdrawalPasswordSetupSurface(withdrawalPage)) ||
      (await hasWithdrawalPasswordRequiredCallToAction(withdrawalPage))
    ) {
      throw new Error(
        "A senha de saque precisa ser configurada manualmente antes de usar esta acao.",
      );
    }

    if (!(await waitForWithdrawalRequestSurface(withdrawalPage, 5000))) {
      await this.clickVisibleTextControl(
        runId,
        withdrawalPage,
        /^solicitar saque$/,
        /conta para recebimento|registro de saques/,
      ).catch(() => undefined);
    }

    if (!(await waitForWithdrawalRequestSurface(withdrawalPage, 3500))) {
      throw new Error("formulario de solicitacao de saque nao ficou visivel");
    }

    this.log(
      runId,
      "info",
      `[${profile.name}] Tela de saques aberta; preenchendo valor e senha.`,
    );

    const amountPrepared =
      descriptor?.id === "777clube-outlier"
        ? await this.applyOutlierWithdrawalAllAmount(
            runId,
            withdrawalPage,
            profile.name,
          )
        : false;
    if (!amountPrepared) {
      await this.clickWithdrawalAllButton(runId, withdrawalPage, profile.name);
    }

    const withdrawalPassword = profile.account?.withdrawalPassword;
    if (withdrawalPassword) {
      const passwordPrepared =
        descriptor?.id === "777clube-outlier"
          ? await this.fillOutlierWithdrawalPasswordState(
              runId,
              withdrawalPage,
              withdrawalPassword,
              profile.name,
            )
          : false;
      if (!passwordPrepared) {
        await this.fillWithdrawalPasswordField(
          runId,
          withdrawalPage,
          withdrawalPassword,
          profile.name,
        );
      }
    } else {
      this.log(
        runId,
        "warning",
        `[${profile.name}] Senha de saque nao configurada no perfil; preenchimento manual necessario.`,
      );
    }

    this.log(
      runId,
      "success",
      `[${profile.name}] Valor e senha de saque preenchidos; confirmacao manual necessaria.`,
    );
  }

  private async selectOutlierWithdrawalRequestTab(
    runId: string,
    page: Page,
    _profileName: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      this.ensureRunActive(runId);
      const state = await resolveContentFrame(page)
        .evaluate(
          () => {
            type RuntimeVue = {
              $children?: RuntimeVue[];
              $forceUpdate?: () => void;
              $store?: {
                state?: { config?: { withdrawalsideWrapperIndex?: number } };
              };
            };
            type RuntimeElement = BrowserRuntimeElement & {
              __vue__?: RuntimeVue;
              __vue_app__?: {
                config?: {
                  globalProperties?: { $store?: RuntimeVue["$store"] };
                };
              };
            };
            const runtimeWindow =
              globalThis as unknown as BrowserRuntimeWindow & {
                changeWrapper?: (index: number, scrollMode?: number) => void;
                location: { pathname: string; search: string };
              };
            const normalize = (value: string | null | undefined) =>
              (value || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
            const seen = new Set<RuntimeVue>();
            const visitVm = (
              vm: RuntimeVue | undefined,
              list: RuntimeVue[],
            ) => {
              if (!vm || seen.has(vm)) return;
              seen.add(vm);
              list.push(vm);
              for (const child of vm.$children ?? []) visitVm(child, list);
            };
            const vms: RuntimeVue[] = [];
            for (const raw of runtimeWindow.document.querySelectorAll(
              "#withdrawal,#withdrawal *,body,body *",
            ) ?? []) {
              const element = raw as RuntimeElement;
              visitVm(element.__vue__, vms);
              const store =
                element.__vue_app__?.config?.globalProperties?.$store;
              if (store?.state?.config) {
                store.state.config.withdrawalsideWrapperIndex = 0;
              }
            }

            let storeSet = false;
            for (const vm of vms) {
              const config = vm.$store?.state?.config;
              if (config && "withdrawalsideWrapperIndex" in config) {
                config.withdrawalsideWrapperIndex = 0;
                vm.$forceUpdate?.();
                storeSet = true;
              }
            }

            let wrapperCalled = false;
            if (typeof runtimeWindow.changeWrapper === "function") {
              try {
                runtimeWindow.changeWrapper(0, 1);
                wrapperCalled = true;
              } catch {
                // Keep the store mutation above.
              }
            }

            let tabClicked = false;
            const tabs = Array.from(
              runtimeWindow.document.querySelectorAll(".van-tab,[role='tab']"),
            );
            const saqueTab = tabs.find((tab) => {
              const text = normalize(
                (tab as BrowserRuntimeElement).textContent,
              );
              return /^saque$|^solicitar saque$/.test(text);
            }) as BrowserRuntimeElement | undefined;
            if (saqueTab) {
              const activeTextBefore = normalize(
                Array.from(
                  runtimeWindow.document.querySelectorAll(
                    ".van-tab--active,[aria-selected='true']",
                  ),
                )
                  .map(
                    (element) =>
                      (element as BrowserRuntimeElement).textContent || "",
                  )
                  .join(" "),
              );
              if (!/^saque$|solicitar saque/.test(activeTextBefore)) {
                saqueTab.click?.();
                tabClicked = true;
              }
            }

            const activeText = normalize(
              Array.from(
                runtimeWindow.document.querySelectorAll(
                  ".van-tab--active,[aria-selected='true']",
                ),
              )
                .map(
                  (element) =>
                    (element as BrowserRuntimeElement).textContent || "",
                )
                .join(" "),
            );
            const bodyText = normalize(
              runtimeWindow.document.body?.innerText || "",
            );
            const routeText = normalize(
              `${runtimeWindow.location.pathname} ${runtimeWindow.location.search}`,
            );
            const hasOutlierRequestForm =
              /confirmar saque/.test(bodyText) &&
              /senha de saque|valor de retirada|valor do saque|retirada/.test(
                bodyText,
              );
            const requestTabActive =
              (/(^|\s)saque(\s|$)|solicitar saque/.test(activeText) &&
                !/registro|auditoria|conta|gerenciar/.test(activeText)) ||
              (hasOutlierRequestForm &&
                !/adicionar pix|adicionar conta para saque/.test(bodyText));
            const requestSurface =
              /withdrawal|withdraw|saque/.test(routeText) &&
              requestTabActive &&
              hasOutlierRequestForm;
            return {
              activeText,
              requestSurface,
              routeText,
              storeSet,
              tabClicked,
              wrapperCalled,
            };
          },
          undefined,
          PATCHRIGHT_MAIN_WORLD,
        )
        .catch(() => undefined);

      if (state?.requestSurface) {
        return true;
      }
      await page.waitForTimeout(180).catch(() => undefined);
    }

    return false;
  }

  private async applyOutlierWithdrawalAllAmount(
    runId: string,
    page: Page,
    _profileName: string,
  ): Promise<boolean> {
    const startedAt = Date.now();
    let lastAmount = "";

    while (Date.now() - startedAt < 3500) {
      this.ensureRunActive(runId);
      const result = await resolveContentFrame(page)
        .evaluate(
          () => {
            type RuntimeVue = {
              $children?: RuntimeVue[];
              $forceUpdate?: () => void;
              AllMoney?: () => void;
              inputche?: () => void;
              max?: number | string;
              UserMoney?: number | string;
              withdrawNumber?: number | string;
            };
            type RuntimeElement = BrowserRuntimeElement & {
              __vue__?: RuntimeVue;
            };
            const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
            const seen = new Set<RuntimeVue>();
            const visitVm = (
              vm: RuntimeVue | undefined,
              list: RuntimeVue[],
            ) => {
              if (!vm || seen.has(vm)) return;
              seen.add(vm);
              list.push(vm);
              for (const child of vm.$children ?? []) visitVm(child, list);
            };
            const vms: RuntimeVue[] = [];
            for (const raw of runtimeWindow.document.querySelectorAll(
              "#withdrawal,#withdrawal *,body,body *",
            ) ?? []) {
              visitVm((raw as RuntimeElement).__vue__, vms);
            }

            for (const vm of vms) {
              if (
                !("withdrawNumber" in vm) &&
                typeof vm.AllMoney !== "function"
              ) {
                continue;
              }
              if (typeof vm.AllMoney === "function") {
                vm.AllMoney();
              } else {
                const userMoney = Number(vm.UserMoney ?? 0);
                const max = Number(vm.max ?? 0);
                const amount =
                  max > 0 && userMoney > max ? max : Math.floor(userMoney);
                if (amount > 0) {
                  vm.withdrawNumber = String(amount);
                }
              }
              vm.inputche?.();
              vm.$forceUpdate?.();
              const amount = String(vm.withdrawNumber ?? "").replace(
                /[^\d.,-]/g,
                "",
              );
              if (amount && Number(amount.replace(",", ".")) > 0) {
                return { amount };
              }
            }

            return { amount: "" };
          },
          undefined,
          PATCHRIGHT_MAIN_WORLD,
        )
        .catch(() => undefined);

      lastAmount = result?.amount ?? "";
      if (lastAmount) {
        return true;
      }
      await page.waitForTimeout(180).catch(() => undefined);
    }

    return false;
  }

  private async fillOutlierWithdrawalPasswordState(
    runId: string,
    page: Page,
    withdrawalPassword: string,
    _profileName: string,
  ): Promise<boolean> {
    this.ensureRunActive(runId);
    const filled = await resolveContentFrame(page)
      .evaluate(
        (password) => {
          type RuntimeVue = {
            $children?: RuntimeVue[];
            $forceUpdate?: () => void;
            onInput1?: () => void;
            pwvalue1?: string;
            showKeyboard1?: boolean;
            whatspromptFlag1?: boolean;
            withdrawNumber?: number | string;
          };
          type RuntimeElement = BrowserRuntimeElement & {
            __vue__?: RuntimeVue;
          };
          const runtimeWindow =
            globalThis as unknown as BrowserRuntimeWindow & {
              InputEvent?: new (
                type: string,
                init?: { bubbles?: boolean; data?: string; inputType?: string },
              ) => unknown;
            };
          const seen = new Set<RuntimeVue>();
          const visitVm = (vm: RuntimeVue | undefined, list: RuntimeVue[]) => {
            if (!vm || seen.has(vm)) return;
            seen.add(vm);
            list.push(vm);
            for (const child of vm.$children ?? []) visitVm(child, list);
          };
          const vms: RuntimeVue[] = [];
          for (const raw of runtimeWindow.document.querySelectorAll(
            "#withdrawal,#withdrawal *,body,body *",
          ) ?? []) {
            visitVm((raw as RuntimeElement).__vue__, vms);
          }

          let vmSet = false;
          for (const vm of vms) {
            if (!("pwvalue1" in vm)) {
              continue;
            }
            vm.pwvalue1 = password;
            vm.whatspromptFlag1 = false;
            vm.showKeyboard1 = false;
            vm.onInput1?.();
            vm.$forceUpdate?.();
            vmSet = true;
          }

          const event = runtimeWindow.InputEvent
            ? new runtimeWindow.InputEvent("input", {
                bubbles: true,
                data: password,
                inputType: "insertText",
              })
            : new (runtimeWindow.Event as NonNullable<
                BrowserRuntimeWindow["Event"]
              >)("input", { bubbles: true });
          for (const rawInput of runtimeWindow.document.querySelectorAll(
            ".passwordInput input,.van-field__control,input[maxlength='6']",
          ) ?? []) {
            const input = rawInput as BrowserRuntimeInputElement;
            const type = (input.getAttribute?.("type") || "").toLowerCase();
            if (
              type &&
              type !== "number" &&
              type !== "tel" &&
              type !== "text" &&
              type !== "password"
            ) {
              continue;
            }
            input.value = password;
            input.dispatchEvent?.(event);
            if (runtimeWindow.Event) {
              input.dispatchEvent?.(
                new runtimeWindow.Event("change", { bubbles: true }),
              );
              input.dispatchEvent?.(
                new runtimeWindow.Event("blur", { bubbles: true }),
              );
            }
          }

          return vmSet;
        },
        withdrawalPassword,
        PATCHRIGHT_MAIN_WORLD,
      )
      .catch(() => false);

    if (filled) {
      return true;
    }

    return false;
  }

  private async clickWithdrawalAllButton(
    runId: string,
    page: Page,
    _profileName: string,
  ): Promise<void> {
    this.ensureRunActive(runId);
    const frame = resolveContentFrame(page);

    const clicked = await frame
      .evaluate(() => {
        const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const isVisible = (element: BrowserRuntimeElement) => {
          const rect = element.getBoundingClientRect();
          const style = runtimeWindow.getComputedStyle(element);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 8 &&
            rect.height > 8 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < runtimeWindow.innerWidth &&
            rect.top < runtimeWindow.innerHeight
          );
        };
        const allCandidates = Array.from(
          runtimeWindow.document.querySelectorAll(
            "button,[role='button'],span,div,li,a",
          ),
        )
          .filter(isVisible)
          .filter((element) => {
            const text = normalize(element.textContent);
            return text === "tudo" || text === "all";
          });
        if (allCandidates.length === 0) return false;
        const leafCandidate =
          allCandidates.find(
            (el) =>
              (el as unknown as { children?: unknown[] }).children?.length ===
              0,
          ) ?? allCandidates[allCandidates.length - 1];
        leafCandidate?.click?.();
        return true;
      })
      .catch(() => false);

    if (clicked) {
      await page.waitForTimeout(500).catch(() => undefined);
    }
  }

  private async fillWithdrawalPasswordField(
    runId: string,
    page: Page,
    withdrawalPassword: string,
    profileName: string,
  ): Promise<void> {
    this.ensureRunActive(runId);
    const frame = resolveContentFrame(page);

    const passwordFieldLocator = frame.locator(".ui-password-input").first();
    const fieldCount = await frame
      .locator(".ui-password-input")
      .count()
      .catch(() => 0);

    if (fieldCount === 0) {
      this.log(
        runId,
        "warning",
        `[${profileName}] Campo de senha de saque nao encontrado.`,
      );
      return;
    }

    await this.fillPasswordGrid(
      runId,
      page,
      passwordFieldLocator,
      withdrawalPassword,
      "withdrawal-pw",
    );
  }

  private async prepareDepositAfterSuccessfulRegistration(
    runId: string,
    page: Page,
    profile: ProfileSummary,
    startUrl: string,
    depositAmount: string,
  ): Promise<void> {
    if (this.remoteAutomation) {
      try {
        await this.executeRemoteAutomation(
          runId,
          POST_REGISTRATION_DEPOSIT_WORKFLOW_ID,
          this.database.getSystemAutomationForProfile(profile.id),
          profile,
          page,
          { depositAmount, startUrl },
        );
        return;
      } catch (error) {
        if (!this.allowLocalAutomationFallback) {
          throw error;
        }
        this.log(
          runId,
          "warning",
          `Workflow remoto de deposito pos-cadastro indisponivel em desenvolvimento; usando fluxo local: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await this.prepareLocalDepositAfterSuccessfulRegistration(
      runId,
      page,
      profile,
      startUrl,
      depositAmount,
    );
  }

  private async prepareLocalDepositAfterSuccessfulRegistration(
    runId: string,
    page: Page,
    profile: ProfileSummary,
    startUrl: string,
    depositAmount: string,
  ): Promise<void> {
    this.ensureRunActive(runId);
    const profileName = profile.name;
    const depositPage = await this.resolveDepositFlowPage(
      runId,
      page,
      profile,
      startUrl,
    );
    await this.browserRuntime.setPageAutoClosePopups(depositPage, false);

    this.ensureRunActive(runId);
    await this.dismissPostRegistrationPopups(runId, depositPage);
    // Depósito do bot é SEMPRE por injeção de estado (Pinia), com valor definido —
    // nunca por navegação até a área de perfil. O antigo ramo "abrir tela de depósito
    // via navegação" era um modo que o produto não expõe. Ver docs/adr/0002.
    await this.fillDepositAmountAndGenerateQr(
      runId,
      depositPage,
      profileName,
      depositAmount,
    );
    await this.applyDepositQrOverlay(
      runId,
      depositPage,
      profileName,
      depositAmount,
    );
  }

  async fillExistingWithdrawalPasswordModal(
    runId: string,
    page: Page,
    withdrawalPassword: string,
  ): Promise<void> {
    const frame = resolveContentFrame(page);

    const vanFields = frame.locator(".van-field__control");
    const vanCount = await vanFields.count().catch(() => 0);
    if (vanCount >= 1) {
      await frame.evaluate((pw) => {
        const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
        const inputs = Array.from(
          runtimeWindow.document.querySelectorAll(".van-field__control"),
        );
        const nativeSetter = Object.getOwnPropertyDescriptor(
          (
            runtimeWindow as unknown as {
              HTMLInputElement?: { prototype: object };
            }
          ).HTMLInputElement?.prototype ?? {},
          "value",
        )?.set as
          | ((this: BrowserRuntimeInputElement, value: string) => void)
          | undefined;
        const el = inputs[0];
        if (el) {
          const input = el as unknown as BrowserRuntimeInputElement;
          nativeSetter?.call(input, pw);
          if (input.value !== pw) {
            input.value = pw;
          }
          const RuntimeEvent = runtimeWindow.Event;
          if (RuntimeEvent) {
            input.dispatchEvent?.(new RuntimeEvent("input", { bubbles: true }));
            input.dispatchEvent?.(
              new RuntimeEvent("change", { bubbles: true }),
            );
          }
        }
      }, withdrawalPassword);
      await page.waitForTimeout(200).catch(() => null);
      const proximoBox = await frame
        .evaluate(() => {
          const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
          const normalize = (v: string | null | undefined) =>
            v?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
          const elements = Array.from(
            runtimeWindow.document.querySelectorAll(
              "div, span, button, [role='button']",
            ),
          );
          for (const el of elements) {
            if (!el) continue;
            const text = normalize(el.textContent);
            if (text !== "próximo" && text !== "proximo") continue;
            const style = runtimeWindow.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden")
              continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 40 || rect.height < 20) continue;
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
          }
          return undefined;
        })
        .catch(() => undefined);
      if (proximoBox) {
        let cx = proximoBox.x;
        let cy = proximoBox.y;
        if (frame !== page) {
          const iframeOffset = await page
            .evaluate(() => {
              const w = globalThis as unknown as BrowserRuntimeWindow;
              const iframes = Array.from(w.document.querySelectorAll("iframe"));
              if (!iframes[0]) return undefined;
              const r = iframes[0].getBoundingClientRect();
              return { x: r.left, y: r.top };
            })
            .catch(() => undefined);
          if (iframeOffset) {
            cx += iframeOffset.x;
            cy += iframeOffset.y;
          }
        }
        await page.touchscreen
          .tap(cx, cy)
          .catch(() => page.mouse.click(cx, cy).catch(() => undefined));
      } else {
        throw new Error(
          "botao Proximo da senha de saque nao encontrado (vant)",
        );
      }
      return;
    }

    const fields = frame.locator(
      ".ui-popup .ui-password-input,.ui-dialog .ui-password-input,.ui-password-input",
    );
    const count = await fields.count().catch(() => 0);
    if (count < 1) {
      throw new Error("campo de senha de saque nao encontrado no modal");
    }

    await this.fillPasswordGrid(runId, page, fields.nth(0), withdrawalPassword);
    const clicked = await this.clickVisibleTextControl(
      runId,
      page,
      /^proximo$/,
      /esqueceu|senha/,
    );
    if (!clicked) {
      throw new Error("botao Proximo da senha de saque nao encontrado");
    }
  }

  private async openPasswordGridKeyboard(
    runId: string,
    page: Page,
    locator: Locator,
  ): Promise<void> {
    this.ensureRunActive(runId);
    await this.waitActionable(locator, {
      budgetMs: AutomationRuntimeService.ACTIONABLE_BUDGET_MS,
      runId,
    });

    const token = `password-grid-${Date.now().toString(36)}-${this.randomInt(1000, 9999)}`;
    const childMarked = await locator
      .evaluate((element, marker) => {
        type RuntimeElement = BrowserRuntimeElement & {
          setAttribute?: (name: string, value: string) => void;
        };
        const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
        const root = element as unknown as RuntimeElement;
        const isVisible = (target: BrowserRuntimeElement) => {
          const rect = target.getBoundingClientRect();
          const style = runtimeWindow.getComputedStyle(target);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 8 &&
            rect.height > 8
          );
        };
        const candidates = Array.from(
          root.querySelectorAll?.(
            ".ui-password-input__item,li,input,[role='textbox'],[class*='password'][class*='item' i],[class*='password-input'][class*='item' i]",
          ) ?? [],
        )
          .filter(isVisible)
          .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            return (
              leftRect.top - rightRect.top || leftRect.left - rightRect.left
            );
          });
        const target = candidates[0];
        if (!target) {
          return false;
        }
        target.setAttribute?.("data-predator-password-grid-tap", marker);
        return true;
      }, token)
      .catch(() => false);

    const tapTarget = childMarked
      ? locator.locator(`[data-predator-password-grid-tap="${token}"]`).first()
      : locator;

    try {
      await tapTarget
        .evaluate((element) => {
          (
            element as unknown as {
              scrollIntoView?: (options?: {
                block?: string;
                inline?: string;
              }) => void;
            }
          ).scrollIntoView?.({
            block: "center",
            inline: "center",
          });
        })
        .catch(() => null);

      const box = await tapTarget.boundingBox().catch(() => null);
      if (box) {
        await page.touchscreen
          .tap(
            box.x + box.width * this.randomFloat(0.38, 0.62),
            box.y + box.height * this.randomFloat(0.35, 0.65),
          )
          .catch(() => null);
      } else {
        await tapTarget
          .tap({ timeout: AutomationRuntimeService.ACTION_PROBE_BUDGET_MS })
          .catch(() => null);
      }

      await page.waitForTimeout(180).catch(() => null);
      if (!(await hasVisibleNumberKeyboard(page))) {
        const rootBox = await locator.boundingBox().catch(() => null);
        if (rootBox) {
          await page.touchscreen
            .tap(
              rootBox.x + rootBox.width * 0.1,
              rootBox.y + rootBox.height * 0.5,
            )
            .catch(() => null);
        }
      }
    } finally {
      await locator
        .evaluate((element, marker) => {
          type RuntimeElement = BrowserRuntimeElement & {
            removeAttribute?: (name: string) => void;
          };
          const root = element as unknown as RuntimeElement;
          for (const target of root.querySelectorAll?.(
            `[data-predator-password-grid-tap="${marker}"]`,
          ) ?? []) {
            target.removeAttribute?.("data-predator-password-grid-tap");
          }
        }, token)
        .catch(() => null);
    }
  }

  private async fillPasswordGrid(
    runId: string,
    page: Page,
    locator: Locator,
    value: string,
    label?: string,
  ): Promise<void> {
    const diag = (...args: unknown[]) => {
      const msg = `[PASS-DIAG] ${args.join(" ")}`;
      console.log(msg);
    };
    const tag = label ?? "?";
    this.ensureRunActive(runId);

    await this.openPasswordGridKeyboard(runId, page, locator);
    await waitForVisibleNumberKeyboard(page, 2500);

    if (!(await hasVisibleNumberKeyboard(page))) {
      throw new Error(
        "teclado numerico virtual nao apareceu apos clicar no campo de senha",
      );
    }

    let dots = await this.countPasswordGridDots(locator);
    diag(`${tag} initialDots=${dots} password=${value}`);
    for (
      let clearAttempt = 0;
      clearAttempt < 3 && dots > 0;
      clearAttempt += 1
    ) {
      diag(`${tag} clearing ${dots} dots attempt=${clearAttempt}`);
      for (let i = 0; i < dots; i += 1) {
        const beforeDelete = await this.countPasswordGridDots(locator);
        if (beforeDelete <= 0) break;
        // tap real so como ultimo recurso (a partir da 2a tentativa de limpeza)
        await this.clickNumberKeyboardDelete(runId, page, clearAttempt >= 2);
        // espera CONDICIONAL: o dot some (count cai) em vez de um waitForTimeout fixo
        await this.waitForDotCount(page, locator, (d) => d < beforeDelete, 600);
      }
      dots = await this.countPasswordGridDots(locator);
      diag(`${tag} afterClear attempt=${clearAttempt} dots=${dots}`);
    }

    for (let di = 0; di < value.length; di += 1) {
      const digit = value[di]!;
      this.ensureRunActive(runId);
      const beforeDots = await this.countPasswordGridDots(locator);
      diag(`${tag} digit=${digit} idx=${di} beforeDots=${beforeDots}`);
      let accepted = false;
      for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
        if (!(await hasVisibleNumberKeyboard(page))) {
          diag(`${tag} keyboard hidden, re-clicking`);
          await this.openPasswordGridKeyboard(runId, page, locator);
          await waitForVisibleNumberKeyboard(page, 600);
        }
        // Mantem o dispatch SINTETICO como primario nas 2 primeiras tentativas; so cai no
        // tap real por coordenada na ultima (attempt 2), como ultimo recurso -- o tap e o
        // que falhava em PC fraco, entao adiamos ao maximo.
        const clicked = await this.clickNumberKeyboardDigit(
          runId,
          page,
          digit,
          attempt >= 2,
        );
        if (!clicked) {
          // tecla nao encontrada -> espera CONDICIONAL o teclado (re)aparecer, sem wait fixo
          await waitForVisibleNumberKeyboard(page, 400);
          continue;
        }
        const expectedDots = Math.min(beforeDots + 1, 6);
        const startedAt = Date.now();
        let lastDots = beforeDots;
        while (Date.now() - startedAt < 700) {
          const afterDots = await this.countPasswordGridDots(locator);
          if (afterDots >= expectedDots) {
            diag(
              `${tag} digit=${digit} accepted afterDots=${afterDots} ms=${Date.now() - startedAt}`,
            );
            accepted = true;
            break;
          }
          if (afterDots !== lastDots) {
            diag(`${tag} digit=${digit} dotsChanged ${lastDots}->${afterDots}`);
            lastDots = afterDots;
          }
          await page.waitForTimeout(80).catch(() => null);
        }
        if (!accepted) {
          const finalDots = await this.countPasswordGridDots(locator);
          diag(
            `${tag} digit=${digit} TIMEOUT attempt=${attempt} beforeDots=${beforeDots} afterDots=${finalDots}`,
          );
        }
      }

      if (!accepted) {
        throw new Error(
          `tecla numerica ${digit} nao foi aceita pelo teclado virtual`,
        );
      }
      await this.humanPause(runId, page, 25, 70);
    }

    const filledCount = await this.countPasswordGridDots(locator);
    diag(
      `${tag} finalDots=${filledCount} expected=${Math.min(value.length, 6)}`,
    );
    if (filledCount < Math.min(value.length, 6)) {
      throw new Error("teclado numerico nao preencheu a senha de saque");
    }
  }

  // PROBE READ-ONLY (gated por env SPIDER_PIN_PROBE=1): descobre a ALAVANCA por tras do
  // PIN-grid W1 da senha de saque, para migrarmos do teclado virtual (clique tecla-a-tecla,
  // que falha em PC fraco) para escrita direta no estado -- mesmo playbook do deposito
  // (dispatch Pinia). RODA NO MAIN WORLD (PATCHRIGHT_MAIN_WORLD): Pinia/__vue_app__ NAO sao
  // visiveis no mundo isolado do stealth (1a tentativa do probe veio vazia por isso). Reusa
  // a MESMA descoberta de Pinia do programmaticDeposit e despeja, em JSON no log [PIN-PROBE]:
  // ids de todas as stores + (para as candidatas a senha/saque) chaves de estado, valores
  // truncados e nomes de actions. NAO altera nada. Rodar 1 cadastro real que alcance a senha
  // de saque e colar o log [PIN-PROBE] (so abre o teclado, efeito ja existente no fluxo).
  private async dumpWithdrawalPinLever(
    runId: string,
    page: Page,
    fieldLocator: Locator,
  ): Promise<void> {
    // Abre o teclado primeiro para que a tecla exista no DOM no momento da inspecao.
    await this.openPasswordGridKeyboard(runId, page, fieldLocator).catch(
      () => null,
    );
    await page.waitForTimeout(200).catch(() => null);

    const frame = resolveContentFrame(page);
    const dump = await frame
      .evaluate(
        () => {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const w = globalThis as any;
          const doc = w.document;
          const isObj = (v: unknown): v is Record<PropertyKey, unknown> =>
            Boolean(v) && (typeof v === "object" || typeof v === "function");
          const read = (t: unknown, k: PropertyKey): unknown => {
            if (!isObj(t)) return undefined;
            try {
              return (t as any)[k];
            } catch {
              return undefined;
            }
          };
          const trunc = (value: unknown, max = 80): string => {
            try {
              const s =
                typeof value === "string" ? value : JSON.stringify(value);
              if (s == null) return String(value);
              return s.length > max ? `${s.slice(0, max)}…` : s;
            } catch {
              return Object.prototype.toString.call(value);
            }
          };

          const result: Record<string, unknown> = {};
          const pin = doc.querySelector(
            ".ui-password-input,[class*='password-input' i],[class*='pin-input' i]",
          );
          result.hasPin = !!pin;

          // Input oculto vizinho? (ja confirmado vazio, mas mantemos o sinal)
          const scope =
            (pin &&
              pin.closest(
                "[class*='dialog' i],[class*='popup' i],.ui-overlay",
              )) ||
            doc;
          result.nearbyInputs = Array.from(scope.querySelectorAll("input")).map(
            (input: any) => ({
              type: input.type,
              name: input.name,
              cls: trunc(input.className, 40),
              value: trunc(input.value, 20),
            }),
          );

          // === Pinia (MESMA descoberta de programmaticDeposit) — roda no MAIN world ===
          const els = Array.from(doc.querySelectorAll("body, body *")) as any[];
          const piniaCandidates: unknown[] = [];
          const seen = new Set<unknown>();
          const addPinia = (value: unknown) => {
            if (!isObj(value) || seen.has(value)) return;
            seen.add(value);
            piniaCandidates.push(value);
          };
          const addProvidesPinia = (provides: unknown) => {
            if (!isObj(provides)) return;
            for (const key of Reflect.ownKeys(provides)) {
              if (String(key).toLowerCase().includes("pinia"))
                addPinia(read(provides, key));
            }
          };
          const addAppPinia = (appLike: unknown) => {
            if (!isObj(appLike)) return;
            addPinia(
              read(read(read(appLike, "config"), "globalProperties"), "$pinia"),
            );
            const ctx = read(appLike, "_context");
            addPinia(
              read(read(read(ctx, "config"), "globalProperties"), "$pinia"),
            );
            addProvidesPinia(read(ctx, "provides"));
            addProvidesPinia(read(appLike, "provides"));
          };
          for (const el of els) {
            addAppPinia(el.__vue_app__);
            const component = el.__vueParentComponent;
            if (isObj(component)) addAppPinia(read(component, "appContext"));
          }
          let stores: Map<string, any> | undefined;
          for (const candidate of piniaCandidates) {
            const s = read(candidate, "_s") as Map<string, any> | undefined;
            if (
              s &&
              typeof s.forEach === "function" &&
              (!stores || s.size > stores.size)
            )
              stores = s;
          }
          result.piniaFound = Boolean(stores);

          if (stores) {
            // Resumo de UMA store: chaves de estado (+valores truncados) e nomes de
            // actions/funcoes expostas (candidatas a "setar senha" / "submit").
            const dumpStore = (store: any) => {
              const state =
                (read(store, "$state") as Record<string, unknown>) || {};
              const stateOut: Record<string, string> = {};
              for (const k of Object.keys(state)) {
                try {
                  stateOut[k] = trunc((state as any)[k]);
                } catch {
                  stateOut[k] = "(err)";
                }
              }
              const fns: string[] = [];
              try {
                for (const k of Object.keys(store)) {
                  if (k.startsWith("$") || k.startsWith("_")) continue;
                  try {
                    if (typeof store[k] === "function") fns.push(k);
                  } catch {
                    /* getter pode lancar */
                  }
                }
              } catch {
                /* store nao iteravel */
              }
              return {
                stateKeys: Object.keys(state),
                state: stateOut,
                actions: fns.slice(0, 50),
              };
            };

            const allIds: string[] = [];
            const passwordLike: Record<string, unknown> = {};
            // Inclusao por ID (narrow): so stores cujo NOME denota senha/saque/seguranca.
            // (Heuristica por action 'set/submit' pegava quase toda store -> ruido.) Para
            // as candidatas, despejamos detalhe completo; das demais, so o nome em storeIds.
            const idRx = /pass|pwd|pin|withdraw|saque|secur|draw|cash|safe/i;
            stores.forEach((store, id) => {
              allIds.push(id);
              if (!idRx.test(id)) return;
              try {
                passwordLike[id] = dumpStore(store);
              } catch {
                passwordLike[id] = {
                  stateKeys: ["(err)"],
                  state: {},
                  actions: [],
                };
              }
            });
            result.storeIds = allIds;
            result.passwordLikeStores = passwordLike;
          }

          // === Instance Vue do COMPONENTE do PIN e de uma TECLA (main world) ===
          // O submit valida o modelo LOCAL do componente, nao a store -> precisamos achar a
          // ref/metodo que o teclado alimenta. __vueParentComponent fica no host element.
          const describeVals = (obj: any): Record<string, string> => {
            const o: Record<string, string> = {};
            if (!isObj(obj)) return o;
            for (const k of Object.keys(obj)) {
              try {
                const r = (obj as any)[k];
                const u =
                  isObj(r) && "value" in r && Object.keys(r).length <= 4
                    ? (r as any).value
                    : r;
                o[k] = typeof u === "function" ? "fn()" : trunc(u, 60);
              } catch {
                o[k] = "(err)";
              }
            }
            return o;
          };
          const dumpInst = (startEl: any, maxHops: number): unknown[] => {
            const chain: unknown[] = [];
            const seenInst = new Set<unknown>();
            let node: any = startEl;
            let hops = 0;
            while (node && hops < maxHops) {
              const inst: any = node.__vueParentComponent;
              if (isObj(inst) && !seenInst.has(inst)) {
                seenInst.add(inst);
                const ss = read(inst, "setupState");
                const ctx = read(inst, "ctx");
                const vnode = read(inst, "vnode");
                chain.push({
                  name:
                    read(read(inst, "type"), "__name") ||
                    read(read(inst, "type"), "name") ||
                    "(anon)",
                  setupKeys: isObj(ss) ? Object.keys(ss as object) : [],
                  setup: describeVals(ss),
                  props: describeVals(read(inst, "props")),
                  methods: isObj(ctx)
                    ? Object.keys(ctx as object)
                        .filter((k) => {
                          try {
                            return typeof (ctx as any)[k] === "function";
                          } catch {
                            return false;
                          }
                        })
                        .slice(0, 40)
                    : [],
                  vnodeProps: isObj(read(vnode, "props"))
                    ? Object.keys(read(vnode, "props") as object)
                    : [],
                });
              }
              node = node.parentElement;
              hops += 1;
            }
            return chain.slice(0, 5);
          };
          const pinEl: any = doc.querySelector(".ui-password-input");
          result.pinHasVueParentComponent = !!(
            pinEl && pinEl.__vueParentComponent
          );
          result.pinComponent = pinEl ? dumpInst(pinEl, 8) : null;
          const keyEl2: any = doc.querySelector(
            ".ui-number-keyboard-key,.van-key,[class*='keyboard-key' i]",
          );
          result.keyboardComponent = keyEl2 ? dumpInst(keyEl2, 6) : null;

          return result;
          /* eslint-enable @typescript-eslint/no-explicit-any */
        },
        undefined,
        PATCHRIGHT_MAIN_WORLD,
      )
      .catch((error: unknown) => ({ error: String(error) }));

    // Grava o dump COMPLETO em disco e imprime so um resumo de 1 linha no log (o dump
    // inteiro estourava o terminal). O arquivo e lido fora de banda (Read/grep), sem
    // poluir o log nem custar tokens.
    const filePath = joinPath(tmpdir(), "spider-pin-probe.json");
    const summary: Record<string, unknown> = {};
    if (dump && typeof dump === "object") {
      const d = dump as Record<string, unknown>;
      summary.piniaFound = d.piniaFound ?? false;
      summary.storeCount = Array.isArray(d.storeIds) ? d.storeIds.length : 0;
      summary.matched = d.passwordLikeStores
        ? Object.keys(d.passwordLikeStores as object)
        : [];
      summary.pinVPC = d.pinHasVueParentComponent ?? false;
      summary.pinCompCount = Array.isArray(d.pinComponent)
        ? d.pinComponent.length
        : 0;
      if (d.error) summary.error = d.error;
    }
    try {
      writeFileSync(filePath, JSON.stringify(dump, null, 2), "utf-8");
      console.log(`[PIN-PROBE] file=${filePath} ${JSON.stringify(summary)}`);
    } catch (error) {
      console.log(
        `[PIN-PROBE] falha ao gravar arquivo: ${String(error)} resumo=${JSON.stringify(summary)}`,
      );
    }
  }

  async fillWithdrawalPasswordSetup(
    runId: string,
    page: Page,
    withdrawalPassword: string,
  ): Promise<void> {
    const diag = (...args: unknown[]) => {
      const msg = `[PASS-DIAG] ${args.join(" ")}`;
      console.log(msg);
    };
    const frame = resolveContentFrame(page);

    const vanFields = frame.locator(".van-field__control");
    const vanCount = await vanFields.count().catch(() => 0);
    diag(`SETUP vanFields=${vanCount}`);

    if (vanCount >= 2) {
      diag(
        `SETUP vant variant, filling textboxes with password=${withdrawalPassword}`,
      );
      await frame.evaluate((pw) => {
        const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
        const inputs = Array.from(
          runtimeWindow.document.querySelectorAll(".van-field__control"),
        );
        const nativeSetter = Object.getOwnPropertyDescriptor(
          (
            runtimeWindow as unknown as {
              HTMLInputElement?: { prototype: object };
            }
          ).HTMLInputElement?.prototype ?? {},
          "value",
        )?.set as
          | ((this: BrowserRuntimeInputElement, value: string) => void)
          | undefined;
        for (let i = 0; i < Math.min(inputs.length, 2); i += 1) {
          const el = inputs[i];
          if (!el) continue;
          const input = el as unknown as BrowserRuntimeInputElement;
          nativeSetter?.call(input, pw);
          if (input.value !== pw) {
            input.value = pw;
          }
          const RuntimeEvent = runtimeWindow.Event;
          if (RuntimeEvent) {
            input.dispatchEvent?.(new RuntimeEvent("input", { bubbles: true }));
            input.dispatchEvent?.(
              new RuntimeEvent("change", { bubbles: true }),
            );
          }
        }
      }, withdrawalPassword);
      await page.waitForTimeout(300).catch(() => null);

      const confirmBox = await frame
        .evaluate(() => {
          const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
          const normalize = (v: string | null | undefined) =>
            v?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
          const elements = Array.from(
            runtimeWindow.document.querySelectorAll(
              "div, span, button, [role='button']",
            ),
          );
          for (const el of elements) {
            if (!el) continue;
            if (normalize(el.textContent) !== "confirmar") continue;
            const style = runtimeWindow.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden")
              continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 40 || rect.height < 20) continue;
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
          }
          return undefined;
        })
        .catch(() => undefined);

      diag(`SETUP confirmBox: ${JSON.stringify(confirmBox)}`);

      if (confirmBox) {
        let cx = confirmBox.x;
        let cy = confirmBox.y;
        if (frame !== page) {
          const iframeOffset = await page
            .evaluate(() => {
              const w = globalThis as unknown as BrowserRuntimeWindow;
              const iframes = Array.from(w.document.querySelectorAll("iframe"));
              if (!iframes[0]) return undefined;
              const r = iframes[0].getBoundingClientRect();
              return { x: r.left, y: r.top };
            })
            .catch(() => undefined);
          if (iframeOffset) {
            cx += iframeOffset.x;
            cy += iframeOffset.y;
          }
        }
        await page.touchscreen
          .tap(cx, cy)
          .catch(() => page.mouse.click(cx, cy).catch(() => undefined));
        diag("SETUP confirmar tapped");
      } else {
        throw new Error(
          "botao Confirmar da senha de saque nao encontrado (vant)",
        );
      }
      return;
    }

    const fields = frame.locator(".ui-password-input");
    const count = await fields.count().catch(() => 0);
    diag(`SETUP fieldsFound=${count} password=${withdrawalPassword}`);
    if (count < 2) {
      throw new Error("campos para criar senha de saque nao encontrados");
    }

    // NB: a escrita direta na store Pinia `security` foi DESCARTADA (testada em runtime):
    // o componente do PIN tem modelo LOCAL proprio e o "Confirmar" valida esse modelo, nao a
    // store -> setar a store nao move os dots nem deixa submeter. O teclado e preenchido pelo
    // fillPasswordGrid, agora via dispatch SINTETICO in-page (sem tap por coordenada) -> ver
    // clickNumberKeyboardKey. Isso e o que robustece em PC fraco.

    // PROBE opcional de diagnostico (SPIDER_PIN_PROBE=1): despeja a estrutura por tras do PIN.
    if (process.env.SPIDER_PIN_PROBE === "1") {
      await this.dumpWithdrawalPinLever(runId, page, fields.nth(0)).catch(
        () => null,
      );
    }

    diag("SETUP filling field[0]");
    await this.fillPasswordGrid(
      runId,
      page,
      fields.nth(0),
      withdrawalPassword,
      "F0",
    );
    await page.waitForTimeout(200).catch(() => null);

    const dots0Before = await this.countPasswordGridDots(fields.nth(0));
    const dots1Before = await this.countPasswordGridDots(fields.nth(1));
    diag(`SETUP after F0: field0=${dots0Before} field1=${dots1Before}`);

    diag("SETUP filling field[1]");
    await this.fillPasswordGrid(
      runId,
      page,
      fields.nth(1),
      withdrawalPassword,
      "F1",
    );
    await page.waitForTimeout(200).catch(() => null);

    const dots0 = await this.countPasswordGridDots(fields.nth(0));
    const dots1 = await this.countPasswordGridDots(fields.nth(1));
    diag(`SETUP after F1: field0=${dots0} field1=${dots1}`);

    if (dots0 !== dots1 || dots0 < withdrawalPassword.length) {
      diag(
        `SETUP MISMATCH field0=${dots0} field1=${dots1} expected=${withdrawalPassword.length} RETRYING`,
      );
      for (let retry = 0; retry < 2; retry += 1) {
        diag(`SETUP retry=${retry} filling field[0]`);
        await this.fillPasswordGrid(
          runId,
          page,
          fields.nth(0),
          withdrawalPassword,
          `R${retry}F0`,
        );
        await page.waitForTimeout(200).catch(() => null);
        diag(`SETUP retry=${retry} filling field[1]`);
        await this.fillPasswordGrid(
          runId,
          page,
          fields.nth(1),
          withdrawalPassword,
          `R${retry}F1`,
        );
        await page.waitForTimeout(200).catch(() => null);
        const rd0 = await this.countPasswordGridDots(fields.nth(0));
        const rd1 = await this.countPasswordGridDots(fields.nth(1));
        diag(`SETUP retry=${retry} result: field0=${rd0} field1=${rd1}`);
        if (rd0 === rd1 && rd0 >= withdrawalPassword.length) {
          diag(`SETUP retry=${retry} CONSISTENT`);
          break;
        }
      }
    }

    const finalDots0 = await this.countPasswordGridDots(fields.nth(0));
    const finalDots1 = await this.countPasswordGridDots(fields.nth(1));
    diag(
      `SETUP final: field0=${finalDots0} field1=${finalDots1} password=${withdrawalPassword}`,
    );

    const clicked = await this.tapVisibleTextControl(
      runId,
      page,
      /^confirmar$/,
      /cancelar|saque$/,
    );
    diag(`SETUP confirmar tapped=${clicked ?? "none"}`);
    if (!clicked) {
      throw new Error("botao Confirmar da senha de saque nao encontrado");
    }
  }

  private async clickNumberKeyboardDigit(
    runId: string,
    page: Page,
    digit: string,
    useTap = false,
  ): Promise<boolean> {
    return this.clickNumberKeyboardKey(runId, page, { digit }, useTap);
  }

  private async clickNumberKeyboardDelete(
    runId: string,
    page: Page,
    useTap = false,
  ): Promise<boolean> {
    return this.clickNumberKeyboardKey(runId, page, { delete: true }, useTap);
  }

  private async clickNumberKeyboardKey(
    runId: string,
    page: Page,
    targetKey: { delete?: boolean; digit?: string },
    useTap = false,
  ): Promise<boolean> {
    this.ensureRunActive(runId);
    const frame = resolveContentFrame(page);

    // CAMINHO PRIMARIO (robusto em PC fraco): acha a tecla e dispara o clique IN-PAGE
    // (sequencia pointer/mouse/touch/click) no MAIN world. Confirmado funcionando na
    // plataforma real (um dot aparece). Sem round-trip do Playwright por digito, sem hit-test
    // por coordenada, sem esperas fixas -- que eram a causa das falhas em PC fraco/sob carga.
    // Se a tecla nao for encontrada in-page, cai no tap real (fallback) abaixo.
    if (!useTap) {
      const dispatched = await frame
        .evaluate(
          ({ targetDigit, wantsDelete }) => {
            const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
            const ctor = runtimeWindow as unknown as {
              PointerEvent?: new (
                type: string,
                init?: Record<string, unknown>,
              ) => Event;
              MouseEvent?: new (
                type: string,
                init?: Record<string, unknown>,
              ) => Event;
              Touch?: new (init: Record<string, unknown>) => unknown;
              TouchEvent?: new (
                type: string,
                init?: Record<string, unknown>,
              ) => Event;
            };
            const normalize = (value: string | null | undefined) =>
              (value || "").replace(/\s+/g, " ").trim().toLowerCase();
            const isVisible = (element: BrowserRuntimeElement) => {
              const rect = element.getBoundingClientRect();
              const style = runtimeWindow.getComputedStyle(element);
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity || "1") > 0.01 &&
                rect.width >= 12 &&
                rect.height >= 12 &&
                rect.right > 0 &&
                rect.bottom > 0 &&
                rect.left < runtimeWindow.innerWidth &&
                rect.top < runtimeWindow.innerHeight
              );
            };
            const keyboardRoots = Array.from(
              runtimeWindow.document.querySelectorAll(
                ".ui-number-keyboard,.van-number-keyboard,[class*='number-keyboard' i],[class*='numberKeyboard' i]",
              ),
            ).filter(isVisible);
            const rootKeys = keyboardRoots.flatMap((root) =>
              Array.from(
                root.querySelectorAll?.(
                  "button,[role='button'],div,span,li,.ui-number-keyboard-key,.van-key",
                ) ?? [],
              ),
            );
            const directKeys = Array.from(
              runtimeWindow.document.querySelectorAll(
                ".ui-number-keyboard-key,.van-key,[class*='number-keyboard-key' i],[class*='keyboard-key' i],[class*='keyboard_key' i]",
              ),
            );
            const keys = Array.from(new Set([...directKeys, ...rootKeys]));
            let target: BrowserRuntimeElement | null = null;
            for (let i = 0; i < keys.length; i += 1) {
              const el = keys[i];
              if (!el || !isVisible(el)) continue;
              const cls = String(el.className || "").toLowerCase();
              const text = normalize(el.textContent);
              const isDelete =
                cls.includes("delete") ||
                cls.includes("backspace") ||
                /delete|backspace|apagar|⌫|←/.test(text);
              if (wantsDelete) {
                if (!isDelete) continue;
              } else {
                if (isDelete || cls.includes("extra")) continue;
                if (text !== targetDigit) continue;
              }
              target = el;
              break;
            }
            if (!target) return false;
            const node = target as unknown as {
              dispatchEvent: (event: Event) => boolean;
              click?: () => void;
            };
            const opts: Record<string, unknown> = {
              bubbles: true,
              cancelable: true,
              view: runtimeWindow,
            };
            const fire = (
              type: string,
              Ctor?: new (
                type: string,
                init?: Record<string, unknown>,
              ) => Event,
            ) => {
              try {
                if (Ctor) node.dispatchEvent(new Ctor(type, opts));
              } catch {
                /* construtor ausente; ignora */
              }
            };
            fire("pointerdown", ctor.PointerEvent);
            fire("mousedown", ctor.MouseEvent);
            try {
              if (ctor.Touch && ctor.TouchEvent) {
                const touch = new ctor.Touch({
                  identifier: 1,
                  target,
                  clientX: 1,
                  clientY: 1,
                });
                node.dispatchEvent(
                  new ctor.TouchEvent("touchstart", {
                    bubbles: true,
                    cancelable: true,
                    touches: [touch],
                    targetTouches: [touch],
                    changedTouches: [touch],
                  }),
                );
                node.dispatchEvent(
                  new ctor.TouchEvent("touchend", {
                    bubbles: true,
                    cancelable: true,
                    touches: [],
                    targetTouches: [],
                    changedTouches: [touch],
                  }),
                );
              }
            } catch {
              /* touch indisponivel; os eventos de mouse/click cobrem */
            }
            fire("pointerup", ctor.PointerEvent);
            fire("mouseup", ctor.MouseEvent);
            fire("click", ctor.MouseEvent);
            try {
              node.click?.();
            } catch {
              /* ignore */
            }
            return true;
          },
          {
            targetDigit: targetKey.digit ?? "",
            wantsDelete: Boolean(targetKey.delete),
          },
          PATCHRIGHT_MAIN_WORLD,
        )
        .catch(() => false);
      if (dispatched) return true;
      // tecla nao encontrada in-page -> tenta o tap real abaixo
    }

    const token = `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const found = await frame
      .evaluate(
        ({ targetDigit, token, wantsDelete }) => {
          const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
          const normalize = (value: string | null | undefined) =>
            (value || "").replace(/\s+/g, " ").trim().toLowerCase();
          const isVisible = (element: BrowserRuntimeElement) => {
            const rect = element.getBoundingClientRect();
            const style = runtimeWindow.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width >= 12 &&
              rect.height >= 12 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const keyboardRoots = Array.from(
            runtimeWindow.document.querySelectorAll(
              ".ui-number-keyboard,.van-number-keyboard,[class*='number-keyboard' i],[class*='numberKeyboard' i]",
            ),
          ).filter(isVisible);
          const rootKeys = keyboardRoots.flatMap((root) =>
            Array.from(
              root.querySelectorAll?.(
                "button,[role='button'],div,span,li,.ui-number-keyboard-key,.van-key",
              ) ?? [],
            ),
          );
          const directKeys = Array.from(
            runtimeWindow.document.querySelectorAll(
              ".ui-number-keyboard-key,.van-key,[class*='number-keyboard-key' i],[class*='keyboard-key' i],[class*='keyboard_key' i]",
            ),
          );
          const keys = Array.from(new Set([...directKeys, ...rootKeys]));
          for (let i = 0; i < keys.length; i += 1) {
            const el = keys[i];
            if (!el) continue;
            if (!isVisible(el)) continue;
            const cls = String(el.className || "").toLowerCase();
            const text = normalize(el.textContent);
            const isDelete =
              cls.includes("delete") ||
              cls.includes("backspace") ||
              /delete|backspace|apagar|⌫|←/.test(text);
            if (wantsDelete) {
              if (!isDelete) continue;
            } else {
              if (isDelete || cls.includes("extra")) continue;
              if (text !== targetDigit) continue;
            }
            el.setAttribute?.("data-predator-kb-tap", token);
            return true;
          }
          return false;
        },
        {
          targetDigit: targetKey.digit ?? "",
          token,
          wantsDelete: Boolean(targetKey.delete),
        },
      )
      .catch(() => false);

    if (!found) return false;

    try {
      const target = frame.locator(`[data-predator-kb-tap="${token}"]`).first();
      await target
        .evaluate((element) => {
          (
            element as unknown as {
              scrollIntoView?: (options?: {
                block?: string;
                inline?: string;
              }) => void;
            }
          ).scrollIntoView?.({
            block: "center",
            inline: "center",
          });
        })
        .catch(() => null);
      const box = await target.boundingBox().catch(() => null);
      if (box) {
        await page.touchscreen.tap(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
      } else {
        await target.tap({
          timeout: AutomationRuntimeService.ACTION_PROBE_BUDGET_MS,
        });
      }
      return true;
    } catch {
      return false;
    } finally {
      frame
        .evaluate((tok) => {
          const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
          const el = Array.from(
            runtimeWindow.document.querySelectorAll(
              `[data-predator-kb-tap="${tok}"]`,
            ),
          )[0];
          el?.removeAttribute?.("data-predator-kb-tap");
        }, token)
        .catch(() => undefined);
    }
  }

  // Espera CONDICIONAL pela contagem de dots do PIN-grid (substitui waitForTimeout fixos
  // na digitacao tecla-a-tecla). Em PC fraco a UI demora para refletir; antes esperavamos
  // um tempo fixo e seguiamos no escuro -> aqui poll-amos ate o predicado bater ou estourar.
  private async waitForDotCount(
    page: Page,
    locator: Locator,
    predicate: (dots: number) => boolean,
    timeoutMs: number,
  ): Promise<number> {
    const startedAt = Date.now();
    let dots = await this.countPasswordGridDots(locator);
    while (!predicate(dots) && Date.now() - startedAt < timeoutMs) {
      await page.waitForTimeout(40).catch(() => null);
      dots = await this.countPasswordGridDots(locator);
    }
    return dots;
  }

  private async countPasswordGridDots(locator: Locator): Promise<number> {
    return locator
      .evaluate((element) => {
        type RuntimeElement = {
          querySelectorAll?: (
            selector: string,
          ) => Iterable<BrowserRuntimeElement>;
        };
        const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
        const root = element as unknown as RuntimeElement;
        return Array.from(root.querySelectorAll?.("i") ?? []).filter(
          (entry) =>
            runtimeWindow.getComputedStyle(entry).visibility !== "hidden",
        ).length;
      })
      .catch(() => 0);
  }

  private async clickVisibleTextControl(
    runId: string,
    page: Page,
    include: RegExp,
    exclude?: RegExp,
  ): Promise<string | undefined> {
    this.ensureRunActive(runId);
    return this.withPopupPageGuard(page, () =>
      resolveContentFrame(page).evaluate(
        ({ includeSource, includeFlags, excludeSource, excludeFlags }) => {
          const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
          const includePattern = new RegExp(includeSource, includeFlags);
          const excludePattern = excludeSource
            ? new RegExp(excludeSource, excludeFlags)
            : undefined;
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const readAttrs = (element: BrowserRuntimeElement) =>
            normalize(
              [
                element.getAttribute?.("id"),
                element.getAttribute?.("class"),
                element.getAttribute?.("aria-label"),
                element.getAttribute?.("title"),
                element.getAttribute?.("placeholder"),
              ].join(" "),
            );
          const isVisible = (element: BrowserRuntimeElement) => {
            const rect = element.getBoundingClientRect();
            const style = runtimeWindow.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const candidates = Array.from(
            runtimeWindow.document.querySelectorAll(
              "button,[role='button'],a,[role='tab'],.ui-tab,div,span,li",
            ),
          )
            .filter(isVisible)
            .map((element) => {
              const text = normalize(element.textContent);
              const attrs = readAttrs(element);
              const combined = `${text} ${attrs}`;
              const rect = element.getBoundingClientRect();
              const exactText = includePattern.test(text);
              return {
                element,
                label: text || attrs,
                score:
                  (exactText ? 100 : includePattern.test(combined) ? 60 : 0) +
                  (/button|tab|ui-button|ui-cell/.test(attrs) ? 18 : 0) +
                  (rect.left >= 0 ? 8 : 0) -
                  (excludePattern && excludePattern.test(combined) ? 200 : 0),
                area: rect.width * rect.height,
              };
            })
            .filter((candidate) => candidate.score > 0)
            .sort((a, b) => b.score - a.score || a.area - b.area);

          const target = candidates[0];
          target?.element.click?.();
          return target?.label?.slice(0, 80);
        },
        {
          excludeFlags: exclude?.flags ?? "",
          excludeSource: exclude?.source ?? "",
          includeFlags: include.flags,
          includeSource: include.source,
        },
      ),
    );
  }

  private async tapVisibleTextControl(
    runId: string,
    page: Page,
    include: RegExp,
    exclude?: RegExp,
  ): Promise<string | undefined> {
    this.ensureRunActive(runId);
    const frame = resolveContentFrame(page);
    const target = await frame
      .evaluate(
        ({ includeSource, includeFlags, excludeSource, excludeFlags }) => {
          const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
          const includePattern = new RegExp(includeSource, includeFlags);
          const excludePattern = excludeSource
            ? new RegExp(excludeSource, excludeFlags)
            : undefined;
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const readAttrs = (element: BrowserRuntimeElement) =>
            normalize(
              [
                element.getAttribute?.("id"),
                element.getAttribute?.("class"),
                element.getAttribute?.("aria-label"),
                element.getAttribute?.("title"),
                element.getAttribute?.("placeholder"),
              ].join(" "),
            );
          const isVisible = (element: BrowserRuntimeElement) => {
            const rect = element.getBoundingClientRect();
            const style = runtimeWindow.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const candidates = Array.from(
            runtimeWindow.document.querySelectorAll(
              "button,[role='button'],a,[role='tab'],.ui-button,.ui-cell,div,span,li",
            ),
          )
            .filter(isVisible)
            .map((element) => {
              const text = normalize(element.textContent);
              const attrs = readAttrs(element);
              const combined = `${text} ${attrs}`;
              const rect = element.getBoundingClientRect();
              const exactText = includePattern.test(text);
              return {
                label: text || attrs,
                score:
                  (exactText ? 100 : includePattern.test(combined) ? 60 : 0) +
                  (/button|ui-button|ui-cell/.test(attrs) ? 18 : 0) +
                  (rect.left >= 0 ? 8 : 0) -
                  (excludePattern && excludePattern.test(combined) ? 200 : 0),
                area: rect.width * rect.height,
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
              };
            })
            .filter((candidate) => candidate.score > 0)
            .sort(
              (left, right) =>
                right.score - left.score || left.area - right.area,
            );

          const hit = candidates[0];
          return hit
            ? { label: hit.label.slice(0, 80), x: hit.x, y: hit.y }
            : undefined;
        },
        {
          excludeFlags: exclude?.flags ?? "",
          excludeSource: exclude?.source ?? "",
          includeFlags: include.flags,
          includeSource: include.source,
        },
      )
      .catch(() => undefined);

    if (!target) {
      return undefined;
    }

    let clickX = target.x;
    let clickY = target.y;
    if (frame !== page) {
      const iframeOffset = await page
        .evaluate(() => {
          const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
          const iframe = Array.from(
            runtimeWindow.document.querySelectorAll("iframe"),
          )[0];
          if (!iframe) {
            return undefined;
          }
          const rect = iframe.getBoundingClientRect();
          return { x: rect.left, y: rect.top };
        })
        .catch(() => undefined);
      if (iframeOffset) {
        clickX += iframeOffset.x;
        clickY += iframeOffset.y;
      }
    }

    await page.touchscreen
      .tap(clickX, clickY)
      .catch(() => page.mouse.click(clickX, clickY).catch(() => undefined));
    return target.label;
  }

  async selectPhonePixType(runId: string, page: Page): Promise<void> {
    const diag = (...args: unknown[]) => {
      console.log(`[PIX-DIAG] ${args.join(" ")}`);
    };
    this.ensureRunActive(runId);
    const result = await programmaticPixUiAction(
      resolveContentFrame(page),
      "selectPhone",
    );
    diag(
      `selectPhone-state: ok=${result.ok} ${result.diag ?? result.reason ?? ""}`,
    );
    if (!result.ok) {
      throw new PixRegistrationError(
        "selectPhone",
        `tipo PHONE nao foi aplicado no estado Vue (${result.reason ?? "motivo desconhecido"})`,
        result.diag,
      );
    }
  }

  async fillPixPhoneAccountForm(
    runId: string,
    page: Page,
    phoneNumber: string,
    cpf: string,
    realName: string,
  ): Promise<void> {
    this.ensureRunActive(runId);
    const diag = (...args: unknown[]) => {
      console.log(`[PIX-DIAG] ${args.join(" ")}`);
    };

    const pixModalOpen = () =>
      resolveContentFrame(page)
        .evaluate(() => {
          const text =
            (
              globalThis as unknown as {
                document?: { body?: { innerText?: string } };
              }
            ).document?.body?.innerText || "";
          return /adicionar\s+pix/i.test(text);
        })
        .catch(() => false);

    diag(`fillForm-modal open: ${await pixModalOpen()}`);

    // Etapa avaliada na pagina: no mode "gather" so COLETA metadados dos inputs do modal;
    // no mode "set" recoleta a MESMA lista (mesma logica/ordem, para os indices baterem) e
    // seta os valores pelos indices que resolvePixFormFieldRoles decidiu em Node. Assim a
    // heuristica de escolha de campos fica testavel fora do browser.
    const pixFormStep = (payload: PixFormFillPayload): Promise<PixFormStepResult> =>
      resolveContentFrame(page)
        .evaluate((input: PixFormFillPayload): PixFormStepResult => {
          const runtimeWindow = globalThis as unknown as BrowserRuntimeWindow;
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const isVisible = (element: BrowserRuntimeElement) => {
            const rect = element.getBoundingClientRect();
            const style = runtimeWindow.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 8 &&
              rect.height > 8
            );
          };
          const isInputElement = (
            element: BrowserRuntimeElement,
          ): element is BrowserRuntimeInputElement =>
            typeof element.value === "string";
          const setValue = (
            target: BrowserRuntimeInputElement,
            value: string,
          ) => {
            const setter = runtimeWindow.HTMLInputElement?.prototype
              ? (Object.getOwnPropertyDescriptor(
                  runtimeWindow.HTMLInputElement.prototype,
                  "value",
                )?.set as
                  | ((this: BrowserRuntimeInputElement, value: string) => void)
                  | undefined)
              : undefined;
            setter?.call(target, value);
            if (target.value !== value) {
              target.value = value;
            }
            const RuntimeEvent = runtimeWindow.Event;
            if (RuntimeEvent) {
              target.dispatchEvent?.(new RuntimeEvent("input", { bubbles: true }));
              target.dispatchEvent?.(new RuntimeEvent("change", { bubbles: true }));
            }
          };
          const roots = Array.from(
            runtimeWindow.document.querySelectorAll(
              ".ui-popup,.ui-dialog,.van-popup,.van-dialog,.modal,.popup,form",
            ),
          )
            .filter(
              (element) =>
                isVisible(element) &&
                /adicionar\s+pix/i.test(normalize(element.textContent)),
            )
            .sort((a, b) => {
              const aHasInput = a.querySelector?.("input") ? 1 : 0;
              const bHasInput = b.querySelector?.("input") ? 1 : 0;
              if (aHasInput !== bHasInput) return bHasInput - aHasInput;
              const aRect = a.getBoundingClientRect();
              const bRect = b.getBoundingClientRect();
              return aRect.width * aRect.height - bRect.width * bRect.height;
            });
          const root = roots[0] ?? runtimeWindow.document.body!;
          const inModal = (el: BrowserRuntimeElement) => {
            const popup = el.closest?.(
              ".van-popup, .van-dialog, .ui-popup, .ui-dialog, .modal, .popup",
            );
            return Boolean(popup && isVisible(popup));
          };
          // Lista canonica: inputs visiveis dentro do modal, em ordem de DOM. Gather e set
          // usam ESTA MESMA lista, entao os indices resolvidos em Node continuam validos.
          const inputs = Array.from(root.querySelectorAll?.("input") ?? []).filter(
            (candidate): candidate is BrowserRuntimeInputElement =>
              isInputElement(candidate) && isVisible(candidate) && inModal(candidate),
          );
          const selector = root.querySelector?.(".ui-popover__wrapper") ?? null;
          const precedes = (
            left: BrowserRuntimeElement,
            right: BrowserRuntimeElement,
          ) =>
            Boolean(
              left.compareDocumentPosition?.(right) &&
                left.compareDocumentPosition(right) & 4,
            );
          const allInputInfo = inputs.map((inp) => ({
            placeholder: (inp.placeholder || "").slice(0, 40),
            disabled: !!inp.disabled,
            value: inp.value?.slice(0, 20) || "",
          }));
          const rootInfo = {
            class: String(root.className || "").slice(0, 50),
            rootCount: roots.length,
            inputCount: inputs.length,
            hasSelector: Boolean(selector),
          };

          if (input.mode === "gather") {
            const descriptors = inputs.map((inp, index) => ({
              index,
              placeholder: (inp.placeholder || "").slice(0, 40),
              name: String(inp.name || "").slice(0, 40),
              id: String(inp.id || "").slice(0, 40),
              className: String(inp.className || "").slice(0, 60),
              precedesSelector: selector ? precedes(inp, selector) : false,
              followsSelector: selector ? precedes(selector, inp) : false,
              writable: !inp.disabled && !inp.readOnly && inp.type !== "hidden",
              hasSelector: Boolean(selector),
            }));
            return {
              phase: "gather",
              descriptors,
              pix: false,
              cpf: false,
              nameFilled: false,
              debug: { rootInfo, allInputInfo },
            };
          }

          const { nameIndex, pixIndex, cpfIndex } = input.roles;
          const nameInput = nameIndex != null ? inputs[nameIndex] : undefined;
          const pixInput = pixIndex != null ? inputs[pixIndex] : undefined;
          const cpfInput = cpfIndex != null ? inputs[cpfIndex] : undefined;
          if (!pixInput || !cpfInput) {
            return {
              phase: "set",
              descriptors: [],
              pix: Boolean(pixInput),
              cpf: Boolean(cpfInput),
              nameFilled: false,
              debug: { rootInfo, allInputInfo },
            };
          }
          if (
            nameInput &&
            !nameInput.disabled &&
            !nameInput.readOnly &&
            !nameInput.value
          ) {
            setValue(nameInput, input.realNameValue);
          }
          setValue(pixInput, input.pixPhone);
          setValue(cpfInput, input.cpfValue);
          return {
            phase: "set",
            descriptors: [],
            pix: true,
            cpf: true,
            nameFilled: !!nameInput,
            debug: { rootInfo, allInputInfo },
          };
        }, payload)
        .catch(
          (): PixFormStepResult => ({
            phase: "error",
            descriptors: [],
            pix: false,
            cpf: false,
            nameFilled: false,
            debug: { error: "evaluate failed" },
          }),
        );

    let filled: PixFormStepResult = {
      phase: "gather",
      descriptors: [],
      pix: false,
      cpf: false,
      nameFilled: false,
      debug: undefined,
    };
    const fillDeadline = Date.now() + PIX_MS(4000);
    do {
      this.ensureRunActive(runId);
      const gathered = await pixFormStep({ mode: "gather" });
      const roles = resolvePixFormFieldRoles(gathered.descriptors);
      filled = await pixFormStep({
        mode: "set",
        roles,
        pixPhone: phoneNumber,
        cpfValue: cpf,
        realNameValue: realName,
      });
      if (filled.pix && filled.cpf) {
        break;
      }
      await page.waitForTimeout(100).catch(() => undefined);
    } while (Date.now() < fillDeadline);

    diag(
      `fillForm-result: pix=${filled.pix} cpf=${filled.cpf} debug=${JSON.stringify(filled.debug)}`,
    );
    diag(`fillForm-modal after fill: ${await pixModalOpen()}`);

    if (!filled.pix || !filled.cpf) {
      throw new PixRegistrationError(
        "fillForm",
        "campos de telefone PIX e CPF nao foram encontrados no formulario",
        JSON.stringify(filled.debug).slice(0, 160),
      );
    }
  }

  /**
   * Plataformas que redirecionam para outro dominio (ex.: link "vip" -> mirror
   * "bet34") criam a conta na URL final, nao na original do perfil. Sem tratar
   * isso, todos os fluxos seguintes (deposito/PIX/saque) renavegam para a homeUrl
   * original, disparam o redirect de novo e a pagina vira documento auxiliar.
   * Ao detectar uma pagina utilizavel num host diferente da homeUrl, gravamos a
   * URL efetiva como homeUrl do perfil (preservando path/query da original) e
   * registramos a nova origem para nao reabrir cadastro.
   */
  private persistRedirectedPlatformUrl(
    runId: string,
    profile: ProfileSummary,
    liveUrl: string,
  ): string {
    const homeUrl = profile.homeUrl.trim();
    if (!liveUrl) {
      return homeUrl;
    }

    let nextUrl = homeUrl;
    try {
      const live = new URL(liveUrl);
      if (live.protocol !== "http:" && live.protocol !== "https:") {
        return homeUrl;
      }
      const home = new URL(homeUrl);
      if (!live.host || live.host === home.host) {
        return homeUrl;
      }
      home.protocol = live.protocol;
      home.host = live.host;
      nextUrl = home.toString();
    } catch {
      return homeUrl;
    }

    if (nextUrl === homeUrl) {
      return homeUrl;
    }

    this.database.updateProfileHomeUrl(profile.id, nextUrl);
    this.database.markProfileAccountRegisteredOrigin(profile.id, nextUrl);
    // Sincroniza o handle em memoria para que o botao "Pagina inicial" use a URL
    // nova imediatamente, sem precisar fechar e reabrir a janela.
    this.browserRuntime.updateProfileHomeUrl(profile.id, nextUrl);
    profile.homeUrl = nextUrl;
    this.log(
      runId,
      "info",
      `[${profile.name}] Plataforma redirecionou para ${new URL(nextUrl).host}; link do perfil atualizado para evitar novo redirecionamento.`,
    );
    return nextUrl;
  }

  private async resolveDepositFlowPage(
    runId: string,
    page: Page,
    profile: ProfileSummary,
    startUrl: string,
  ): Promise<Page> {
    const isUsable = async (candidate: Page) => {
      if (candidate.isClosed()) {
        return false;
      }

      const state = await this.readAutomationPageState(candidate);
      return Boolean(
        state &&
        !state.auxiliary &&
        state.viewportWidth > 0 &&
        state.viewportHeight > 0,
      );
    };

    if (await isUsable(page)) {
      this.persistRedirectedPlatformUrl(runId, profile, page.url());
      return page;
    }

    const currentState = await this.readAutomationPageState(page).catch(
      () => undefined,
    );
    this.log(
      runId,
      "warning",
      `[${profile.name}] Pagina atual virou documento auxiliar (${currentState?.url || "sem url"}; viewport ${
        currentState
          ? `${currentState.viewportWidth}x${currentState.viewportHeight}`
          : "desconhecido"
      }); recuperando pagina da plataforma.`,
    );

    const context = page.context();
    const startOrigin = (() => {
      try {
        return new URL(startUrl).origin;
      } catch {
        return "";
      }
    })();

    const candidates = context
      .pages()
      .filter((candidate) => candidate !== page && !candidate.isClosed());
    for (const candidate of candidates) {
      const state = await this.readAutomationPageState(candidate).catch(
        () => undefined,
      );
      if (
        !state ||
        state.auxiliary ||
        state.viewportWidth <= 0 ||
        state.viewportHeight <= 0
      ) {
        continue;
      }

      // O contexto e isolado por perfil: qualquer pagina http(s) utilizavel aqui
      // e a propria plataforma (mesmo num host redirecionado diferente da
      // startOrigin). Por isso aceitamos sameOrigin OU heuristica de conteudo OU
      // simplesmente uma pagina http carregada.
      const sameOrigin = startOrigin && state.url.startsWith(startOrigin);
      const looksLikePlatform =
        /perfil|profile|deposito|deposit|registro|login|comecar|ofertas/.test(
          state.body,
        );
      const isHttp = /^https?:\/\//i.test(state.url);
      if (sameOrigin || looksLikePlatform || isHttp) {
        await this.browserRuntime
          .setPageAutoClosePopups(candidate, true)
          .catch(() => undefined);
        this.persistRedirectedPlatformUrl(
          runId,
          profile,
          state.url || candidate.url(),
        );
        return candidate;
      }
    }

    const recoveryPage = page.isClosed() ? await context.newPage() : page;
    await recoveryPage
      .goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20000 })
      .catch(() => null);
    await this.browserRuntime
      .setPageAutoClosePopups(recoveryPage, true)
      .catch(() => undefined);
    await this.waitForPlatformLoadingToClear(runId, recoveryPage, {
      retryWithReload: true,
    });
    await recoveryPage
      .waitForLoadState("networkidle", { timeout: 3000 })
      .catch(() => null);
    await this.normalizeRegistrationEntryPage(
      runId,
      recoveryPage,
      profile.name,
    ).catch(() => undefined);
    await waitForProfileSurface(recoveryPage, 6000).catch(() => false);
    this.persistRedirectedPlatformUrl(runId, profile, recoveryPage.url());
    return recoveryPage;
  }

  private async readAutomationPageState(page: Page): Promise<
    | {
        auxiliary: boolean;
        body: string;
        url: string;
        viewportHeight: number;
        viewportWidth: number;
      }
    | undefined
  > {
    if (page.isClosed()) {
      return undefined;
    }

    const url = (() => {
      try {
        return page.url();
      } catch {
        return "";
      }
    })();
    const snapshot = await page
      .evaluate(() => {
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const runtimeWindow = globalThis as unknown as {
          document: {
            body?: { innerText?: string; textContent?: string | null };
            title?: string;
          };
          innerHeight: number;
          innerWidth: number;
          location?: { href?: string };
        };
        const body = normalize(
          runtimeWindow.document.body?.innerText ||
            runtimeWindow.document.body?.textContent ||
            "",
        );
        return {
          body: body.slice(0, 300),
          href: runtimeWindow.location?.href || "",
          title: normalize(runtimeWindow.document.title || ""),
          viewportHeight: runtimeWindow.innerHeight,
          viewportWidth: runtimeWindow.innerWidth,
        };
      })
      .catch(() => undefined);

    if (!snapshot) {
      return undefined;
    }

    const pageUrl = snapshot.href || url;
    const badgeOnlyBody =
      snapshot.body.length <= 80 &&
      /tela\s*\d*.*ip\s*(direto|direct|[\d.:a-f]+)/.test(snapshot.body);
    const auxiliary =
      /^about:(blank|srcdoc)$/i.test(pageUrl) ||
      snapshot.viewportWidth <= 0 ||
      snapshot.viewportHeight <= 0 ||
      badgeOnlyBody;
    return {
      auxiliary,
      body: snapshot.body,
      url: pageUrl,
      viewportHeight: snapshot.viewportHeight,
      viewportWidth: snapshot.viewportWidth,
    };
  }

  private resolveDepositAmount(params: Record<string, string>): string {
    const explicitAmount = this.parseDepositNumber(params.depositAmount);
    if (explicitAmount !== undefined) {
      return String(explicitAmount);
    }

    const min = this.parseDepositNumber(params.depositAmountMin);
    const max = this.parseDepositNumber(params.depositAmountMax);
    if (min === undefined || max === undefined) {
      return "200";
    }

    const safeMin = Math.max(1, Math.trunc(Math.min(min, max)));
    const safeMax = Math.max(safeMin, Math.trunc(Math.max(min, max)));
    return String(this.randomInt(safeMin, safeMax));
  }

  private isPostRegistrationDepositEnabled(
    automation: AutomationRecord,
    settings: AppSettings,
  ): boolean {
    if (
      !Object.prototype.hasOwnProperty.call(
        automation.params,
        "postRegistrationDepositEnabled",
      )
    ) {
      return settings.postRegistrationDepositEnabled ?? true;
    }
    const rawValue = automation.params.postRegistrationDepositEnabled
      ?.trim()
      .toLowerCase();
    return (
      rawValue === "true" ||
      rawValue === "1" ||
      rawValue === "on" ||
      rawValue === "yes"
    );
  }

  private normalizeManualDepositAmounts(values: string[]): string[] {
    return values
      .map((value) => this.parseDepositNumber(value))
      .filter((value): value is number => value !== undefined)
      .map((value) =>
        Number.isInteger(value)
          ? String(value)
          : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""),
      );
  }

  private parseDepositNumber(value: string | undefined): number | undefined {
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

  private getGeetestSolver(): GeetestSolverService {
    this.geetestSolver ??= new GeetestSolverService();
    return this.geetestSolver;
  }

  private isAutoCaptchaSolverEnabled(runId: string): boolean {
    return this.autoCaptchaSolverRuns.has(runId);
  }

  private async waitForManualCaptchaIfPresent(
    runId: string,
    page: Page,
    profileName: string,
    stage: string,
    options?: ManualCaptchaOptions,
  ): Promise<boolean> {
    const appearanceTimeoutMs = options?.appearanceTimeoutMs ?? 800;
    const solvedTimeoutMs = options?.solvedTimeoutMs ?? 10 * 60 * 1000;
    const challenge = await this.waitForCaptchaChallenge(
      runId,
      page,
      appearanceTimeoutMs,
    );

    if (!challenge.active) {
      return false;
    }

    if (
      challenge.label === "Geetest" &&
      this.isAutoCaptchaSolverEnabled(runId)
    ) {
      await this.applyGeetestAutoSolveMask(page).catch(() => undefined);
      const autoSolved = await this.tryAutoSolveGeetestCaptcha(
        runId,
        page,
        profileName,
      ).catch(() => false);
      if (autoSolved) {
        await this.waitForRunDelay(runId, page, 1200);
        await this.restoreGeetestAutoSolveMask(page).catch(() => undefined);
        if (!(await this.detectCaptchaChallenge(page)).active) {
          this.log(
            runId,
            "success",
            `[${profileName}] Captcha Geetest resolvido automaticamente em ${stage}.`,
          );
          return true;
        }
        return true;
      }

      await this.restoreGeetestAutoSolveMask(page).catch(() => undefined);
    }

    this.ensureRunActive(runId);
    await page.bringToFront().catch(() => null);
    this.log(
      runId,
      "warning",
      `[${profileName}] Captcha detectado em ${stage} (${challenge.label}). Resolva manualmente na janela do navegador; a automacao vai continuar sozinha.`,
    );
    const startedAt = Date.now();
    let lastReminderAt = Date.now();

    while (Date.now() - startedAt < solvedTimeoutMs) {
      this.ensureRunActive(runId);
      const current = await this.detectCaptchaChallenge(page);
      if (!current.active) {
        await this.waitForRunDelay(runId, page, 500);
        this.log(
          runId,
          "success",
          `[${profileName}] Captcha resolvido; retomando ${stage}.`,
        );
        return true;
      }

      if (Date.now() - lastReminderAt > 30000) {
        lastReminderAt = Date.now();
        this.log(
          runId,
          "info",
          `[${profileName}] Aguardando solucao manual do captcha em ${stage}.`,
        );
      }

      await this.waitForRunDelay(runId, page, 550);
    }

    throw new Error(
      `captcha em ${stage} nao foi resolvido dentro do tempo limite`,
    );
  }

  private async waitForCaptchaChallenge(
    runId: string,
    page: Page,
    timeoutMs: number,
  ): Promise<CaptchaChallengeInfo> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const challenge = await this.detectCaptchaChallenge(page);
      if (challenge.active) {
        return challenge;
      }
      await this.waitForRunDelay(runId, page, 180);
    }

    return this.detectCaptchaChallenge(page);
  }

  private async detectCaptchaChallenge(
    page: Page,
  ): Promise<CaptchaChallengeInfo> {
    return page
      .evaluate(() => {
        type RuntimeElement = {
          getAttribute?: (name: string) => string | null;
          getBoundingClientRect: () => {
            bottom: number;
            height: number;
            left: number;
            right: number;
            top: number;
            width: number;
          };
          localName?: string;
          querySelector?: (selector: string) => RuntimeElement | null;
          textContent?: string | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: {
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
          };
          getComputedStyle: (element: RuntimeElement) => {
            display: string;
            opacity: string;
            visibility: string;
            zIndex: string;
          };
          innerHeight: number;
          innerWidth: number;
        };
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        // Detector restrito a assinaturas REAIS de captcha. Termos/seletores genericos
        // (slider, puzzle, verify/verificar/verificacao, seguranca/security, validate)
        // foram removidos: casavam UI legitima — ex.: `m-slider` (slider de VALOR do
        // deposito), "Codigo de Verificacao" do login SMS, menu "Seguranca" — gerando
        // falso captcha que disparava o zoom de view-aid e quebrava o clique de
        // "Deposite agora". O captcha real dessas plataformas e Geetest, coberto por
        // [class*='geetest']/iframe geetest; reCAPTCHA/hCaptcha/Turnstile por vendor.
        const captchaTextPattern =
          /captcha|recaptcha|hcaptcha|turnstile|geetest|gee test|deslize|arraste/;
        const captchaSelector = [
          "iframe[src*='captcha' i]",
          "iframe[src*='recaptcha' i]",
          "iframe[src*='hcaptcha' i]",
          "iframe[src*='turnstile' i]",
          "iframe[src*='geetest' i]",
          "iframe[title*='captcha' i]",
          "[class*='captcha' i]",
          "[id*='captcha' i]",
          "[class*='geetest' i]",
          "[id*='geetest' i]",
          "[class*='turnstile' i]",
          "[id*='turnstile' i]",
          "[class*='hcaptcha' i]",
          "[id*='hcaptcha' i]",
          "[class*='recaptcha' i]",
          "[id*='recaptcha' i]",
        ].join(",");
        const viewportArea = Math.max(
          1,
          runtimeWindow.innerWidth * runtimeWindow.innerHeight,
        );
        const isVisible = (element: RuntimeElement) => {
          const style = runtimeWindow.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 24 &&
            rect.height > 24 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < runtimeWindow.innerWidth &&
            rect.top < runtimeWindow.innerHeight
          );
        };
        const readElement = (element: RuntimeElement) =>
          normalize(
            [
              element.textContent,
              element.getAttribute?.("id"),
              element.getAttribute?.("class"),
              element.getAttribute?.("src"),
              element.getAttribute?.("title"),
              element.getAttribute?.("aria-label"),
            ].join(" "),
          );
        const scoreElement = (element: RuntimeElement) => {
          if (element.getAttribute?.("id") === "__predatorAutoSolveMask") {
            return undefined;
          }
          if (
            !isVisible(element) ||
            /^(script|style|noscript|html|body)$/i.test(element.localName || "")
          ) {
            return undefined;
          }

          const rect = element.getBoundingClientRect();
          const area = rect.width * rect.height;
          const haystack = readElement(element);
          const hasPointClickChallenge =
            /confirmar|confirm|verificar|verify/.test(haystack) &&
            Boolean(
              element.querySelector?.(
                "canvas,img,svg,[class*='point' i],[class*='click' i],[class*='mark' i],[class*='verify' i],[class*='validate' i]",
              ),
            ) &&
            !/deposito|depositar|recarga|pix|registro|login|senha|password/.test(
              haystack,
            );
          if (
            !captchaTextPattern.test(haystack) &&
            !element.querySelector?.(captchaSelector) &&
            !hasPointClickChallenge
          ) {
            return undefined;
          }

          let score = 0;
          if (/geetest|captcha|recaptcha|hcaptcha|turnstile/.test(haystack)) {
            score += 90;
          }
          if (/deslize|arraste/.test(haystack)) {
            score += 48;
          }
          if (/iframe/i.test(element.localName || "")) {
            score += 40;
          }
          if (area > viewportArea * 0.85) {
            score -= 40;
          }
          if (area < 1200) {
            score -= 35;
          }

          return {
            label: /geetest/.test(haystack)
              ? "Geetest"
              : /turnstile/.test(haystack)
                ? "Turnstile"
                : /hcaptcha/.test(haystack)
                  ? "hCaptcha"
                  : /recaptcha/.test(haystack)
                    ? "reCAPTCHA"
                    : "captcha",
            score,
            zIndex:
              Number.parseInt(
                runtimeWindow.getComputedStyle(element).zIndex || "0",
                10,
              ) || 0,
          };
        };

        const candidates = [
          ...Array.from(
            runtimeWindow.document.querySelectorAll(captchaSelector),
          ),
          ...Array.from(
            runtimeWindow.document.querySelectorAll(
              ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,.dialog",
            ),
          ),
        ]
          .map((element) => ({ element, result: scoreElement(element) }))
          .filter(
            (
              entry,
            ): entry is {
              element: RuntimeElement;
              result: { label: string; score: number; zIndex: number };
            } => Boolean(entry.result && entry.result.score >= 45),
          )
          .sort(
            (left, right) =>
              right.result.score - left.result.score ||
              right.result.zIndex - left.result.zIndex,
          );

        const best = candidates[0];
        return best
          ? {
              active: true,
              label: best.result.label,
            }
          : {
              active: false,
              label: "",
            };
      })
      .catch(() => ({ active: false, label: "" }));
  }

  private async applyGeetestAutoSolveMask(
    page: Page,
  ): Promise<string | undefined> {
    return page
      .evaluate(
        () => {
          type RuntimeRect = {
            bottom: number;
            height: number;
            left: number;
            right: number;
            top: number;
            width: number;
          };
          type RuntimeElement = {
            closest?: (selector: string) => RuntimeElement | null;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => RuntimeRect;
            id?: string;
            remove?: () => void;
            setAttribute?: (name: string, value: string) => void;
            style: {
              cssText: string;
            };
            textContent?: string | null;
          };
          const maskId = "__predatorAutoSolveMask";
          const runtimeWindow = globalThis as unknown as {
            __predatorGeetestBridge?: {
              autoMaskSuppressed?: boolean;
            };
            document: {
              body: {
                append: (element: RuntimeElement) => void;
              };
              createElement: (tagName: string) => RuntimeElement;
              getElementById: (id: string) => RuntimeElement | null;
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
            };
            innerHeight: number;
            innerWidth: number;
          };
          if (runtimeWindow.__predatorGeetestBridge) {
            runtimeWindow.__predatorGeetestBridge.autoMaskSuppressed = false;
          }
          const existing = runtimeWindow.document.getElementById(maskId);
          if (existing) {
            return (
              existing.getAttribute?.("data-predator-mask-label") || "ativo"
            );
          }

          const selector = [
            ".geetest_panel",
            ".geetest_box",
            ".geetest_popup",
            ".geetest_widget",
            ".geetest_window",
            ".geetest_float",
            ".geetest_bind",
            "[class*='geetest_panel']",
            "[class*='geetest_box']",
            "[class*='geetest_popup']",
            "[class*='geetest_widget']",
            "[class*='geetest_window']",
            "[class*='geetest_float']",
            "[class*='geetest_bind']",
            "[id*='geetest']",
            "iframe[src*='geetest']",
            "iframe[src*='gcaptcha']",
          ].join(",");
          const isVisible = (element: RuntimeElement) => {
            const style = runtimeWindow.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 20 &&
              rect.height > 20 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const elements = Array.from(
            runtimeWindow.document.querySelectorAll(selector),
          ).filter(isVisible);
          const candidates = elements
            .map((element) => {
              const modal = element.closest?.(
                "[role='dialog'], [aria-modal='true'], .modal, .popup, .dialog, .ui-popup, .ui-dialog, .van-popup, .van-dialog, .geetest_panel, .geetest_box, .geetest_popup",
              );
              const target = modal && isVisible(modal) ? modal : element;
              const rect = target.getBoundingClientRect();
              return {
                rect,
                area: rect.width * rect.height,
              };
            })
            .filter((entry) => entry.area > 0)
            .sort((a, b) => b.area - a.area);

          const viewportWidth = Math.max(1, runtimeWindow.innerWidth);
          const viewportHeight = Math.max(1, runtimeWindow.innerHeight);
          const targetRect = candidates[0]?.rect;
          const pad = targetRect ? 10 : 0;
          const left = targetRect ? Math.max(0, targetRect.left - pad) : 0;
          const top = targetRect ? Math.max(0, targetRect.top - pad) : 0;
          const right = targetRect
            ? Math.min(viewportWidth, targetRect.right + pad)
            : viewportWidth;
          const bottom = targetRect
            ? Math.min(viewportHeight, targetRect.bottom + pad)
            : viewportHeight;

          const mask = runtimeWindow.document.createElement("div");
          mask.id = maskId;
          mask.setAttribute?.(
            "data-predator-mask-label",
            targetRect ? "widget" : "pagina",
          );
          mask.setAttribute?.("aria-live", "polite");
          mask.textContent = "Resolvendo captcha automaticamente...";
          mask.style.cssText = [
            "position:fixed",
            `left:${Math.round(left)}px`,
            `top:${Math.round(top)}px`,
            `width:${Math.max(1, Math.round(right - left))}px`,
            `height:${Math.max(1, Math.round(bottom - top))}px`,
            "z-index:2147483647",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "box-sizing:border-box",
            "padding:18px",
            "background:rgba(255,255,255,0.97)",
            "color:#0f172a",
            "font:600 14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
            "text-align:center",
            "pointer-events:auto",
            "border-radius:10px",
            "box-shadow:0 10px 30px rgba(15,23,42,0.18)",
          ].join(";");
          runtimeWindow.document.body.append(mask);
          return mask.getAttribute?.("data-predator-mask-label") || undefined;
        },
        undefined,
        PATCHRIGHT_MAIN_WORLD,
      )
      .catch(() => undefined);
  }

  private async restoreGeetestAutoSolveMask(page: Page): Promise<void> {
    await page
      .evaluate(
        () => {
          const runtimeWindow = globalThis as unknown as {
            __predatorGeetestBridge?: {
              autoMaskSuppressed?: boolean;
            };
            document: {
              getElementById: (id: string) => { remove?: () => void } | null;
            };
          };
          if (runtimeWindow.__predatorGeetestBridge) {
            runtimeWindow.__predatorGeetestBridge.autoMaskSuppressed = true;
          }
          runtimeWindow.document
            .getElementById("__predatorAutoSolveMask")
            ?.remove?.();
        },
        undefined,
        PATCHRIGHT_MAIN_WORLD,
      )
      .catch(() => undefined);
  }

  private async installGeetestBridge(page: Page): Promise<void> {
    await page.addInitScript({
      content: `
(() => {
  const key = "__predatorGeetestBridge";
  const win = window;
  if (win[key] && win[key].installed) {
    return;
  }

  const bridge = win[key] || {};
  try {
    Object.defineProperty(win, key, {
      configurable: true,
      value: bridge
    });
  } catch (error) {
    win[key] = bridge;
  }
  bridge.installed = true;
  bridge.solution = null;
  bridge.successCallbacks = bridge.successCallbacks || [];
  bridge.closeCallbacks = bridge.closeCallbacks || [];
  bridge.errorCallbacks = bridge.errorCallbacks || [];
  bridge.instances = bridge.instances || [];
  bridge.callbacksFired = bridge.callbacksFired || 0;
  bridge.lastConfig = bridge.lastConfig || null;
  bridge.lastInstance = bridge.lastInstance || null;

  const hasSolution = () => {
    const solution = bridge.solution || {};
    return Boolean(solution.lot_number && solution.pass_token);
  };

  const maskId = "__predatorAutoSolveMask";
  const geetestMaskSelector = [
    ".geetest_panel",
    ".geetest_box",
    ".geetest_popup",
    ".geetest_widget",
    ".geetest_window",
    ".geetest_float",
    ".geetest_bind",
    "[class*='geetest_panel']",
    "[class*='geetest_box']",
    "[class*='geetest_popup']",
    "[class*='geetest_widget']",
    "[class*='geetest_window']",
    "[class*='geetest_float']",
    "[class*='geetest_bind']",
    "[id*='geetest']",
    "iframe[src*='geetest']",
    "iframe[src*='gcaptcha']"
  ].join(",");

  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0.01 &&
      rect.width > 20 &&
      rect.height > 20 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < innerWidth &&
      rect.top < innerHeight
    );
  };

  const removeAutoSolveMask = () => {
    try {
      document.getElementById(maskId)?.remove();
    } catch (error) {
      // Ignore detached documents.
    }
  };

  const ensureAutoSolveMask = () => {
    if (bridge.autoMaskSuppressed || !document.body || document.getElementById(maskId)) {
      return;
    }

    const candidates = Array.from(document.querySelectorAll(geetestMaskSelector))
      .filter(isVisible)
      .map((element) => {
        const modal = element.closest(
          "[role='dialog'], [aria-modal='true'], .modal, .popup, .dialog, .ui-popup, .ui-dialog, .van-popup, .van-dialog, .geetest_panel, .geetest_box, .geetest_popup"
        );
        const target = modal && isVisible(modal) ? modal : element;
        const rect = target.getBoundingClientRect();
        return {
          rect,
          area: rect.width * rect.height
        };
      })
      .filter((entry) => entry.area > 0)
      .sort((a, b) => b.area - a.area);

    const targetRect = candidates[0]?.rect;
    if (!targetRect) {
      return;
    }

    const pad = 10;
    const left = Math.max(0, targetRect.left - pad);
    const top = Math.max(0, targetRect.top - pad);
    const right = Math.min(innerWidth, targetRect.right + pad);
    const bottom = Math.min(innerHeight, targetRect.bottom + pad);
    const mask = document.createElement("div");
    mask.id = maskId;
    mask.setAttribute("data-predator-mask-label", "observer");
    mask.setAttribute("aria-live", "polite");
    mask.textContent = "Resolvendo captcha automaticamente...";
    mask.style.cssText = [
      "position:fixed",
      \`left:\${Math.round(left)}px\`,
      \`top:\${Math.round(top)}px\`,
      \`width:\${Math.max(1, Math.round(right - left))}px\`,
      \`height:\${Math.max(1, Math.round(bottom - top))}px\`,
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "box-sizing:border-box",
      "padding:18px",
      "background:rgba(255,255,255,0.97)",
      "color:#0f172a",
      "font:600 14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "text-align:center",
      "pointer-events:auto",
      "border-radius:10px",
      "box-shadow:0 10px 30px rgba(15,23,42,0.18)"
    ].join(";");
    document.body.append(mask);
  };

  const scheduleAutoSolveMask = () => {
    if (bridge.autoMaskScheduled) {
      return;
    }
    bridge.autoMaskScheduled = true;
    setTimeout(() => {
      bridge.autoMaskScheduled = false;
      ensureAutoSolveMask();
    }, 0);
  };

  // Antes: um MutationObserver no documento INTEIRO com {attributes,childList,subtree}
  // rodava desde o load em TODA pagina, mesmo sem captcha. Nessas SPAs animadas
  // (carrossel/ticker/marquee/NProgress) isso gera um fluxo enorme de mutacoes +
  // querySelectorAll por tick -> CPU saturada com varias instancias (causa de janelas
  // "travando ao carregar"). Agora: um poll BARATO (1 querySelector a cada ~800ms) so
  // ARMA o observer de mascara (childList/subtree, SEM attributes) quando um Geetest REAL
  // esta na pagina, e o desarma quando some.
  const geetestPresenceSelector =
    "[class*='geetest_'],[id*='geetest'],iframe[src*='geetest'],iframe[src*='gcaptcha']";
  const startMaskObserver = () => {
    if (bridge.maskObserver || !(document.body || document.documentElement)) {
      return;
    }
    const observer = new MutationObserver(scheduleAutoSolveMask);
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
    bridge.maskObserver = observer;
    scheduleAutoSolveMask();
  };
  const stopMaskObserver = () => {
    if (bridge.maskObserver) {
      try {
        bridge.maskObserver.disconnect();
      } catch (error) {
        // Ignore detached documents.
      }
      bridge.maskObserver = null;
    }
    removeAutoSolveMask();
  };
  bridge.startMaskObserver = startMaskObserver;
  bridge.stopMaskObserver = stopMaskObserver;
  const watchGeetestPresence = () => {
    let present = false;
    try {
      present = Boolean(document.querySelector(geetestPresenceSelector));
    } catch (error) {
      present = false;
    }
    if (present) {
      startMaskObserver();
    } else {
      stopMaskObserver();
    }
  };
  if (!bridge.maskWatchTimer) {
    bridge.maskWatchTimer = setInterval(watchGeetestPresence, 800);
    watchGeetestPresence();
  }

  const buildValidate = () => {
    const solution = bridge.solution || {};
    const config = bridge.lastConfig || {};
    return {
      captcha_id: solution.captcha_id || config.captchaId || config.captcha_id || "",
      lot_number: solution.lot_number || "",
      pass_token: solution.pass_token || "",
      gen_time: solution.gen_time || String(Math.floor(Date.now() / 1000)),
      captcha_output: solution.captcha_output || ""
    };
  };

  const cleanupDom = () => {
    removeAutoSolveMask();
    const selectors = [
      ".geetest_panel",
      ".geetest_box",
      ".geetest_popup",
      ".geetest_widget",
      ".geetest_window",
      ".geetest_float",
      ".geetest_bind",
      ".geetest_overlay",
      ".geetest_mask",
      "[class*='geetest_panel']",
      "[class*='geetest_box']",
      "[class*='geetest_popup']",
      "[class*='geetest_widget']",
      "[class*='geetest_window']",
      "[class*='geetest_float']",
      "[class*='geetest_bind']",
      "[class*='geetest_overlay']",
      "[class*='geetest_mask']",
      "iframe[src*='geetest']",
      "iframe[src*='gcaptcha']"
    ];
    for (let i = 0; i < selectors.length; i += 1) {
      const nodes = document.querySelectorAll(selectors[i]);
      for (let j = 0; j < nodes.length; j += 1) {
        const node = nodes[j];
        try {
          const target = node.closest("[role='dialog'], [aria-modal='true'], .modal, .popup, .dialog, .ui-popup, .ui-dialog, .van-popup, .van-dialog") || node;
          target.style.setProperty("display", "none", "important");
          target.style.setProperty("visibility", "hidden", "important");
          target.style.setProperty("pointer-events", "none", "important");
        } catch (error) {
          // Ignore DOM nodes from cross-origin frames or detached trees.
        }
      }
    }
  };

  const fireSuccessCallbacks = () => {
    const callbacks = bridge.successCallbacks.slice();
    for (let i = 0; i < callbacks.length; i += 1) {
      const callback = callbacks[i];
      if (typeof callback !== "function") {
        continue;
      }
      setTimeout(() => {
        try {
          bridge.callbacksFired += 1;
          callback();
        } catch (error) {
          // The page owns these callbacks; keep the bridge non-invasive.
        }
      }, 0);
    }
    if (callbacks.length > 0) {
      setTimeout(cleanupDom, 250);
    }
    return callbacks.length;
  };

  const rememberCallback = (list, callback) => {
    if (typeof callback === "function" && list.indexOf(callback) === -1) {
      list.push(callback);
    }
  };

  const patchInstance = (instance) => {
    if (!instance || instance.__predatorGeetestPatched) {
      return instance;
    }

    try {
      Object.defineProperty(instance, "__predatorGeetestPatched", {
        configurable: true,
        value: true
      });
    } catch (error) {
      instance.__predatorGeetestPatched = true;
    }

    bridge.instances.push(instance);
    bridge.lastInstance = instance;

    const originalGetValidate = instance.getValidate;
    instance.getValidate = function patchedGetValidate() {
      const validate = buildValidate();
      if (validate.lot_number && validate.pass_token) {
        return validate;
      }
      if (typeof originalGetValidate === "function") {
        try {
          return originalGetValidate.apply(this, arguments);
        } catch (error) {
          return validate;
        }
      }
      return validate;
    };

    const originalShowCaptcha = instance.showCaptcha;
    if (typeof originalShowCaptcha === "function") {
      instance.showCaptcha = function patchedShowCaptcha() {
        const result = originalShowCaptcha.apply(this, arguments);
        scheduleAutoSolveMask();
        return result;
      };
    }

    const originalAppendTo = instance.appendTo;
    if (typeof originalAppendTo === "function") {
      instance.appendTo = function patchedAppendTo() {
        const result = originalAppendTo.apply(this, arguments);
        scheduleAutoSolveMask();
        return result || this;
      };
    }

    const originalOnSuccess = instance.onSuccess;
    if (typeof originalOnSuccess === "function") {
      instance.onSuccess = function patchedOnSuccess(callback) {
        rememberCallback(bridge.successCallbacks, callback);
        const result = originalOnSuccess.apply(this, arguments);
        if (hasSolution()) {
          fireSuccessCallbacks();
        }
        return result || this;
      };
    }

    const originalOnClose = instance.onClose;
    if (typeof originalOnClose === "function") {
      instance.onClose = function patchedOnClose(callback) {
        rememberCallback(bridge.closeCallbacks, callback);
        const result = originalOnClose.apply(this, arguments);
        return result || this;
      };
    }

    const originalOnError = instance.onError;
    if (typeof originalOnError === "function") {
      instance.onError = function patchedOnError(callback) {
        rememberCallback(bridge.errorCallbacks, callback);
        const result = originalOnError.apply(this, arguments);
        return result || this;
      };
    }

    return instance;
  };

  bridge.resolve = (solution) => {
    bridge.solution = solution || {};
    if (bridge.lastInstance) {
      patchInstance(bridge.lastInstance);
    }
    const callbacks = fireSuccessCallbacks();
    return {
      callbacks,
      fired: bridge.callbacksFired,
      hasInstance: Boolean(bridge.lastInstance),
      instances: bridge.instances.length
    };
  };

  bridge.status = () => ({
    callbacks: bridge.successCallbacks.length,
    fired: bridge.callbacksFired,
    hasInstance: Boolean(bridge.lastInstance),
    instances: bridge.instances.length,
    hasSolution: hasSolution()
  });

  const wrapInit = (name) => {
    let current = win[name];
    const wrap = (fn) => {
      if (typeof fn !== "function" || fn.__predatorGeetestWrapped) {
        return fn;
      }
      const wrapped = function wrappedGeetestInit(config, callback) {
        bridge.autoMaskSuppressed = false;
        bridge.lastConfig = config || {};
        scheduleAutoSolveMask();
        return fn.call(this, config, (instance) => {
          const patched = patchInstance(instance);
          scheduleAutoSolveMask();
          if (typeof callback === "function") {
            return callback(patched);
          }
          return undefined;
        });
      };
      try {
        Object.defineProperty(wrapped, "__predatorGeetestWrapped", {
          configurable: true,
          value: true
        });
      } catch (error) {
        wrapped.__predatorGeetestWrapped = true;
      }
      return wrapped;
    };

    try {
      Object.defineProperty(win, name, {
        configurable: true,
        enumerable: true,
        get() {
          return current;
        },
        set(value) {
          current = wrap(value);
        }
      });
      if (current) {
        current = wrap(current);
      }
    } catch (error) {
      if (typeof current === "function") {
        win[name] = wrap(current);
      }
    }
  };

  wrapInit("initGeetest4");
  wrapInit("initBotion");
})();
`,
    });
  }

  private setupGeetestInterception(runId: string, page: Page): void {
    const listener = (request: unknown) => {
      const url = String((request as { url: () => string }).url?.() ?? "");
      if (!/geetest|geevisit|gcaptcha/.test(url.toLowerCase())) {
        return;
      }
      // 1o sinal de rede geetest neste run = ha captcha real chegando. Pre-aquece o worker
      // AGORA (em paralelo com o widget montando) para esconder o cold-start do CLIP, sem
      // nunca aquecer quando a plataforma nao tem captcha. So enquanto o run esta ativo.
      if (
        this.autoCaptchaSolverRuns.has(runId) &&
        !this.warmedSolverRuns.has(runId)
      ) {
        this.warmedSolverRuns.add(runId);
        this.getGeetestSolver().beginWarmSession();
      }
      const parsed = this.extractGeetestDataFromUrl(url);
      if (parsed) {
        this.geetestCapturedData.set(runId, parsed);
      }
    };
    const wrapped = listener as (...args: unknown[]) => void;
    page.on("request", wrapped);
    this.geetestRequestListeners.set(runId, { page, listener: wrapped });
  }

  private disposeGeetestInterception(runId: string): void {
    const entry = this.geetestRequestListeners.get(runId);
    if (entry) {
      // page.off com a MESMA ref remove o listener -> sem acumulo entre execucoes.
      entry.page.off("request", entry.listener);
      this.geetestRequestListeners.delete(runId);
    }
    this.geetestCapturedData.delete(runId);
  }

  private extractGeetestDataFromUrl(url: string): GeetestCaptchaData | null {
    try {
      const parsed = new URL(url);
      const captchaId = parsed.searchParams.get("captcha_id");
      if (!captchaId || !/^[a-f0-9]{20,}$/i.test(captchaId)) {
        return null;
      }
      return {
        captchaId,
        baseUrl: `${parsed.protocol}//${parsed.host}`,
        riskType: parsed.searchParams.get("risk_type") || undefined,
      };
    } catch {
      return null;
    }
  }

  private async tryAutoSolveGeetestCaptcha(
    runId: string,
    page: Page,
    profileName: string,
  ): Promise<boolean> {
    const captured = this.geetestCapturedData.get(runId);
    const captchaId =
      captured?.captchaId || (await this.extractGeetestCaptchaIdFromPage(page));
    if (!captchaId) {
      return false;
    }

    const solver = this.getGeetestSolver();

    for (
      let attempt = 1;
      attempt <= GEETEST_AUTO_SOLVE_ATTEMPTS;
      attempt += 1
    ) {
      this.ensureRunActive(runId);
      const solution = await solver.solve(
        captchaId,
        captured?.riskType || null,
        captured?.baseUrl,
        undefined,
        1,
      );

      if (!solution || !solution.lot_number || !solution.pass_token) {
        if (attempt < GEETEST_AUTO_SOLVE_ATTEMPTS) {
          await this.waitForRunDelay(runId, page, 180);
          continue;
        }

        this.log(
          runId,
          "warning",
          `[${profileName}] Resolucao automatica do Geetest falhou apos ${GEETEST_AUTO_SOLVE_ATTEMPTS} tentativa(s); aguardando solucao manual.`,
        );
        return false;
      }

      const bridgeResult = await this.resolveGeetestWithPageBridge(
        page,
        solution,
      );
      if (bridgeResult.resolved) {
        return true;
      }

      const interacted = await this.interactWithGeetestWidget(page, solution);
      if (interacted) {
        return true;
      }

      this.log(
        runId,
        "warning",
        `[${profileName}] Nao consegui acionar o callback do Geetest; mantendo o captcha aberto para evitar travar o cadastro.`,
      );
      await this.injectGeetestSolution(page, solution);
      return false;
    }

    return false;
  }

  private async resolveGeetestWithPageBridge(
    page: Page,
    solution: GeetestSolution,
  ): Promise<GeetestBridgeResult> {
    const tokensJson = JSON.stringify({
      captcha_id: solution.captcha_id || "",
      lot_number: solution.lot_number || "",
      pass_token: solution.pass_token || "",
      gen_time: solution.gen_time || String(Math.floor(Date.now() / 1000)),
      captcha_output: solution.captcha_output || "",
    });
    const fallback: GeetestBridgeResult = {
      resolved: false,
      callbacks: 0,
      fired: 0,
      instances: 0,
      hasInstance: false,
      reason: "bridge-unavailable",
    };

    const initial = await page
      .evaluate(
        (json) => {
          type BridgeStatus = {
            callbacks?: number;
            fired?: number;
            hasInstance?: boolean;
            instances?: number;
          };
          type Bridge = {
            resolve?: (solution: Record<string, string>) => BridgeStatus;
            status?: () => BridgeStatus & { hasSolution?: boolean };
          };
          const runtimeWindow = globalThis as typeof globalThis & {
            __predatorGeetestBridge?: Bridge;
          };
          const bridge = runtimeWindow.__predatorGeetestBridge;
          if (!bridge?.resolve) {
            return {
              resolved: false,
              callbacks: 0,
              fired: 0,
              instances: 0,
              hasInstance: false,
              reason: "bridge-missing",
            };
          }

          const result =
            bridge.resolve(JSON.parse(json) as Record<string, string>) || {};
          const callbacks = Number(result.callbacks || 0);
          const fired = Number(result.fired || 0);
          const instances = Number(result.instances || 0);
          const hasInstance = Boolean(result.hasInstance);
          return {
            resolved: callbacks > 0 || fired > 0,
            callbacks,
            fired,
            instances,
            hasInstance,
            reason: callbacks > 0 || fired > 0 ? undefined : "no-callback-yet",
          };
        },
        tokensJson,
        PATCHRIGHT_MAIN_WORLD,
      )
      .catch(() => fallback);

    if (initial.resolved) {
      return initial;
    }

    const startedAt = Date.now();
    let latest = initial;
    while (Date.now() - startedAt < 2500) {
      await page.waitForTimeout(150);
      latest = await page
        .evaluate(
          () => {
            type BridgeStatus = {
              callbacks?: number;
              fired?: number;
              hasInstance?: boolean;
              instances?: number;
              hasSolution?: boolean;
            };
            type Bridge = {
              status?: () => BridgeStatus;
            };
            const runtimeWindow = globalThis as typeof globalThis & {
              __predatorGeetestBridge?: Bridge;
            };
            const status = runtimeWindow.__predatorGeetestBridge?.status?.();
            if (!status) {
              return {
                resolved: false,
                callbacks: 0,
                fired: 0,
                instances: 0,
                hasInstance: false,
                reason: "bridge-missing",
              };
            }
            const callbacks = Number(status.callbacks || 0);
            const fired = Number(status.fired || 0);
            const instances = Number(status.instances || 0);
            const hasInstance = Boolean(status.hasInstance);
            return {
              resolved:
                Boolean(status.hasSolution) && (callbacks > 0 || fired > 0),
              callbacks,
              fired,
              instances,
              hasInstance,
              reason: callbacks > 0 || fired > 0 ? undefined : "no-callback",
            };
          },
          undefined,
          PATCHRIGHT_MAIN_WORLD,
        )
        .catch(() => latest);

      if (latest.resolved) {
        return latest;
      }
    }

    return latest;
  }

  private async interactWithGeetestWidget(
    page: Page,
    solution: GeetestSolution,
  ): Promise<boolean> {
    try {
      const frame = page
        .frameLocator('iframe[src*="geetest" i], iframe[src*="gcaptcha" i]')
        .first();

      const slider = frame
        .locator(
          ".geetest_slider_button, [class*='geetest_slider_button'], [class*='slider_button']",
        )
        .first();
      const sliderVisible = await slider.isVisible().catch(() => false);
      if (sliderVisible) {
        const box = await slider.boundingBox().catch(() => null);
        if (!box) return false;

        const track = frame
          .locator(
            ".geetest_slider_track, [class*='geetest_slide_track'], [class*='slider_track']",
          )
          .first();
        const trackBox = await track.boundingBox().catch(() => null);
        const maxSlide = trackBox ? trackBox.width - box.width : 300;

        const userresponse = Number(
          solution.setLeft ?? solution.userresponse ?? 0,
        );
        const distance = Math.min(maxSlide, Math.max(0, userresponse));
        const startX = box.x + box.width / 2;
        const startY = box.y + box.height / 2;
        const endX = startX + distance;

        await page.mouse.move(startX, startY, { steps: 3 });
        await page.waitForTimeout(40 + Math.floor(Math.random() * 60));
        await page.mouse.down();
        await page.waitForTimeout(20 + Math.floor(Math.random() * 40));
        for (let step = 1; step <= 6; step++) {
          const progress = step / 6;
          const ease =
            progress < 0.5
              ? 2 * progress * progress
              : 1 - Math.pow(-2 * progress + 2, 2) / 2;
          const currentX = startX + (endX - startX) * ease;
          const currentY = startY + (Math.random() - 0.5) * 2;
          await page.mouse.move(currentX, currentY, { steps: 1 });
          await page.waitForTimeout(6 + Math.floor(Math.random() * 12));
        }
        await page.mouse.move(endX, startY, { steps: 2 });
        await page.waitForTimeout(30 + Math.floor(Math.random() * 80));
        await page.mouse.up();

        await page.waitForTimeout(1200);
        return !(await this.detectCaptchaChallenge(page)).active;
      }

      return false;
    } catch (_err) {
      return false;
    }
  }

  private async extractGeetestCaptchaIdFromPage(
    page: Page,
  ): Promise<string | null> {
    return page
      .evaluate(() => {
        type RuntimeElement = {
          getAttribute?: (name: string) => string | null;
          textContent?: string | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: {
            querySelector: (selector: string) => RuntimeElement | null;
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
          };
        };
        const scripts = runtimeWindow.document.querySelectorAll("script");
        for (const script of scripts) {
          const match = (script.textContent || "").match(
            /captcha_id["\s:=]+["']([a-f0-9]+)["']/i,
          );
          if (match?.[1]) return match[1];
        }
        const iframe = runtimeWindow.document.querySelector(
          'iframe[src*="geetest" i], iframe[src*="gcaptcha" i]',
        );
        if (iframe) {
          const src = iframe.getAttribute?.("src") || "";
          const match = src.match(/captcha_id=([a-f0-9]+)/i);
          if (match?.[1]) return match[1];
        }
        const container = runtimeWindow.document.querySelector(
          '[id*="geetest" i], [class*="geetest" i]',
        );
        if (container) {
          const id =
            container.getAttribute?.("data-captcha-id") ||
            container.getAttribute?.("captchaid");
          if (id) return id;
        }
        return null;
      })
      .catch(() => null);
  }

  private async injectGeetestSolution(
    page: Page,
    solution: GeetestSolution,
  ): Promise<void> {
    const tokensJson = JSON.stringify({
      captcha_id: solution.captcha_id || "",
      lot_number: solution.lot_number || "",
      pass_token: solution.pass_token || "",
      gen_time: solution.gen_time || String(Math.floor(Date.now() / 1000)),
      captcha_output: solution.captcha_output || "",
    });

    await page
      .evaluate((json) => {
        const data = JSON.parse(json) as Record<string, string>;
        const d: Record<string, string> = data;
        const win = globalThis as unknown as {
          document: {
            querySelectorAll: (s: string) => Iterable<{
              closest?: (
                s: string,
              ) => {
                style: {
                  setProperty: (n: string, v: string, p?: string) => void;
                };
                parentNode?: { removeChild: (c: unknown) => void } | null;
              } | null;
              dispatchEvent?: (e: { bubbles?: boolean }) => boolean;
              parentNode?: { removeChild: (c: unknown) => void } | null;
              style?: {
                setProperty: (n: string, v: string, p?: string) => void;
              };
              value?: string;
            }> | null;
          };
          Event: new (
            type: string,
            init?: { bubbles?: boolean },
          ) => { bubbles?: boolean };
        };

        const names = [
          "lot_number",
          "pass_token",
          "captcha_output",
          "gen_time",
          "captcha_id",
        ];
        for (let ni = 0; ni < names.length; ni++) {
          const name = names[ni]!;
          const value = d[name] || "";
          if (!value) continue;
          const inputs =
            win.document.querySelectorAll(
              'input[name="' +
                name +
                '"], input[id="' +
                name +
                '"], input[name*="' +
                name +
                '" i], input[id*="' +
                name +
                '" i]',
            ) || [];
          for (const input of inputs) {
            try {
              const proto = Object.getPrototypeOf(input);
              const desc = Object.getOwnPropertyDescriptor(proto, "value") as
                | PropertyDescriptor
                | undefined;
              if (desc?.set) desc.set.call(input, value);
              else if (input.value !== undefined) input.value = value;
            } catch {
              if (input.value !== undefined) input.value = value;
            }
            try {
              input.dispatchEvent?.(new win.Event("input", { bubbles: true }));
            } catch {
              /* ignore */
            }
            try {
              input.dispatchEvent?.(new win.Event("change", { bubbles: true }));
            } catch {
              /* ignore */
            }
          }
        }
      }, tokensJson)
      .catch(() => undefined);
  }

  private async describeDepositSpaCapabilities(
    page: Page,
  ): Promise<string | undefined> {
    const snapshot = await resolveContentFrame(page)
      .evaluate(
        () => {
          type RuntimeRecord = Record<PropertyKey, unknown>;
          type RuntimeElement = {
            __vue__?: unknown;
            __vueParentComponent?: RuntimeRecord | null;
            __vue_app__?: RuntimeRecord | null;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            textContent?: string | null;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              body?: RuntimeElement & { innerText?: string };
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
              zIndex?: string;
            };
            innerHeight: number;
            innerWidth: number;
            location: { hash: string; pathname: string; search: string };
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const isObject = (value: unknown): value is RuntimeRecord =>
            Boolean(value) &&
            (typeof value === "object" || typeof value === "function");
          const readProp = (
            target: RuntimeRecord,
            key: PropertyKey,
          ): unknown => {
            try {
              return target[key];
            } catch {
              return undefined;
            }
          };
          const isVisible = (element: RuntimeElement) => {
            const rect = element.getBoundingClientRect();
            const style = runtimeWindow.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const findRouter = (): RuntimeRecord | null => {
            const direct = (globalThis as RuntimeRecord)["$router"];
            if (
              isObject(direct) &&
              typeof readProp(direct, "push") === "function"
            )
              return direct;
            for (const raw of runtimeWindow.document.querySelectorAll(
              "body,body *",
            )) {
              const element = raw as RuntimeElement;
              const vue = element.__vue__;
              if (isObject(vue) && isObject(readProp(vue, "$router")))
                return readProp(vue, "$router") as RuntimeRecord;
              const appConfig = element.__vue_app__?.config;
              const globalProperties = isObject(appConfig)
                ? readProp(appConfig, "globalProperties")
                : undefined;
              const router = isObject(globalProperties)
                ? readProp(globalProperties, "$router")
                : undefined;
              if (isObject(router)) return router;
            }
            return null;
          };
          const flattenRoutes = (
            routes: unknown[],
            base = "",
          ): Array<{ name: string; path: string }> => {
            const entries: Array<{ name: string; path: string }> = [];
            const joinPath = (left: string, right: string) => {
              if (!right) return left || "/";
              if (right.startsWith("/")) return right;
              return (
                `${left.replace(/\/$/, "")}/${right}`.replace(/\/{2,}/g, "/") ||
                "/"
              );
            };
            for (const route of routes) {
              if (!isObject(route)) continue;
              const path = joinPath(
                base,
                String(readProp(route, "path") ?? ""),
              );
              entries.push({
                name: String(readProp(route, "name") ?? ""),
                path,
              });
              const children = readProp(route, "children");
              if (Array.isArray(children))
                entries.push(...flattenRoutes(children, path));
            }
            return entries;
          };
          const router = findRouter();
          const rawRoutes =
            isObject(router) && isObject(readProp(router, "options"))
              ? readProp(readProp(router, "options") as RuntimeRecord, "routes")
              : undefined;
          const routes = Array.isArray(rawRoutes)
            ? flattenRoutes(rawRoutes)
                .filter((route) =>
                  /recharge|deposit|cashier|wallet|pay|recarga|deposito/i.test(
                    `${route.name} ${route.path}`,
                  ),
                )
                .slice(0, 10)
                .map((route) => `${route.name || "-"}:${route.path}`)
            : [];
          const elements = Array.from(
            runtimeWindow.document.querySelectorAll(
              "#app,#app *,[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],[class*='cashier' i],[id*='cashier' i],[class*='wallet' i],[id*='wallet' i],.ui-popup,.van-popup,.modal,.popup,body",
            ),
          ).slice(0, 1800);
          const seen = new Set<RuntimeRecord>();
          const stores: string[] = [];
          const methods = new Set<string>();
          const visit = (value: unknown, depth: number): void => {
            if (!isObject(value) || seen.has(value) || seen.size > 1600) return;
            seen.add(value);
            const formModel = readProp(value, "formModel");
            const state = readProp(value, "$state");
            const stateFormModel = isObject(state)
              ? readProp(state, "formModel")
              : undefined;
            const resolvedFormModel = isObject(formModel)
              ? formModel
              : isObject(stateFormModel)
                ? stateFormModel
                : undefined;
            if (resolvedFormModel) {
              stores.push(
                Object.keys(resolvedFormModel).slice(0, 8).join("|") ||
                  "formModel",
              );
            }
            for (const key of Reflect.ownKeys(value).slice(0, 100)) {
              const keyText = String(key);
              const child = readProp(value, key);
              if (
                typeof child === "function" &&
                /recharge|deposit|cashier|wallet|pay|submit|order|confirm|open|recarga|deposito/i.test(
                  keyText,
                )
              ) {
                methods.add(keyText);
              }
              if (depth < 3 && isObject(child)) {
                visit(child, depth + 1);
              }
            }
          };
          for (const element of elements) {
            visit(element.__vue__, 0);
            const component = element.__vueParentComponent;
            if (component) {
              visit(component, 0);
              visit(readProp(component, "proxy"), 0);
              visit(readProp(component, "ctx"), 0);
              visit(readProp(component, "setupState"), 0);
              visit(readProp(component, "exposed"), 0);
            }
            const app = element.__vue_app__;
            if (app) {
              visit(app, 0);
              visit(readProp(app, "_context"), 0);
            }
          }
          const buttons = Array.from(
            runtimeWindow.document.querySelectorAll(
              "button,a,[role='button'],.ui-button,.van-button,div,span",
            ),
          )
            .filter(isVisible)
            .map((element) =>
              normalize(
                [
                  element.textContent,
                  element.getAttribute?.("class"),
                  element.getAttribute?.("id"),
                  element.getAttribute?.("aria-label"),
                  element.getAttribute?.("title"),
                ].join(" "),
              ),
            )
            .filter((text) =>
              /deposit|deposito|recarga|recharge|pagar|pay|confirmar|gerar|pix|qr/.test(
                text,
              ),
            )
            .slice(0, 10);
          return {
            buttons,
            methods: Array.from(methods).slice(0, 14),
            route: `${runtimeWindow.location.pathname}${runtimeWindow.location.search}${runtimeWindow.location.hash}`,
            routes,
            stores: stores.slice(0, 8),
          };
        },
        undefined,
        PATCHRIGHT_MAIN_WORLD,
      )
      .catch(() => undefined);

    if (!snapshot) {
      return undefined;
    }
    return (
      `rota=${snapshot.route}; rotas=[${snapshot.routes.join(", ") || "nenhuma"}]; ` +
      `stores=[${snapshot.stores.join(", ") || "nenhum"}]; metodos=[${snapshot.methods.join(", ") || "nenhum"}]; ` +
      `botoes=[${snapshot.buttons.join(" | ") || "nenhum"}]`
    );
  }

  private async tryOpenDepositViaSpaCommand(
    runId: string,
    page: Page,
    _profileName: string,
  ): Promise<boolean> {
    this.ensureRunActive(runId);
    const result = await resolveContentFrame(page)
      .evaluate(
        async () => {
          type RuntimeRecord = Record<PropertyKey, unknown>;
          type RuntimeElement = {
            __vue__?: unknown;
            __vueParentComponent?: RuntimeRecord | null;
            __vue_app__?: RuntimeRecord | null;
            click?: () => void;
            getBoundingClientRect?: () => {
              bottom: number;
              height: number;
              right: number;
              top: number;
              width: number;
            };
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            innerHeight: number;
            innerWidth: number;
          };
          const isObject = (value: unknown): value is RuntimeRecord =>
            Boolean(value) &&
            (typeof value === "object" || typeof value === "function");
          const readProp = (
            target: RuntimeRecord,
            key: PropertyKey,
          ): unknown => {
            try {
              return target[key];
            } catch {
              return undefined;
            }
          };
          const call = async (
            owner: RuntimeRecord,
            key: PropertyKey,
            args: unknown[],
          ) => {
            const fn = readProp(owner, key);
            if (typeof fn !== "function") return false;
            try {
              await Reflect.apply(fn, owner, args);
              return true;
            } catch {
              return false;
            }
          };
          const functionSource = (fn: unknown) => {
            try {
              return Function.prototype.toString
                .call(fn)
                .slice(0, 1200)
                .toLowerCase();
            } catch {
              return "";
            }
          };
          const routesInsteadOfOpeningWallet = (source: string) =>
            /(?:\$router|router)\.push|\$cc\.tourl|location\.(?:href|assign|replace)/i.test(
              source,
            ) &&
            /m_recharge|rechargefund|home\/recharge|\/recharge|deposit|event|\/user|\/home\//i.test(
              source,
            );

          const elements = Array.from(
            runtimeWindow.document.querySelectorAll(
              "#app,#app *,[class*='profile' i],[class*='mine' i],[class*='user' i],[class*='wallet' i],[class*='deposit' i],[class*='recharge' i],body",
            ),
          ).slice(0, 1600);
          const objects: RuntimeRecord[] = [];
          const seen = new Set<RuntimeRecord>();
          const addObject = (value: unknown) => {
            if (!isObject(value) || seen.has(value)) return;
            seen.add(value);
            objects.push(value);
          };
          for (const element of elements) {
            addObject(element.__vue__);
            const component = element.__vueParentComponent;
            if (component) {
              addObject(component);
              addObject(readProp(component, "proxy"));
              addObject(readProp(component, "ctx"));
              addObject(readProp(component, "setupState"));
              addObject(readProp(component, "exposed"));
            }
          }
          const piniaCandidates: unknown[] = [];
          const seenPinia = new Set<unknown>();
          const addPinia = (value: unknown) => {
            if (!isObject(value) || seenPinia.has(value)) return;
            seenPinia.add(value);
            piniaCandidates.push(value);
          };
          const addProvidesPinia = (provides: unknown) => {
            if (!isObject(provides)) return;
            for (const key of Reflect.ownKeys(provides)) {
              if (String(key).toLowerCase().includes("pinia")) {
                addPinia(readProp(provides, key));
              }
            }
          };
          const addAppPinia = (appLike: unknown) => {
            if (!isObject(appLike)) return;
            addPinia(
              readProp(
                readProp(
                  readProp(appLike, "config") as RuntimeRecord,
                  "globalProperties",
                ) as RuntimeRecord,
                "$pinia",
              ),
            );
            const context = readProp(appLike, "_context");
            addPinia(
              readProp(
                readProp(
                  readProp(context as RuntimeRecord, "config") as RuntimeRecord,
                  "globalProperties",
                ) as RuntimeRecord,
                "$pinia",
              ),
            );
            addProvidesPinia(readProp(context as RuntimeRecord, "provides"));
            addProvidesPinia(readProp(appLike, "provides"));
          };
          for (const element of elements) {
            addAppPinia(element.__vue_app__);
            const component = element.__vueParentComponent;
            if (component) {
              addAppPinia(readProp(component, "appContext"));
            }
          }
          const bestStores = piniaCandidates
            .map((pinia) => {
              const stores = readProp(pinia as RuntimeRecord, "_s") as
                | Map<string, RuntimeRecord>
                | undefined;
              if (
                !stores ||
                typeof stores.get !== "function" ||
                typeof stores.keys !== "function"
              )
                return undefined;
              const keys = Array.from(stores.keys());
              const score =
                keys.length +
                (stores.has("dialog") ? 1000 : 0) +
                (stores.has("recharge-with-form") ? 1000 : 0) +
                (stores.has("recharge-qrcode") ? 1000 : 0);
              return { stores, score };
            })
            .filter(
              (
                candidate,
              ): candidate is {
                stores: Map<string, RuntimeRecord>;
                score: number;
              } => Boolean(candidate),
            )
            .sort((left, right) => right.score - left.score)[0]?.stores;
          const dialog = bestStores?.get("dialog");
          const dialogOpen = dialog ? readProp(dialog, "open") : undefined;
          if (dialog && typeof dialogOpen === "function") {
            try {
              await Reflect.apply(dialogOpen, dialog, [
                "recharge",
                { openType: "overlay" },
              ]);
              return { label: "pinia:dialog.open(recharge)" };
            } catch {
              // Try Vuex/component methods below.
            }
          }
          const walletPayload = { isShow: true, active: 0, type: "" };
          for (const owner of objects) {
            const store = readProp(owner, "$store");
            if (!isObject(store)) {
              continue;
            }
            const state = readProp(store, "state");
            const config = isObject(state)
              ? readProp(state, "config")
              : undefined;
            if (isObject(config) && "walletShow" in config) {
              try {
                config.walletShow = walletPayload;
                await call(store, "commit", ["walletShowEvent", walletPayload]);
                await call(store, "dispatch", [
                  "walletShowEvent",
                  walletPayload,
                ]);
                return { label: "vuex:walletShowEvent" };
              } catch {
                // Try methods below.
              }
            }
          }
          const methodPattern =
            /^(open|show|go|to|handle|click|on).*(recharge|deposit|cashier|recarga|deposito)|(recharge|deposit|cashier|recarga|deposito).*(open|show|click|handle)$/i;
          for (const owner of objects) {
            for (const key of Reflect.ownKeys(owner).slice(0, 140)) {
              const keyText = String(key);
              if (
                !methodPattern.test(keyText) ||
                /submit|confirm|order|withdraw|login|register/i.test(keyText)
              ) {
                continue;
              }
              const fn = readProp(owner, key);
              if (
                typeof fn !== "function" ||
                routesInsteadOfOpeningWallet(functionSource(fn))
              ) {
                continue;
              }
              try {
                await Reflect.apply(fn, owner, []);
                return { label: `method:${keyText}` };
              } catch {
                // Try the next candidate.
              }
            }
          }
          const isVisibleControl = (element: RuntimeElement) => {
            const rect = element.getBoundingClientRect?.();
            if (!rect) return false;
            return (
              rect.width > 10 &&
              rect.height > 10 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const domDepositControl =
            elements.find(
              (element) =>
                String(readProp(element as RuntimeRecord, "id") ?? "") ===
                  "depositClick" && isVisibleControl(element),
            ) ??
            elements.find((element) => {
              if (!isVisibleControl(element)) return false;
              const text = [
                readProp(element as RuntimeRecord, "id"),
                readProp(element as RuntimeRecord, "className"),
                readProp(element as RuntimeRecord, "textContent"),
              ]
                .join(" ")
                .normalize("NFD")
                .replace(/[̀-ͯ]/g, "")
                .toLowerCase();
              return /depositclick|deposito|depositar|recarga|recharge/.test(
                text,
              );
            });
          if (
            domDepositControl &&
            typeof domDepositControl.click === "function"
          ) {
            try {
              domDepositControl.click();
              return { label: "dom:depositClick" };
            } catch {
              // Nothing else to try here.
            }
          }
          return { label: "" };
        },
        undefined,
        PATCHRIGHT_MAIN_WORLD,
      )
      .catch(() => undefined);

    if (result?.label) {
      await waitForDepositSurface(page, 4500).catch(() => false);
      return true;
    }
    return false;
  }

  private async fillDepositAmountAndGenerateQr(
    runId: string,
    page: Page,
    profileName: string,
    depositAmount: string,
  ): Promise<void> {
    this.ensureRunActive(runId);
    const spa = resolveContentFrame(page);

    // Deposito por INJECAO verificada no estado da SPA (Pinia store ou componente Wallet
    // no Vuex). RISCO ZERO de "QR falso": `programmaticDeposit` so retorna ok se a ordem for
    // NOVA (orderNo/registro mudou apos submeter), o valor BATER com o pedido e houver
    // copia-e-cola — tudo lido do estado autoritativo, NUNCA raspando pixel/DOM. A unica
    // tolerancia e abrir a superficie nativa de deposito para carregar stores lazy; jamais
    // clicamos para submeter pedido nem aceitamos QR sem validacao. Sem dado de pagador
    // fabricado (no Vuex o roleid vem da plataforma).
    let result = await programmaticDeposit(spa, depositAmount, 20000);
    if (!result.ok && result.reason === "stores-recharge-ausentes") {
      const opened = await this.tryOpenDepositViaSpaCommand(
        runId,
        page,
        profileName,
      );
      if (opened) {
        await waitForDepositSurface(page, 4500).catch(() => false);
        result = await programmaticDeposit(spa, depositAmount, 20000);
      }
    }
    if (!result.ok) {
      const capabilities = await this.describeDepositSpaCapabilities(
        page,
      ).catch(() => undefined);
      this.log(
        runId,
        "warning",
        `[${profileName}] Deposito programatico nao verificado (motivo=${result.reason ?? "desconhecido"})${
          result.diag ? ` diag=${result.diag}` : ""
        }${capabilities ? ` | ${capabilities}` : ""}`,
      );
      throw new Error(
        `deposito nao verificado (${result.reason ?? "desconhecido"})`,
      );
    }

    // Cinto e suspensorio: revalida no Node que o valor da ordem == pedido antes de exibir.
    const requestedAmount = Number(
      String(depositAmount).replace(/\s/g, "").replace(",", "."),
    );
    const confirmedAmount = Number(
      String(result.amount ?? "")
        .replace(/\s/g, "")
        .replace(",", "."),
    );
    if (
      !Number.isFinite(confirmedAmount) ||
      confirmedAmount !== requestedAmount
    ) {
      throw new Error(
        `valor da ordem (${result.amount ?? "?"}) diferente do pedido (${depositAmount})`,
      );
    }

    const copia = result.copiaECola ?? "";
    const maskedCopia =
      copia.length > 16 ? `${copia.slice(0, 8)}...${copia.slice(-6)}` : copia;
    this.log(
      runId,
      "success",
      `[${profileName}] Deposito ${depositAmount} verificado (${result.stack ?? "?"}) ordem=${
        result.orderNo ?? "?"
      } copia-e-cola=${maskedCopia}`,
    );

    // Restaura o viewport real e deixa o QR da propria plataforma visivel.
    // Aplica overlay para maximizar o QR na tela.
    await this.browserRuntime
      .clearLayoutViewportOverride(page)
      .catch(() => null);
    await this.waitForDepositQrCode(page, 2500).catch(() => false);
    await this.applyDepositQrOverlay(runId, page, profileName, depositAmount);
  }

  // Mostra o QR Code do deposito o maior possivel na janela (importante porque, com varias
  // telas abertas, cada janela fica pequena) e o valor logo abaixo numa tarja de destaque no
  // estilo vermelho da identidade do SpiderBOT. Usa MutationObserver para detectar o QR no DOM
  // de forma eficiente (sem polling 100%).
  // Geracao do watcher de QR por pagina. Cada watcher captura a sua geracao ao
  // iniciar e encerra assim que ela muda. Isso (a) impede dois watchers no mesmo
  // deposito — um novo supera o anterior — e (b) permite PARAR o watcher: o overlay
  // (position:fixed, z-index maximo, pointer-events:auto) cobre a tela toda e, se
  // ficar aberto quando outro fluxo assume a pagina (navegacao, slots, chave PIX,
  // saque), o Playwright nao consegue clicar (o overlay intercepta os eventos) e o
  // fluxo falha. stopQrOverlay() incrementa a geracao, encerrando o loop atual.
  private readonly qrWatcherGeneration = new WeakMap<Page, number>();

  // Para o watcher de QR e remove o overlay de TODAS as paginas do contexto do perfil.
  // Chamado no inicio de cada fluxo (em ensureLoggedIn) para o overlay nao bloquear
  // os cliques. Para o deposito e inofensivo: ele inicia um novo watcher logo apos.
  async stopQrOverlay(page: Page): Promise<void> {
    const targets = new Set<Page>([page]);
    try {
      for (const contextPage of page.context().pages()) {
        targets.add(contextPage);
      }
    } catch {
      /* contexto/pagina ja fechado: usamos so a page recebida */
    }
    await Promise.allSettled(
      Array.from(targets).map(async (target) => {
        const current = this.qrWatcherGeneration.get(target);
        if (current !== undefined) {
          this.qrWatcherGeneration.set(target, current + 1); // invalida o watcher atual
        }
        await this.dismissQrOverlay(target).catch(() => undefined);
      }),
    );
  }

  // Mostra o QR do deposito num overlay grande. Delega ao watcher unico em Node, que
  // captura o QR por SCREENSHOT (robusto contra src branco/placeholder), le o valor da
  // propria pagina e mantem o overlay sincronizado (atualiza ao trocar de deposito,
  // remove quando o QR some). E best-effort: nunca aborta o deposito ja gerado.
  async applyDepositQrOverlay(
    runId: string,
    page: Page,
    profileName: string,
    depositAmount: string,
  ): Promise<void> {
    this.ensureRunActive(runId);
    this.startQrOverlayWatcher(runId, page, profileName, depositAmount);
  }

  // Fallback robusto p/ obter a imagem do QR: captura o proprio elemento como PNG.
  // Resolve casos que a extracao via DOM nao cobre (canvas cross-origin/tainted,
  // QR renderizado como <table>, <svg> sem xmlns). Retorna data URL ou null.
  private async screenshotQrElement(
    runId: string,
    page: Page,
    profileName: string,
  ): Promise<string | null> {
    try {
      const frame = resolveContentFrame(page);
      const handle = await frame.evaluateHandle(() => {
        const QR_SELECTORS = [
          "#qrcode1 canvas",
          "#qrcode1 img",
          "#qrcode1 svg",
          "#qrcode1 table",
          ".codeimg canvas",
          ".codeimg img",
          ".codeimg svg",
          "[class*='qrcode' i]",
          "[id*='qrcode' i]",
          "[class*='qr-code' i]",
          "[id*='qr-code' i]",
          "canvas[class*='qr' i]",
          "img[class*='qr' i]",
          "img[src*='qr' i]",
          "svg[class*='qr' i]",
        ].join(",");
        const rawCandidates = Array.from(
          document.querySelectorAll(QR_SELECTORS),
        ) as Element[];
        const leafCandidates = rawCandidates.flatMap((candidate) => {
          const tag = candidate.tagName.toLowerCase();
          if (["canvas", "img", "svg", "table"].includes(tag)) {
            return [candidate];
          }
          return Array.from(candidate.querySelectorAll("canvas,img,svg,table"));
        });
        const visible = leafCandidates
          .filter(
            (candidate, index, candidates) =>
              candidates.indexOf(candidate) === index,
          )
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            const aspect = r.width / Math.max(1, r.height);
            const viewportArea = Math.max(
              1,
              window.innerWidth * window.innerHeight,
            );
            return (
              s.display !== "none" &&
              s.visibility !== "hidden" &&
              Number(s.opacity || "1") > 0.01 &&
              r.width > 8 &&
              r.height > 8 &&
              aspect >= 0.72 &&
              aspect <= 1.38 &&
              r.width <=
                Math.min(1200, Math.max(80, window.innerWidth * 0.82)) &&
              r.height <=
                Math.min(1200, Math.max(80, window.innerHeight * 0.82)) &&
              r.width * r.height <= viewportArea * 0.48
            );
          })
          .sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return rb.width * rb.height - ra.width * ra.height;
          });
        // Prefere um candidato que "pareca QR" (mix de preto e branco quando
        // amostrado); se nenhum for amostravel (cross-origin), usa o maior quadrado.
        const looksQr = (el: Element): boolean => {
          try {
            const c = document.createElement("canvas");
            c.width = 24;
            c.height = 24;
            const cx = c.getContext("2d");
            if (!cx) return false;
            cx.drawImage(el as CanvasImageSource, 0, 0, 24, 24);
            const d = cx.getImageData(0, 0, 24, 24).data;
            let dark = 0;
            let light = 0;
            for (let i = 0; i < d.length; i += 4) {
              if ((d[i + 3] ?? 0) <= 10) continue;
              const lum = ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3;
              if (lum < 110) dark += 1;
              else if (lum > 150) light += 1;
            }
            return dark > 20 && light > 20;
          } catch {
            return false; // cross-origin/nao desenhavel
          }
        };
        const semanticQr = (el: Element): boolean => {
          const hints = [
            el.id,
            el.getAttribute("class"),
            el.getAttribute("alt"),
            el.getAttribute("src"),
            el.parentElement?.id,
            el.parentElement?.getAttribute("class"),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return /qr|qrcode|qr-code|codeimg/.test(hints);
        };
        return visible.find(looksQr) ?? visible.find(semanticQr) ?? null;
      });

      const element = handle.asElement();
      if (!element) {
        await handle.dispose();
        return null;
      }
      try {
        // Amplia o elemento do QR temporariamente para capturar em ALTA resolucao.
        // O QR desta plataforma e SVG (vetor): aumentar o tamanho on-screen faz ele
        // re-rasterizar nitido (a captura no tamanho pequeno original ficava borrada
        // ao ampliar no overlay). Floata via position:fixed para nao ser cortado por
        // ancestrais com overflow:hidden. O estilo original e restaurado em seguida.
        const TARGET_PX = 720;
        const previousStyle = await element
          .evaluate((node, target) => {
            const el = node as Element;
            const prev = el.getAttribute("style");
            const enlarge =
              `position:fixed !important;left:0 !important;top:0 !important;` +
              `z-index:2147483646 !important;width:${target}px !important;` +
              `height:${target}px !important;max-width:none !important;` +
              `max-height:none !important;background:#fff !important;` +
              `margin:0 !important;padding:0 !important;transform:none !important`;
            el.setAttribute("style", prev ? `${prev};${enlarge}` : enlarge);
            return prev;
          }, TARGET_PX)
          .catch(() => undefined);

        let buffer: Buffer | null = null;
        try {
          buffer = await element.screenshot({ type: "png" });
        } finally {
          // Restaura o estilo original do elemento (mesmo se a captura falhar).
          await element
            .evaluate((node, prev) => {
              const el = node as Element;
              if (prev === null || prev === undefined) {
                el.removeAttribute("style");
              } else {
                el.setAttribute("style", prev);
              }
            }, previousStyle ?? null)
            .catch(() => undefined);
        }

        const dimensions = buffer ? readPngDimensions(buffer) : undefined;
        if (
          !buffer ||
          !dimensions ||
          !isPlausibleQrImageDimensions(dimensions.width, dimensions.height)
        ) {
          this.log(
            runId,
            "warning",
            `[${profileName}] Captura descartada: elemento nao possui dimensoes de QR (${dimensions?.width ?? 0}x${dimensions?.height ?? 0}).`,
          );
          return null;
        }
        return `data:image/png;base64,${buffer.toString("base64")}`;
      } finally {
        await handle.dispose().catch(() => undefined);
      }
    } catch {
      return null;
    }
  }

  // Renderiza o overlay do QR Code com o tema SpiderBOT (vermelho).
  // O overlay cobre a tela toda, mostra o QR maximizado e o valor do deposito.
  private async renderQrOverlay(
    _runId: string,
    page: Page,
    qrSrc: string,
    depositAmount: string,
    _profileName: string,
  ): Promise<boolean> {
    // Formata o valor em BRL (aceita "16", "16,00" ou ja "R$ 16,00").
    const amountText = this.formatDepositAmount(depositAmount);

    // Usa o frame de conteudo onde o QR code esta (importante para plataformas com iframe)
    const contentFrame = resolveContentFrame(page);

    return contentFrame
      .evaluate(
        async (payload) => {
          const OVERLAY_ID = "predator-deposit-qr-overlay";
          const REOPEN_ID = "predator-deposit-qr-reopen";
          const doc = document;
          if (!doc.body) {
            return {
              overlayCreated: false,
              bodyExists: false,
              imageLoaded: false,
            };
          }

          const {
            backdropStyle,
            qrImgStyle,
            barStyle,
            closeStyle,
            reopenStyle,
          } = payload.theme;

          // Substitui qualquer overlay anterior (novo deposito = novo QR/valor). O
          // ciclo de vida (atualizar/remover) e gerido pelo watcher em Node.
          doc.getElementById(OVERLAY_ID)?.remove();

          const root = doc.createElement("div");
          root.id = OVERLAY_ID;
          root.setAttribute("style", backdropStyle);

          const close = doc.createElement("div");
          close.setAttribute("style", closeStyle);
          close.textContent = "✕";

          const qrEl = doc.createElement("img");
          qrEl.setAttribute("alt", "QR Code PIX");
          qrEl.setAttribute("style", qrImgStyle);
          const imageReady = new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (loaded: boolean) => {
              if (settled) return;
              settled = true;
              resolve(loaded);
            };
            qrEl.addEventListener(
              "load",
              () => finish(qrEl.naturalWidth >= 40 && qrEl.naturalHeight >= 40),
              { once: true },
            );
            qrEl.addEventListener("error", () => finish(false), { once: true });
            window.setTimeout(() => finish(false), 2000);
          });
          qrEl.setAttribute("src", payload.src);

          const bar = doc.createElement("div");
          bar.setAttribute("style", barStyle);
          bar.textContent = payload.amountText;

          root.appendChild(close);
          root.appendChild(qrEl);
          root.appendChild(bar);
          doc.body.appendChild(root);

          const imageLoaded = await imageReady;
          if (!imageLoaded) {
            root.remove();
            return {
              overlayCreated: false,
              bodyExists: true,
              imageLoaded: false,
            };
          }

          let reopen = doc.getElementById(REOPEN_ID);
          if (!reopen) {
            reopen = doc.createElement("div");
            reopen.id = REOPEN_ID;
            reopen.textContent = "Mostrar QR  ⛶";
            doc.body.appendChild(reopen);
          }
          const reopenEl = reopen;
          reopenEl.setAttribute("style", reopenStyle + ";display:none");
          close.addEventListener("click", () => {
            root.setAttribute("style", backdropStyle + ";display:none");
            reopenEl.setAttribute("style", reopenStyle + ";display:flex");
          });
          reopenEl.addEventListener("click", () => {
            root.setAttribute("style", backdropStyle);
            reopenEl.setAttribute("style", reopenStyle + ";display:none");
          });

          return {
            overlayCreated: true,
            bodyExists: true,
            imageLoaded: true,
            imageWidth: qrEl.naturalWidth,
            imageHeight: qrEl.naturalHeight,
          };
        },
        { src: qrSrc, amountText, theme: qrOverlayTheme() },
      )
      .then((result) => {
        return result.overlayCreated === true && result.imageLoaded === true;
      })
      .catch(() => false);
  }

  // Observa o QR de um deposito MANUAL (feito pelo usuario na propria plataforma) e
  // mostra o overlay. Delega ao mesmo watcher unico em Node do caminho programatico.
  async armQrOverlayObserverForManualDeposit(
    runId: string,
    page: Page,
    depositAmount: string,
  ): Promise<void> {
    this.ensureRunActive(runId);
    this.startQrOverlayWatcher(runId, page, "ManualDeposit", depositAmount);
  }

  private parseBrlToNumber(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const cleaned = value
      .replace(/[R$\s.]/g, "")
      .replace(",", ".")
      .trim();
    const n = Number(cleaned);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  private isDepositAmountPlausible(
    pageAmount: string,
    expectedAmount: string,
  ): boolean {
    const page = this.parseBrlToNumber(pageAmount);
    const expected =
      this.parseBrlToNumber(expectedAmount) ??
      this.parseDepositNumber(expectedAmount);
    if (page === undefined || expected === undefined) return false;
    const ratio = page / expected;
    return ratio >= 0.95 && ratio <= 1.05;
  }

  // Formata um valor de deposito em BRL. Aceita "16", "16,00", "16.00" ou ja "R$ 16,00".
  private formatDepositAmount(value: string): string {
    const parsed = this.parseDepositNumber(value);
    if (typeof parsed === "number") {
      return parsed.toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      });
    }
    const trimmed = (value || "").trim();
    return trimmed.startsWith("R$") ? trimmed : `R$ ${trimmed}`;
  }

  // setTimeout com unref para nao segurar o event loop (importante nos testes).
  private sleepUnref(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  // Le o valor (R$) exibido na propria pagina do deposito (texto mais proeminente e
  // proximo do QR). Faz o overlay refletir o deposito ATUAL (e nao um valor antigo).
  private async readDepositAmountFromPage(page: Page): Promise<string | null> {
    return resolveContentFrame(page)
      .evaluate((selector) => {
        const re = /R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?/;
        const qrRect =
          (Array.from(document.querySelectorAll(selector)) as Element[])
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 8 && r.height > 8)
            .sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
        let best: { text: string; score: number } | null = null;
        for (const el of Array.from(
          document.querySelectorAll("body *"),
        ) as HTMLElement[]) {
          if (el.children.length > 0) continue;
          if (el.closest("#predator-deposit-qr-overlay")) continue;
          const m = (el.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .match(re);
          if (!m) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          const s = window.getComputedStyle(el);
          if (
            s.display === "none" ||
            s.visibility === "hidden" ||
            Number(s.opacity || "1") < 0.05
          )
            continue;
          const font = parseFloat(s.fontSize || "0") || 0;
          let score = font;
          if (qrRect) {
            const dx = r.left + r.width / 2 - (qrRect.left + qrRect.width / 2);
            const dy = r.top + r.height / 2 - (qrRect.top + qrRect.height / 2);
            score = font * 1000 - Math.sqrt(dx * dx + dy * dy);
          }
          if (!best || score > best.score)
            best = { text: m[0].replace(/\s+/g, " ").trim(), score };
        }
        return best?.text ?? null;
      }, QR_DETECT_SELECTOR)
      .catch(() => null);
  }

  // Espera o valor (R$) aparecer na propria pagina do deposito, ate timeoutMs.
  // Preferimos SEMPRE o valor lido da pagina (mais confiavel que o informado ao
  // bot, que pode divergir). Retorna null se a pagina nunca expor o valor a tempo.
  private async waitForDepositAmountFromPage(
    page: Page,
    timeoutMs: number,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const amount = await this.readDepositAmountFromPage(page);
      if (amount) return amount;
      if (Date.now() >= deadline || page.isClosed()) return null;
      await this.sleepUnref(250);
    }
  }

  // Remove o overlay do QR (e o botao "Mostrar QR") da pagina.
  private async dismissQrOverlay(page: Page): Promise<void> {
    await resolveContentFrame(page)
      .evaluate(() => {
        document.getElementById("predator-deposit-qr-overlay")?.remove();
        document.getElementById("predator-deposit-qr-reopen")?.remove();
      })
      .catch(() => undefined);
  }

  // Watcher unico (por page) que mantem o overlay do QR sincronizado com a pagina:
  // quando um QR aparece/muda, esconde o overlay antigo, extrai a imagem real do QR
  // (com screenshot restrito ao elemento como fallback), le o valor e (re)renderiza; quando o QR
  // some, remove o overlay. Roda em background por ate 5min; best-effort.
  private startQrOverlayWatcher(
    runId: string,
    page: Page,
    profileName: string,
    fallbackAmount: string,
  ): void {
    // Inicia uma nova geracao para esta pagina; supera qualquer watcher anterior.
    const myGeneration = (this.qrWatcherGeneration.get(page) ?? 0) + 1;
    this.qrWatcherGeneration.set(page, myGeneration);

    const deadline = Date.now() + 300000; // 5 min
    // Encerra se a pagina fechar OU se outro watcher/stopQrOverlay assumiu (geracao mudou).
    const isCurrent = () =>
      !page.isClosed() && this.qrWatcherGeneration.get(page) === myGeneration;
    const loop = async () => {
      let lastSig = "";
      // Ciclos consecutivos sem QR antes de remover o overlay. O QR PIX desta
      // plataforma re-renderiza/destaca o elemento brevemente (contador, redraw);
      // remover no primeiro "miss" fazia o overlay "piscar". Tolera ~3,6s.
      let missCount = 0;
      const MISS_LIMIT = 3;
      try {
        // O deposito pode terminar a run imediatamente depois de gerar o QR. O
        // overlay pertence a pagina, nao ao ciclo de vida da automacao, portanto
        // continua ativo ate o QR sumir, a pagina fechar ou expirar o prazo.
        while (Date.now() < deadline && isCurrent()) {
          try {
            const sig = await detectQrSignature(page);
            if (!isCurrent()) break;
            if (sig && sig !== lastSig) {
              missCount = 0;
              // Le o valor da pagina e valida contra o esperado. Se a pagina exibir
              // um valor absurdo (saldo, limite, promo) em vez do deposito real,
              // preferimos o fallbackAmount (valor solicitado ao bot).
              const pageAmount = await this.waitForDepositAmountFromPage(
                page,
                2500,
              );
              const amount =
                pageAmount &&
                this.isDepositAmountPlausible(pageAmount, fallbackAmount)
                  ? pageAmount
                  : fallbackAmount;
              if (!isCurrent()) break;
              // NAO removemos o overlay antes de ter o novo QR: renderQrOverlay
              // substitui o overlay anterior atomicamente, evitando o gap visivel.
              // extractQrCode le os pixels direto do DOM (canvas/img), entao nao e
              // afetado pelo overlay cobrir o QR.
              const extracted = await extractQrCode(
                runId,
                page,
                Date.now() + 4000,
                profileName,
              );
              if (!isCurrent()) break;
              let rendered = extracted
                ? await this.renderQrOverlay(
                    runId,
                    page,
                    extracted,
                    amount,
                    profileName,
                  )
                : false;
              // Fallback robusto: se a extracao falhou OU a imagem extraida nao
              // carregou no overlay (ex.: SVG/icone que nao renderiza como <img>),
              // captura o elemento por screenshot (PNG real dos pixels). O screenshot
              // precisa do QR desocluido, entao removemos o overlay antes.
              if (!rendered) {
                await this.dismissQrOverlay(page);
                const shot = await this.screenshotQrElement(
                  runId,
                  page,
                  profileName,
                );
                if (!isCurrent()) break;
                if (shot && shot !== extracted) {
                  rendered = await this.renderQrOverlay(
                    runId,
                    page,
                    shot,
                    amount,
                    profileName,
                  );
                }
              }
              if (rendered) {
                lastSig = sig;
              }
            } else if (sig) {
              missCount = 0; // QR estavel; nada a fazer
            } else if (lastSig) {
              // Sem QR neste ciclo: pode ser transitorio (redraw/contador). So
              // removemos o overlay apos MISS_LIMIT ciclos consecutivos sem QR.
              missCount += 1;
              if (missCount >= MISS_LIMIT) {
                await this.dismissQrOverlay(page);
                lastSig = "";
                missCount = 0;
              }
            }
          } catch {
            /* best-effort */
          }
          await this.sleepUnref(1200);
        }
      } finally {
        // So removemos overlay/geracao se ainda formos o watcher vigente. Se fomos
        // substituidos (deposito novo) ou parados (stopQrOverlay ja removeu o overlay),
        // quem assumiu cuida disso — evita apagar um overlay mais recente.
        if (this.qrWatcherGeneration.get(page) === myGeneration) {
          this.qrWatcherGeneration.delete(page);
          await this.dismissQrOverlay(page).catch(() => undefined);
        }
      }
    };
    void loop();
  }

  async selectPreferredDepositChannel(page: Page): Promise<string | undefined> {
    return resolveContentFrame(page)
      .evaluate(() => {
        type RuntimeElement = {
          click?: () => void;
          getAttribute?: (name: string) => string | null;
          getBoundingClientRect: () => {
            bottom: number;
            height: number;
            left: number;
            right: number;
            top: number;
            width: number;
          };
          querySelector?: (selector: string) => RuntimeElement | null;
          querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
          textContent?: string | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: {
            body: RuntimeElement;
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
          };
          getComputedStyle: (element: RuntimeElement) => {
            display: string;
            opacity: string;
            visibility: string;
            zIndex: string;
          };
          innerHeight: number;
          innerWidth: number;
        };
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const isVisible = (element: RuntimeElement) => {
          const style = runtimeWindow.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 8 &&
            rect.height > 8 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < runtimeWindow.innerWidth &&
            rect.top < runtimeWindow.innerHeight
          );
        };
        const depositRootSelector =
          ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],[class*='cashier' i],[id*='cashier' i],[class*='wallet' i],[id*='wallet' i]";
        const roots = Array.from(
          runtimeWindow.document.querySelectorAll(depositRootSelector),
        )
          .filter((root) => {
            const text = normalize(
              [
                root.textContent,
                root.getAttribute?.("class"),
                root.getAttribute?.("id"),
              ].join(" "),
            );
            return (
              isVisible(root) &&
              /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet|pix/.test(
                text,
              )
            );
          })
          .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            const leftZ =
              Number.parseInt(
                runtimeWindow.getComputedStyle(left).zIndex || "0",
                10,
              ) || 0;
            const rightZ =
              Number.parseInt(
                runtimeWindow.getComputedStyle(right).zIndex || "0",
                10,
              ) || 0;
            return (
              rightZ - leftZ ||
              rightRect.width * rightRect.height -
                leftRect.width * leftRect.height
            );
          });
        const root = roots[0] ?? runtimeWindow.document.body;
        const candidates = Array.from(
          root.querySelectorAll?.(
            "[class*='channel' i],[class*='pay' i],[class*='payment' i],[class*='pix' i],[class*='method' i],[role='button'],button",
          ) ?? [],
        )
          .filter(isVisible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = normalize(
              [
                element.textContent,
                element.getAttribute?.("class"),
                element.getAttribute?.("id"),
              ].join(" "),
            );
            let score = 0;
            if (/pix/.test(text)) {
              score += 90;
            }
            if (
              /canal|channel|pagamento|payment|metodo|method|pay/.test(text)
            ) {
              score += 45;
            }
            if (/active|selected|checked/.test(text)) {
              score += 20;
            }
            if (
              /deposito|recarga|recharge|saque|withdraw|login|registro|close|fechar|cancel/.test(
                text,
              )
            ) {
              score -= 60;
            }
            if (
              rect.width * rect.height >
              runtimeWindow.innerWidth * runtimeWindow.innerHeight * 0.3
            ) {
              score -= 40;
            }
            return { element, score, text };
          })
          .filter((candidate) => candidate.score > 30)
          .sort((left, right) => right.score - left.score);

        const candidate = candidates[0];
        candidate?.element.click?.();
        return candidate?.text;
      })
      .catch(() => undefined);
  }

  async waitForDepositAmountApplied(
    page: Page,
    amount: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const applied = await resolveContentFrame(page)
        .evaluate((expectedAmount) => {
          type RuntimeElement = {
            closest?: (selector: string) => RuntimeElement | null;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
            textContent?: string | null;
            value?: string;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              body: RuntimeElement;
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
              zIndex: string;
            };
            innerHeight: number;
            innerWidth: number;
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const parseNumber = (value: string | null | undefined) => {
            const cleaned = (value || "").replace(/[^\d,.-]/g, "").trim();
            if (!cleaned) {
              return Number.NaN;
            }
            const lastComma = cleaned.lastIndexOf(",");
            const lastDot = cleaned.lastIndexOf(".");
            const normalized =
              lastComma > lastDot
                ? cleaned.replace(/\./g, "").replace(",", ".")
                : cleaned.replace(/,/g, "");
            return Number(normalized);
          };
          const extractNumbers = (value: string | null | undefined) =>
            ((value || "").match(/-?\d[\d.,]*/g) || [])
              .map((entry) => parseNumber(entry))
              .filter((entry) => Number.isFinite(entry));
          const expectedNumber = parseNumber(expectedAmount);
          if (!Number.isFinite(expectedNumber)) {
            return false;
          }
          const isSameAmount = (value: number) =>
            Math.abs(value - expectedNumber) < 0.001;
          const isVisible = (element: RuntimeElement) => {
            const style = runtimeWindow.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 6 &&
              rect.height > 6 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const depositRootSelector =
            ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],[class*='cashier' i],[id*='cashier' i],[class*='wallet' i],[id*='wallet' i]";
          const roots = Array.from(
            runtimeWindow.document.querySelectorAll(depositRootSelector),
          )
            .filter((root) => {
              const text = normalize(
                [
                  root.textContent,
                  root.getAttribute?.("class"),
                  root.getAttribute?.("id"),
                ].join(" "),
              );
              return (
                isVisible(root) &&
                /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet|pix/.test(
                  text,
                )
              );
            })
            .sort((left, right) => {
              const leftRect = left.getBoundingClientRect();
              const rightRect = right.getBoundingClientRect();
              const leftZ =
                Number.parseInt(
                  runtimeWindow.getComputedStyle(left).zIndex || "0",
                  10,
                ) || 0;
              const rightZ =
                Number.parseInt(
                  runtimeWindow.getComputedStyle(right).zIndex || "0",
                  10,
                ) || 0;
              return (
                rightZ - leftZ ||
                rightRect.width * rightRect.height -
                  leftRect.width * leftRect.height
              );
            });
          const searchRoots =
            roots.length > 0
              ? roots.slice(0, 4)
              : [runtimeWindow.document.body];

          for (const root of searchRoots) {
            const fields = Array.from(
              root.querySelectorAll?.(
                "input,textarea,[contenteditable='true'],[role='textbox']",
              ) ?? [],
            ).filter(isVisible);
            for (const field of fields) {
              const rawValue =
                typeof field.value === "string"
                  ? field.value
                  : field.textContent || "";
              if (isSameAmount(parseNumber(rawValue))) {
                return true;
              }
            }

            const selectedAmounts = Array.from(
              root.querySelectorAll?.(
                "[class*='active' i],[class*='selected' i],[class*='checked' i],[aria-selected='true'],[aria-checked='true'],button,[role='button'],.ui-button,.van-button",
              ) ?? [],
            ).filter(isVisible);
            for (const element of selectedAmounts) {
              const marker = normalize(
                [
                  element.getAttribute?.("class"),
                  element.getAttribute?.("aria-selected"),
                  element.getAttribute?.("aria-checked"),
                  element
                    .closest?.(
                      "[class*='active' i],[class*='selected' i],[class*='checked' i]",
                    )
                    ?.getAttribute?.("class"),
                ].join(" "),
              );
              if (!/active|selected|checked|true/.test(marker)) {
                continue;
              }
              const text = normalize(element.textContent);
              if (
                text.length <= 64 &&
                extractNumbers(text).some(isSameAmount)
              ) {
                return true;
              }
            }
          }

          return false;
        }, amount)
        .catch(() => false);

      if (applied) {
        return true;
      }
      await page.waitForTimeout(150);
    }

    return false;
  }

  async clickDepositAmountPreset(
    runId: string,
    page: Page,
    amount: string,
  ): Promise<string | undefined> {
    this.ensureRunActive(runId);
    const targetToken = `deposit-preset-${Date.now()}-${this.randomInt(1000, 9999)}`;
    const label = await resolveContentFrame(page)
      .evaluate(
        ({ depositAmount, targetToken }) => {
          type RuntimeElement = {
            closest?: (selector: string) => RuntimeElement | null;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
            setAttribute?: (name: string, value: string) => void;
            textContent?: string | null;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              body: RuntimeElement;
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
              zIndex: string;
            };
            innerHeight: number;
            innerWidth: number;
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const parseNumber = (value: string | null | undefined) => {
            const cleaned = (value || "").replace(/[^\d,.-]/g, "").trim();
            if (!cleaned) {
              return Number.NaN;
            }
            const lastComma = cleaned.lastIndexOf(",");
            const lastDot = cleaned.lastIndexOf(".");
            const normalized =
              lastComma > lastDot
                ? cleaned.replace(/\./g, "").replace(",", ".")
                : cleaned.replace(/,/g, "");
            return Number(normalized);
          };
          const extractNumbers = (value: string | null | undefined) =>
            ((value || "").match(/-?\d[\d.,]*/g) || [])
              .map((entry) => parseNumber(entry))
              .filter((entry) => Number.isFinite(entry));
          const expectedNumber = parseNumber(depositAmount);
          if (!Number.isFinite(expectedNumber)) {
            return undefined;
          }
          const isSameAmount = (value: number) =>
            Math.abs(value - expectedNumber) < 0.001;
          const isVisible = (element: RuntimeElement) => {
            const style = runtimeWindow.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const depositRootSelector =
            ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],[class*='cashier' i],[id*='cashier' i],[class*='wallet' i],[id*='wallet' i]";
          const roots = Array.from(
            runtimeWindow.document.querySelectorAll(depositRootSelector),
          )
            .filter((root) => {
              const text = normalize(
                [
                  root.textContent,
                  root.getAttribute?.("class"),
                  root.getAttribute?.("id"),
                ].join(" "),
              );
              return (
                isVisible(root) &&
                /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet|pix/.test(
                  text,
                )
              );
            })
            .sort((left, right) => {
              const leftRect = left.getBoundingClientRect();
              const rightRect = right.getBoundingClientRect();
              const leftZ =
                Number.parseInt(
                  runtimeWindow.getComputedStyle(left).zIndex || "0",
                  10,
                ) || 0;
              const rightZ =
                Number.parseInt(
                  runtimeWindow.getComputedStyle(right).zIndex || "0",
                  10,
                ) || 0;
              return (
                rightZ - leftZ ||
                rightRect.width * rightRect.height -
                  leftRect.width * leftRect.height
              );
            });
          const searchRoots =
            roots.length > 0
              ? roots.slice(0, 4)
              : [runtimeWindow.document.body];
          // Nao deixar o fallback p/ document.body captar nossos overlays injetados.
          const injectedOverlaySelector =
            "#spider-acct-info,#predator-splash-overlay,#predator-deposit-qr-overlay,#predator-deposit-qr-reopen";
          const candidates = new Map<
            RuntimeElement,
            {
              element: RuntimeElement;
              label: string;
              score: number;
              area: number;
              top: number;
            }
          >();
          const optionSelector =
            "button,[role='button'],.ui-button,.van-button,[class*='amount' i],[class*='money' i],[class*='quick' i],[class*='price' i],[class*='valor' i],[class*='value' i],div,span";
          const clickableSelector =
            "button,[role='button'],.ui-button,.van-button,[class*='button' i],[class*='btn' i]";

          for (const root of searchRoots) {
            for (const element of root.querySelectorAll?.(optionSelector) ??
              []) {
              const clickable = element.closest?.(clickableSelector) ?? element;
              if (
                !isVisible(clickable) ||
                clickable.closest?.(injectedOverlaySelector)
              ) {
                continue;
              }

              const rect = clickable.getBoundingClientRect();
              const labelText = normalize(
                element.textContent || clickable.textContent || "",
              );
              if (!labelText || labelText.length > 64) {
                continue;
              }

              const attrs = normalize(
                [
                  element.getAttribute?.("class"),
                  element.getAttribute?.("id"),
                  clickable.getAttribute?.("class"),
                  clickable.getAttribute?.("id"),
                  clickable.getAttribute?.("aria-label"),
                  clickable.getAttribute?.("title"),
                ].join(" "),
              );
              const haystack = `${labelText} ${attrs}`;
              if (
                /cancelar|cancel|fechar|close|saque|withdraw|login|registro|suporte|service|depositar|confirmar|submit|pagar|pay/.test(
                  haystack,
                )
              ) {
                continue;
              }

              const matchingAmount =
                extractNumbers(labelText).some(isSameAmount);
              if (!matchingAmount) {
                continue;
              }

              let score = 100;
              if (
                /amount|money|quick|price|valor|value|recharge|deposit|recarga|deposito/.test(
                  attrs,
                )
              ) {
                score += 35;
              }
              if (/active|selected|checked/.test(attrs)) {
                score += 16;
              }
              if (/minimo|maximo|minimum|maximum|limite|limit/.test(haystack)) {
                score -= 45;
              }
              if (
                rect.width * rect.height >
                runtimeWindow.innerWidth * runtimeWindow.innerHeight * 0.12
              ) {
                score -= 55;
              }

              if (score < 55) {
                continue;
              }

              const existing = candidates.get(clickable);
              const candidate = {
                element: clickable,
                label: labelText,
                score,
                area: rect.width * rect.height,
                top: rect.top,
              };
              if (
                !existing ||
                score > existing.score ||
                (score === existing.score && candidate.area < existing.area)
              ) {
                candidates.set(clickable, candidate);
              }
            }
          }

          const candidate = Array.from(candidates.values()).sort(
            (left, right) =>
              right.score - left.score ||
              left.area - right.area ||
              right.top - left.top,
          )[0];
          candidate?.element.setAttribute?.(
            "data-predator-deposit-preset-target",
            targetToken,
          );
          return candidate?.label;
        },
        { depositAmount: amount, targetToken },
      )
      .catch(() => undefined);

    if (!label) {
      return undefined;
    }

    const target = resolveContentFrame(page)
      .locator(`[data-predator-deposit-preset-target="${targetToken}"]`)
      .first();
    await this.withPopupPageGuard(page, async () => {
      await this.fastClickControl(runId, page, target).catch(async () => {
        await target.click({ timeout: 1200, force: true }).catch(async () => {
          await target
            .evaluate((element) => {
              (element as unknown as { click: () => void }).click();
            })
            .catch(() => undefined);
        });
      });
    }).catch(() => undefined);

    await target
      .evaluate((element) =>
        element.removeAttribute("data-predator-deposit-preset-target"),
      )
      .catch(() => undefined);
    await page.waitForTimeout(250);
    return `opcao ${label}`;
  }

  async applyDepositAmountViaSpaState(
    runId: string,
    page: Page,
    _profileName: string,
    depositAmount: string,
  ): Promise<string | undefined> {
    this.ensureRunActive(runId);
    const result = await resolveContentFrame(page)
      .evaluate(
        (amountToApply) => {
          type RuntimeRecord = Record<PropertyKey, unknown>;
          type RuntimeElement = {
            __vue__?: unknown;
            __vueParentComponent?: RuntimeRecord | null;
            __vue_app__?: RuntimeRecord | null;
            getAttribute?: (name: string) => string | null;
            querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              body?: RuntimeElement;
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
          };
          const isObject = (value: unknown): value is RuntimeRecord =>
            Boolean(value) &&
            (typeof value === "object" || typeof value === "function");
          const readProp = (
            target: RuntimeRecord,
            key: PropertyKey,
          ): unknown => {
            try {
              return target[key];
            } catch {
              return undefined;
            }
          };
          const parseNumber = (value: unknown) => {
            const cleaned = String(value ?? "")
              .replace(/[^\d,.-]/g, "")
              .trim();
            if (!cleaned) return Number.NaN;
            const lastComma = cleaned.lastIndexOf(",");
            const lastDot = cleaned.lastIndexOf(".");
            const normalized =
              lastComma > lastDot
                ? cleaned.replace(/\./g, "").replace(",", ".")
                : cleaned.replace(/,/g, "");
            return Number(normalized);
          };
          const expectedNumber = parseNumber(amountToApply);
          if (!Number.isFinite(expectedNumber)) {
            return {
              confirmed: false,
              reason: "amount-invalid",
              stores: 0,
              touched: [] as string[],
            };
          }

          const seen = new Set<RuntimeRecord>();
          const stores: RuntimeRecord[] = [];
          const hasFormModel = (target: RuntimeRecord) => {
            const formModel = readProp(target, "formModel");
            const state = readProp(target, "$state");
            return (
              isObject(formModel) ||
              (isObject(state) && isObject(readProp(state, "formModel")))
            );
          };
          const visit = (value: unknown, depth: number): void => {
            if (!isObject(value) || seen.has(value) || seen.size > 1800) {
              return;
            }
            seen.add(value);
            if (hasFormModel(value)) {
              stores.push(value);
            }
            if (depth >= 5) {
              return;
            }
            for (const key of Reflect.ownKeys(value).slice(0, 80)) {
              const child = readProp(value, key);
              if (!isObject(child)) {
                continue;
              }
              if (
                child === runtimeWindow.document ||
                child === runtimeWindow.document.body
              ) {
                continue;
              }
              visit(child, depth + 1);
            }
          };

          const elements = Array.from(
            runtimeWindow.document.querySelectorAll(
              "#app,#app *,[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],.ui-popup,.van-popup,.modal,.popup,body",
            ),
          ).slice(0, 2200);
          for (const element of elements) {
            visit(element.__vue__, 0);
            const vue3 = element.__vueParentComponent;
            if (vue3) {
              visit(vue3, 0);
              visit(readProp(vue3, "proxy"), 0);
              visit(readProp(vue3, "ctx"), 0);
              visit(readProp(vue3, "setupState"), 0);
              visit(readProp(vue3, "exposed"), 0);
              visit(readProp(vue3, "appContext"), 0);
            }
            const app = element.__vue_app__;
            if (app) {
              visit(app, 0);
              visit(readProp(app, "_context"), 0);
              visit(readProp(app, "config"), 0);
            }
          }

          const touched: string[] = [];
          const confirmed: string[] = [];
          const callSafely = (
            fn: unknown,
            thisArg: unknown,
            args: unknown[],
          ) => {
            if (typeof fn !== "function") {
              return;
            }
            try {
              Reflect.apply(fn, thisArg, args);
            } catch {
              // Best effort: reactive assignment is the important part.
            }
          };
          const candidateKeysFor = (
            store: RuntimeRecord,
            formModel: RuntimeRecord,
          ) => {
            const rawKeys = [
              readProp(store, "activeCategoryTypeText"),
              readProp(store, "activeTabIndex"),
              readProp(store, "activeCategoryType"),
              "online",
              "crypto",
              "transfer",
              "artificial",
              "merchant",
              ...Object.keys(formModel),
            ];
            return rawKeys
              .map((entry) => String(entry ?? "").trim())
              .filter(Boolean)
              .filter((entry, index, list) => list.indexOf(entry) === index);
          };

          for (const store of stores) {
            const state = readProp(store, "$state");
            const formModel = (
              isObject(readProp(store, "formModel"))
                ? readProp(store, "formModel")
                : isObject(state)
                  ? readProp(state, "formModel")
                  : undefined
            ) as RuntimeRecord | undefined;
            if (!formModel) {
              continue;
            }
            for (const key of candidateKeysFor(store, formModel)) {
              const model = readProp(formModel, key);
              if (!isObject(model) || !("amount" in model)) {
                continue;
              }
              try {
                model.amount = amountToApply;
                touched.push(key);
                if ("preAmount" in store) {
                  store.preAmount = amountToApply;
                }
                callSafely(readProp(store, "updateFee"), store, [key]);
                callSafely(readProp(store, "$patch"), store, [
                  (draft: RuntimeRecord) => {
                    const draftFormModel = readProp(draft, "formModel");
                    const draftModel = isObject(draftFormModel)
                      ? readProp(draftFormModel, key)
                      : undefined;
                    if (isObject(draftModel) && "amount" in draftModel) {
                      draftModel.amount = amountToApply;
                    }
                  },
                ]);
                const appliedNumber = parseNumber(model.amount);
                if (
                  Number.isFinite(appliedNumber) &&
                  Math.abs(appliedNumber - expectedNumber) < 0.001
                ) {
                  confirmed.push(key);
                }
              } catch {
                // Try the next store/key.
              }
            }
          }

          for (const vm of seen) {
            if (!("rechargeNumber" in vm)) {
              continue;
            }
            try {
              vm.rechargeNumber = amountToApply;
              touched.push("rechargeNumber");
              callSafely(readProp(vm, "numberInputEvent"), vm, []);
              callSafely(readProp(vm, "$forceUpdate"), vm, []);
              const rechargeAmount = readProp(vm, "rechargeAmount");
              if (isObject(rechargeAmount)) {
                rechargeAmount.value = -1;
              }
              const appliedNumber = parseNumber(readProp(vm, "rechargeNumber"));
              if (
                Number.isFinite(appliedNumber) &&
                Math.abs(appliedNumber - expectedNumber) < 0.001
              ) {
                confirmed.push("rechargeNumber");
              }
            } catch {
              // Try the next component.
            }
          }

          const forceUpdated = new Set<RuntimeRecord>();
          for (const element of elements.slice(0, 500)) {
            for (const value of [
              element.__vue__,
              element.__vueParentComponent,
              element.__vueParentComponent?.proxy,
            ]) {
              if (!isObject(value) || forceUpdated.has(value)) {
                continue;
              }
              forceUpdated.add(value);
              callSafely(readProp(value, "$forceUpdate"), value, []);
              callSafely(readProp(value, "update"), value, []);
            }
          }

          return {
            confirmed: confirmed.length > 0,
            reason:
              confirmed.length > 0
                ? "applied"
                : touched.length > 0
                  ? "touched-unconfirmed"
                  : "store-not-found",
            stores: stores.length,
            touched,
          };
        },
        depositAmount,
        PATCHRIGHT_MAIN_WORLD,
      )
      .catch(() => undefined);

    if (result?.confirmed) {
      await page.waitForTimeout(250).catch(() => undefined);
      return `estado SPA ${result.touched.join(", ")}`;
    }

    return undefined;
  }

  async fillDepositAmountWithVisualKeypad(
    runId: string,
    page: Page,
    amount: string,
  ): Promise<string | undefined> {
    this.ensureRunActive(runId);
    const targetToken = `deposit-keypad-${Date.now()}-${this.randomInt(1000, 9999)}`;
    const frame = resolveContentFrame(page);
    const focused = await frame
      .evaluate(
        ({ targetToken }) => {
          type RuntimeElement = {
            blur?: () => void;
            click?: () => void;
            closest?: (selector: string) => RuntimeElement | null;
            focus?: () => void;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            parentElement?: RuntimeElement | null;
            querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
            setAttribute?: (name: string, value: string) => void;
            textContent?: string | null;
            value?: string;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              body: RuntimeElement;
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
              zIndex: string;
            };
            innerHeight: number;
            innerWidth: number;
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const isVisible = (
            element: RuntimeElement,
            allowOffscreen = false,
          ) => {
            const style = runtimeWindow.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const inViewport = allowOffscreen
              ? rect.right > -runtimeWindow.innerWidth &&
                rect.bottom > -runtimeWindow.innerHeight &&
                rect.left < runtimeWindow.innerWidth * 2 &&
                rect.top < runtimeWindow.innerHeight * 2
              : rect.right > 0 &&
                rect.bottom > 0 &&
                rect.left < runtimeWindow.innerWidth &&
                rect.top < runtimeWindow.innerHeight;
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8 &&
              inViewport
            );
          };
          const unique = (items: RuntimeElement[]) =>
            items.filter(
              (element, index, list) => list.indexOf(element) === index,
            );
          const depositRootSelector =
            ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],[class*='cashier' i],[id*='cashier' i],[class*='wallet' i],[id*='wallet' i]";
          const roots = Array.from(
            runtimeWindow.document.querySelectorAll(depositRootSelector),
          )
            .filter((root) => {
              const text = normalize(
                [
                  root.textContent,
                  root.getAttribute?.("class"),
                  root.getAttribute?.("id"),
                ].join(" "),
              );
              return (
                isVisible(root, true) &&
                /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet|pix|pagamento|payment/.test(
                  text,
                )
              );
            })
            .sort((left, right) => {
              const leftRect = left.getBoundingClientRect();
              const rightRect = right.getBoundingClientRect();
              const leftZ =
                Number.parseInt(
                  runtimeWindow.getComputedStyle(left).zIndex || "0",
                  10,
                ) || 0;
              const rightZ =
                Number.parseInt(
                  runtimeWindow.getComputedStyle(right).zIndex || "0",
                  10,
                ) || 0;
              return (
                rightZ - leftZ ||
                rightRect.width * rightRect.height -
                  leftRect.width * leftRect.height
              );
            });
          const searchRoots = unique([
            ...roots.slice(0, 8),
            runtimeWindow.document.body,
          ]);
          const injectedOverlaySelector =
            "#spider-acct-info,#predator-splash-overlay,#predator-deposit-qr-overlay,#predator-deposit-qr-reopen";
          const selectors = [
            "input",
            "textarea",
            "[contenteditable='true']",
            "[role='textbox']",
            ".ui-input",
            ".ui-input__input",
            "[class*='amount-input' i]",
            "[class*='amount-form-item' i]",
            "[class*='input-box' i]",
            "[class*='money' i]",
            "[class*='count' i]",
          ].join(",");
          const candidates = unique(
            searchRoots.flatMap((root) =>
              Array.from(root.querySelectorAll?.(selectors) ?? []),
            ),
          )
            .filter(
              (element) =>
                isVisible(element, true) &&
                !element.closest?.(injectedOverlaySelector),
            )
            .map((element) => {
              const rect = element.getBoundingClientRect();
              const wrapper =
                element.closest?.(
                  ".ui-input,[class*='amount-input' i],[class*='amount-form-item' i],[class*='input-box' i],label",
                ) ??
                element.parentElement ??
                element;
              const own = normalize(
                [
                  element.getAttribute?.("type"),
                  element.getAttribute?.("placeholder"),
                  element.getAttribute?.("name"),
                  element.getAttribute?.("id"),
                  element.getAttribute?.("class"),
                  element.getAttribute?.("inputmode"),
                  element.getAttribute?.("aria-label"),
                  element.getAttribute?.("title"),
                  element.textContent,
                ].join(" "),
              );
              const wrapperText = normalize(
                [
                  wrapper.getAttribute?.("class"),
                  wrapper.getAttribute?.("id"),
                  wrapper.getAttribute?.("aria-label"),
                  wrapper.textContent,
                ].join(" "),
              );
              const haystack = `${own} ${wrapperText}`;
              let score = 0;
              if (
                /amount|valor|quantia|montante|money|preco|price/.test(haystack)
              )
                score += 85;
              if (
                /minimo|maximo|minimum|maximum|limite|limit|min|max/.test(
                  haystack,
                )
              )
                score += 55;
              if (/r\$|brl|pix|moeda|currency/.test(haystack)) score += 45;
              if (
                /ui-input|input-box|amount-input|amount-form-item/.test(
                  haystack,
                )
              )
                score += 60;
              if (
                /input|textarea|textbox|number|tel|numeric|decimal/.test(
                  haystack,
                )
              )
                score += 35;
              if (
                /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet/.test(
                  haystack,
                )
              )
                score += 18;
              if (rect.top > runtimeWindow.innerHeight * 0.82) score -= 90;
              if (
                rect.width * rect.height >
                runtimeWindow.innerWidth * runtimeWindow.innerHeight * 0.3
              )
                score -= 60;
              if (
                /canal|channel|pagamento|payment|metodo|method|confirmar|submit|depositar agora|saque|withdraw|senha|password|telefone|cpf|email/.test(
                  haystack,
                )
              ) {
                score -= 120;
              }
              return {
                element: wrapper,
                label: haystack.slice(0, 96) || "valor",
                score,
              };
            })
            .filter((candidate) => candidate.score > 45)
            .sort((left, right) => right.score - left.score);

          const candidate = candidates[0];
          if (!candidate) {
            return undefined;
          }
          candidate.element.setAttribute?.(
            "data-predator-deposit-keypad-target",
            targetToken,
          );
          candidate.element.focus?.();
          candidate.element.click?.();
          return candidate.label;
        },
        { targetToken },
      )
      .catch(() => undefined);

    if (!focused) {
      return undefined;
    }

    await page.waitForTimeout(140).catch(() => undefined);
    const keypadResult = await frame
      .evaluate(
        async ({ depositAmount, targetToken }) => {
          type RuntimeElement = {
            blur?: () => void;
            click?: () => void;
            closest?: (selector: string) => RuntimeElement | null;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
            removeAttribute?: (name: string) => void;
            textContent?: string | null;
            value?: string;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              activeElement?: RuntimeElement | null;
              body: RuntimeElement;
              querySelector: (selector: string) => RuntimeElement | null;
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
              zIndex: string;
            };
            innerHeight: number;
            innerWidth: number;
          };
          const wait = (ms: number) =>
            new Promise((resolve) => setTimeout(resolve, ms));
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const isVisible = (element: RuntimeElement) => {
            const style = runtimeWindow.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 14 &&
              rect.height > 14 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };
          const parseNumber = (value: string | null | undefined) => {
            const cleaned = (value || "").replace(/[^\d,.-]/g, "").trim();
            if (!cleaned) return Number.NaN;
            const lastComma = cleaned.lastIndexOf(",");
            const lastDot = cleaned.lastIndexOf(".");
            const normalized =
              lastComma > lastDot
                ? cleaned.replace(/\./g, "").replace(",", ".")
                : cleaned.replace(/,/g, "");
            return Number(normalized);
          };
          const expectedNumber = parseNumber(depositAmount);
          const digits = depositAmount.replace(/\D+/g, "");
          if (!digits || !Number.isFinite(expectedNumber)) {
            return { clicked: 0, confirmed: false };
          }
          const target = runtimeWindow.document.querySelector(
            `[data-predator-deposit-keypad-target="${targetToken}"]`,
          );
          const readTargetValue = () => {
            if (!target) return "";
            const direct = typeof target.value === "string" ? target.value : "";
            return direct || target.textContent || "";
          };
          const isExpected = (value: string | null | undefined) => {
            const parsed = parseNumber(value);
            return (
              Number.isFinite(parsed) &&
              Math.abs(parsed - expectedNumber) < 0.001
            );
          };
          if (isExpected(readTargetValue())) {
            target?.removeAttribute?.("data-predator-deposit-keypad-target");
            return { clicked: 0, confirmed: true };
          }

          const clickableSelector =
            "button,[role='button'],.van-key,.van-number-keyboard__key,.ui-key,.ui-keyboard__key,[class*='key' i],[class*='keyboard' i],[class*='kb' i],div,span";
          const allClickables = () =>
            Array.from(
              runtimeWindow.document.querySelectorAll(clickableSelector),
            )
              .filter(isVisible)
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                if (rect.top < runtimeWindow.innerHeight * 0.58) return false;
                const attrs = normalize(
                  [
                    element.getAttribute?.("class"),
                    element.getAttribute?.("id"),
                    element.getAttribute?.("aria-label"),
                    element.getAttribute?.("title"),
                    element.textContent,
                  ].join(" "),
                );
                return !/depositar|confirmar|submit|pagamento|payment|metodo|method|canal|channel/.test(
                  attrs,
                );
              });
          const findDigitKey = (digit: string) =>
            allClickables()
              .filter((element) => normalize(element.textContent) === digit)
              .sort((left, right) => {
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                return (
                  rightRect.top - leftRect.top ||
                  rightRect.width * rightRect.height -
                    leftRect.width * leftRect.height
                );
              })[0];

          let clicked = 0;
          for (const digit of digits) {
            const key = findDigitKey(digit);
            if (!key) {
              break;
            }
            key.click?.();
            clicked += 1;
            await wait(80);
          }

          const hideKey = allClickables()
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              const text = normalize(element.textContent);
              const attrs = normalize(
                [
                  element.getAttribute?.("class"),
                  element.getAttribute?.("id"),
                  element.getAttribute?.("aria-label"),
                  element.getAttribute?.("title"),
                ].join(" "),
              );
              return (
                rect.top > runtimeWindow.innerHeight * 0.82 &&
                (/(keyboard|teclado|hide|close|done|ok|collapse)/.test(attrs) ||
                  text === "") &&
                !/(delete|backspace|del|apagar|limpar|clear)/.test(attrs)
              );
            })
            .sort(
              (left, right) =>
                left.getBoundingClientRect().left -
                right.getBoundingClientRect().left,
            )[0];
          hideKey?.click?.();
          runtimeWindow.document.activeElement?.blur?.();
          target?.blur?.();
          target?.removeAttribute?.("data-predator-deposit-keypad-target");
          await wait(120);

          return {
            clicked,
            confirmed: isExpected(readTargetValue()),
          };
        },
        { depositAmount: amount, targetToken },
      )
      .catch(() => ({ clicked: 0, confirmed: false }));

    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(220).catch(() => undefined);
    if (
      keypadResult.confirmed ||
      keypadResult.clicked === amount.replace(/\D+/g, "").length
    ) {
      return `teclado numerico visual (${focused})`;
    }

    return undefined;
  }

  async fillDepositAmountField(
    runId: string,
    page: Page,
    amount: string,
  ): Promise<string | undefined> {
    const targetToken = `deposit-${Date.now()}-${this.randomInt(1000, 9999)}`;
    const fieldResult = await resolveContentFrame(page)
      .evaluate(
        ({ depositAmount, targetToken }) => {
          type RuntimeElement = {
            closest?: (selector: string) => RuntimeElement | null;
            disabled?: boolean;
            dispatchEvent?: (event: unknown) => boolean;
            focus?: () => void;
            getAttribute: (name: string) => string | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            parentElement?: RuntimeElement | null;
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            readOnly?: boolean;
            removeAttribute?: (name: string) => void;
            setAttribute?: (name: string, value: string) => void;
            textContent?: string | null;
            value?: string;
          };
          const runtimeWindow = globalThis as unknown as {
            Event: new (type: string, init?: { bubbles?: boolean }) => unknown;
            InputEvent?: new (
              type: string,
              init?: { bubbles?: boolean; data?: string; inputType?: string },
            ) => unknown;
            document: {
              body: RuntimeElement;
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
              zIndex: string;
            };
            innerHeight: number;
            innerWidth: number;
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const isVisible = (
            element: RuntimeElement,
            allowOffscreen = false,
          ) => {
            const style = runtimeWindow.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const inViewport = allowOffscreen
              ? rect.right > -runtimeWindow.innerWidth &&
                rect.bottom > -runtimeWindow.innerHeight &&
                rect.left < runtimeWindow.innerWidth * 2 &&
                rect.top < runtimeWindow.innerHeight * 2
              : rect.right > 0 &&
                rect.bottom > 0 &&
                rect.left < runtimeWindow.innerWidth &&
                rect.top < runtimeWindow.innerHeight;
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8 &&
              inViewport
            );
          };
          const depositRootSelector =
            ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],[class*='cashier' i],[id*='cashier' i],[class*='wallet' i],[id*='wallet' i]";
          const roots = Array.from(
            runtimeWindow.document.querySelectorAll(depositRootSelector),
          )
            .filter((root) => {
              const text = normalize(
                [
                  root.textContent,
                  root.getAttribute("class"),
                  root.getAttribute("id"),
                ].join(" "),
              );
              return (
                isVisible(root, true) &&
                /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet|pix/.test(
                  text,
                )
              );
            })
            .sort((left, right) => {
              const leftRect = left.getBoundingClientRect();
              const rightRect = right.getBoundingClientRect();
              const leftZ =
                Number.parseInt(
                  runtimeWindow.getComputedStyle(left).zIndex || "0",
                  10,
                ) || 0;
              const rightZ =
                Number.parseInt(
                  runtimeWindow.getComputedStyle(right).zIndex || "0",
                  10,
                ) || 0;
              return (
                rightZ - leftZ ||
                rightRect.width * rightRect.height -
                  leftRect.width * leftRect.height
              );
            });
          const root = roots[0] ?? runtimeWindow.document.body;
          const rootIsDeposit = roots.length > 0;
          const injectedOverlaySelector =
            "#spider-acct-info,#predator-splash-overlay,#predator-deposit-qr-overlay,#predator-deposit-qr-reopen";
          const unique = (items: RuntimeElement[]) =>
            items.filter(
              (element, index, list) => list.indexOf(element) === index,
            );
          const searchRoots = unique([
            ...roots.slice(0, 8),
            root,
            runtimeWindow.document.body,
          ]);
          const visibleInputs = Array.from(
            unique(
              searchRoots.flatMap((searchRoot) =>
                Array.from(
                  searchRoot.querySelectorAll(
                    "input,textarea,[contenteditable='true'],[role='textbox']",
                  ),
                ),
              ),
            ),
          ).filter(
            (element) =>
              isVisible(element, true) &&
              !element.closest?.(injectedOverlaySelector),
          );
          const candidates = visibleInputs
            .filter((element) => {
              const type = normalize(element.getAttribute("type"));
              return ![
                "password",
                "checkbox",
                "radio",
                "hidden",
                "file",
              ].includes(type);
            })
            .map((element) => {
              const type = normalize(element.getAttribute("type"));
              const placeholder = normalize(
                element.getAttribute("placeholder"),
              );
              const wrapper =
                element.closest?.(
                  "label,.ui-input,.van-field,.form-item,.form-control,.input-item,.el-form-item",
                ) ?? element.parentElement;
              const ownHaystack = normalize(
                [
                  placeholder,
                  element.getAttribute("name"),
                  element.getAttribute("id"),
                  element.getAttribute("class"),
                  element.getAttribute("data-input-name"),
                  element.getAttribute("inputmode"),
                  element.getAttribute("aria-label"),
                  element.getAttribute("title"),
                  type,
                ].join(" "),
              );
              const wrapperText = normalize(wrapper?.textContent);
              const haystack = normalize(
                [ownHaystack, wrapper?.textContent].join(" "),
              );
              const amountPattern =
                /valor|amount|quantia|montante|money|preco|price/;
              const depositPattern =
                /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet/;
              const currencyPattern = /r\$|brl|pix|moeda|currency/;
              const numericPattern = /numeric|decimal|number|tel/;
              const limitPattern =
                /minimo|maximo|minimum|maximum|limite|limit|min|max/;
              let score = 0;
              if (amountPattern.test(ownHaystack)) {
                score += 72;
              }
              if (amountPattern.test(wrapperText)) {
                score += 36;
              }
              if (depositPattern.test(ownHaystack)) {
                score += 34;
              }
              if (depositPattern.test(wrapperText)) {
                score += 18;
              }
              if (currencyPattern.test(haystack)) {
                score += 30;
              }
              if (numericPattern.test(ownHaystack)) {
                score += 32;
              }
              if (rootIsDeposit) {
                score += 28;
              }
              if (/text|number|tel|numeric|decimal/.test(ownHaystack)) {
                score += 24;
              }
              if (/^\s*(r\$)?\s*[\d,.]*\s*$/.test(placeholder)) {
                score += 20;
              }
              if (rootIsDeposit && visibleInputs.length <= 3) {
                score += 20;
              }
              if (
                /conta|usuario|senha|password|phone|telefone|celular|cpf|email/.test(
                  haystack,
                )
              ) {
                score -= 120;
              }
              if (/saque|withdraw|retirada/.test(haystack)) {
                score -= 45;
              }
              if (limitPattern.test(ownHaystack)) {
                score -= 95;
              } else if (
                limitPattern.test(wrapperText) &&
                !amountPattern.test(haystack) &&
                !currencyPattern.test(haystack)
              ) {
                score -= 30;
              } else if (limitPattern.test(wrapperText)) {
                score += 6;
              }
              if (element.disabled || element.readOnly) {
                score -= 70;
              }
              if (visibleInputs.length === 1) {
                score += 45;
              }
              if (
                !rootIsDeposit &&
                !amountPattern.test(haystack) &&
                !depositPattern.test(haystack) &&
                !currencyPattern.test(haystack)
              ) {
                score -= 35;
              }
              return {
                element,
                haystack: haystack || ownHaystack || "valor",
                score,
              };
            })
            .filter((candidate) => candidate.score > 18)
            .sort((left, right) => right.score - left.score);

          const candidate = candidates[0];
          if (!candidate) {
            return undefined;
          }

          const dispatchValueEvents = () => {
            const inputEvent = runtimeWindow.InputEvent
              ? new runtimeWindow.InputEvent("input", {
                  bubbles: true,
                  data: depositAmount,
                  inputType: "insertText",
                })
              : new runtimeWindow.Event("input", { bubbles: true });
            candidate.element.dispatchEvent?.(
              new runtimeWindow.Event("beforeinput", { bubbles: true }),
            );
            candidate.element.dispatchEvent?.(inputEvent);
            candidate.element.dispatchEvent?.(
              new runtimeWindow.Event("keyup", { bubbles: true }),
            );
            candidate.element.dispatchEvent?.(
              new runtimeWindow.Event("change", { bubbles: true }),
            );
            candidate.element.dispatchEvent?.(
              new runtimeWindow.Event("compositionend", { bubbles: true }),
            );
            candidate.element.dispatchEvent?.(
              new runtimeWindow.Event("blur", { bubbles: true }),
            );
          };
          const readValue = () => {
            const inputValue = candidate.element.value;
            return typeof inputValue === "string"
              ? inputValue
              : candidate.element.textContent || "";
          };
          const parseNumber = (value: string) => {
            const cleaned = value.replace(/[^\d,.-]/g, "").trim();
            if (!cleaned) {
              return Number.NaN;
            }
            const lastComma = cleaned.lastIndexOf(",");
            const lastDot = cleaned.lastIndexOf(".");
            const normalized =
              lastComma > lastDot
                ? cleaned.replace(/\./g, "").replace(",", ".")
                : cleaned.replace(/,/g, "");
            return Number(normalized);
          };

          candidate.element.disabled = false;
          candidate.element.readOnly = false;
          candidate.element.removeAttribute?.("disabled");
          candidate.element.removeAttribute?.("readonly");
          candidate.element.focus?.();
          const valueSetter = (
            Object.getOwnPropertyDescriptor(
              Object.getPrototypeOf(candidate.element),
              "value",
            ) as
              | { set?: (this: RuntimeElement, value: string) => void }
              | undefined
          )?.set;
          valueSetter?.call(candidate.element, depositAmount);
          if (!valueSetter) {
            candidate.element.value = depositAmount;
          }
          if (
            candidate.element.getAttribute("contenteditable") === "true" ||
            candidate.element.getAttribute("role") === "textbox"
          ) {
            candidate.element.textContent = depositAmount;
          }
          dispatchValueEvents();
          candidate.element.setAttribute?.(
            "data-predator-deposit-amount-target",
            targetToken,
          );
          const current = readValue();
          const currentNumber = parseNumber(current);
          const expectedNumber = parseNumber(depositAmount);
          const confirmed =
            current.trim() === depositAmount ||
            (Number.isFinite(currentNumber) &&
              Number.isFinite(expectedNumber) &&
              Math.abs(currentNumber - expectedNumber) < 0.001);
          return { confirmed, label: candidate.haystack || "valor" };
        },
        { depositAmount: amount, targetToken },
      )
      .catch(() => undefined);

    const fieldLabel = fieldResult?.label;
    if (!fieldLabel) {
      return undefined;
    }

    const markedField = resolveContentFrame(page)
      .locator(`[data-predator-deposit-amount-target="${targetToken}"]`)
      .first();
    if (fieldResult.confirmed) {
      await markedField
        .evaluate((element) =>
          element.removeAttribute("data-predator-deposit-amount-target"),
        )
        .catch(() => undefined);
      return fieldLabel;
    }
    await markedField
      .evaluate((el) =>
        el.scrollIntoView({ block: "center", inline: "center" }),
      )
      .catch(() => null);
    await this.waitActionable(markedField).catch(() => null);
    await markedField
      .fill(amount, { timeout: AutomationRuntimeService.ACTIONABLE_BUDGET_MS })
      .catch(async () => {
        // Fallback robusto. Garante foco e limpa de forma confiavel ANTES de digitar,
        // e usa pressSequentially pelo locator (que espera o campo ficar acionavel e
        // focado) em vez de keyboard.type — evita perder o 1o caractere quando o campo
        // ainda nao estava pronto (a causa do "49" virar "9").
        await this.focusFieldForTyping(runId, page, markedField).catch(
          () => null,
        );
        await markedField
          .fill("", {
            timeout: AutomationRuntimeService.ACTION_PROBE_BUDGET_MS,
          })
          .catch(async () => {
            await page.keyboard.press("Control+A").catch(() => null);
            await page.keyboard.press("Delete").catch(() => null);
          });
        await markedField
          .pressSequentially(amount, {
            delay: 35,
            timeout: AutomationRuntimeService.ACTIONABLE_BUDGET_MS,
          })
          .catch(() => null);
      });
    const valueConfirmed = await markedField
      .evaluate((element, expectedAmount) => {
        const runtimeWindow = globalThis as unknown as {
          Event: new (type: string, init?: { bubbles?: boolean }) => Event;
          InputEvent?: new (
            type: string,
            init?: { bubbles?: boolean; data?: string; inputType?: string },
          ) => Event;
        };
        const readValue = () => {
          const inputValue = (element as unknown as { value?: unknown }).value;
          return typeof inputValue === "string"
            ? inputValue
            : element.textContent || "";
        };
        const parseNumber = (value: string) => {
          const cleaned = value.replace(/[^\d,.-]/g, "").trim();
          if (!cleaned) {
            return Number.NaN;
          }
          const lastComma = cleaned.lastIndexOf(",");
          const lastDot = cleaned.lastIndexOf(".");
          const normalized =
            lastComma > lastDot
              ? cleaned.replace(/\./g, "").replace(",", ".")
              : cleaned.replace(/,/g, "");
          return Number(normalized);
        };
        const inputEvent = runtimeWindow.InputEvent
          ? new runtimeWindow.InputEvent("input", {
              bubbles: true,
              data: expectedAmount,
              inputType: "insertText",
            })
          : new runtimeWindow.Event("input", { bubbles: true });
        element.dispatchEvent(
          new runtimeWindow.Event("beforeinput", { bubbles: true }),
        );
        element.dispatchEvent(inputEvent);
        element.dispatchEvent(
          new runtimeWindow.Event("keyup", { bubbles: true }),
        );
        element.dispatchEvent(
          new runtimeWindow.Event("change", { bubbles: true }),
        );
        element.dispatchEvent(
          new runtimeWindow.Event("compositionend", { bubbles: true }),
        );
        element.dispatchEvent(
          new runtimeWindow.Event("blur", { bubbles: true }),
        );
        element.removeAttribute("data-predator-deposit-amount-target");
        const current = readValue();
        const currentNumber = parseNumber(current);
        const expectedNumber = parseNumber(expectedAmount);
        // Igualdade estrita: aceitar apenas valor exato ou numericamente igual.
        // (NAO usar includes: "1050".includes("50") aceitaria 1050 para o alvo 50,
        // produzindo valores acima do intervalo quando sobra digito no campo.)
        return (
          current.trim() === expectedAmount ||
          (Number.isFinite(currentNumber) &&
            Number.isFinite(expectedNumber) &&
            Math.abs(currentNumber - expectedNumber) < 0.001)
        );
      }, amount)
      .catch(() => false);

    if (!valueConfirmed) {
      return undefined;
    }

    return fieldLabel;
  }

  async trySubmitDepositViaSpaCommand(
    runId: string,
    page: Page,
    _profileName: string,
  ): Promise<string | undefined> {
    this.ensureRunActive(runId);
    const result = await resolveContentFrame(page)
      .evaluate(
        async () => {
          type RuntimeRecord = Record<PropertyKey, unknown>;
          type RuntimeElement = {
            __vue__?: unknown;
            __vueParentComponent?: RuntimeRecord | null;
            __vue_app__?: RuntimeRecord | null;
            closest?: (selector: string) => RuntimeElement | null;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
            textContent?: string | null;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              body: RuntimeElement;
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
              zIndex?: string;
            };
            innerHeight: number;
            innerWidth: number;
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const isObject = (value: unknown): value is RuntimeRecord =>
            Boolean(value) &&
            (typeof value === "object" || typeof value === "function");
          const readProp = (
            target: RuntimeRecord,
            key: PropertyKey,
          ): unknown => {
            try {
              return target[key];
            } catch {
              return undefined;
            }
          };
          const isVisible = (
            element: RuntimeElement,
            allowOffscreen = false,
          ) => {
            const rect = element.getBoundingClientRect();
            const style = runtimeWindow.getComputedStyle(element);
            const inViewport = allowOffscreen
              ? rect.right > -runtimeWindow.innerWidth &&
                rect.bottom > -runtimeWindow.innerHeight &&
                rect.left < runtimeWindow.innerWidth * 2 &&
                rect.top < runtimeWindow.innerHeight * 2
              : rect.right > 0 &&
                rect.bottom > 0 &&
                rect.left < runtimeWindow.innerWidth &&
                rect.top < runtimeWindow.innerHeight;
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8 &&
              inViewport
            );
          };
          const call = async (
            owner: RuntimeRecord,
            key: PropertyKey,
            args: unknown[],
          ) => {
            const fn = readProp(owner, key);
            if (typeof fn !== "function") return false;
            try {
              await Reflect.apply(fn, owner, args);
              return true;
            } catch {
              return false;
            }
          };
          const depositRootSelector =
            ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],[class*='cashier' i],[id*='cashier' i],[class*='wallet' i],[id*='wallet' i]";
          const roots = Array.from(
            runtimeWindow.document.querySelectorAll(depositRootSelector),
          )
            .filter((root) => {
              const text = normalize(
                [
                  root.textContent,
                  root.getAttribute?.("class"),
                  root.getAttribute?.("id"),
                ].join(" "),
              );
              return (
                isVisible(root, true) &&
                /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet|pix|pagamento|payment/.test(
                  text,
                )
              );
            })
            .sort((left, right) => {
              const leftRect = left.getBoundingClientRect();
              const rightRect = right.getBoundingClientRect();
              const leftZ =
                Number.parseInt(
                  runtimeWindow.getComputedStyle(left).zIndex || "0",
                  10,
                ) || 0;
              const rightZ =
                Number.parseInt(
                  runtimeWindow.getComputedStyle(right).zIndex || "0",
                  10,
                ) || 0;
              return (
                rightZ - leftZ ||
                rightRect.width * rightRect.height -
                  leftRect.width * leftRect.height
              );
            });
          const unique = (items: RuntimeElement[]) =>
            items.filter(
              (element, index, list) => list.indexOf(element) === index,
            );
          const searchRoots = unique([
            ...roots.slice(0, 8),
            runtimeWindow.document.body,
          ]);
          const elements = unique(
            searchRoots.flatMap((root) =>
              Array.from(
                root.querySelectorAll?.(
                  "button,a,input,[role='button'],.ui-button,.van-button,div,span,*",
                ) ?? [],
              ),
            ),
          ).slice(0, 1800);
          const likelySubmitElements = elements
            .filter((element) => isVisible(element, true))
            .map((element) => {
              const text = normalize(
                [
                  element.textContent,
                  element.getAttribute?.("class"),
                  element.getAttribute?.("id"),
                  element.getAttribute?.("aria-label"),
                  element.getAttribute?.("title"),
                  element.getAttribute?.("value"),
                ].join(" "),
              );
              let score = 0;
              if (
                /^(depositar|depositar agora|deposite|deposite agora|recarregar|recarregar agora|gerar|pagar|confirmar|confirmar pagamento|proximo|continuar|enviar|submit|pay|recharge)$/.test(
                  text,
                )
              ) {
                score += 120;
              } else if (
                /depositar|deposite|recarregar|gerar|pagar|confirmar|submit|pay|recharge|qr|pix/.test(
                  text,
                )
              ) {
                score += 70;
              }
              if (
                /submit|confirm|primary|button|btn|submittable|raeinput|red-btn|btn-box/.test(
                  text,
                )
              )
                score += 35;
              if (
                /cancelar|cancel|fechar|close|voltar|back|saque|withdraw|login|registro|suporte|service/.test(
                  text,
                )
              )
                score -= 120;
              const rect = element.getBoundingClientRect();
              if (rect.top > runtimeWindow.innerHeight * 0.45) score += 15;
              if (
                rect.width * rect.height >
                runtimeWindow.innerWidth * runtimeWindow.innerHeight * 0.28
              )
                score -= 80;
              return { element, score, text };
            })
            .filter((candidate) => candidate.score > 55)
            .sort((left, right) => right.score - left.score);

          const objectSet = new Set<RuntimeRecord>();
          const objects: RuntimeRecord[] = [];
          const addObject = (value: unknown) => {
            if (!isObject(value) || objectSet.has(value)) return;
            objectSet.add(value);
            objects.push(value);
          };
          const addComponentObjects = (element: RuntimeElement | undefined) => {
            if (!element) return;
            let current: RuntimeElement | null | undefined = element;
            for (let depth = 0; current && depth < 5; depth += 1) {
              addObject(current.__vue__);
              const component = current.__vueParentComponent;
              if (component) {
                addObject(component);
                addObject(readProp(component, "proxy"));
                addObject(readProp(component, "ctx"));
                addObject(readProp(component, "setupState"));
                addObject(readProp(component, "exposed"));
              }
              current = current.closest?.("*");
              break;
            }
          };
          for (const candidate of likelySubmitElements.slice(0, 6)) {
            addComponentObjects(candidate.element);
            const parent = candidate.element.closest?.(
              ".ui-popup,.van-popup,.modal,.popup,[class*='recharge' i],[class*='deposit' i],[class*='wallet' i],[class*='cashier' i]",
            );
            addComponentObjects(parent ?? undefined);
          }
          for (const root of searchRoots.slice(0, 6)) {
            addComponentObjects(root);
          }
          for (const raw of runtimeWindow.document.querySelectorAll(
            "#app,#app *,body",
          )) {
            const element = raw as RuntimeElement;
            addObject(element.__vue__);
            const component = element.__vueParentComponent;
            if (component) {
              const state = readProp(component, "setupState");
              const ctx = readProp(component, "ctx");
              const proxy = readProp(component, "proxy");
              const text = normalize(
                [
                  element.textContent,
                  element.getAttribute?.("class"),
                  element.getAttribute?.("id"),
                ].join(" "),
              );
              if (
                /recharge|deposit|cashier|wallet|recarga|deposito|pagamento|payment/.test(
                  text,
                )
              ) {
                addObject(component);
                addObject(state);
                addObject(ctx);
                addObject(proxy);
              }
            }
            if (objects.length > 200) break;
          }

          const methodPattern =
            /(submit|confirm|create.*order|order.*create|recharge.*(pay|submit|order|event)|deposit.*(pay|submit|order)|pay.*(submit|order|way)|handlePay|handleSubmit|onSubmit|submitOrder|submitRecharge|submitDeposit|payOrder|payNow|payWayEvent|rechargeEvent|createPay|createRecharge|createDeposit)/i;
          const rejectPattern =
            /withdraw|saque|login|register|registro|close|cancel|captcha|refresh|delete|remove/i;
          const methods: Array<{
            args: unknown[];
            key: PropertyKey;
            keyText: string;
            owner: RuntimeRecord;
            score: number;
          }> = [];
          for (const owner of objects) {
            for (const key of Reflect.ownKeys(owner).slice(0, 160)) {
              const keyText = String(key);
              const value = readProp(owner, key);
              if (
                typeof value !== "function" ||
                !methodPattern.test(keyText) ||
                rejectPattern.test(keyText)
              ) {
                continue;
              }
              let score = 80;
              if (/submit|confirm/i.test(keyText)) score += 45;
              if (/order|pay/i.test(keyText)) score += 30;
              if (/recharge|deposit/i.test(keyText)) score += 25;
              const args = /payWayEvent/i.test(keyText) ? [0] : [];
              methods.push({ args, key, keyText, owner, score });
            }
          }
          const method = methods.sort(
            (left, right) => right.score - left.score,
          )[0];
          if (!method) {
            return { label: "" };
          }
          if (await call(method.owner, method.key, method.args)) {
            return { label: `method:${method.keyText}` };
          }
          return { label: "" };
        },
        undefined,
        PATCHRIGHT_MAIN_WORLD,
      )
      .catch(() => undefined);

    if (result?.label) {
      await page.waitForTimeout(650).catch(() => undefined);
      return result.label;
    }
    return undefined;
  }

  async clickDepositSubmitButton(
    runId: string,
    page: Page,
  ): Promise<string | undefined> {
    this.ensureRunActive(runId);
    const targetToken = `deposit-submit-${Date.now()}-${this.randomInt(1000, 9999)}`;
    const label = await resolveContentFrame(page)
      .evaluate((token) => {
        type RuntimeElement = {
          click?: () => void;
          closest?: (selector: string) => RuntimeElement | null;
          disabled?: boolean;
          getAttribute?: (name: string) => string | null;
          getBoundingClientRect: () => {
            bottom: number;
            height: number;
            left: number;
            right: number;
            top: number;
            width: number;
          };
          querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
          setAttribute?: (name: string, value: string) => void;
          textContent?: string | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: {
            body: RuntimeElement;
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
          };
          getComputedStyle: (element: RuntimeElement) => {
            display: string;
            opacity: string;
            visibility: string;
            zIndex: string;
          };
          innerHeight: number;
          innerWidth: number;
        };
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const isVisible = (element: RuntimeElement, allowOffscreen = false) => {
          const style = runtimeWindow.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const inViewport = allowOffscreen
            ? rect.right > -runtimeWindow.innerWidth &&
              rect.bottom > -runtimeWindow.innerHeight &&
              rect.left < runtimeWindow.innerWidth * 2 &&
              rect.top < runtimeWindow.innerHeight * 2
            : rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight;
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 8 &&
            rect.height > 8 &&
            inViewport
          );
        };
        const depositRootSelector =
          ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],[class*='cashier' i],[id*='cashier' i],[class*='wallet' i],[id*='wallet' i]";
        const roots = Array.from(
          runtimeWindow.document.querySelectorAll(depositRootSelector),
        )
          .filter((root) => {
            const text = normalize(
              [
                root.textContent,
                root.getAttribute?.("class"),
                root.getAttribute?.("id"),
              ].join(" "),
            );
            return (
              isVisible(root, true) &&
              /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet|pix/.test(
                text,
              )
            );
          })
          .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            const leftZ =
              Number.parseInt(
                runtimeWindow.getComputedStyle(left).zIndex || "0",
                10,
              ) || 0;
            const rightZ =
              Number.parseInt(
                runtimeWindow.getComputedStyle(right).zIndex || "0",
                10,
              ) || 0;
            return (
              rightZ - leftZ ||
              rightRect.width * rightRect.height -
                leftRect.width * leftRect.height
            );
          });
        const root = roots[0] ?? runtimeWindow.document.body;
        const unique = (items: RuntimeElement[]) =>
          items.filter(
            (element, index, list) => list.indexOf(element) === index,
          );
        const searchRoots = unique([
          ...roots.slice(0, 8),
          root,
          runtimeWindow.document.body,
        ]);
        const submitTextPattern =
          /depositar|depositar agora|deposite|deposite agora|deposit now|recarregar|recarregar agora|gerar|pagar|confirmar|confirm|proximo|continuar|enviar|submit|pay|recharge|qr|pix|agora/;
        const exactSubmitTextPattern =
          /^(depositar|depositar agora|deposite|deposite agora|deposit now|recarregar|recarregar agora|gerar|pagar|confirmar|confirmar pagamento|proximo|continuar|enviar|submit|pay|recharge)$/;
        const clickableSelector =
          "button,a,input[type='button'],input[type='submit'],[role='button'],.ui-button,.van-button,[class*='button' i],[class*='btn' i],[class*='submit' i],[class*='confirm' i],[class*='primary' i],[class*='submitTable' i],[class*='raeInput' i],[class*='mem-icon' i],[class*='red-btn' i],[class*='btn-box' i],[id*='submit' i],[id*='confirm' i]";
        // Overlays que NOS injetamos (dados da conta, splash, QR) nao sao alvos clicaveis;
        // sem excluir, o fallback p/ document.body capta a linha "CHAVE PIX" do overlay
        // (casa /pix/) e o clique cai no lugar errado, travando o deposito.
        const injectedOverlaySelector =
          "#spider-acct-info,#predator-splash-overlay,#predator-deposit-qr-overlay,#predator-deposit-qr-reopen";
        const candidates = unique(
          searchRoots.flatMap((searchRoot) =>
            Array.from(
              searchRoot.querySelectorAll?.(
                "button,a,input,[role='button'],.ui-button,.van-button,div,span",
              ) ?? [],
            ),
          ),
        )
          .map((element) => element.closest?.(clickableSelector) ?? element)
          .filter(
            (element, index, elements) => elements.indexOf(element) === index,
          )
          .filter((element) => {
            const attrs = normalize(
              [
                element.getAttribute?.("class"),
                element.getAttribute?.("aria-disabled"),
              ].join(" "),
            );
            return (
              isVisible(element, true) &&
              !element.closest?.(injectedOverlaySelector) &&
              !element.disabled &&
              !/disabled|disable|desabilitado|true/.test(attrs)
            );
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = normalize(
              [
                element.textContent,
                element.getAttribute?.("class"),
                element.getAttribute?.("id"),
                element.getAttribute?.("aria-label"),
                element.getAttribute?.("title"),
                element.getAttribute?.("data-testid"),
                element.getAttribute?.("translate"),
                element.getAttribute?.("value"),
              ].join(" "),
            );
            let score = 0;
            if (exactSubmitTextPattern.test(text)) {
              score += 100;
            } else if (submitTextPattern.test(text)) {
              score += 60;
            }
            if (/button|btn|submit|confirm|primary/.test(text)) {
              score += 20;
            }
            if (/submittable|raeinput|mem-icon|red-btn|btn-box/.test(text)) {
              score += 34;
            }
            const buttonLike =
              /button|btn|submit|confirm|primary|ui-button|van-button/.test(
                text,
              );
            if (buttonLike) {
              score += 24;
            } else if (text.length > 30) {
              score -= 40;
            }
            if (
              /cancelar|cancel|fechar|close|voltar|back|saque|withdraw|login|registro|suporte|service/.test(
                text,
              )
            ) {
              score -= 90;
            }
            if (
              /copiar|copy|codigo qr|qrcode|status do pedido|numero do pedido/.test(
                text,
              )
            ) {
              score -= 90;
            }
            if (rect.top > runtimeWindow.innerHeight * 0.48) {
              score += 12;
            }
            if (
              rect.width * rect.height >
              runtimeWindow.innerWidth * runtimeWindow.innerHeight * 0.25
            ) {
              score -= 60;
            }
            return { element, score, text };
          })
          .filter((candidate) => candidate.score > 35)
          .sort((left, right) => right.score - left.score);

        const candidate = candidates[0];
        candidate?.element.setAttribute?.(
          "data-predator-deposit-submit-target",
          token,
        );
        return candidate?.text;
      }, targetToken)
      .catch(() => undefined);

    if (!label) {
      return undefined;
    }

    const target = resolveContentFrame(page)
      .locator(`[data-predator-deposit-submit-target="${targetToken}"]`)
      .first();
    const clicked = await this.withPopupPageGuard(page, async () => {
      if (
        await this.fastClickControl(runId, page, target)
          .then(() => true)
          .catch(() => false)
      ) {
        return true;
      }
      if (
        await target
          .click({ timeout: 1200, force: true })
          .then(() => true)
          .catch(() => false)
      ) {
        return true;
      }
      return target
        .evaluate((element) => {
          (element as unknown as { click: () => void }).click();
        })
        .then(() => true)
        .catch(() => false);
    }).catch(() => false);

    await target
      .evaluate((element) =>
        element.removeAttribute("data-predator-deposit-submit-target"),
      )
      .catch(() => undefined);
    if (!clicked) {
      return undefined;
    }
    return label;
  }

  private async waitForDepositQrCode(
    page: Page,
    timeoutMs: number,
  ): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const found = await resolveContentFrame(page)
        .evaluate(() => {
          type RuntimeElement = {
            closest?: (selector: string) => RuntimeElement | null;
            getBoundingClientRect: () => {
              bottom: number;
              height: number;
              left: number;
              right: number;
              top: number;
              width: number;
            };
            innerText?: string;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              body: { innerText: string };
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
            };
            innerHeight: number;
            innerWidth: number;
            localStorage?: { getItem: (key: string) => string | null };
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const isVisible = (element: RuntimeElement) => {
            const style = runtimeWindow.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 16 &&
              rect.height > 16 &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < runtimeWindow.innerWidth &&
              rect.top < runtimeWindow.innerHeight
            );
          };

          const qrElementSelector = [
            "#qrcode1 canvas",
            "#qrcode1 img",
            "#qrcode1 svg",
            "#qrcode1 table",
            ".codeimg canvas",
            ".codeimg img",
            ".codeimg svg",
            "[class*='qrcode' i]",
            "[id*='qrcode' i]",
            "[class*='qr-code' i]",
            "[id*='qr-code' i]",
            "canvas[class*='qr' i]",
            "img[class*='qr' i]",
            "img[src*='qr' i]",
            "svg[class*='qr' i]",
          ].join(",");
          const isRealQrElement = (el: RuntimeElement) => {
            if (!isVisible(el)) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width < 16 || rect.height < 16) return false;
            const tag = (
              (el as unknown as { tagName?: string }).tagName || ""
            ).toLowerCase();
            if (tag === "img") {
              const src = (el as unknown as { src?: string }).src || "";
              if (
                !src ||
                src.startsWith("data:image/gif") ||
                src.startsWith("data:image/png;base64,iVBOR")
              )
                return false;
            }
            if (tag === "canvas") {
              try {
                const ctx = (
                  el as unknown as {
                    getContext?: (
                      type: string,
                    ) => {
                      getImageData: (
                        x: number,
                        y: number,
                        w: number,
                        h: number,
                      ) => { data: Uint8ClampedArray };
                    } | null;
                  }
                ).getContext?.("2d");
                if (ctx) {
                  const sample = ctx.getImageData(
                    0,
                    0,
                    Math.min(4, Math.round(rect.width)),
                    Math.min(4, Math.round(rect.height)),
                  );
                  const hasContent =
                    sample.data.some(
                      (v, i) => i % 4 !== 3 && v !== 0 && v !== 255,
                    ) || sample.data.some((v, i) => i % 4 !== 3 && v < 128);
                  if (!hasContent) return false;
                }
              } catch {
                /* tainted canvas — treat as valid */
              }
            }
            return true;
          };
          const qrElement = Array.from(
            runtimeWindow.document.querySelectorAll(qrElementSelector),
          ).some(isRealQrElement);
          // Tira o texto dos overlays injetados (o "CHAVE PIX" do overlay adicionaria "pix").
          const injectedOverlaySelector =
            "#spider-acct-info,#predator-splash-overlay,#predator-deposit-qr-overlay,#predator-deposit-qr-reopen";
          let rawText = runtimeWindow.document.body.innerText || "";
          for (const overlay of Array.from(
            runtimeWindow.document.querySelectorAll(injectedOverlaySelector),
          )) {
            const overlayText = overlay.innerText || "";
            if (overlayText) {
              rawText = rawText.split(overlayText).join(" ");
            }
          }
          const text = normalize(rawText);
          const resultTextReady =
            /copiar codigo qr|endereco do codigo qr|numero do pedido|numero do pedido do comerciante|status do pedido|tempo efetivo/.test(
              text,
            ) && /pix|deposito|pagamento|brl|valor/.test(text);
          const storedOrderReady = (() => {
            try {
              const raw =
                runtimeWindow.localStorage?.getItem("szOrderInfo") || "";
              if (!raw) {
                return false;
              }
              const parsed = JSON.parse(raw) as {
                orderid?: unknown;
                order3rd?: unknown;
                qrcode?: unknown;
              };
              return Boolean(
                parsed && (parsed.qrcode || parsed.orderid || parsed.order3rd),
              );
            } catch {
              return false;
            }
          })();
          return qrElement || (storedOrderReady && resultTextReady);
        })
        .catch(() => false);

      if (found) {
        return true;
      }
      await page.waitForTimeout(250);
    }

    return false;
  }

  async waitForDepositQrOrManualCaptcha(
    runId: string,
    page: Page,
    profileName: string,
    stage: string,
    timeoutMs: number,
  ): Promise<{ qrCodeReady: boolean; handledCaptcha: boolean }> {
    const startedAt = Date.now();
    let handledCaptcha = false;

    while (Date.now() - startedAt < timeoutMs) {
      this.ensureRunActive(runId);

      if (await this.waitForDepositQrCode(page, 120)) {
        return { qrCodeReady: true, handledCaptcha };
      }

      const challenge = await this.detectCaptchaChallenge(page);
      if (challenge.active) {
        handledCaptcha = true;
        await this.waitForManualCaptchaIfPresent(
          runId,
          page,
          profileName,
          stage,
          {
            appearanceTimeoutMs: 0,
          },
        );
        continue;
      }

      await page.waitForTimeout(120);
    }

    return { qrCodeReady: false, handledCaptcha };
  }

  private async dismissPostRegistrationPopups(
    runId: string,
    page: Page,
  ): Promise<void> {
    for (let pass = 0; pass < 5; pass += 1) {
      this.ensureRunActive(runId);
      if ((await this.detectCaptchaChallenge(page)).active) {
        break;
      }
      const dismissed = await this.withPopupPageGuard(page, () =>
        resolveContentFrame(page)
          .evaluate(() => {
            type RuntimeElement = {
              click?: () => void;
              closest?: (selector: string) => RuntimeElement | null;
              getAttribute?: (name: string) => string | null;
              getBoundingClientRect: () => {
                bottom: number;
                height: number;
                left: number;
                right: number;
                top: number;
                width: number;
              };
              querySelector?: (selector: string) => RuntimeElement | null;
              querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
              textContent?: string | null;
            };
            type RuntimeEvent = {
              preventDefault?: () => void;
              target?: RuntimeElement | null;
            };
            const runtimeWindow = globalThis as unknown as {
              addEventListener: (
                type: string,
                listener: (event: RuntimeEvent) => void,
                options?: boolean,
              ) => void;
              document: {
                querySelectorAll: (
                  selector: string,
                ) => Iterable<RuntimeElement>;
              };
              getComputedStyle: (element: RuntimeElement) => {
                display: string;
                visibility: string;
                opacity: string;
                zIndex: string;
              };
              innerHeight: number;
              innerWidth: number;
              open?: (...args: unknown[]) => unknown;
              removeEventListener: (
                type: string,
                listener: (event: RuntimeEvent) => void,
                options?: boolean,
              ) => void;
              setTimeout: (callback: () => void, timeout: number) => unknown;
            };
            const normalizeText = (value: string | null | undefined) =>
              (value || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
            const isNavigatingHref = (href: string | null | undefined) => {
              const normalized = normalizeText(href);
              return Boolean(
                normalized &&
                normalized !== "#" &&
                !normalized.startsWith("#") &&
                !normalized.startsWith("javascript:") &&
                !normalized.startsWith("void(") &&
                normalized !== "about:blank",
              );
            };
            const isUrlLikeText = (text: string) =>
              /https?:|www\.|t\.me|telegram|facebook|whatsapp|wa\.me|\.com\b|\.net\b|\.org\b/i.test(
                text,
              );
            const exactDismissTexts = [
              "fechar",
              "close",
              "cancelar",
              "entendi",
              "ok",
              "x",
              "×",
              "✕",
              "✖",
            ];
            const phraseDismissTexts = [
              "agora não",
              "agora nao",
              "não agora",
              "nao agora",
              "depois",
              "mais tarde",
              "later",
              "pular",
              "skip",
            ];
            const actionDismissTexts = [
              "confirmar",
              "confimar",
              "confirm",
              "confirmacao",
              "continuar",
              "continue",
              "prosseguir",
              "aceitar",
              "accept",
              "concordo",
              "agree",
              "salvar",
              "save",
              "pronto",
              "done",
            ];
            const isDismissText = (value: string | null | undefined) => {
              const text = normalizeText(value);
              if (!text || text.length > 48 || isUrlLikeText(text)) {
                return false;
              }
              return (
                exactDismissTexts.includes(text) ||
                actionDismissTexts.includes(text) ||
                phraseDismissTexts.some(
                  (hint) => text === hint || text.includes(hint),
                ) ||
                (text.length <= 24 &&
                  (text.includes("fechar") || text.includes("close")))
              );
            };
            const popupRootSelector =
              ".ui-popup,.ui-dialog,.van-popup,.van-dialog,.el-dialog,.el-drawer,.m_sign_in,.sign_in_body,.login_content,[role='dialog'],[aria-modal='true'],.modal,.popup,.dialog,[class*='messagepopup' i],[class*='notice' i],[class*='popup' i],[class*='modal' i],[class*='dialog' i],[class*='announce' i],[class*='activity' i],[class*='promo' i],[class*='ppp' i]";
            const getPopupRoot = (element: RuntimeElement) =>
              element.closest?.(popupRootSelector) ??
              element.closest?.(".ui-overlay") ??
              element;
            const isVisible = (element: RuntimeElement) => {
              const style = runtimeWindow.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity || "1") > 0.01 &&
                rect.width > 4 &&
                rect.height > 4 &&
                rect.right > 0 &&
                rect.bottom > 0 &&
                rect.left < runtimeWindow.innerWidth &&
                rect.top < runtimeWindow.innerHeight
              );
            };
            const isSafeClickTarget = (element: RuntimeElement) => {
              const anchor = element.closest?.("a[href]");
              const href =
                anchor?.getAttribute?.("href") ??
                element.getAttribute?.("href");
              return !isNavigatingHref(href);
            };
            const normalizeCloseClickTarget = (element: RuntimeElement) =>
              element.closest?.(
                ".ui-dialog-close-box,.van-popup__close-icon,.van-icon-cross,.icon-guanbi,.iconfontguanbistyle,.xiazaipppclose,.imgx,.popupshowimgx,.pofswpclosestyle,.xImgaes,[class*='modal-close' i],[class*='popup-close' i],[class*='dialog-close' i],[class*='icon-close' i],[class*='close-btn' i],[class*='closeBtn' i],[class*='guanbi' i],[class*='imgx' i],[class*='closestyle' i],[aria-label*='close' i],[aria-label*='fechar' i]",
              ) ??
              element.closest?.("button,[role='button'],a") ??
              element;
            const getClosePriority = (element: RuntimeElement) => {
              const root = getPopupRoot(element);
              const marker = normalizeText(
                [
                  element.getAttribute?.("id"),
                  element.getAttribute?.("class"),
                  element.getAttribute?.("aria-label"),
                  element.getAttribute?.("title"),
                  element.getAttribute?.("data-testid"),
                  root.getAttribute?.("data-dialog-name"),
                  root.getAttribute?.("class"),
                ].join(" "),
              );
              let priority = 0;
              if (/messagepopup/.test(marker)) {
                priority += 80;
              }
              if (/ui-dialog-close-box/.test(marker)) {
                priority += 70;
              }
              if (
                /modal-close|popup-close|dialog-close|icon-close|close-btn|closebtn|van-popup__close|van-icon-cross|guanbi|xiazaipppclose|popupshowimgx|pofswpclosestyle|ximgaes|imgx|closestyle/.test(
                  marker,
                )
              ) {
                priority += 45;
              }
              if (/close|fechar/.test(marker)) {
                priority += 25;
              }
              return priority;
            };
            const captchaTextPattern =
              /captcha|recaptcha|hcaptcha|turnstile|geetest|gee test|deslize|arraste/i;
            const captchaSelector =
              "iframe[src*='captcha' i],iframe[src*='recaptcha' i],iframe[src*='hcaptcha' i],iframe[src*='turnstile' i],iframe[src*='geetest' i],[class*='captcha' i],[id*='captcha' i],[class*='geetest' i],[id*='geetest' i]";
            const isCaptchaPopupElement = (element: RuntimeElement) => {
              const root = getPopupRoot(element);
              const haystack = normalizeText(
                [
                  root.textContent,
                  root.getAttribute?.("id"),
                  root.getAttribute?.("class"),
                  root.getAttribute?.("aria-label"),
                  root.getAttribute?.("title"),
                ].join(" "),
              );

              return (
                captchaTextPattern.test(haystack) ||
                Boolean(root.querySelector?.(captchaSelector))
              );
            };
            const isDepositPopupElement = (element: RuntimeElement) => {
              const root = getPopupRoot(element);
              const text = normalizeText(
                [
                  root.textContent,
                  root.getAttribute?.("id"),
                  root.getAttribute?.("class"),
                  root.getAttribute?.("aria-label"),
                  root.getAttribute?.("title"),
                ].join(" "),
              );
              const hasDepositTerm =
                /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet/.test(
                  text,
                );
              if (!hasDepositTerm) {
                return false;
              }

              const hasPaymentTerm =
                /pix|valor|amount|canal|channel|pagamento|payment|metodo|method|qrcode|qr code/.test(
                  text,
                );
              const hasPaymentField = Boolean(
                root.querySelector?.(
                  "input[placeholder*='valor' i],input[placeholder*='amount' i],input[placeholder*='pix' i],input[name*='amount' i],input[id*='amount' i],[class*='recharge' i],[class*='deposit' i],[id*='recharge' i],[id*='deposit' i]",
                ),
              );

              return hasPaymentTerm || hasPaymentField;
            };
            const getPopupScore = (element: RuntimeElement) => {
              const root = getPopupRoot(element);
              const rootStyle = runtimeWindow.getComputedStyle(root);
              const elementStyle = runtimeWindow.getComputedStyle(element);
              const rootRect = root.getBoundingClientRect();
              return {
                rootArea: rootRect.width * rootRect.height,
                zIndex:
                  Number.parseInt(
                    rootStyle.zIndex || elementStyle.zIndex || "0",
                    10,
                  ) || 0,
              };
            };
            const preventAnchorNavigation = (event: RuntimeEvent) => {
              const anchor = event.target?.closest?.("a[href]");
              if (isNavigatingHref(anchor?.getAttribute?.("href"))) {
                event.preventDefault?.();
              }
            };
            const clickWithoutOpeningTabs = (element: RuntimeElement) => {
              const originalOpen = runtimeWindow.open;
              try {
                runtimeWindow.open = () => null;
                runtimeWindow.addEventListener(
                  "click",
                  preventAnchorNavigation,
                  true,
                );
                runtimeWindow.addEventListener(
                  "auxclick",
                  preventAnchorNavigation,
                  true,
                );
                element.click?.();
              } finally {
                runtimeWindow.setTimeout(() => {
                  runtimeWindow.removeEventListener(
                    "click",
                    preventAnchorNavigation,
                    true,
                  );
                  runtimeWindow.removeEventListener(
                    "auxclick",
                    preventAnchorNavigation,
                    true,
                  );
                  runtimeWindow.open = originalOpen;
                }, 1000);
              }
            };
            const closeSelectors = [
              ".ui-dialog-close-box__icon",
              ".ui-dialog-close-box",
              ".van-popup__close-icon",
              ".van-icon-cross",
              ".icon-guanbi",
              ".iconfontguanbistyle",
              ".xiazaipppclose",
              ".imgx",
              ".popupshowimgx",
              ".pofswpclosestyle",
              ".xImgaes",
              "[aria-label*='fechar' i]",
              "[aria-label*='close' i]",
              "[title*='fechar' i]",
              "[title*='close' i]",
              "[data-testid*='close' i]",
              "[data-testid*='fechar' i]",
              "img[class*='close' i]",
              "svg[class*='close' i]",
              "[class*='modal-close' i]",
              "[class*='popup-close' i]",
              "[class*='dialog-close' i]",
              "[class*='icon-close' i]",
              "[class*='close-icon' i]",
              "[class*='closeIcon' i]",
              "[class*='close-btn' i]",
              "[class*='closeBtn' i]",
              "[class*='guanbi' i]",
              "[class*='imgx' i]",
              "[class*='closestyle' i]",
              "[class*='close' i]",
            ];
            const candidates = new Set<RuntimeElement>();
            for (const selector of closeSelectors) {
              for (const element of runtimeWindow.document.querySelectorAll(
                selector,
              )) {
                candidates.add(normalizeCloseClickTarget(element));
              }
            }

            for (const root of runtimeWindow.document.querySelectorAll(
              popupRootSelector,
            )) {
              if (
                !isVisible(root) ||
                isCaptchaPopupElement(root) ||
                isDepositPopupElement(root)
              ) {
                continue;
              }

              for (const element of root.querySelectorAll?.(
                "button,[role='button'],.ui-button,.van-button,span,div",
              ) ?? []) {
                if (isDismissText(element.textContent)) {
                  candidates.add(normalizeCloseClickTarget(element));
                }
              }
            }

            for (const element of runtimeWindow.document.querySelectorAll(
              "button,[role='button'],a",
            )) {
              if (isDismissText(element.textContent)) {
                candidates.add(normalizeCloseClickTarget(element));
              }
            }

            const candidate = Array.from(candidates)
              .filter(
                (element) =>
                  isVisible(element) &&
                  isSafeClickTarget(element) &&
                  !isCaptchaPopupElement(element) &&
                  !isDepositPopupElement(element),
              )
              .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                const aScore = getPopupScore(a);
                const bScore = getPopupScore(b);
                return (
                  getClosePriority(b) - getClosePriority(a) ||
                  bScore.zIndex - aScore.zIndex ||
                  aRect.width * aRect.height - bRect.width * bRect.height ||
                  aScore.rootArea - bScore.rootArea
                );
              })[0];

            if (!candidate) {
              const blockingPopup = Array.from(
                runtimeWindow.document.querySelectorAll(popupRootSelector),
              )
                .filter(
                  (root) =>
                    isVisible(root) &&
                    !isCaptchaPopupElement(root) &&
                    !isDepositPopupElement(root),
                )
                .sort((a, b) => {
                  const aScore = getPopupScore(a);
                  const bScore = getPopupScore(b);
                  return (
                    bScore.zIndex - aScore.zIndex ||
                    bScore.rootArea - aScore.rootArea
                  );
                })[0];
              if (!blockingPopup) {
                return 0;
              }

              const rootRect = blockingPopup.getBoundingClientRect();
              const cornerCandidates = Array.from(
                blockingPopup.querySelectorAll?.(
                  "button,[role='button'],a,span,div,svg,img",
                ) ?? [],
              )
                .filter((element) => {
                  if (!isVisible(element) || !isSafeClickTarget(element)) {
                    return false;
                  }
                  const rect = element.getBoundingClientRect();
                  const area = rect.width * rect.height;
                  const nearTopRight =
                    rect.left >= rootRect.left + rootRect.width * 0.55 &&
                    rect.top <=
                      rootRect.top + Math.max(90, rootRect.height * 0.35);
                  const smallControl =
                    area <=
                    Math.max(9000, rootRect.width * rootRect.height * 0.08);
                  const text = normalizeText(element.textContent);
                  const marker = normalizeText(
                    [
                      element.getAttribute?.("class"),
                      element.getAttribute?.("id"),
                      element.getAttribute?.("aria-label"),
                      element.getAttribute?.("title"),
                    ].join(" "),
                  );
                  return (
                    nearTopRight &&
                    smallControl &&
                    (isDismissText(text) ||
                      /close|fechar|guanbi|imgx|closestyle|(^|\s|_|-)x(\s|_|-|$)/.test(
                        marker,
                      ))
                  );
                })
                .sort((a, b) => {
                  const ar = a.getBoundingClientRect();
                  const br = b.getBoundingClientRect();
                  return (
                    ar.width * ar.height - br.width * br.height ||
                    br.left - ar.left ||
                    ar.top - br.top
                  );
                });

              const cornerCandidate = cornerCandidates[0];
              if (!cornerCandidate) {
                return -1;
              }
              clickWithoutOpeningTabs(cornerCandidate);
              return 1;
            }

            clickWithoutOpeningTabs(candidate);
            return 1;
          })
          .catch(() => 0),
      );

      if (dismissed < 0) {
        await page.keyboard.press("Escape").catch(() => null);
        await page.waitForTimeout(180);
        continue;
      }
      if (dismissed === 0) {
        break;
      }
      await page.waitForTimeout(140);
    }
  }

  // Diagnostico do campo de valor do deposito: serve para distinguir "campo nao renderizou"
  // (layout mobile da plataforma em viewport estreito) de "campo existe mas a heuristica
  // rejeitou". Reporta viewport, se achou um root de deposito, e os inputs/presets visiveis
  // com seus atributos e dimensoes. Mesmo formato compacto do describeProfileEntryPointState.
  async describeDepositFieldState(page: Page): Promise<string | undefined> {
    const frame = resolveContentFrame(page);
    const snapshot = await frame
      .evaluate(() => {
        type RuntimeElement = {
          closest?: (selector: string) => RuntimeElement | null;
          getAttribute?: (name: string) => string | null;
          getBoundingClientRect: () => {
            bottom: number;
            height: number;
            left: number;
            right: number;
            top: number;
            width: number;
          };
          querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
          textContent?: string | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: {
            body?: RuntimeElement;
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
          };
          getComputedStyle: (element: RuntimeElement) => {
            display: string;
            opacity: string;
            visibility: string;
          };
          innerHeight: number;
          innerWidth: number;
        };
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const isVisible = (element: RuntimeElement) => {
          const style = runtimeWindow.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 8 &&
            rect.height > 8
          );
        };
        const depositRootSelector =
          ".ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,[class*='recharge' i],[id*='recharge' i],[class*='deposit' i],[id*='deposit' i],[class*='cashier' i],[id*='cashier' i],[class*='wallet' i],[id*='wallet' i]";
        const roots = Array.from(
          runtimeWindow.document.querySelectorAll(depositRootSelector),
        )
          .filter((root) => {
            const text = normalize(
              [
                root.textContent,
                root.getAttribute?.("class"),
                root.getAttribute?.("id"),
              ].join(" "),
            );
            return (
              isVisible(root) &&
              /deposito|depositar|recarga|recarregar|recharge|cashier|carteira|wallet|pix/.test(
                text,
              )
            );
          })
          .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            return (
              rightRect.width * rightRect.height -
              leftRect.width * leftRect.height
            );
          });
        const unique = (items: RuntimeElement[]) =>
          items.filter(
            (element, index, list) => list.indexOf(element) === index,
          );
        const searchRoots = unique(
          [...roots.slice(0, 8), runtimeWindow.document.body].filter(
            Boolean,
          ) as RuntimeElement[],
        );
        const allInputs = unique(
          searchRoots.flatMap((searchRoot) =>
            Array.from(
              searchRoot?.querySelectorAll?.(
                "input,textarea,[contenteditable='true'],[role='textbox'],.ui-input,.ui-input__input,[class*='amount-input' i],[class*='input-box' i]",
              ) ?? [],
            ),
          ),
        );
        const describe = (element: RuntimeElement) => {
          const rect = element.getBoundingClientRect();
          const attrs = normalize(
            [
              (element as unknown as { tagName?: string }).tagName,
              element.getAttribute?.("type"),
              element.getAttribute?.("placeholder"),
              element.getAttribute?.("name"),
              element.getAttribute?.("id"),
              element.getAttribute?.("inputmode"),
              element.getAttribute?.("class"),
            ].join(" "),
          ).slice(0, 90);
          return `${isVisible(element) ? "v" : "h"}:${Math.round(rect.width)}x${Math.round(rect.height)}:${attrs}`;
        };
        const presets = unique(
          searchRoots.flatMap((searchRoot) =>
            Array.from(
              searchRoot?.querySelectorAll?.(
                "button,[role='button'],.van-button,[class*='btn' i],[class*='chip' i],li,span,div",
              ) ?? [],
            ),
          ),
        )
          .filter(
            (element) =>
              isVisible(element) &&
              /^\s*(r\$)?\s*[\d.,]{1,7}\s*$/.test(
                normalize(element.textContent),
              ),
          )
          .slice(0, 10)
          .map((element) => normalize(element.textContent).slice(0, 12));
        const keypad = unique(
          Array.from(
            runtimeWindow.document.querySelectorAll(
              "button,[role='button'],[class*='key' i],[class*='keyboard' i],[class*='kb' i],div,span",
            ),
          ),
        )
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return (
              isVisible(element) &&
              rect.top > runtimeWindow.innerHeight * 0.58 &&
              /^[0-9]$/.test(normalize(element.textContent))
            );
          })
          .slice(0, 12)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return `${normalize(element.textContent)}@${Math.round(rect.left)},${Math.round(rect.top)}`;
          });
        const rootSummary = roots.slice(0, 5).map((element) => {
          const rect = element.getBoundingClientRect();
          const attrs = normalize(
            [
              element.getAttribute?.("id"),
              element.getAttribute?.("class"),
            ].join(" "),
          ).slice(0, 50);
          return `${Math.round(rect.width)}x${Math.round(rect.height)}:${attrs}`;
        });
        return {
          viewport: `${runtimeWindow.innerWidth}x${runtimeWindow.innerHeight}`,
          rootFound: roots.length > 0,
          roots: rootSummary,
          inputsTotal: allInputs.length,
          inputsVisible: allInputs.filter(isVisible).length,
          inputs: allInputs.slice(0, 8).map(describe),
          keypad,
          presets,
        };
      })
      .catch(() => undefined);

    if (!snapshot) {
      return undefined;
    }
    return (
      `viewport=${snapshot.viewport}; rootDeposito=${snapshot.rootFound}; ` +
      `roots=[${snapshot.roots.join(" | ") || "nenhum"}]; ` +
      `inputs=${snapshot.inputsVisible}/${snapshot.inputsTotal} [${snapshot.inputs.join(" | ") || "nenhum"}]; ` +
      `teclado=[${snapshot.keypad.join(", ") || "nenhum"}]; ` +
      `presets=[${snapshot.presets.join(", ") || "nenhum"}]`
    );
  }

  private async clickRegistrationEntryPoint(
    runId: string,
    page: Page,
  ): Promise<string | undefined> {
    this.ensureRunActive(runId);
    const targetToken = `registration-entry-${Date.now()}-${this.randomInt(1000, 9999)}`;
    const label = await page
      .evaluate((token) => {
        type RuntimeElement = {
          closest?: (selector: string) => RuntimeElement | null;
          getAttribute?: (name: string) => string | null;
          getBoundingClientRect: () => {
            bottom: number;
            height: number;
            left: number;
            right: number;
            top: number;
            width: number;
          };
          setAttribute?: (name: string, value: string) => void;
          textContent?: string | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: {
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
          };
          getComputedStyle: (element: RuntimeElement) => {
            display: string;
            opacity: string;
            visibility: string;
          };
          innerHeight: number;
          innerWidth: number;
        };
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const readAttrs = (element: RuntimeElement) =>
          normalize(
            [
              element.getAttribute?.("id"),
              element.getAttribute?.("class"),
              element.getAttribute?.("href"),
              element.getAttribute?.("to"),
              element.getAttribute?.("data-name"),
              element.getAttribute?.("data-route"),
              element.getAttribute?.("data-testid"),
              element.getAttribute?.("aria-label"),
              element.getAttribute?.("title"),
            ].join(" "),
          );
        const isVisible = (element: RuntimeElement) => {
          const style = runtimeWindow.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 8 &&
            rect.height > 8 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < runtimeWindow.innerWidth &&
            rect.top < runtimeWindow.innerHeight
          );
        };
        const clickSelector =
          "button,a,[role='button'],[role='tab'],.ui-tabbar-item,[id*='register' i],[id*='signup' i],[id*='regist' i],[class*='register' i],[class*='signup' i],[class*='regist' i],[class*='cadastro' i],[class*='navItem' i],[class*='menu-item' i],[class*='menuItem' i],[class*='itemContent' i],[class*='item_' i]";
        const candidates = new Map<
          RuntimeElement,
          { element: RuntimeElement; label: string; score: number; y: number }
        >();

        for (const element of runtimeWindow.document.querySelectorAll(
          "button,a,[role='button'],[role='tab'],div,span",
        )) {
          const clickable = element.closest?.(clickSelector) ?? element;
          if (!isVisible(clickable)) {
            continue;
          }

          const rect = clickable.getBoundingClientRect();
          const area = rect.width * rect.height;
          const viewportArea =
            runtimeWindow.innerWidth * runtimeWindow.innerHeight;
          const text = normalize(
            `${element.textContent || ""} ${clickable.textContent || ""}`,
          );
          const attrs = `${readAttrs(element)} ${readAttrs(clickable)}`;
          const haystack = normalize(`${text} ${attrs}`);
          const exact =
            /^(registro|registrar|cadastro|cadastrar|cadastre-se|criar conta|sign up|signup|register|join)$/i.test(
              text,
            );
          const contains =
            /registro|registrar|cadastro|cadastrar|cadastre-se|criar conta|sign up|signup|register|join/.test(
              haystack,
            );
          const strongAttr =
            /(^|\s|_|-|\/)(register|signup|sign-up|regist|cadastro)(\s|_|-|\/|$)|registerclick|registermodal/.test(
              attrs,
            );

          if (
            /tenho mais de 18 anos|acordo de usuario|termos|terms|agreement|vinculativo|suporte ao cliente/.test(
              haystack,
            ) ||
            /checkbox|register_text|footercenter|dating-img|agreement|terms/.test(
              attrs,
            )
          ) {
            continue;
          }

          if (!exact && !contains && !strongAttr) {
            continue;
          }

          let score = 0;
          if (strongAttr) {
            score += 100;
          }
          if (exact) {
            score += 92;
          } else if (contains) {
            score += 55;
          }
          if (
            /button|btn|tabbar|navitem|menu-item|menuitem|itemcontent|primary/.test(
              haystack,
            )
          ) {
            score += 22;
          }
          if (
            rect.top < runtimeWindow.innerHeight * 0.35 ||
            rect.top > runtimeWindow.innerHeight * 0.62
          ) {
            score += 10;
          }
          if (
            /login|entrar|deposit|deposito|recarga|saque|withdraw|bonus|promocao|promotion|close|fechar|captcha|suporte|service/.test(
              haystack,
            )
          ) {
            score -= 85;
          }
          if (area > viewportArea * 0.3 || text.length > 90) {
            score -= 60;
          }
          if (score < 45) {
            continue;
          }

          const label = text || attrs.split(" ")[0] || "registro";
          const existing = candidates.get(clickable);
          if (!existing || score > existing.score) {
            candidates.set(clickable, {
              element: clickable,
              label,
              score,
              y: rect.top + rect.height / 2,
            });
          }
        }

        const best = Array.from(candidates.values()).sort(
          (left, right) => right.score - left.score || left.y - right.y,
        )[0];
        best?.element.setAttribute?.(
          "data-predator-registration-entry-target",
          token,
        );
        return best?.label;
      }, targetToken)
      .catch(() => undefined);

    if (!label) {
      return undefined;
    }

    const target = page
      .locator(`[data-predator-registration-entry-target="${targetToken}"]`)
      .first();
    await this.withPopupPageGuard(page, async () => {
      await this.humanMouseClick(runId, page, target).catch(async () => {
        await target.click({ timeout: 1200, force: true }).catch(async () => {
          await target
            .evaluate((element) => {
              (element as unknown as { click: () => void }).click();
            })
            .catch(() => undefined);
        });
      });
    }).catch(() => undefined);
    await target
      .evaluate((element) =>
        element.removeAttribute("data-predator-registration-entry-target"),
      )
      .catch(() => undefined);

    return label;
  }
  private async normalizeRegistrationEntryPage(
    _runId: string,
    page: Page,
    profileName: string,
  ): Promise<void> {
    const iframeSource = await page
      .evaluate(() => {
        type RuntimeElement = {
          getAttribute: (name: string) => string | null;
        };
        const runtimeWindow = globalThis as unknown as {
          document: {
            querySelector: (selector: string) => RuntimeElement | null;
          };
        };
        return (
          runtimeWindow.document
            .querySelector("iframe#h5_iframe,iframe[src*='isredirect=1']")
            ?.getAttribute("src") ?? ""
        );
      })
      .catch(() => "");

    if (iframeSource) {
      try {
        const iframeUrl = new URL(iframeSource, page.url()).toString();
        if (iframeUrl !== page.url()) {
          await page
            .goto(iframeUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
            .catch(() => null);
          await page.waitForTimeout(500).catch(() => null);
        }
      } catch {
        // If the iframe source is malformed, continue with the current page.
      }
    }

    const uiFamily = await detectRegistrationUiFamily(page);
    if (uiFamily) {
      console.log(
        `[${profileName}] Adaptador de cadastro detectado: ${uiFamily}.`,
      );
    }
  }

  private async ensureRegistrationDialogOpen(
    runId: string,
    page: Page,
    profileName: string,
  ): Promise<void> {
    const accountHints = ["Digite o Conta", "Conta", "usuario", "usuÃ¡rio"];
    accountHints.push("account");
    {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        this.ensureRunActive(runId);

        if (await this.isRegistrationFormReady(runId, page, accountHints)) {
          return;
        }

        await this.dismissInitialPopupsBeforeRegistration(
          runId,
          page,
          profileName,
        );

        if (await this.isRegistrationFormReady(runId, page, accountHints)) {
          return;
        }

        const clicked = await this.clickRegistrationEntryPoint(runId, page);
        if (!clicked) {
          await page.waitForTimeout(250);
          continue;
        }

        if (
          await this.isRegistrationFormReady(runId, page, accountHints, 1400)
        ) {
          return;
        }

        await this.dismissInitialPopupsBeforeRegistration(
          runId,
          page,
          profileName,
        );
      }

      throw new Error(
        "Popup de cadastro nao abriu apos fechar popups e clicar em Registro.",
      );
    }
  }

  private async isRegistrationFormReady(
    runId: string,
    page: Page,
    accountHints: string[],
    timeoutMs = 500,
  ): Promise<boolean> {
    const accountInput = await this.getVisibleInputByHints(
      runId,
      page,
      "conta",
      accountHints,
      {
        optional: true,
        timeoutMs,
      },
    );
    if (!accountInput) {
      return false;
    }

    const passwordCount =
      await this.countVisibleRegistrationPasswordInputs(page);
    if (passwordCount < 2) {
      return false;
    }

    const registerSubmit = await this.getVisibleRegistrationSubmitControl(
      runId,
      page,
      {
        timeoutMs: Math.min(timeoutMs, 700),
      },
    );
    return Boolean(registerSubmit);
  }

  private async countVisibleRegistrationPasswordInputs(
    page: Page,
  ): Promise<number> {
    return page
      .evaluate(() => {
        type RuntimeElement = {
          getAttribute: (name: string) => string | null;
          getBoundingClientRect: () => {
            bottom: number;
            height: number;
            left: number;
            right: number;
            top: number;
            width: number;
          };
        };
        const runtimeWindow = globalThis as unknown as {
          document: {
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
          };
          getComputedStyle: (element: RuntimeElement) => {
            display: string;
            opacity: string;
            visibility: string;
          };
          innerHeight: number;
          innerWidth: number;
        };
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const isVisible = (element: RuntimeElement) => {
          const style = runtimeWindow.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 4 &&
            rect.height > 4
          );
        };
        const isPasswordLikeInput = (element: RuntimeElement) => {
          const haystack = normalize(
            [
              element.getAttribute("type"),
              element.getAttribute("autocomplete"),
              element.getAttribute("name"),
              element.getAttribute("id"),
              element.getAttribute("class"),
              element.getAttribute("placeholder"),
              element.getAttribute("aria-label"),
              element.getAttribute("title"),
            ].join(" "),
          );
          return (
            normalize(element.getAttribute("type")) === "password" ||
            /new-password|senha|password|confirm/.test(haystack)
          );
        };

        return Array.from(
          runtimeWindow.document.querySelectorAll("input"),
        ).filter((input) => isVisible(input) && isPasswordLikeInput(input))
          .length;
      })
      .catch(() =>
        page
          .locator("input[type='password']:visible")
          .count()
          .catch(() => 0),
      );
  }

  private async getRequiredRegistrationSubmitControl(
    runId: string,
    page: Page,
  ): Promise<Locator> {
    const locator = await this.getVisibleRegistrationSubmitControl(
      runId,
      page,
      {
        timeoutMs: 15000,
      },
    );
    if (!locator) {
      throw new Error(
        "Botao de registro nao encontrado no formulario de cadastro.",
      );
    }
    return locator;
  }

  private async getVisibleRegistrationSubmitControl(
    runId: string,
    page: Page,
    options?: { timeoutMs?: number },
  ): Promise<Locator | undefined> {
    const timeoutMs = options?.timeoutMs ?? 45000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      this.ensureRunActive(runId);

      const fixedSubmit = page
        .locator(
          "#insideRegisterSubmitClick:visible,.insideRegisterSubmitClick:visible",
        )
        .first();
      if (await fixedSubmit.isVisible({ timeout: 150 }).catch(() => false)) {
        return fixedSubmit;
      }

      const targetToken = `registration-submit-${Date.now()}-${this.randomInt(1000, 9999)}`;
      const match = await page
        .evaluate((token) => {
          type RuntimeRect = {
            bottom: number;
            height: number;
            left: number;
            right: number;
            top: number;
            width: number;
          };
          type RuntimeElement = {
            closest?: (selector: string) => RuntimeElement | null;
            getAttribute?: (name: string) => string | null;
            getBoundingClientRect: () => RuntimeRect;
            querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
            setAttribute?: (name: string, value: string) => void;
            textContent?: string | null;
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              body: RuntimeElement;
              querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
            };
            getComputedStyle: (element: RuntimeElement) => {
              display: string;
              opacity: string;
              visibility: string;
            };
            innerHeight: number;
            innerWidth: number;
          };
          const normalize = (value: string | null | undefined) =>
            (value || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const queryAll = (
            root: RuntimeElement | undefined,
            selector: string,
          ) =>
            Array.from(
              root?.querySelectorAll?.(selector) ??
                runtimeWindow.document.querySelectorAll(selector),
            );
          const readAttrs = (element: RuntimeElement) =>
            normalize(
              [
                element.getAttribute?.("id"),
                element.getAttribute?.("class"),
                element.getAttribute?.("name"),
                element.getAttribute?.("role"),
                element.getAttribute?.("type"),
                element.getAttribute?.("aria-label"),
                element.getAttribute?.("title"),
              ].join(" "),
            );
          const isRendered = (element: RuntimeElement) => {
            const style = runtimeWindow.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01 &&
              rect.width > 8 &&
              rect.height > 8
            );
          };
          const inputType = (element: RuntimeElement) =>
            normalize(element.getAttribute?.("type"));
          const sectionSelector =
            "form,.ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,.dialog,.m_sign_in,.sign_in_body,.login_content,.form_box";
          const sections = Array.from(
            new Set([
              runtimeWindow.document.body,
              ...Array.from(
                runtimeWindow.document.querySelectorAll(sectionSelector),
              ),
            ]),
          )
            .filter(isRendered)
            .map((section) => {
              const inputs = queryAll(section, "input").filter(isRendered);
              const passwordInputs = inputs.filter(
                (input) => inputType(input) === "password",
              );
              const text = normalize(section.textContent).slice(0, 2500);
              const rect = section.getBoundingClientRect();
              let score = 0;
              if (passwordInputs.length >= 2) {
                score += 100;
              }
              if (
                /registro|registrar|cadastro|cadastrar|criar conta|sign up|signup|register|join/.test(
                  text,
                )
              ) {
                score += 45;
              }
              if (/senha|password/.test(text)) {
                score += 20;
              }
              return {
                area: rect.width * rect.height,
                element: section,
                passwordBottom: Math.max(
                  0,
                  ...passwordInputs.map(
                    (input) => input.getBoundingClientRect().bottom,
                  ),
                ),
                score,
              };
            })
            .filter((section) => section.score >= 100)
            .sort(
              (left, right) =>
                right.score - left.score || left.area - right.area,
            );

          const roots =
            sections.length > 0
              ? sections
              : [{ element: runtimeWindow.document.body, passwordBottom: 0 }];
          const clickSelector =
            "button,a,[role='button'],input[type='submit'],input[type='button'],.sing_btn,.login_sign_btn,.register_btn,.primary,.submit,.btn,[class*='submit' i],[class*='register' i],[class*='regist' i],[id*='submit' i],[id*='register' i],[id*='regist' i]";
          const candidates = new Map<
            RuntimeElement,
            { element: RuntimeElement; label: string; score: number; y: number }
          >();

          for (const root of roots) {
            for (const element of queryAll(
              root.element,
              "button,a,input,[role='button'],div,span",
            )) {
              const clickable = element.closest?.(clickSelector) ?? element;
              if (!isRendered(clickable)) {
                continue;
              }

              const rect = clickable.getBoundingClientRect();
              const viewportArea =
                runtimeWindow.innerWidth * runtimeWindow.innerHeight;
              const elementText = normalize(element.textContent);
              const clickableText = normalize(clickable.textContent);
              const label = clickableText || elementText || "registro";
              const attrs = `${readAttrs(element)} ${readAttrs(clickable)}`;
              const haystack = normalize(`${label} ${attrs}`);
              const exactSubmit =
                /^(registro|registrar|cadastro|cadastrar|criar conta|sign up|signup|register|join)$/i.test(
                  label,
                ) ||
                /^(registro|registrar|cadastro|cadastrar|criar conta|sign up|signup|register|join)$/i.test(
                  elementText,
                );
              const containsSubmit =
                /registro|registrar|cadastro|cadastrar|criar conta|sign up|signup|register|join/.test(
                  haystack,
                );
              const strongSubmit =
                /insideregistersubmitclick|login_sign_btn|sing_btn|submit|register_btn|primary|(^|\s)btn(\s|$)/.test(
                  attrs,
                );

              if (!exactSubmit && !containsSubmit && !strongSubmit) {
                continue;
              }

              let score = 0;
              if (strongSubmit) {
                score += 55;
              }
              if (exactSubmit) {
                score += 92;
              } else if (containsSubmit) {
                score += 38;
              }
              if (root.passwordBottom > 0) {
                score += rect.top >= root.passwordBottom - 8 ? 70 : -100;
              }
              if (/tab|van-tab|sing_type_item/.test(attrs)) {
                score -= 80;
              }
              if (/checkbox|radio|switch|icon|img|image/.test(attrs)) {
                score -= 120;
              }
              if (!strongSubmit && (rect.width < 120 || rect.height < 28)) {
                score -= 70;
              }
              if (
                /login|entrar|suporte|cliente|vinculativo|download|baixar|termos|acordo/.test(
                  label,
                )
              ) {
                score -= 75;
              }
              if (
                rect.width * rect.height > viewportArea * 0.45 ||
                label.length > 90
              ) {
                score -= 70;
              }
              if (score < 60) {
                continue;
              }

              const existing = candidates.get(clickable);
              if (!existing || score > existing.score) {
                candidates.set(clickable, {
                  element: clickable,
                  label,
                  score,
                  y: rect.top + rect.height / 2,
                });
              }
            }
          }

          const best = Array.from(candidates.values()).sort(
            (left, right) => right.score - left.score || right.y - left.y,
          )[0];
          best?.element.setAttribute?.(
            "data-predator-registration-submit-target",
            token,
          );
          return best ? { label: best.label, score: best.score } : undefined;
        }, targetToken)
        .catch(() => undefined);

      if (match) {
        const target = page
          .locator(
            `[data-predator-registration-submit-target="${targetToken}"]`,
          )
          .first();
        if (await target.isVisible({ timeout: 300 }).catch(() => false)) {
          return target;
        }
      }

      await page.waitForTimeout(120);
    }

    return undefined;
  }

  private async getRequiredVisibleInputByHints(
    runId: string,
    page: Page,
    fieldName: string,
    hints: string[],
  ): Promise<Locator> {
    const locator = await this.getVisibleInputByHints(
      runId,
      page,
      fieldName,
      hints,
    );
    if (!locator) {
      throw new Error(
        `Campo ${fieldName} nao encontrado no popup de cadastro.`,
      );
    }
    return locator;
  }

  private async dismissInitialPopupsBeforeRegistration(
    runId: string,
    page: Page,
    profileName: string,
  ): Promise<void> {
    let totalDismissed = 0;
    let escapeFallbacks = 0;

    for (let pass = 0; pass < 8; pass += 1) {
      this.ensureRunActive(runId);
      const result = await this.withPopupPageGuard(page, () =>
        resolveContentFrame(page)
          .evaluate(() => {
            type DismissPopupResult = {
              dismissed: number;
              hasBlockingPopup: boolean;
              hasCaptchaPopup: boolean;
            };
            type RuntimeElement = {
              click?: () => void;
              closest?: (selector: string) => RuntimeElement | null;
              getAttribute?: (name: string) => string | null;
              getBoundingClientRect: () => {
                bottom: number;
                height: number;
                left: number;
                right: number;
                top: number;
                width: number;
              };
              querySelector?: (selector: string) => RuntimeElement | null;
              querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
              textContent?: string | null;
            };
            type RuntimeEvent = {
              preventDefault?: () => void;
              target?: RuntimeElement | null;
            };
            const runtimeWindow = globalThis as unknown as {
              addEventListener: (
                type: string,
                listener: (event: RuntimeEvent) => void,
                options?: boolean,
              ) => void;
              document: {
                querySelectorAll: (
                  selector: string,
                ) => Iterable<RuntimeElement>;
              };
              getComputedStyle: (element: RuntimeElement) => {
                display: string;
                visibility: string;
                opacity: string;
                zIndex: string;
              };
              innerHeight: number;
              innerWidth: number;
              open?: (...args: unknown[]) => unknown;
              removeEventListener: (
                type: string,
                listener: (event: RuntimeEvent) => void,
                options?: boolean,
              ) => void;
              setTimeout: (callback: () => void, timeout: number) => unknown;
            };
            const noPopupResult = (): DismissPopupResult => ({
              dismissed: 0,
              hasBlockingPopup: false,
              hasCaptchaPopup: false,
            });
            const normalizeText = (value: string | null | undefined) =>
              (value || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
            const isNavigatingHref = (href: string | null | undefined) => {
              const normalized = normalizeText(href);
              return Boolean(
                normalized &&
                normalized !== "#" &&
                !normalized.startsWith("#") &&
                !normalized.startsWith("javascript:") &&
                !normalized.startsWith("void(") &&
                normalized !== "about:blank",
              );
            };
            const isUrlLikeText = (text: string) =>
              /https?:|www\.|t\.me|telegram|facebook|whatsapp|wa\.me|\.com\b|\.net\b|\.org\b/i.test(
                text,
              );
            const exactDismissTexts = [
              "fechar",
              "close",
              "cancelar",
              "entendi",
              "ok",
            ];
            const phraseDismissTexts = [
              "agora não",
              "agora nao",
              "não agora",
              "nao agora",
              "depois",
              "mais tarde",
              "later",
            ];
            const actionDismissTexts = [
              "confirmar",
              "confimar",
              "confirm",
              "confirmacao",
              "continuar",
              "continue",
              "prosseguir",
              "aceitar",
              "accept",
              "concordo",
              "agree",
              "salvar",
              "save",
              "pronto",
              "done",
            ];
            const isDismissText = (value: string | null | undefined) => {
              const text = normalizeText(value);
              if (!text || text.length > 48 || isUrlLikeText(text)) {
                return false;
              }
              return (
                exactDismissTexts.includes(text) ||
                actionDismissTexts.includes(text) ||
                phraseDismissTexts.some(
                  (hint) => text === hint || text.includes(hint),
                ) ||
                (text.length <= 24 &&
                  (text.includes("fechar") || text.includes("close")))
              );
            };
            const isVisible = (element: RuntimeElement) => {
              const style = runtimeWindow.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity || "1") > 0.01 &&
                rect.width > 4 &&
                rect.height > 4 &&
                rect.right > 0 &&
                rect.bottom > 0 &&
                rect.left < runtimeWindow.innerWidth &&
                rect.top < runtimeWindow.innerHeight
              );
            };
            const isSafeClickTarget = (element: RuntimeElement) => {
              const anchor = element.closest?.("a[href]");
              const href =
                anchor?.getAttribute?.("href") ??
                element.getAttribute?.("href");
              return !isNavigatingHref(href);
            };
            const normalizeCloseClickTarget = (element: RuntimeElement) =>
              element.closest?.(
                ".ui-dialog-close-box,.van-popup__close-icon,.van-icon-cross,.icon-guanbi,.iconfontguanbistyle,.xiazaipppclose,.imgx,.popupshowimgx,.pofswpclosestyle,.xImgaes,[class*='modal-close' i],[class*='popup-close' i],[class*='dialog-close' i],[class*='icon-close' i],[class*='close-btn' i],[class*='closeBtn' i],[class*='guanbi' i],[class*='imgx' i],[class*='closestyle' i],[aria-label*='close' i],[aria-label*='fechar' i]",
              ) ??
              element.closest?.("button,[role='button'],a") ??
              element;
            const popupRootSelector =
              ".ui-popup,.ui-dialog,.van-popup,.van-dialog,.el-dialog,.el-drawer,.m_sign_in,.sign_in_body,.login_content,[role='dialog'],[aria-modal='true'],.modal,.popup,.dialog,[class*='messagepopup' i],[class*='notice' i],[class*='popup' i],[class*='ppp' i]";
            const getPopupRoot = (element: RuntimeElement) =>
              element.closest?.(popupRootSelector) ??
              element.closest?.(".ui-overlay") ??
              element;
            const getClosePriority = (element: RuntimeElement) => {
              const root = getPopupRoot(element);
              const marker = normalizeText(
                [
                  element.getAttribute?.("id"),
                  element.getAttribute?.("class"),
                  element.getAttribute?.("aria-label"),
                  element.getAttribute?.("title"),
                  element.getAttribute?.("data-testid"),
                  root.getAttribute?.("data-dialog-name"),
                  root.getAttribute?.("class"),
                ].join(" "),
              );
              let priority = 0;
              if (/messagepopup/.test(marker)) {
                priority += 80;
              }
              if (/ui-dialog-close-box/.test(marker)) {
                priority += 70;
              }
              if (
                /modal-close|popup-close|dialog-close|icon-close|close-btn|closebtn|van-popup__close|van-icon-cross|guanbi|xiazaipppclose|popupshowimgx|pofswpclosestyle|ximgaes|imgx|closestyle/.test(
                  marker,
                )
              ) {
                priority += 45;
              }
              if (/close|fechar/.test(marker)) {
                priority += 25;
              }
              return priority;
            };
            const captchaTextPattern =
              /captcha|recaptcha|hcaptcha|turnstile|geetest|gee test|deslize|arraste/i;
            const captchaSelector =
              "iframe[src*='captcha' i],iframe[src*='recaptcha' i],iframe[src*='hcaptcha' i],iframe[src*='turnstile' i],iframe[src*='geetest' i],[class*='captcha' i],[id*='captcha' i],[class*='geetest' i],[id*='geetest' i]";
            const isCaptchaPopupElement = (element: RuntimeElement) => {
              const root = getPopupRoot(element);
              const haystack = normalizeText(
                [
                  root.textContent,
                  root.getAttribute?.("id"),
                  root.getAttribute?.("class"),
                  root.getAttribute?.("aria-label"),
                  root.getAttribute?.("title"),
                ].join(" "),
              );

              return (
                captchaTextPattern.test(haystack) ||
                Boolean(root.querySelector?.(captchaSelector))
              );
            };
            const isPasswordLikeInput = (element: RuntimeElement) => {
              const haystack = normalizeText(
                [
                  element.getAttribute?.("type"),
                  element.getAttribute?.("autocomplete"),
                  element.getAttribute?.("name"),
                  element.getAttribute?.("id"),
                  element.getAttribute?.("class"),
                  element.getAttribute?.("placeholder"),
                  element.getAttribute?.("aria-label"),
                  element.getAttribute?.("title"),
                ].join(" "),
              );
              return (
                normalizeText(element.getAttribute?.("type")) === "password" ||
                /new-password|senha|password|confirm/.test(haystack)
              );
            };
            const isRegistrationPopupElement = (element: RuntimeElement) => {
              const root = getPopupRoot(element);
              const inputs = Array.from(
                root.querySelectorAll?.("input") ?? [],
              ).filter(isVisible);
              const inputText = normalizeText(
                inputs
                  .map((input) =>
                    [
                      input.getAttribute?.("type"),
                      input.getAttribute?.("autocomplete"),
                      input.getAttribute?.("name"),
                      input.getAttribute?.("id"),
                      input.getAttribute?.("class"),
                      input.getAttribute?.("placeholder"),
                      input.getAttribute?.("aria-label"),
                      input.getAttribute?.("title"),
                    ].join(" "),
                  )
                  .join(" "),
              );
              const text = normalizeText(root.textContent);
              const passwordLikeCount =
                inputs.filter(isPasswordLikeInput).length;
              return (
                inputs.length >= 3 &&
                passwordLikeCount >= 2 &&
                /registro|registrar|cadastro|cadastrar|criar conta|sign up|signup|register|join/.test(
                  `${text} ${inputText}`,
                ) &&
                /conta|account|usuario|username|celular|telefone|phone|mobile/.test(
                  `${text} ${inputText}`,
                )
              );
            };
            const getPopupScore = (element: RuntimeElement) => {
              const root = getPopupRoot(element);
              const rootStyle = runtimeWindow.getComputedStyle(root);
              const elementStyle = runtimeWindow.getComputedStyle(element);
              const rootRect = root.getBoundingClientRect();
              return {
                rootArea: rootRect.width * rootRect.height,
                zIndex:
                  Number.parseInt(
                    rootStyle.zIndex || elementStyle.zIndex || "0",
                    10,
                  ) || 0,
              };
            };
            const visiblePopupRoots = Array.from(
              runtimeWindow.document.querySelectorAll(popupRootSelector),
            ).filter((element) => isVisible(element));
            const hasCaptchaPopup = visiblePopupRoots.some((element) =>
              isCaptchaPopupElement(element),
            );
            const hasBlockingPopup = visiblePopupRoots.some(
              (element) =>
                !isCaptchaPopupElement(element) &&
                !isRegistrationPopupElement(element),
            );
            const preventAnchorNavigation = (event: RuntimeEvent) => {
              const anchor = event.target?.closest?.("a[href]");
              if (isNavigatingHref(anchor?.getAttribute?.("href"))) {
                event.preventDefault?.();
              }
            };
            const clickWithoutOpeningTabs = (element: RuntimeElement) => {
              const originalOpen = runtimeWindow.open;
              try {
                runtimeWindow.open = () => null;
                runtimeWindow.addEventListener(
                  "click",
                  preventAnchorNavigation,
                  true,
                );
                runtimeWindow.addEventListener(
                  "auxclick",
                  preventAnchorNavigation,
                  true,
                );
                element.click?.();
              } finally {
                runtimeWindow.setTimeout(() => {
                  runtimeWindow.removeEventListener(
                    "click",
                    preventAnchorNavigation,
                    true,
                  );
                  runtimeWindow.removeEventListener(
                    "auxclick",
                    preventAnchorNavigation,
                    true,
                  );
                  runtimeWindow.open = originalOpen;
                }, 1400);
              }
            };

            const closeSelectors = [
              "#loginRegisterModalCloseButton",
              ".ui-dialog-close-box__icon",
              ".ui-dialog-close-box",
              ".van-popup__close-icon",
              ".van-icon-cross",
              ".icon-guanbi",
              ".iconfontguanbistyle",
              ".xiazaipppclose",
              ".imgx",
              ".popupshowimgx",
              ".pofswpclosestyle",
              ".xImgaes",
              "[aria-label*='fechar' i]",
              "[aria-label*='close' i]",
              "[title*='fechar' i]",
              "[title*='close' i]",
              "[data-testid*='close' i]",
              "[data-testid*='fechar' i]",
              "img[class*='close' i]",
              "svg[class*='close' i]",
              "[class*='modal-close' i]",
              "[class*='popup-close' i]",
              "[class*='dialog-close' i]",
              "[class*='icon-close' i]",
              "[class*='close-icon' i]",
              "[class*='closeIcon' i]",
              "[class*='close-btn' i]",
              "[class*='closeBtn' i]",
              "[class*='guanbi' i]",
              "[class*='imgx' i]",
              "[class*='closestyle' i]",
              "[class*='close' i]",
            ];
            const textDismissHints = [
              "fechar",
              "close",
              "agora não",
              "agora nao",
              "não agora",
              "nao agora",
              "depois",
              "mais tarde",
              "later",
              "cancelar",
              "entendi",
              "ok",
            ];

            void textDismissHints;

            const candidates = new Set<RuntimeElement>();
            for (const selector of closeSelectors) {
              for (const element of runtimeWindow.document.querySelectorAll(
                selector,
              )) {
                candidates.add(normalizeCloseClickTarget(element));
              }
            }

            for (const element of runtimeWindow.document.querySelectorAll(
              "button,[role='button'],a",
            )) {
              if (isDismissText(element.textContent)) {
                candidates.add(normalizeCloseClickTarget(element));
              }
            }

            for (const root of runtimeWindow.document.querySelectorAll(
              popupRootSelector,
            )) {
              if (
                !isVisible(root) ||
                isCaptchaPopupElement(root) ||
                isRegistrationPopupElement(root)
              ) {
                continue;
              }

              for (const element of root.querySelectorAll?.(
                "button,[role='button'],.ui-button,.van-button",
              ) ?? []) {
                if (isDismissText(element.textContent)) {
                  candidates.add(normalizeCloseClickTarget(element));
                }
              }
            }

            for (const element of runtimeWindow.document.querySelectorAll(
              "button,[role='button'],a,div,span,svg,img",
            )) {
              const marker = normalizeText(
                [
                  element.getAttribute?.("id"),
                  element.getAttribute?.("class"),
                  element.getAttribute?.("aria-label"),
                  element.getAttribute?.("title"),
                  element.getAttribute?.("data-testid"),
                ].join(" "),
              );
              if (
                /close|fechar|modal-close|popup-close|dialog-close|icon-close|closebtn|close-btn|van-popup__close|van-icon-cross|guanbi|xiazaipppclose|popupshowimgx|pofswpclosestyle|ximgaes|imgx|closestyle/.test(
                  marker,
                )
              ) {
                candidates.add(normalizeCloseClickTarget(element));
              }
            }

            const candidate = Array.from(candidates)
              .filter(
                (element) =>
                  isVisible(element) &&
                  isSafeClickTarget(element) &&
                  !isCaptchaPopupElement(element) &&
                  !isRegistrationPopupElement(element),
              )
              .sort((a, b) => {
                const aRect = a.getBoundingClientRect();
                const bRect = b.getBoundingClientRect();
                const aScore = getPopupScore(a);
                const bScore = getPopupScore(b);
                return (
                  getClosePriority(b) - getClosePriority(a) ||
                  bScore.zIndex - aScore.zIndex ||
                  aRect.width * aRect.height - bRect.width * bRect.height ||
                  aScore.rootArea - bScore.rootArea
                );
              })[0];

            if (!candidate) {
              return {
                dismissed: 0,
                hasBlockingPopup,
                hasCaptchaPopup,
              };
            }

            try {
              clickWithoutOpeningTabs(candidate);
              return {
                dismissed: 1,
                hasBlockingPopup,
                hasCaptchaPopup,
              };
            } catch {
              return noPopupResult();
            }
          })
          .catch(() => ({
            dismissed: 0,
            hasBlockingPopup: false,
            hasCaptchaPopup: false,
          })),
      );

      totalDismissed += result.dismissed;
      if (result.dismissed > 0) {
        await page.waitForTimeout(140);
        continue;
      }

      if (
        result.hasBlockingPopup &&
        !result.hasCaptchaPopup &&
        escapeFallbacks < 3
      ) {
        escapeFallbacks += 1;
        await page.keyboard.press("Escape").catch(() => null);
        await page.waitForTimeout(180);
        continue;
      }

      break;
    }

    if (totalDismissed > 0) {
      console.log(
        `[${profileName}] Popups iniciais fechados antes de abrir o cadastro (${totalDismissed} clique(s)).`,
      );
    }
  }

  private async withPopupPageGuard<T>(
    page: Page,
    action: () => Promise<T>,
  ): Promise<T> {
    const context = page.context();
    const existingPages = new Set(context.pages());
    const openedPages: Page[] = [];
    const rememberOpenedPage = (openedPage: Page) => {
      if (!existingPages.has(openedPage)) {
        openedPages.push(openedPage);
      }
    };

    context.on("page", rememberOpenedPage);
    try {
      const result = await action();
      await page.waitForTimeout(120).catch(() => null);
      return result;
    } finally {
      context.off("page", rememberOpenedPage);
      await Promise.allSettled(
        openedPages
          .filter((openedPage) => openedPage !== page && !openedPage.isClosed())
          .map((openedPage) =>
            openedPage.close({ runBeforeUnload: false }).catch(() => null),
          ),
      );
    }
  }

  private async getVisibleInputByHints(
    runId: string,
    page: Page,
    fieldName: string,
    hints: string[],
    options?: {
      optional?: boolean;
      timeoutMs?: number;
      rejectHints?: string[];
    },
  ): Promise<Locator | undefined> {
    const timeoutMs = options?.timeoutMs ?? 45000;
    const rejectHints =
      options?.rejectHints?.map((hint) => this.normalizeSearchText(hint)) ?? [];
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      this.ensureRunActive(runId);
      const inputs = page.locator("input:visible");
      const count = await inputs.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const candidate = inputs.nth(index);
        const context = await candidate
          .evaluate((element) => {
            type RuntimeElement = {
              closest?: (selector: string) => RuntimeElement | null;
              getAttribute: (name: string) => string | null;
              nextElementSibling?: RuntimeElement | null;
              parentElement?: RuntimeElement | null;
              previousElementSibling?: RuntimeElement | null;
              querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
              textContent?: string | null;
            };
            const runtimeElement = element as unknown as RuntimeElement;
            const runtimeGlobal = globalThis as unknown as {
              document: {
                getElementById: (id: string) => RuntimeElement | null;
                querySelector: (selector: string) => RuntimeElement | null;
              };
            };
            const normalize = (value: string | null | undefined) =>
              (value || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
            const cssEscape = (value: string) =>
              value.replace(/["\\]/g, "\\$&");
            const read = (target: RuntimeElement | null | undefined) =>
              normalize(target?.textContent);
            const id = runtimeElement.getAttribute("id");
            const ariaLabelledBy =
              runtimeElement.getAttribute("aria-labelledby");
            const labelledByText = ariaLabelledBy
              ?.split(/\s+/)
              .map((entry: string) =>
                read(runtimeGlobal.document.getElementById(entry)),
              )
              .join(" ");
            const labelText = [
              id
                ? read(
                    runtimeGlobal.document.querySelector(
                      `label[for="${cssEscape(id)}"]`,
                    ),
                  )
                : "",
              read(runtimeElement.closest?.("label")),
              normalize(runtimeElement.getAttribute("aria-label")),
              normalize(labelledByText),
            ].join(" ");
            const wrapper =
              runtimeElement.closest?.(
                "label,.ui-input,.van-field,.form-item,.form-control,.input-item,.input_box,.m_input_box,.el-form-item,.field,.form-row",
              ) ?? runtimeElement.parentElement;
            const section =
              runtimeElement.closest?.(
                "form,.ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,.dialog,.m_sign_in,.sign_in_body,.login_content,.form_box",
              ) ?? runtimeElement.parentElement;
            const siblings = [
              runtimeElement.previousElementSibling,
              runtimeElement.nextElementSibling,
              wrapper?.previousElementSibling,
              wrapper?.nextElementSibling,
            ]
              .map(read)
              .join(" ");
            const inputs = Array.from(
              section?.querySelectorAll?.("input") ?? [],
            );
            const isPasswordLikeInput = (input: RuntimeElement) => {
              const haystack = normalize(
                [
                  input.getAttribute("type"),
                  input.getAttribute("autocomplete"),
                  input.getAttribute("name"),
                  input.getAttribute("id"),
                  input.getAttribute("data-input-name"),
                  input.getAttribute("class"),
                  input.getAttribute("placeholder"),
                  input.getAttribute("aria-label"),
                  input.getAttribute("title"),
                ].join(" "),
              );
              return (
                normalize(input.getAttribute("type")) === "password" ||
                /new-password|senha|password|confirm/.test(haystack)
              );
            };
            const passwordInputs = inputs.filter(isPasswordLikeInput);
            return {
              autocomplete: normalize(
                runtimeElement.getAttribute("autocomplete"),
              ),
              identity: normalize(
                [
                  runtimeElement.getAttribute("name"),
                  runtimeElement.getAttribute("id"),
                  runtimeElement.getAttribute("data-input-name"),
                  runtimeElement.getAttribute("class"),
                ].join(" "),
              ),
              inputMode: normalize(runtimeElement.getAttribute("inputmode")),
              labelText,
              siblingText: normalize(siblings),
              wrapperText: normalize(wrapper?.textContent),
              placeholder: normalize(
                runtimeElement.getAttribute("placeholder"),
              ),
              sectionText: normalize(section?.textContent).slice(0, 1200),
              title: normalize(runtimeElement.getAttribute("title")),
              type: normalize(runtimeElement.getAttribute("type")),
              maxLength: normalize(runtimeElement.getAttribute("maxlength")),
              passwordLike: isPasswordLikeInput(runtimeElement),
              passwordIndex: passwordInputs.indexOf(runtimeElement),
              passwordInputCount: passwordInputs.length,
              visibleIndex: Math.max(0, inputs.indexOf(runtimeElement)),
              visibleInputCount: inputs.length,
            };
          })
          .catch(() => ({
            autocomplete: "",
            identity: "",
            inputMode: "",
            labelText: "",
            passwordIndex: -1,
            placeholder: "",
            sectionText: "",
            siblingText: "",
            title: "",
            type: "",
            maxLength: "",
            passwordLike: false,
            visibleIndex: index,
            visibleInputCount: count,
            passwordInputCount: 0,
            wrapperText: "",
          }));

        const rejectHaystack = this.normalizeSearchText(
          [
            context.labelText,
            context.autocomplete,
            context.identity,
            context.inputMode,
            context.title,
            context.placeholder,
            context.siblingText,
          ].join(" "),
        );

        if (rejectHints.some((hint) => rejectHaystack.includes(hint))) {
          continue;
        }

        const normalizedHints = hints
          .map((hint) => this.normalizeSearchText(hint))
          .filter(Boolean);
        const hintsText = normalizedHints.join(" ");
        const sourceScore = (value: string, weight: number) =>
          normalizedHints.some((hint) => value.includes(hint)) ? weight : 0;
        let score =
          sourceScore(context.labelText, 90) +
          sourceScore(context.wrapperText, 64) +
          sourceScore(context.autocomplete, 62) +
          sourceScore(context.identity, 48) +
          sourceScore(context.title, 40) +
          sourceScore(context.placeholder, 18) +
          sourceScore(context.siblingText, 12) +
          sourceScore(context.sectionText, 6);

        if (/senha|password/.test(hintsText) && context.passwordLike) {
          if (/confirm|confirma|repet|again/.test(hintsText)) {
            score += context.passwordIndex > 0 ? 90 : -70;
          } else {
            score += context.passwordIndex === 0 ? 90 : -30;
          }
        }

        if (
          /conta|account|usuario|username/.test(hintsText) &&
          context.type !== "password"
        ) {
          const accountStructuralText = this.normalizeSearchText(
            [
              context.labelText,
              context.wrapperText,
              context.autocomplete,
              context.identity,
              context.inputMode,
              context.title,
              context.placeholder,
            ].join(" "),
          );
          const hasAccountHint = /conta|account|usuario|username/.test(
            accountStructuralText,
          );
          if (hasAccountHint) {
            score += 46;
          }
          if (
            hasAccountHint &&
            context.passwordInputCount >= 2 &&
            context.visibleIndex === 0
          ) {
            score += 24;
          }
        }

        if (/telefone|celular|phone|mobile/.test(hintsText)) {
          const phoneStructuralText = `${context.type} ${context.inputMode} ${context.autocomplete} ${context.identity}`;
          const maxLength = Number.parseInt(context.maxLength || "0", 10);
          const hasPhoneSizedLimit = maxLength >= 8 && maxLength <= 15;
          if (
            /tel|numeric|decimal|phone|mobile|cell|celular|telefone/.test(
              phoneStructuralText,
            )
          ) {
            score += 46;
          }
          if (
            context.passwordInputCount >= 2 &&
            context.visibleIndex > context.passwordInputCount
          ) {
            score += 18;
          }
          if (hasPhoneSizedLimit) {
            score += 8;
          }
          if (
            context.passwordInputCount >= 2 &&
            context.visibleIndex > context.passwordInputCount &&
            hasPhoneSizedLimit
          ) {
            score += 30;
          }
          if (
            /email|cpf|document|documento|realname|real-name|nome/.test(
              phoneStructuralText,
            )
          ) {
            score -= 70;
          }
        }

        if (score >= 55) {
          return candidate;
        }
      }

      await page.waitForTimeout(100);
    }

    if (options?.optional) {
      return undefined;
    }

    throw new Error(`Campo ${fieldName} nao encontrado no popup de cadastro.`);
  }

  private async fastFillRegistrationMainFields(
    runId: string,
    page: Page,
    fields: Array<{ fieldName: string; locator: Locator; value: string }>,
  ): Promise<boolean> {
    this.ensureRunActive(runId);
    try {
      await Promise.all(
        fields.map((field) =>
          this.forceSetFieldValue(field.locator, field.value),
        ),
      );
      await page.waitForTimeout(25).catch(() => null);
      const values = await Promise.all(
        fields.map((field) => this.readFieldValue(field.locator)),
      );
      return values.every((value, index) => value === fields[index]?.value);
    } catch {
      return false;
    }
  }

  private async fastFillRegistrationOptionalFields(
    runId: string,
    page: Page,
    values: { cpf?: string; phoneNumber?: string; realName?: string },
  ): Promise<{ cpf: boolean; phone: boolean; realName: boolean }> {
    this.ensureRunActive(runId);
    return page
      .evaluate((payload) => {
        type RuntimeRect = {
          bottom: number;
          height: number;
          left: number;
          right: number;
          top: number;
          width: number;
        };
        type RuntimeElement = {
          autocomplete?: string;
          checked?: boolean;
          closest?: (selector: string) => RuntimeElement | null;
          disabled?: boolean;
          dispatchEvent?: (event: Event) => boolean;
          focus?: (options?: { preventScroll?: boolean }) => void;
          getAttribute?: (name: string) => string | null;
          getBoundingClientRect: () => RuntimeRect;
          id?: string;
          name?: string;
          nextElementSibling?: RuntimeElement | null;
          parentElement?: RuntimeElement | null;
          placeholder?: string;
          previousElementSibling?: RuntimeElement | null;
          querySelectorAll?: (selector: string) => Iterable<RuntimeElement>;
          readOnly?: boolean;
          removeAttribute?: (name: string) => void;
          tagName?: string;
          textContent?: string | null;
          type?: string;
          value?: string;
        };
        type RuntimeWindow = typeof globalThis & {
          document: {
            body?: RuntimeElement;
            getElementById: (id: string) => RuntimeElement | null;
            querySelector: (selector: string) => RuntimeElement | null;
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
          };
          getComputedStyle: (element: RuntimeElement) => {
            display: string;
            opacity: string;
            visibility: string;
          };
          innerHeight: number;
          innerWidth: number;
          InputEvent?: new (
            type: string,
            init?: {
              bubbles?: boolean;
              cancelable?: boolean;
              data?: string;
              inputType?: string;
            },
          ) => Event;
        };
        const runtimeWindow = globalThis as RuntimeWindow;
        const normalize = (value: string | null | undefined) =>
          (value || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const cssEscape = (value: string) => value.replace(/["\\]/g, "\\$&");
        const read = (target: RuntimeElement | null | undefined) =>
          normalize(target?.textContent);
        const isVisible = (element: RuntimeElement) => {
          const style = runtimeWindow.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 4 &&
            rect.height > 4 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < runtimeWindow.innerWidth &&
            rect.top < runtimeWindow.innerHeight
          );
        };
        const isPasswordLikeInput = (input: RuntimeElement) => {
          const haystack = normalize(
            [
              input.getAttribute?.("type"),
              input.getAttribute?.("autocomplete"),
              input.getAttribute?.("name"),
              input.getAttribute?.("id"),
              input.getAttribute?.("data-input-name"),
              input.getAttribute?.("class"),
              input.getAttribute?.("placeholder"),
              input.getAttribute?.("aria-label"),
              input.getAttribute?.("title"),
            ].join(" "),
          );
          return (
            normalize(input.getAttribute?.("type")) === "password" ||
            /new-password|senha|password|confirm/.test(haystack)
          );
        };
        const setValue = (target: RuntimeElement, nextValue: string) => {
          target.disabled = false;
          target.readOnly = false;
          target.removeAttribute?.("disabled");
          target.removeAttribute?.("readonly");
          target.focus?.({ preventScroll: true });
          const valueSetter = (
            Object.getOwnPropertyDescriptor(
              Object.getPrototypeOf(target),
              "value",
            ) as
              | { set?: (this: RuntimeElement, value: string) => void }
              | undefined
          )?.set;
          if (valueSetter) {
            valueSetter.call(target, nextValue);
          } else if ("value" in target) {
            target.value = nextValue;
          } else {
            target.textContent = nextValue;
          }
          if (
            target.getAttribute?.("contenteditable") === "true" ||
            target.getAttribute?.("role") === "textbox"
          ) {
            target.textContent = nextValue;
          }
          const inputEvent = runtimeWindow.InputEvent
            ? new runtimeWindow.InputEvent("input", {
                bubbles: true,
                cancelable: true,
                data: nextValue,
                inputType: "insertText",
              })
            : new runtimeWindow.Event("input", {
                bubbles: true,
                cancelable: true,
              });
          target.dispatchEvent?.(
            new runtimeWindow.Event("beforeinput", {
              bubbles: true,
              cancelable: true,
            }),
          );
          target.dispatchEvent?.(inputEvent);
          target.dispatchEvent?.(
            new runtimeWindow.Event("keyup", { bubbles: true }),
          );
          target.dispatchEvent?.(
            new runtimeWindow.Event("change", { bubbles: true }),
          );
          target.dispatchEvent?.(
            new runtimeWindow.Event("compositionend", { bubbles: true }),
          );
        };
        const allInputs = (
          Array.from(
            runtimeWindow.document.querySelectorAll(
              "input,textarea,[contenteditable='true'],[role='textbox']",
            ),
          ) as unknown as RuntimeElement[]
        ).filter(isVisible);
        const rootFor = (input: RuntimeElement) =>
          input.closest?.(
            "form,.ui-popup,.ui-dialog,.van-popup,.van-dialog,[role='dialog'],[aria-modal='true'],.modal,.popup,.dialog,.m_sign_in,.sign_in_body,.login_content,.form_box",
          ) ?? runtimeWindow.document.body;
        const contextFor = (input: RuntimeElement) => {
          const id = input.getAttribute?.("id");
          const ariaLabelledBy = input.getAttribute?.("aria-labelledby");
          const labelledByText = ariaLabelledBy
            ?.split(/\s+/)
            .map((entry: string) =>
              read(
                runtimeWindow.document.getElementById(
                  entry,
                ) as unknown as RuntimeElement | null,
              ),
            )
            .join(" ");
          const labelText = [
            id
              ? read(
                  runtimeWindow.document.querySelector(
                    `label[for="${cssEscape(id)}"]`,
                  ) as unknown as RuntimeElement | null,
                )
              : "",
            read(input.closest?.("label")),
            normalize(input.getAttribute?.("aria-label")),
            normalize(labelledByText),
          ].join(" ");
          const wrapper =
            input.closest?.(
              "label,.ui-input,.van-field,.form-item,.form-control,.input-item,.input_box,.m_input_box,.el-form-item,.field,.form-row",
            ) ?? input.parentElement;
          const section = rootFor(input);
          const siblings = [
            input.previousElementSibling,
            input.nextElementSibling,
            wrapper?.previousElementSibling,
            wrapper?.nextElementSibling,
          ]
            .map(read)
            .join(" ");
          const sectionInputs = Array.from(
            section?.querySelectorAll?.("input") ?? [],
          ).filter(isVisible);
          const passwordInputs = sectionInputs.filter(isPasswordLikeInput);
          return {
            autocomplete: normalize(input.getAttribute?.("autocomplete")),
            identity: normalize(
              [
                input.getAttribute?.("name"),
                input.getAttribute?.("id"),
                input.getAttribute?.("data-input-name"),
                input.getAttribute?.("class"),
              ].join(" "),
            ),
            inputMode: normalize(input.getAttribute?.("inputmode")),
            labelText,
            maxLength: normalize(input.getAttribute?.("maxlength")),
            passwordInputCount: passwordInputs.length,
            passwordLike: isPasswordLikeInput(input),
            placeholder: normalize(input.getAttribute?.("placeholder")),
            sectionText: normalize(section?.textContent).slice(0, 1200),
            siblingText: normalize(siblings),
            title: normalize(input.getAttribute?.("title")),
            type: normalize(input.getAttribute?.("type")),
            value:
              typeof input.value === "string"
                ? input.value
                : (input.textContent ?? ""),
            visibleIndex: Math.max(0, sectionInputs.indexOf(input)),
            wrapperText: normalize(wrapper?.textContent),
          };
        };
        const normalizedHints = (hints: string[]) =>
          hints.map(normalize).filter(Boolean);
        const sourceScore = (
          context: ReturnType<typeof contextFor>,
          hints: string[],
          weight: number,
        ) =>
          hints.some((hint) =>
            [
              context.labelText,
              context.wrapperText,
              context.autocomplete,
              context.identity,
              context.inputMode,
              context.title,
              context.placeholder,
              context.siblingText,
              context.sectionText,
            ].some((source) => source.includes(hint)),
          )
            ? weight
            : 0;
        const used = new Set<RuntimeElement>();
        const filled = { cpf: false, phone: false, realName: false };
        const chooseAndFill = (
          key: keyof typeof filled,
          value: string | undefined,
          hints: string[],
          reject: RegExp,
          boost: (context: ReturnType<typeof contextFor>) => number,
        ) => {
          if (!value) {
            return;
          }
          const hintList = normalizedHints(hints);
          const best = allInputs
            .filter((input) => {
              if (used.has(input)) return false;
              const context = contextFor(input);
              if (context.passwordLike) return false;
              if (context.value.trim()) return false;
              const rejectHaystack = [
                context.labelText,
                context.wrapperText,
                context.autocomplete,
                context.identity,
                context.inputMode,
                context.title,
                context.placeholder,
                context.siblingText,
              ].join(" ");
              return !reject.test(rejectHaystack);
            })
            .map((input) => {
              const context = contextFor(input);
              let score =
                sourceScore(context, hintList, 90) +
                sourceScore(context, hintList, 64) +
                sourceScore(context, hintList, 44) +
                boost(context);
              if (
                context.type === "hidden" ||
                context.type === "file" ||
                context.type === "checkbox" ||
                context.type === "radio"
              ) {
                score -= 200;
              }
              return { context, input, score };
            })
            .sort((left, right) => right.score - left.score)[0];
          if (best && best.score >= 55) {
            setValue(best.input, value);
            used.add(best.input);
            filled[key] = true;
          }
        };

        chooseAndFill(
          "phone",
          payload.phoneNumber,
          ["Digite o Celular", "celular", "telefone", "phone", "mobile"],
          /conta|account|usuario|username|cpf|documento|nome|name/,
          (context) => {
            const structural = `${context.type} ${context.inputMode} ${context.autocomplete} ${context.identity}`;
            const maxLength = Number.parseInt(context.maxLength || "0", 10);
            const hasPhoneSizedLimit = maxLength >= 8 && maxLength <= 15;
            return (
              (/tel|numeric|decimal|phone|mobile|cell|celular|telefone/.test(
                structural,
              )
                ? 46
                : 0) +
              (context.passwordInputCount >= 2 &&
              context.visibleIndex > context.passwordInputCount
                ? 18
                : 0) +
              (hasPhoneSizedLimit ? 8 : 0) +
              (context.passwordInputCount >= 2 &&
              context.visibleIndex > context.passwordInputCount &&
              hasPhoneSizedLimit
                ? 30
                : 0) -
              (/email|cpf|document|documento|realname|real-name|nome/.test(
                structural,
              )
                ? 70
                : 0)
            );
          },
        );
        chooseAndFill(
          "realName",
          payload.realName,
          [
            "Introduza o seu nome real",
            "nome real",
            "nome completo",
            "full name",
            "real name",
            "realName",
          ],
          /conta|account|usuario|username|apelido|nickname|celular|telefone|phone|cpf|documento/,
          (context) =>
            /name|nome|realname|real-name/.test(
              `${context.identity} ${context.placeholder} ${context.autocomplete}`,
            )
              ? 42
              : 0,
        );
        chooseAndFill(
          "cpf",
          payload.cpf,
          ["CPF", "documento", "document number", "tax id"],
          /celular|telefone|phone|mobile|nome|name|senha|password/,
          (context) =>
            /cpf|document|documento|tax/.test(
              `${context.identity} ${context.placeholder} ${context.autocomplete}`,
            )
              ? 48
              : 0,
        );

        return filled;
      }, values)
      .catch(() => ({ cpf: false, phone: false, realName: false }));
  }

  private async fastAcceptRegistrationTerms(
    runId: string,
    page: Page,
  ): Promise<boolean> {
    this.ensureRunActive(runId);
    return page
      .evaluate(() => {
        type RuntimeElement = {
          checked?: boolean;
          click?: () => void;
          dispatchEvent?: (event: Event) => boolean;
          getBoundingClientRect: () => BrowserRuntimeRect;
        };
        const runtimeWindow = globalThis as unknown as {
          Event: new (type: string, init?: { bubbles?: boolean }) => Event;
          document: {
            querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
          };
          getComputedStyle: (element: RuntimeElement) => {
            display: string;
            opacity: string;
            visibility: string;
          };
          innerHeight: number;
          innerWidth: number;
        };
        const isVisible = (element: RuntimeElement) => {
          const style = runtimeWindow.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0.01 &&
            rect.width > 4 &&
            rect.height > 4 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < runtimeWindow.innerWidth &&
            rect.top < runtimeWindow.innerHeight
          );
        };
        const checkbox = Array.from(
          runtimeWindow.document.querySelectorAll("input[type='checkbox']"),
        ).filter((input) => isVisible(input) && !input.checked)[0];
        if (!checkbox) {
          return false;
        }
        checkbox.click?.();
        checkbox.checked = true;
        checkbox.dispatchEvent?.(
          new runtimeWindow.Event("input", { bubbles: true }),
        );
        checkbox.dispatchEvent?.(
          new runtimeWindow.Event("change", { bubbles: true }),
        );
        return true;
      })
      .catch(() => false);
  }

  private async fastClickControl(
    runId: string,
    page: Page,
    locator: Locator,
  ): Promise<void> {
    this.ensureRunActive(runId);
    try {
      await this.waitActionable(locator, { budgetMs: 2500, runId });
      await locator
        .evaluate((element) => {
          element.scrollIntoView({
            block: "center",
            inline: "center",
          });
        })
        .catch(() => null);
      const box = await locator.boundingBox().catch(() => null);
      if (!box) {
        await this.activateElementDirectly(locator);
        return;
      }
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      if (await this.prefersTouchTap(page)) {
        await page.touchscreen.tap(x, y);
      } else {
        await page.mouse.click(x, y);
      }
    } catch {
      await this.humanMouseClick(runId, page, locator);
    }
  }

  private async humanTypeField(
    runId: string,
    page: Page,
    locator: Locator,
    value: string,
  ): Promise<void> {
    this.ensureRunActive(runId);
    await this.focusFieldForTyping(runId, page, locator);
    await page.waitForTimeout(50).catch(() => null);
    // Espera o campo ficar realmente acionavel e confirma que o valor entrou: em
    // plataforma lenta ou com emulacao touch, a digitacao programatica pode ser descartada
    // (ex.: "49" virar "9"). Retry + backoff em vez de timeout fixo curto.
    await this.withActionRetry(runId, page, async () => {
      await this.waitActionable(locator, { runId });
      let directSetError: unknown;
      await this.forceSetFieldValue(locator, value).catch((error) => {
        directSetError = error;
      });
      await page.waitForTimeout(40).catch(() => null);

      let actual = await this.readFieldValue(locator);
      if (value.length > 0 && (actual === null || actual === "")) {
        await locator
          .fill(value, {
            timeout: AutomationRuntimeService.ACTION_PROBE_BUDGET_MS,
          })
          .catch((error) => {
            directSetError ??= error;
          });
        actual = await this.readFieldValue(locator);
      }
      if (value.length > 0 && (actual === null || actual === "")) {
        await this.forceSetFieldValue(locator, value).catch((error) => {
          directSetError ??= error;
        });
        await page.waitForTimeout(40).catch(() => null);
        actual = await this.readFieldValue(locator);
      }
      if (value.length > 0 && (actual === null || actual === "")) {
        const reason =
          directSetError instanceof Error ? `: ${directSetError.message}` : "";
        throw new Error(
          `campo ficou vazio apos fallback de preenchimento${reason}`,
        );
      }
    });
  }

  private async focusFieldForTyping(
    runId: string,
    page: Page,
    locator: Locator,
  ): Promise<void> {
    this.ensureRunActive(runId);
    await this.waitActionable(locator, {
      budgetMs: AutomationRuntimeService.ACTIONABLE_BUDGET_MS,
      runId,
    });
    await locator
      .evaluate((element) => {
        type RuntimeElement = {
          focus?: (options?: { preventScroll?: boolean }) => void;
          scrollIntoView?: (options?: {
            block?: string;
            inline?: string;
          }) => void;
        };
        const target = element as unknown as RuntimeElement;
        target.scrollIntoView?.({
          block: "center",
          inline: "center",
        });
        target.focus?.({
          preventScroll: false,
        });
      })
      .catch(() => null);

    const box = await locator.boundingBox().catch(() => null);
    if (box) {
      const x = box.x + box.width * this.randomFloat(0.38, 0.62);
      const y = box.y + box.height * this.randomFloat(0.35, 0.65);
      await page.touchscreen.tap(x, y).catch(() => null);
    }

    await locator
      .focus({ timeout: AutomationRuntimeService.ACTION_PROBE_BUDGET_MS })
      .catch(() => null);
  }

  private async readFieldValue(locator: Locator): Promise<string | null> {
    const inputValue = await locator.inputValue().catch(() => null);
    if (inputValue !== null) {
      return inputValue;
    }

    return locator
      .evaluate((element) => {
        const field = element as unknown as {
          textContent?: string | null;
          value?: unknown;
        };
        return typeof field.value === "string"
          ? field.value
          : (field.textContent ?? null);
      })
      .catch(() => null);
  }

  private async forceSetFieldValue(
    locator: Locator,
    value: string,
  ): Promise<void> {
    await locator.evaluate((element, nextValue) => {
      type RuntimeWindow = typeof globalThis & {
        Event: new (
          type: string,
          init?: { bubbles?: boolean; cancelable?: boolean },
        ) => Event;
        InputEvent?: new (
          type: string,
          init?: {
            bubbles?: boolean;
            cancelable?: boolean;
            data?: string;
            inputType?: string;
          },
        ) => Event;
      };
      type RuntimeElement = {
        value?: string;
        disabled?: boolean;
        readOnly?: boolean;
        textContent: string | null;
        getAttribute: (name: string) => string | null;
        dispatchEvent: (event: Event) => boolean;
        focus?: (options?: { preventScroll?: boolean }) => void;
        removeAttribute?: (name: string) => void;
      };

      const runtimeWindow = globalThis as RuntimeWindow;
      const target = element as RuntimeElement;
      target.disabled = false;
      target.readOnly = false;
      target.removeAttribute?.("disabled");
      target.removeAttribute?.("readonly");
      target.focus?.({ preventScroll: false });

      const valueSetter = (
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(target),
          "value",
        ) as { set?: (this: RuntimeElement, value: string) => void } | undefined
      )?.set;
      if (valueSetter) {
        valueSetter.call(target, nextValue);
      } else if ("value" in target) {
        target.value = nextValue;
      } else {
        target.textContent = nextValue;
      }

      if (
        target.getAttribute("contenteditable") === "true" ||
        target.getAttribute("role") === "textbox"
      ) {
        target.textContent = nextValue;
      }

      const inputEvent = runtimeWindow.InputEvent
        ? new runtimeWindow.InputEvent("input", {
            bubbles: true,
            cancelable: true,
            data: nextValue,
            inputType: "insertText",
          })
        : new runtimeWindow.Event("input", { bubbles: true, cancelable: true });
      target.dispatchEvent(
        new runtimeWindow.Event("beforeinput", {
          bubbles: true,
          cancelable: true,
        }),
      );
      target.dispatchEvent(inputEvent);
      target.dispatchEvent(new runtimeWindow.Event("keyup", { bubbles: true }));
      target.dispatchEvent(
        new runtimeWindow.Event("change", { bubbles: true }),
      );
      target.dispatchEvent(
        new runtimeWindow.Event("compositionend", { bubbles: true }),
      );
    }, value);
  }

  // Espera o elemento ficar acionavel de verdade (visivel + habilitado) ate um budget
  // generoso, com polling curto que nao trava a thread. Independe de plataforma: e o
  // --- Gate de carregamento INTERNO da plataforma (alem do domcontentloaded) ---
  // Estas SPAs tem ate TRES sinais de carregamento, e o navegador so reflete o 1o:
  //   (1) load do navegador           -> domcontentloaded (ja tratado nos goto).
  //   (2) splash interno no boot       -> overlay fixo cobrindo a tela
  //       (#startLodingContent / .global_loading_content / ui-loading).
  //   (3) barra NProgress no topo      -> #nprogress + classe nprogress-busy no <html>,
  //       que aparece nas trocas de rota SEM reload (Perfil/Home/Saque/Deposito).
  // Sem esperar (2)/(3) sumirem, o proximo passo procura/clica numa tela meio montada
  // (alvo coberto pelo overlay ou ainda inexistente) — causa de falhas "o carregamento
  // demorou mais do que o previsto". Generico: nao conhece dominio; varre TODOS os
  // frames (cobre o caso da plataforma que roda dentro de um iframe).
  private async isPlatformLoading(page: Page): Promise<boolean> {
    for (const frame of page.frames()) {
      const loading = await frame
        .evaluate(() => {
          type RuntimeLoaderElement = {
            getBoundingClientRect: () => { height: number; width: number };
          };
          const runtimeWindow = globalThis as unknown as {
            document: {
              documentElement: {
                classList?: { contains: (token: string) => boolean };
              } | null;
              getElementById: (id: string) => RuntimeLoaderElement | null;
              querySelectorAll: (
                selector: string,
              ) => Iterable<RuntimeLoaderElement>;
            } | null;
            getComputedStyle: (element: RuntimeLoaderElement) => {
              display: string;
              opacity: string;
              position: string;
              visibility: string;
            };
          };
          const doc = runtimeWindow.document;
          if (!doc) return false;
          // (3) Barra de troca de rota (NProgress) — sinal autoritativo no <html>.
          if (doc.documentElement?.classList?.contains("nprogress-busy"))
            return true;
          const showState = (element: RuntimeLoaderElement | null) => {
            if (!element) return undefined;
            const style = runtimeWindow.getComputedStyle(element);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              Number(style.opacity || "1") <= 0.01
            ) {
              return undefined;
            }
            return {
              position: style.position,
              rect: element.getBoundingClientRect(),
            };
          };
          const nprogress = showState(doc.getElementById("nprogress"));
          if (nprogress && nprogress.rect.width > 0) return true;
          // (2) Splash de boot — overlay fixo/absoluto cobrindo a tela. O filtro de
          // posicao+tamanho evita confundir com icones/spinners pequenos da UI normal.
          for (const element of doc.querySelectorAll(
            "#startLodingContent, [class*='global_loading' i], [class*='ui-loading' i]",
          )) {
            const shown = showState(element);
            if (!shown) continue;
            const coversScreen =
              (shown.position === "fixed" || shown.position === "absolute") &&
              shown.rect.width >= 80 &&
              shown.rect.height >= 80;
            if (coversScreen) return true;
          }
          return false;
        })
        .catch(() => false);
      if (loading) return true;
    }
    return false;
  }

  // Loop de polling cru: retorna true assim que o loading some por `settleMs` continuos,
  // ou false se estourar `timeoutMs`. O settle evita "vazar" pela janela entre o clique e
  // o NProgress.start(), ou entre dois passos.
  private async pollPlatformLoadingClear(
    runId: string,
    page: Page,
    timeoutMs: number,
    settleMs: number,
  ): Promise<boolean> {
    const startedAt = Date.now();
    let clearSince: number | undefined;
    while (Date.now() - startedAt < timeoutMs) {
      this.ensureRunActive(runId);
      if (await this.isPlatformLoading(page)) {
        clearSince = undefined;
      } else {
        if (clearSince === undefined) clearSince = Date.now();
        if (Date.now() - clearSince >= settleMs) return true;
      }
      await page.waitForTimeout(120).catch(() => null);
    }
    return !(await this.isPlatformLoading(page));
  }

  // Espera o carregamento interno da plataforma sumir antes de devolver o controle.
  // Budget generoso (e justamente o caso "demorou mais que o previsto"); retorna assim
  // que estiver limpo.
  //
  // `retryWithReload`: nos pontos que acabaram de fazer goto (inicio de cada fluxo), a SPA
  // as vezes "trava" num loading infinito que so um refresh destrava (confirmado na mao).
  // Nesses casos usamos um budget menor na 1a tentativa (sem reload, esperar 25s e falhar
  // e desperdicio: a pagina presa nao se recupera sozinha), damos UM reload e tentamos de
  // novo com budget curto. NAO usar em route-change SPA pos-clique: o reload cancelaria a
  // navegacao recem-iniciada.
  private async waitForPlatformLoadingToClear(
    runId: string,
    page: Page,
    options?: {
      timeoutMs?: number;
      settleMs?: number;
      retryWithReload?: boolean;
    },
  ): Promise<boolean> {
    const settleMs = options?.settleMs ?? 250;
    const retryWithReload = options?.retryWithReload ?? false;
    const timeoutMs = options?.timeoutMs ?? (retryWithReload ? 15000 : 25000);

    const cleared = await this.pollPlatformLoadingClear(
      runId,
      page,
      timeoutMs,
      settleMs,
    );
    if (cleared || !retryWithReload) return cleared;

    // Travou no loading. Um reload costuma destravar a SPA; tentamos uma vez com budget curto.
    this.log(
      runId,
      "warning",
      "Carregamento da plataforma travou; atualizando a pagina para tentar destravar.",
    );
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 20000 })
      .catch(() => null);
    return this.pollPlatformLoadingClear(runId, page, 12000, settleMs);
  }

  // Pagina utilizavel da plataforma (nao auxiliar/badge) e com o loading interno ja
  // resolvido num budget curto, SEM reload. Mesmos criterios de "usavel" que
  // resolveDepositFlowPage usa para reaproveitar a pagina atual.
  private async isPlatformPageReady(
    runId: string,
    page: Page,
  ): Promise<boolean> {
    if (page.isClosed()) {
      return false;
    }
    const state = await this.readAutomationPageState(page).catch(
      () => undefined,
    );
    if (
      !state ||
      state.auxiliary ||
      state.viewportWidth <= 0 ||
      state.viewportHeight <= 0
    ) {
      return false;
    }
    if (isDetachedDepositRouteState(state)) {
      return false;
    }
    return this.pollPlatformLoadingClear(runId, page, 2500, 250);
  }

  // Garante a home carregada no inicio de um fluxo manual (saque/PIX/deposito). Esses fluxos
  // rodam logo apos ensureLoggedIn — que ja navegou para a home e confirmou a sessao — entao
  // um segundo goto so recarregaria a SPA a toa (origem das "duas recargas" relatadas). So
  // navegamos quando a pagina ainda nao e uma pagina utilizavel da plataforma com o loading
  // limpo. Espelha prepareLocalDepositAfterSuccessfulRegistration, que ja confia na pagina
  // resolvida sem re-navegar.
  private async ensurePlatformHomeLoaded(
    runId: string,
    page: Page,
    profile: ProfileSummary,
    startUrl: string,
  ): Promise<void> {
    const state = await this.readAutomationPageState(page).catch(
      () => undefined,
    );
    if (state && isDetachedDepositRouteState(state)) {
      this.log(
        runId,
        "info",
        `[${profile.name}] Rota de deposito solta detectada; voltando para a entrada da plataforma.`,
      );
    }
    if (await this.isPlatformPageReady(runId, page)) {
      this.log(
        runId,
        "info",
        `[${profile.name}] Pagina ja carregada na plataforma; reaproveitando sem recarregar.`,
      );
      return;
    }
    await page
      .goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20000 })
      .catch(() => null);
    await this.waitForPlatformLoadingToClear(runId, page, {
      retryWithReload: true,
    });
  }

  // tempo real de prontidao do ponto que manda, nao um timeout fixo. Lanca se estourar.
  private async waitActionable(
    locator: Locator,
    opts?: { runId?: string; budgetMs?: number },
  ): Promise<void> {
    const budgetMs =
      opts?.budgetMs ?? AutomationRuntimeService.ACTIONABLE_BUDGET_MS;
    if (opts?.runId) {
      this.ensureRunActive(opts.runId);
    }
    await locator.waitFor({ state: "visible", timeout: budgetMs });
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (opts?.runId) {
        this.ensureRunActive(opts.runId);
      }
      const enabled = await locator.isEnabled().catch(() => true);
      if (enabled) {
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(150, Math.max(0, deadline - Date.now()))),
      );
    }
  }

  // Executa uma acao de interacao com retry + backoff exponencial, reavaliando a
  // actionability a cada tentativa (a plataforma pode ainda estar montando o ponto).
  // Generico: nao conhece dominios nem seletores. Propaga o ultimo erro se esgotar.
  private async withActionRetry<T>(
    runId: string,
    page: Page,
    action: (attempt: number) => Promise<T>,
    attempts: number = AutomationRuntimeService.ACTION_ATTEMPTS,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.ensureRunActive(runId);
      try {
        return await action(attempt);
      } catch (error) {
        lastError = error;
        if (attempt < attempts - 1) {
          const backoff =
            AutomationRuntimeService.ACTION_BACKOFF_BASE_MS * 2 ** attempt;
          await this.waitForRunDelay(runId, page, backoff);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async humanMouseClick(
    runId: string,
    page: Page,
    locator: Locator,
  ): Promise<void> {
    this.ensureRunActive(runId);
    try {
      await this.withActionRetry(runId, page, () =>
        this.performHumanClick(runId, page, locator),
      );
    } catch {
      // Esgotou as tentativas mesmo apos esperar actionability real: ultimo recurso e
      // ativar o elemento diretamente (JS click), preservando o comportamento antigo de
      // nao falhar duro — mas agora so depois de ter realmente esperado e repetido.
      this.ensureRunActive(runId);
      await this.activateElementDirectly(locator);
    }
  }

  private async performHumanClick(
    runId: string,
    page: Page,
    locator: Locator,
  ): Promise<void> {
    await this.waitActionable(locator, { runId });
    await locator
      .evaluate((element) => {
        element.scrollIntoView({
          block: "center",
          inline: "center",
        });
      })
      .catch(() => null);
    await this.humanPause(runId, page, 10, 30);

    const preferTouchTap = await this.prefersTouchTap(page);
    const box = await locator.boundingBox();
    if (!box) {
      if (preferTouchTap) {
        await this.activateElementDirectly(locator);
        return;
      }
      // Sem caixa mesmo apos actionability: no desktop, clica pelo proprio locator
      // (faz scroll e espera acionavel ate o budget). Se falhar, o retry/fallback assume.
      await locator.click({
        timeout: AutomationRuntimeService.ACTIONABLE_BUDGET_MS,
      });
      return;
    }

    const x = box.x + box.width * this.randomFloat(0.35, 0.65);
    const y = box.y + box.height * this.randomFloat(0.35, 0.65);
    const viewport = await page
      .evaluate(() => {
        const runtimeWindow = globalThis as unknown as {
          innerHeight: number;
          innerWidth: number;
        };
        return {
          height: runtimeWindow.innerHeight,
          width: runtimeWindow.innerWidth,
        };
      })
      .catch(() => undefined);

    if (
      viewport &&
      (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)
    ) {
      if (preferTouchTap) {
        await this.activateElementDirectly(locator);
        return;
      }
      // Fora da viewport: no desktop, clica pelo locator (Playwright faz scroll + espera acionavel).
      // Sem force: queremos a checagem real de actionability, nao um bypass. Falha -> retry.
      await locator.click({
        timeout: AutomationRuntimeService.ACTIONABLE_BUDGET_MS,
      });
      return;
    }

    if (preferTouchTap) {
      await page.touchscreen.tap(x, y);
      return;
    }

    await page.mouse.move(
      x + this.randomFloat(-4, 4),
      y + this.randomFloat(-3, 3),
      {
        steps: this.randomInt(2, 4),
      },
    );
    await this.humanPause(runId, page, 8, 20);
    await page.mouse.click(x, y, {
      delay: this.randomInt(18, 45),
    });
  }

  private async prefersTouchTap(page: Page): Promise<boolean> {
    return page
      .evaluate(() => {
        const runtimeWindow = globalThis as unknown as {
          navigator?: { maxTouchPoints?: number };
        };
        return (
          (runtimeWindow.navigator?.maxTouchPoints ?? 0) > 0 ||
          "ontouchstart" in runtimeWindow
        );
      })
      .catch(() => false);
  }

  private async activateElementDirectly(locator: Locator): Promise<void> {
    await locator.evaluate((element) => {
      type RuntimeElement = {
        click?: () => void;
        focus?: (options?: { preventScroll?: boolean }) => void;
        scrollIntoView?: (options?: {
          block?: string;
          inline?: string;
        }) => void;
      };
      const target = element as unknown as RuntimeElement;
      target.scrollIntoView?.({
        block: "center",
        inline: "center",
      });
      target.focus?.({
        preventScroll: false,
      });
      target.click?.();
    });
  }

  private async humanPause(
    runId: string,
    page: Page,
    minMs: number,
    maxMs: number,
  ): Promise<void> {
    this.ensureRunActive(runId);
    await this.waitForRunDelay(runId, page, this.randomInt(minMs, maxMs));
    this.ensureRunActive(runId);
  }

  private async waitForRunDelay(
    runId: string,
    page: Page,
    ms: number,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(0, ms);
    while (Date.now() < deadline) {
      this.ensureRunActive(runId);
      await page.waitForTimeout(Math.min(250, deadline - Date.now()));
    }
    this.ensureRunActive(runId);
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  private generateRegistrationPhoneNumber(): string {
    const areaCodes = [
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "21",
      "22",
      "24",
      "27",
      "28",
      "31",
      "32",
      "33",
      "34",
      "35",
      "37",
      "38",
      "41",
      "42",
      "43",
      "44",
      "45",
      "46",
      "47",
      "48",
      "49",
      "51",
      "53",
      "54",
      "55",
      "61",
      "62",
      "63",
      "64",
      "65",
      "66",
      "67",
      "68",
      "69",
      "71",
      "73",
      "74",
      "75",
      "77",
      "79",
      "81",
      "82",
      "83",
      "84",
      "85",
      "86",
      "87",
      "88",
      "89",
      "91",
      "92",
      "93",
      "94",
      "95",
      "96",
      "97",
      "98",
      "99",
    ];
    const areaCode = areaCodes[this.randomInt(0, areaCodes.length - 1)] ?? "11";
    const subscriberDigits = Array.from({ length: 8 }, () =>
      String(this.randomInt(0, 9)),
    ).join("");
    return `${areaCode}9${subscriberDigits}`;
  }

  private randomFloat(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  private normalizeSearchText(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  private createLoggedPage(runId: string, page: Page): Page {
    const locatorFactories = new Set([
      "locator",
      "getByAltText",
      "getByLabel",
      "getByPlaceholder",
      "getByRole",
      "getByTestId",
      "getByText",
      "getByTitle",
    ]);

    return new Proxy(page, {
      get: (target, prop, receiver) => {
        const method = String(prop);

        // Permite ao runtime "desembrulhar" o page real por tras deste Proxy. Sem
        // isto, setPageAutoClosePopups(loggedPage,...) usava o Proxy como chave do
        // WeakMap e o reset (no page raw) nao batia -> o popup killer vazava ligado.
        if (method === "__predatorRawPage") {
          return target;
        }

        if (
          [
            "goto",
            "click",
            "dblclick",
            "fill",
            "type",
            "selectOption",
            "press",
          ].includes(method)
        ) {
          return async (...args: unknown[]) => {
            this.ensureRunActive(runId);
            return this.callMethod(target, method, args);
          };
        }

        if (locatorFactories.has(method)) {
          return (...args: unknown[]) => {
            const locator = this.callMethod<Locator>(target, method, args);
            return this.createLoggedLocator(
              runId,
              locator,
              this.describeLocatorFactory(method, args),
            );
          };
        }

        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Page;
  }

  private createLoggedLocator(
    runId: string,
    locator: Locator,
    description: string,
  ): Locator {
    const locatorFactories = new Set([
      "filter",
      "first",
      "last",
      "locator",
      "nth",
      "getByAltText",
      "getByLabel",
      "getByPlaceholder",
      "getByRole",
      "getByTestId",
      "getByText",
      "getByTitle",
    ]);

    return new Proxy(locator, {
      get: (target, prop, receiver) => {
        const method = String(prop);

        if (
          [
            "click",
            "dblclick",
            "fill",
            "type",
            "check",
            "uncheck",
            "setChecked",
            "selectOption",
            "press",
          ].includes(method)
        ) {
          return async (...args: unknown[]) => {
            this.ensureRunActive(runId);
            return this.callMethod(target, method, args);
          };
        }

        if (locatorFactories.has(method)) {
          return (...args: unknown[]) => {
            const nextLocator = this.callMethod<Locator>(target, method, args);
            const nextDescription =
              method === "first" || method === "last"
                ? `${description} (${method})`
                : this.describeLocatorFactory(method, args);
            return this.createLoggedLocator(
              runId,
              nextLocator,
              nextDescription,
            );
          };
        }

        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Locator;
  }

  private callMethod<T = unknown>(
    target: unknown,
    method: string,
    args: unknown[],
  ): T {
    const value = (target as Record<string, unknown>)[method];
    if (typeof value !== "function") {
      throw new Error(`A ação ${method} não está disponível.`);
    }
    return (value as (...methodArgs: unknown[]) => T).apply(target, args);
  }

  private describeLocatorFactory(method: string, args: unknown[]): string {
    if (method === "getByRole") {
      const role = this.describeAutomationTarget(args[0]);
      const options = args[1] as { name?: unknown } | undefined;
      return options?.name
        ? `${role} "${this.describeAutomationTarget(options.name)}"`
        : role;
    }

    if (method.startsWith("getBy")) {
      return `${method.replace("getBy", "").toLowerCase()} "${this.describeAutomationTarget(args[0])}"`;
    }

    if (method === "nth") {
      return `item ${this.describeAutomationTarget(args[0])}`;
    }

    return this.describeAutomationTarget(args[0]);
  }

  private describeAutomationTarget(target: unknown): string {
    if (typeof target === "string" || typeof target === "number") {
      const value = String(target).replace(/\s+/g, " ").trim();
      return value.length > 86 ? `${value.slice(0, 83)}...` : value;
    }

    if (target instanceof URL) {
      return target.toString();
    }

    return "elemento da página";
  }

  private ensureRunActive(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (!active || active.cancelRequested) {
      throw new Error("Rotina interrompida.");
    }
  }

  // Passos de execução vão SÓ para o run log (aba Execuções) + broadcast. Os
  // marcos de workspace (Rotina iniciada/concluída, Chave PIX cadastrada, etc.)
  // são gravados separadamente via this.database.logActivity nos fluxos. Gravar
  // aqui também na activity duplicava cada linha na aba Tudo (run + activity).
  private log(runId: string, level: ActivityLevel, message: string): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    this.database.appendRunLog(runId, entry);
    // Nao enviamos o run completo aqui: o renderer consome logs via snapshot, e
    // anexar todo o array a cada linha duplicava o custo O(n^2) no IPC.
    this.broadcast({
      type: "automation-log",
      payload: {
        runId,
        entry,
      },
    });
  }
}
