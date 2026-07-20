import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildDefaultPersona,
  defaultSettings
} from "../../shared/defaults.js";
import {
  ACCOUNT_REGISTRATION_KIND
} from "../../shared/contracts.js";
import { migrateScreenLayoutSettings } from "../../shared/window-layout.js";
import type {
  ActivityLogRecord,
  AppSettings,
  AppSnapshot,
  AutomationDraft,
  AutomationKind,
  AutomationRecord,
  AutomationRunLogEntry,
  AutomationRunRecord,
  ExportRecord,
  NativeExportPayload,
  PersonaConfig,
  PixPhoneKeyImportResult,
  PixPhoneKeyRecord,
  ProfileAccountRecord,
  ProfileDraft,
  ProfileRecord,
  ProfileSummary,
  ProxyConfig,
  ProxyDraft
} from "../../shared/contracts.js";
import type { PredatorPaths } from "./paths.js";
import { SecureStore } from "./secure-store.js";

const SCHEMA_VERSION = 1;
type DatabaseSnapshot = Omit<AppSnapshot, "license" | "runtimeWindows">;
export type RemoveProfileDirectory = (storagePath: string) => Promise<void>;

const removeProfileDirectory: RemoveProfileDirectory = (storagePath) =>
  rm(storagePath, { recursive: true, force: true });

function normalizeBrowserChannel(_channel?: AppSettings["browserChannel"] | "chrome" | "msedge" | string): AppSettings["browserChannel"] {
  return "chromium";
}

function normalizeProxyMode(mode?: string): ProxyConfig["mode"] {
  if (mode === "rotating-residential") {
    return "rotating-residential";
  }

  return "static";
}

function normalizeProxyUsernameSuffixTemplate(template?: string): string | null {
  const trimmed = template?.trim();
  return trimmed ? trimmed : null;
}

function normalizeDepositAmountText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

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

function normalizeCustomDepositAmounts(
  values: AppSettings["customDepositAmounts"] | undefined
): AppSettings["customDepositAmounts"] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((entry) => {
      const amount = normalizeDepositAmountText(entry?.amount);
      if (!amount) {
        return undefined;
      }

      return {
        id: entry.id || crypto.randomUUID(),
        amount,
        source: entry.source === "generated" ? "generated" : "manual",
        createdAt: entry.createdAt || new Date().toISOString()
      };
    })
    .filter((entry): entry is AppSettings["customDepositAmounts"][number] => Boolean(entry))
    .slice(0, 500);
}

// Limpa as entradas de dominio: tira protocolo/caminho/porta, normaliza caixa e pontas,
// exige ao menos um ponto (dominio real), remove duplicatas. Casamento e por hostname.
function normalizeBlockedDomains(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") {
      continue;
    }
    let domain = raw
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/:\d+$/, "")
      .replace(/^\.+/, "")
      .replace(/\.+$/, "");
    if (!domain || !domain.includes(".") || /\s/.test(domain) || seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    result.push(domain);
  }
  return result.slice(0, 1000);
}

function normalizeSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    autoClosePopupsDuringNavigation: settings.autoClosePopupsDuringNavigation ?? false,
    showAccountInfoOverlay: settings.showAccountInfoOverlay ?? false,
    postRegistrationDepositEnabled: settings.postRegistrationDepositEnabled ?? true,
    browserChannel: normalizeBrowserChannel(settings.browserChannel),
    customDepositAmounts: normalizeCustomDepositAmounts(settings.customDepositAmounts),
    domainBlockEnabled: settings.domainBlockEnabled ?? true,
    blockedDomains: normalizeBlockedDomains(settings.blockedDomains),
    screenLayout: migrateScreenLayoutSettings(settings.screenLayout)
  };
}

interface ProfileRow {
  id: string;
  name: string;
  code_name: string;
  notes: string;
  status: ProfileRecord["status"];
  storage_path: string;
  home_url: string;
  persona_id: string;
  color: string;
  last_launched_at: string | null;
  last_automation_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PersonaRow {
  id: string;
  profile_id: string;
  version: number;
  name: string;
  user_agent: string;
  locale: string;
  timezone: string;
  viewport_json: string;
  geolocation_json: string;
  allow_notifications: number;
  allow_clipboard: number;
  web_rtc_mode: PersonaConfig["webRtcMode"];
  dns_mode: PersonaConfig["dnsMode"];
  leak_protection: PersonaConfig["leakProtection"];
  headers_json: string;
  launch_args_json: string;
  created_at: string;
  updated_at: string;
}

interface ProxyRow {
  id: string;
  label: string;
  protocol: ProxyConfig["protocol"];
  host: string;
  port: number;
  username_enc: string | null;
  password_enc: string | null;
  status: ProxyConfig["status"];
  mode: string;
  username_suffix_template: string | null;
  last_checked_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ProfileAccountRow {
  id: string;
  profile_id: string;
  platform_id: string;
  username_enc: string;
  password_enc: string;
  phone_country_code: string;
  phone_number_enc: string;
  real_name_enc: string;
  cpf_enc: string | null;
  withdrawal_password_enc: string | null;
  pix_phone_key_enc: string | null;
  pix_key_registered_origins_json: string | null;
  pix_key_registered_at: string | null;
  status: ProfileAccountRecord["status"];
  last_error: string | null;
  generated_at: string;
  registered_at: string | null;
  registered_origins_json: string | null;
  created_at: string;
  updated_at: string;
}

interface PixPhoneKeyRow {
  id: string;
  phone_number_enc: string;
  phone_hash: string;
  status: PixPhoneKeyRecord["status"];
  assigned_profile_id: string | null;
  assigned_at: string | null;
  reservation_run_id: string | null;
  pending_profile_id: string | null;
  pending_run_id: string | null;
  pending_at: string | null;
  rejected_at: string | null;
  rejection_reason: PixPhoneKeyRecord["rejectionReason"] | null;
  used_profile_id: string | null;
  used_account_id: string | null;
  used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AutomationRow {
  id: string;
  profile_id: string;
  kind: AutomationKind;
  name: string;
  description: string;
  start_url: string;
  params_json: string;
  status: AutomationRecord["status"];
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  automation_id: string;
  profile_id: string;
  status: AutomationRunRecord["status"];
  started_at: string;
  finished_at: string | null;
  logs_json: string;
  metrics_json: string;
}

interface ActivityRow {
  id: string;
  scope: ActivityLogRecord["scope"];
  scope_id: string | null;
  level: ActivityLogRecord["level"];
  message: string;
  details_json: string | null;
  created_at: string;
}

interface ExportRow {
  id: string;
  type: ExportRecord["type"];
  path: string;
  created_at: string;
  metadata_json: string;
}

const jsonParse = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const accountGivenNames = [
  "Alice",
  "Aline",
  "Amanda",
  "Ana",
  "Andre",
  "Antonio",
  "Arthur",
  "Beatriz",
  "Bernardo",
  "Bianca",
  "Bruna",
  "Bruno",
  "Caio",
  "Camila",
  "Carla",
  "Carolina",
  "Clara",
  "Daniel",
  "Daniela",
  "Davi",
  "Diego",
  "Eduarda",
  "Eduardo",
  "Elisa",
  "Enzo",
  "Fabio",
  "Felipe",
  "Fernanda",
  "Fernando",
  "Gabriel",
  "Gabriela",
  "Giovana",
  "Gustavo",
  "Helena",
  "Henrique",
  "Igor",
  "Isabela",
  "Jessica",
  "Joao",
  "Jorge",
  "Julia",
  "Juliana",
  "Laura",
  "Leandro",
  "Leonardo",
  "Leticia",
  "Lorena",
  "Luana",
  "Lucas",
  "Luiz",
  "Marcela",
  "Marcelo",
  "Marcos",
  "Mariana",
  "Marina",
  "Matheus",
  "Miguel",
  "Murilo",
  "Natalia",
  "Nicolas",
  "Patricia",
  "Paula",
  "Paulo",
  "Pedro",
  "Rafael",
  "Rafaela",
  "Renata",
  "Renato",
  "Ricardo",
  "Rodrigo",
  "Sabrina",
  "Samuel",
  "Thais",
  "Thiago",
  "Vanessa",
  "Vinicius",
  "Vitoria",
  "Vitor",
  "Yasmin"
];

const accountMiddleNames = [
  "Alana",
  "Alex",
  "Breno",
  "Cecilia",
  "Cesar",
  "Cristina",
  "Debora",
  "Elaine",
  "Emanuel",
  "Erica",
  "Estela",
  "Farias",
  "Flavia",
  "Francisco",
  "Heitor",
  "Iara",
  "Ingrid",
  "Israel",
  "Jose",
  "Kelly",
  "Larissa",
  "Livia",
  "Luciana",
  "Manuela",
  "Maria",
  "Michele",
  "Monica",
  "Nadia",
  "Otavio",
  "Priscila",
  "Raquel",
  "Roberta",
  "Roberto",
  "Sandro",
  "Sara",
  "Sergio",
  "Solange",
  "Tatiana",
  "Valeria",
  "Wesley"
];

const accountSurnames = [
  "Albuquerque",
  "Almeida",
  "Alves",
  "Amaral",
  "Andrade",
  "Araujo",
  "Assis",
  "Azevedo",
  "Barbosa",
  "Barros",
  "Batista",
  "Borges",
  "Brandao",
  "Campos",
  "Cardoso",
  "Carvalho",
  "Castro",
  "Cavalcanti",
  "Correia",
  "Costa",
  "Cunha",
  "Dias",
  "Duarte",
  "Farias",
  "Fernandes",
  "Ferreira",
  "Figueiredo",
  "Fonseca",
  "Freire",
  "Freitas",
  "Garcia",
  "Gomes",
  "Goncalves",
  "Lacerda",
  "Leal",
  "Lima",
  "Lopes",
  "Machado",
  "Marques",
  "Martins",
  "Medeiros",
  "Melo",
  "Mendes",
  "Miranda",
  "Monteiro",
  "Moraes",
  "Moreira",
  "Moura",
  "Nascimento",
  "Neves",
  "Nogueira",
  "Novaes",
  "Oliveira",
  "Pacheco",
  "Peixoto",
  "Pereira",
  "Pinto",
  "Ramos",
  "Rezende",
  "Ribeiro",
  "Rocha",
  "Rodrigues",
  "Sales",
  "Santana",
  "Santos",
  "Silva",
  "Soares",
  "Sousa",
  "Souza",
  "Teixeira",
  "Teles",
  "Torres",
  "Vargas",
  "Vasconcelos",
  "Vieira"
];

const randomItem = <T>(values: T[]): T => values[secureRandomInt(values.length)] as T;

const randomDigits = (length: number): string =>
  Array.from({ length }, () => secureRandomInt(10)).join("");

const passwordLetters = "abcdefghijkmnpqrstuvwxyz";
const passwordDigits = "23456789";

const secureRandomInt = (maxExclusive: number): number => {
  if (maxExclusive <= 0) {
    return 0;
  }

  const values = crypto.getRandomValues(new Uint32Array(1));
  return (values[0] ?? 0) % maxExclusive;
};

const secureRandomItem = (characters: string): string => characters[secureRandomInt(characters.length)] ?? characters[0] ?? "";

const randomWithdrawalPassword = (): string =>
  Array.from({ length: 6 }, () => secureRandomItem("123456789")).join("");

const generateValidCpf = (): string => {
  const digits = Array.from({ length: 9 }, () => secureRandomItem("0123456789"));
  const calcCheck = (base: string[], weightStart: number): string => {
    let sum = 0;
    for (let i = 0; i < base.length; i += 1) {
      sum += Number(base[i]) * (weightStart - i);
    }
    const remainder = sum % 11;
    return String(remainder < 2 ? 0 : 11 - remainder);
  };
  const cd1 = calcCheck(digits, 10);
  const cd2 = calcCheck([...digits, cd1], 11);
  const cpf = `${digits.join("")}${cd1}${cd2}`;
  if (/^(\d)\1{10}$/.test(cpf)) {
    return generateValidCpf();
  }
  return cpf;
};

const shuffleString = (value: string): string => {
  const characters = value.split("");

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = secureRandomInt(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex] ?? "", characters[index] ?? ""];
  }

  return characters.join("");
};

const normalizePasswordForComparison = (value: string): string => value.trim().toLowerCase();

const sharedPrefixLength = (left: string, right: string): number => {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;

  while (index < maxLength && left[index] === right[index]) {
    index += 1;
  }

  return index;
};

const levenshteinDistance = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }

  if (!left.length) {
    return right.length;
  }

  if (!right.length) {
    return left.length;
  }

  const distances = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let previousDiagonal = distances[0] ?? 0;
    distances[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previousValue = distances[rightIndex] ?? 0;
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;

      distances[rightIndex] = Math.min(
        (distances[rightIndex] ?? 0) + 1,
        (distances[rightIndex - 1] ?? 0) + 1,
        previousDiagonal + substitutionCost
      );

      previousDiagonal = previousValue;
    }
  }

  return distances[right.length] ?? 0;
};

const countPasswordCategories = (password: string): number => {
  const categories = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ];

  return categories.filter(Boolean).length;
};

const isAcceptedPlatformPassword = (password: string): boolean =>
  password.length >= 6 && password.length <= 16 && countPasswordCategories(password) >= 2;

const hasLongRepeatedSequence = (password: string): boolean => /(.)\1\1/i.test(password);

const hasSequentialRun = (password: string, sequenceLength = 4): boolean => {
  const normalized = password.toLowerCase();

  for (let index = 0; index <= normalized.length - sequenceLength; index += 1) {
    const slice = normalized.slice(index, index + sequenceLength);
    const isAscending = Array.from({ length: slice.length - 1 }).every((_, offset) => {
      const current = slice.charCodeAt(offset);
      const next = slice.charCodeAt(offset + 1);
      return next - current === 1;
    });
    const isDescending = Array.from({ length: slice.length - 1 }).every((_, offset) => {
      const current = slice.charCodeAt(offset);
      const next = slice.charCodeAt(offset + 1);
      return current - next === 1;
    });

    if (isAscending || isDescending) {
      return true;
    }
  }

  return false;
};

const isPreferredPlatformPassword = (password: string): boolean =>
  /^[a-z0-9]{10,14}$/.test(password) &&
  /[a-z]/.test(password) &&
  /[0-9]/.test(password) &&
  !hasLongRepeatedSequence(password) &&
  !hasSequentialRun(password);

const isPasswordTooSimilar = (candidate: string, existing: string): boolean => {
  const normalizedCandidate = normalizePasswordForComparison(candidate);
  const normalizedExisting = normalizePasswordForComparison(existing);

  if (!normalizedCandidate || !normalizedExisting) {
    return false;
  }

  if (normalizedCandidate === normalizedExisting) {
    return true;
  }

  if (sharedPrefixLength(normalizedCandidate, normalizedExisting) >= 4) {
    return true;
  }

  const maxLength = Math.max(normalizedCandidate.length, normalizedExisting.length);
  const samePositionCount = Array.from({ length: Math.min(normalizedCandidate.length, normalizedExisting.length) }).filter(
    (_, index) => normalizedCandidate[index] === normalizedExisting[index]
  ).length;

  if (samePositionCount / maxLength >= 0.7) {
    return true;
  }

  return levenshteinDistance(normalizedCandidate, normalizedExisting) <= 3;
};

const shouldRotatePasswordAfterFailure = (lastError?: string): boolean => {
  if (!lastError) {
    return false;
  }

  const normalized = lastError
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return ["senha", "password", "requisito", "invalido", "inválido", "formato", "caracter"].some((snippet) =>
    normalized.includes(snippet.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
  );
};

const normalizeIdentityText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const normalizeNameKey = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const getIdentityNameParts = (realName: string): string[] =>
  normalizeNameKey(realName)
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const pickDistinctItem = <T>(values: T[], avoid: T[]): T => {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const picked = randomItem(values);
    if (!avoid.includes(picked)) {
      return picked;
    }
  }

  return values.find((value) => !avoid.includes(value)) ?? randomItem(values);
};

const buildGeneratedRealName = (): string => {
  const givenName = randomItem(accountGivenNames);
  const nameParts = [givenName];

  if (secureRandomInt(100) < 32) {
    nameParts.push(pickDistinctItem(accountMiddleNames, nameParts));
  }

  const firstSurname = randomItem(accountSurnames);
  nameParts.push(firstSurname);

  if (secureRandomInt(100) < 48) {
    nameParts.push(pickDistinctItem(accountSurnames, [firstSurname]));
  }

  return nameParts.join(" ");
};

const normalizeUsername = (value: string): string => normalizeIdentityText(value).slice(0, 12);

const isAcceptedGeneratedUsername = (username: string): boolean => /^[a-z][a-z0-9]{5,11}$/.test(username);

const buildUsernameFromBase = (base: string): string => {
  const suffixLength = 2 + secureRandomInt(3);
  const suffix = randomDigits(suffixLength);
  const normalizedBase = normalizeUsername(base).replace(/^[0-9]+/, "");
  const safeBase = normalizedBase || `u${randomDigits(3)}`;
  const maxBaseLength = Math.max(3, 12 - suffix.length);
  let username = `${safeBase.slice(0, maxBaseLength)}${suffix}`;

  while (username.length < 6) {
    username += String(secureRandomInt(10));
  }

  return username.slice(0, 12);
};

const buildUsernameCandidate = (realName: string): string => {
  const parts = getIdentityNameParts(realName);
  const first = parts[0] ?? "user";
  const last = parts[parts.length - 1] ?? first;
  const middle = parts.length > 2 ? (parts[1] ?? "") : "";
  const bases = [
    `${first}${last}`,
    `${first.slice(0, 1)}${last}`,
    `${first}${last.slice(0, 4)}`,
    `${last}${first.slice(0, 1)}`,
    `${first.slice(0, 3)}${last}`,
    `${first}${middle.slice(0, 1)}${last.slice(0, 4)}`,
    `${first.slice(0, 4)}${last.slice(0, 4)}`
  ].filter(Boolean);

  return buildUsernameFromBase(randomItem(bases));
};

const isUsernameRelatedToRealName = (username: string, realName: string): boolean => {
  const normalizedUsername = normalizeUsername(username);
  const parts = getIdentityNameParts(realName).filter((part) => part.length >= 3);
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";

  return (
    parts.some((part) => normalizedUsername.includes(part.slice(0, Math.min(5, part.length)))) ||
    Boolean(first && last && normalizedUsername.includes(`${first[0]}${last.slice(0, 4)}`))
  );
};

const isPreferredGeneratedIdentity = (username: string, realName: string): boolean =>
  isAcceptedGeneratedUsername(username) && isUsernameRelatedToRealName(username, realName);

const isLegacyGeneratedUsername = (username: string): boolean => /^gc(?:user|auto|autopr|predat|profil|[a-z0-9]{4,})/i.test(username);

const isIdentityError = (lastError?: string): boolean => {
  if (!lastError) {
    return false;
  }

  const normalized = normalizeNameKey(lastError);
  return ["conta", "usuario", "username", "existe", "existente", "cadastrado"].some((snippet) =>
    normalized.includes(snippet)
  );
};

const normalizeRegistrationOrigin = (value: string): string => {
  try {
    const parsed = new URL(value);
    return parsed.origin.toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/, "");
  }
};

const normalizePixPhoneNumber = (value: string): string => {
  const digits = value.replace(/\D+/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    return digits.slice(2);
  }

  return digits;
};

const isAcceptedPixPhoneNumber = (value: string): boolean =>
  /^[1-9]{2}(?:9\d{8}|\d{8})$/.test(value);

const hashPixPhoneNumber = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const parsePixPhoneInput = (input: string): string[] =>
  input
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);

const normalizeCpf = (value: string | undefined): string => (value || "").replace(/\D+/g, "");

const isAcceptedCpf = (value: string): boolean => {
  const cpf = normalizeCpf(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) {
    return false;
  }

  const calculateDigit = (length: number) => {
    const sum = cpf
      .slice(0, length)
      .split("")
      .reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return calculateDigit(9) === Number(cpf[9]) && calculateDigit(10) === Number(cpf[10]);
};

const normalizeWithdrawalPassword = (value: string | undefined): string => (value || "").replace(/\D+/g, "");

const isAcceptedWithdrawalPassword = (value: string): boolean => /^\d{6}$/.test(value);

const buildPlatformIdFromUrl = (value: string | undefined): string => {
  const normalized = value?.trim();
  if (!normalized) {
    return "generic";
  }

  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "") || "generic";
  } catch {
    return "generic";
  }
};

const mergeRegistrationOrigins = (origins: string[] | undefined, nextOrigin?: string): string[] => {
  const normalizedOrigins = new Set((origins ?? []).map(normalizeRegistrationOrigin).filter(Boolean));
  if (nextOrigin) {
    normalizedOrigins.add(normalizeRegistrationOrigin(nextOrigin));
  }

  return [...normalizedOrigins].sort();
};

export class PredatorDatabase {
  private readonly db: DatabaseSync;

  // Buffer de logs por run em memoria. appendRunLog acumula aqui (O(1), sem I/O)
  // e o conteudo so e serializado/persistido quando alguem le os runs (getRun/
  // listRuns -> snapshot). Antes, cada linha de log fazia dois getRun e reescrevia
  // o array inteiro em JSON -> custo O(n^2) por run no caminho mais quente.
  private readonly runLogBuffer = new Map<string, AutomationRunLogEntry[]>();
  private readonly dirtyRunLogs = new Set<string>();

  constructor(
    private readonly paths: PredatorPaths,
    private readonly secureStore: SecureStore,
    private readonly removeProfileStorage: RemoveProfileDirectory = removeProfileDirectory
  ) {
    this.db = new DatabaseSync(paths.databaseFile);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initializeSchema();
    this.seedIfEmpty();
    this.ensureProfileArtifacts();
    this.migrateLegacyUsedPixPhoneKeys();
    this.recoverInterruptedRuns();
    this.recoverInactivePixPhoneKeyReservations([]);
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    const currentVersion = this.getSchemaVersion();
    if (currentVersion !== SCHEMA_VERSION) {
      this.resetWorkspaceData();
    }

    this.createSchema();
    this.ensureProfileAccountOptionalColumns();
    this.ensureProxyOptionalColumns();
    this.ensurePixPhoneKeyLifecycleColumns();
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  private getSchemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return row?.user_version ?? 0;
  }

  private resetWorkspaceData(): void {
    this.db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      DROP TABLE IF EXISTS automation_runs;
      DROP TABLE IF EXISTS automations;
      DROP TABLE IF EXISTS exports;
      DROP TABLE IF EXISTS activity_logs;
      DROP TABLE IF EXISTS app_settings;
      DROP TABLE IF EXISTS pix_phone_keys;
      DROP TABLE IF EXISTS profile_accounts;
      DROP TABLE IF EXISTS profile_proxy_bindings;
      DROP TABLE IF EXISTS proxies;
      DROP TABLE IF EXISTS profile_tags;
      DROP TABLE IF EXISTS personas;
      DROP TABLE IF EXISTS profiles;
      PRAGMA user_version = 0;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);

    for (const path of [this.paths.profilesRoot, this.paths.exportsRoot, this.paths.capturesRoot]) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
      mkdirSync(path, { recursive: true });
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code_name TEXT NOT NULL,
        notes TEXT NOT NULL,
        status TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        home_url TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        color TEXT NOT NULL,
        last_launched_at TEXT,
        last_automation_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profile_tags (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        tag TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS personas (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        user_agent TEXT NOT NULL,
        locale TEXT NOT NULL,
        timezone TEXT NOT NULL,
        viewport_json TEXT NOT NULL,
        geolocation_json TEXT NOT NULL,
        allow_notifications INTEGER NOT NULL,
        allow_clipboard INTEGER NOT NULL,
        web_rtc_mode TEXT NOT NULL,
        dns_mode TEXT NOT NULL,
        leak_protection TEXT NOT NULL,
        headers_json TEXT NOT NULL,
        launch_args_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proxies (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        protocol TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username_enc TEXT,
        password_enc TEXT,
        status TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'static',
        username_suffix_template TEXT,
        last_checked_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profile_proxy_bindings (
        profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        proxy_id TEXT REFERENCES proxies(id) ON DELETE SET NULL,
        assigned_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profile_accounts (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
        platform_id TEXT NOT NULL,
        username_enc TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        phone_country_code TEXT NOT NULL,
        phone_number_enc TEXT NOT NULL,
        real_name_enc TEXT NOT NULL,
        cpf_enc TEXT,
        withdrawal_password_enc TEXT,
        pix_phone_key_enc TEXT,
        pix_key_registered_origins_json TEXT NOT NULL DEFAULT '[]',
        pix_key_registered_at TEXT,
        status TEXT NOT NULL,
        last_error TEXT,
        generated_at TEXT NOT NULL,
        registered_at TEXT,
        registered_origins_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pix_phone_keys (
        id TEXT PRIMARY KEY,
        phone_number_enc TEXT NOT NULL,
        phone_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        assigned_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
        assigned_at TEXT,
        reservation_run_id TEXT,
        pending_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
        pending_run_id TEXT,
        pending_at TEXT,
        rejected_at TEXT,
        rejection_reason TEXT,
        used_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
        used_account_id TEXT,
        used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'account-registration',
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        start_url TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        logs_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_id TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exports (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
    `);
  }

  private ensureProfileAccountOptionalColumns(): void {
    const rows = this.db.prepare("PRAGMA table_info(profile_accounts)").all() as Array<{ name: string }>;
    const existing = new Set(rows.map((row) => row.name));
    const columns: Array<{ name: string; definition: string }> = [
      { name: "cpf_enc", definition: "cpf_enc TEXT" },
      { name: "withdrawal_password_enc", definition: "withdrawal_password_enc TEXT" },
      { name: "pix_phone_key_enc", definition: "pix_phone_key_enc TEXT" },
      {
        name: "pix_key_registered_origins_json",
        definition: "pix_key_registered_origins_json TEXT NOT NULL DEFAULT '[]'"
      },
      { name: "pix_key_registered_at", definition: "pix_key_registered_at TEXT" }
    ];

    for (const column of columns) {
      if (!existing.has(column.name)) {
        this.db.exec(`ALTER TABLE profile_accounts ADD COLUMN ${column.definition};`);
      }
    }
  }

  private ensureProxyOptionalColumns(): void {
    const rows = this.db.prepare("PRAGMA table_info(proxies)").all() as Array<{ name: string }>;
    const existing = new Set(rows.map((row) => row.name));
    const columns: Array<{ name: string; definition: string }> = [
      { name: "mode", definition: "mode TEXT NOT NULL DEFAULT 'static'" },
      { name: "username_suffix_template", definition: "username_suffix_template TEXT" }
    ];

    for (const column of columns) {
      if (!existing.has(column.name)) {
        this.db.exec(`ALTER TABLE proxies ADD COLUMN ${column.definition};`);
      }
    }
  }

  private seedIfEmpty(): void {
    const profileCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM profiles")
      .get() as { count: number };

    if (profileCount.count > 0) {
      return;
    }

    this.setSettings(defaultSettings);
  }

  private recoverInterruptedRuns(): void {
    const interruptedRuns = this.db
      .prepare("SELECT * FROM automation_runs WHERE status = 'running'")
      .all() as unknown as RunRow[];

    if (!interruptedRuns.length) {
      return;
    }

    const now = new Date().toISOString();

    for (const run of interruptedRuns) {
      const logs = jsonParse<AutomationRunLogEntry[]>(run.logs_json, []);
      const metrics = jsonParse<Record<string, string | number | boolean>>(run.metrics_json, {});
      const recoveryLog: AutomationRunLogEntry = {
        timestamp: now,
        level: "warning",
        message: "Rotina interrompida porque o app foi encerrado antes da finalizacao."
      };

      this.db.prepare(`
        UPDATE automation_runs
        SET status = 'failed', finished_at = ?, logs_json = ?, metrics_json = ?
        WHERE id = ?
      `).run(
        now,
        JSON.stringify([...logs, recoveryLog]),
        JSON.stringify({
          ...metrics,
          interrupted: true
        }),
        run.id
      );

      this.db
        .prepare("UPDATE automations SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(now, run.automation_id);
      this.db
        .prepare("UPDATE profiles SET status = 'error', updated_at = ? WHERE id = ? AND status = 'running-automation'")
        .run(now, run.profile_id);

      this.logActivity({
        id: crypto.randomUUID(),
        scope: "automation",
        scopeId: run.automation_id,
        level: "warning",
        message: "Rotina anterior foi marcada como interrompida ao reabrir o app.",
        details: {
          runId: run.id
        },
        createdAt: now
      });
    }
  }

  private setSettings(settings: AppSettings): void {
    const normalized = normalizeSettings(settings);
    const statement = this.db.prepare(`
      INSERT INTO app_settings (key, value_json)
      VALUES ('settings', ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `);
    statement.run(JSON.stringify(normalized));
  }

  listProfiles(): ProfileSummary[] {
    const profileRows = this.db
      .prepare("SELECT * FROM profiles ORDER BY archived_at IS NOT NULL, updated_at DESC, name ASC")
      .all() as unknown as ProfileRow[];

    const tagRows = this.db
      .prepare("SELECT profile_id, tag FROM profile_tags ORDER BY tag ASC")
      .all() as Array<{ profile_id: string; tag: string }>;
    const bindingRows = this.db
      .prepare("SELECT profile_id, proxy_id FROM profile_proxy_bindings")
      .all() as Array<{ profile_id: string; proxy_id: string | null }>;
    const personas = new Map(
      (this.db.prepare("SELECT * FROM personas").all() as unknown as PersonaRow[]).map((row) => [
        row.profile_id,
        this.mapPersona(row)
      ])
    );
    const proxies = new Map(this.listProxies().map((proxy) => [proxy.id, proxy]));
    const accounts = new Map(
      (this.db.prepare("SELECT * FROM profile_accounts").all() as unknown as ProfileAccountRow[]).map((row) => [
        row.profile_id,
        this.mapProfileAccount(row)
      ])
    );
    const automationCounts = new Map(
      (
        this.db
          .prepare(
            "SELECT profile_id, COUNT(*) AS automation_count, MAX(last_run_at) AS last_run_at FROM automations GROUP BY profile_id"
          )
          .all() as Array<{
          profile_id: string;
          automation_count: number;
          last_run_at: string | null;
        }>
      ).map((row) => [row.profile_id, row])
    );
    const runStatusRows = this.db
      .prepare(
        "SELECT profile_id, status, MAX(started_at) AS started_at FROM automation_runs GROUP BY profile_id"
      )
      .all() as Array<{
      profile_id: string;
      status: AutomationRunRecord["status"];
      started_at: string;
    }>;
    const runStatuses = new Map(runStatusRows.map((row) => [row.profile_id, row.status]));
    const tagsByProfile = new Map<string, string[]>();

    for (const tagRow of tagRows) {
      const current = tagsByProfile.get(tagRow.profile_id) ?? [];
      current.push(tagRow.tag);
      tagsByProfile.set(tagRow.profile_id, current);
    }

    const bindingMap = new Map(bindingRows.map((row) => [row.profile_id, row.proxy_id]));

    return profileRows.map((row) => {
      const persona = personas.get(row.id) ?? buildDefaultPersona(row.id, row.name);
      const proxyId = bindingMap.get(row.id) ?? undefined;
      const automationInfo = automationCounts.get(row.id);

      return {
        ...this.mapProfile(row, tagsByProfile.get(row.id) ?? [], proxyId),
        persona,
        proxy: proxyId ? proxies.get(proxyId) : undefined,
        account: accounts.get(row.id),
        automationCount: automationInfo?.automation_count ?? 0,
        lastRunStatus: runStatuses.get(row.id)
      };
    });
  }

  getProfile(profileId: string): ProfileSummary {
    const profile = this.listProfiles().find((entry) => entry.id === profileId);

    if (!profile) {
      throw new Error(`Profile ${profileId} not found.`);
    }

    return profile;
  }

  profileExists(profileId: string): boolean {
    const row = this.db
      .prepare("SELECT id FROM profiles WHERE id = ? LIMIT 1")
      .get(profileId) as { id: string } | undefined;
    return Boolean(row);
  }

  createProfile(draft: ProfileDraft): ProfileSummary {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const storagePath = join(this.paths.profilesRoot, id);
    mkdirSync(storagePath, { recursive: true });
    const persona = this.materializePersona(id, draft.name, draft.persona);

    this.db.prepare(`
      INSERT INTO profiles (
        id, name, code_name, notes, status, storage_path, home_url,
        persona_id, color, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      draft.name,
      draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      draft.notes,
      "idle",
      storagePath,
      draft.homeUrl,
      persona.id,
      draft.color,
      now,
      now
    );

    for (const tag of draft.tags) {
      this.db
        .prepare("INSERT INTO profile_tags (profile_id, tag) VALUES (?, ?)")
        .run(id, tag);
    }

    this.db.prepare(`
      INSERT INTO personas (
        id, profile_id, version, name, user_agent, locale, timezone,
        viewport_json, geolocation_json, allow_notifications, allow_clipboard,
        web_rtc_mode, dns_mode, leak_protection, headers_json, launch_args_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      persona.id,
      persona.profileId,
      persona.version,
      persona.name,
      persona.userAgent,
      persona.locale,
      persona.timezone,
      JSON.stringify(persona.viewport),
      JSON.stringify(persona.geolocation),
      Number(persona.allowNotifications),
      Number(persona.allowClipboard),
      persona.webRtcMode,
      persona.dnsMode,
      persona.leakProtection,
      JSON.stringify(persona.headers),
      JSON.stringify(persona.launchArgs),
      persona.createdAt,
      persona.updatedAt
    );

    if (draft.proxyId) {
      this.bindProxy(id, draft.proxyId);
    }

    let account = this.ensureProfileAccount(id);
    if (draft.accountCpf !== undefined || draft.withdrawalPassword !== undefined) {
      account = this.updateProfileAccountPixData(id, {
        cpf: draft.accountCpf,
        withdrawalPassword: draft.withdrawalPassword
      });
    }
    const finalProfileName = this.shouldUseAccountProfileName(draft)
      ? this.buildAccountProfileName(account)
      : draft.name;

    if (finalProfileName !== draft.name) {
      this.db.prepare("UPDATE profiles SET name = ?, code_name = ?, updated_at = ? WHERE id = ?").run(
        finalProfileName,
        finalProfileName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        now,
        id
      );
      this.db.prepare("UPDATE personas SET name = ?, updated_at = ? WHERE id = ?").run(
        finalProfileName,
        now,
        persona.id
      );
    }

    this.ensureSystemAutomation(id);

    this.logActivity({
      id: crypto.randomUUID(),
      scope: "profile",
      scopeId: id,
      level: "success",
      message: `🧩 ${finalProfileName} preparado para abrir o link.`,
      details: {
        homeUrl: draft.homeUrl
      },
      createdAt: now
    });

    return this.getProfile(id);
  }

  updateProfile(profileId: string, draft: Partial<ProfileDraft>): ProfileSummary {
    const existing = this.getProfile(profileId);
    const now = new Date().toISOString();
    const nextTags = draft.tags ?? existing.tags;
    const nextName = draft.name ?? existing.name;
    const nextNotes = draft.notes ?? existing.notes;
    const nextHomeUrl = draft.homeUrl ?? existing.homeUrl;
    const nextColor = draft.color ?? existing.color;

    this.db.prepare(`
      UPDATE profiles
      SET name = ?, code_name = ?, notes = ?, home_url = ?, color = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextName,
      nextName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      nextNotes,
      nextHomeUrl,
      nextColor,
      now,
      profileId
    );

    this.db.prepare("DELETE FROM profile_tags WHERE profile_id = ?").run(profileId);
    for (const tag of nextTags) {
      this.db.prepare("INSERT INTO profile_tags (profile_id, tag) VALUES (?, ?)").run(profileId, tag);
    }

    if (draft.persona) {
      this.updatePersona(existing.persona, draft.persona);
    }

    if (draft.proxyId !== undefined) {
      this.bindProxy(profileId, draft.proxyId);
    }

    if (draft.accountCpf !== undefined || draft.withdrawalPassword !== undefined) {
      this.updateProfileAccountPixData(profileId, {
        cpf: draft.accountCpf,
        withdrawalPassword: draft.withdrawalPassword
      });
    }

    this.syncSystemAutomationStartUrl(profileId, nextHomeUrl);

    this.logActivity({
      id: crypto.randomUUID(),
      scope: "profile",
      scopeId: profileId,
      level: "info",
      message: `⚙️ Preferências de ${nextName} salvas.`,
      createdAt: now
    });

    return this.getProfile(profileId);
  }

  /**
   * Atualiza apenas o link inicial do perfil. Usado quando a plataforma
   * redireciona para outro dominio durante o cadastro: a conta passa a viver na
   * URL final, entao gravamos ela como homeUrl para que deposito/PIX/saque nao
   * renaveguem para a URL original (que dispararia o redirect de novo).
   */
  updateProfileHomeUrl(profileId: string, homeUrl: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE profiles SET home_url = ?, updated_at = ? WHERE id = ?").run(homeUrl, now, profileId);
    this.syncSystemAutomationStartUrl(profileId, homeUrl);
  }

  archiveProfile(profileId: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE profiles SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, profileId);
    this.logActivity({
      id: crypto.randomUUID(),
      scope: "profile",
      scopeId: profileId,
      level: "warning",
      message: "📦 Perfil movido para arquivados.",
      createdAt: now
    });
  }

  async deleteProfile(profileId: string): Promise<void> {
    const existing = this.getProfile(profileId);
    await this.removeProfileStorage(existing.storagePath);
    this.db.prepare("DELETE FROM profiles WHERE id = ?").run(profileId);
    this.logActivity({
      id: crypto.randomUUID(),
      scope: "profile",
      scopeId: profileId,
      level: "warning",
      message: `🧹 ${existing.name} removido da área de trabalho.`,
      createdAt: new Date().toISOString()
    });
  }

  duplicateProfile(profileId: string): ProfileSummary {
    const existing = this.getProfile(profileId);
    return this.createProfile({
      name: `${existing.name} Copy`,
      notes: existing.notes,
      homeUrl: existing.homeUrl,
      tags: existing.tags,
      color: existing.color,
      proxyId: existing.proxy?.id,
      persona: {
        ...existing.persona,
        name: `${existing.persona.name} Copy`
      }
    });
  }

  updateProfileStatus(profileId: string, status: ProfileRecord["status"]): ProfileSummary {
    const now = new Date().toISOString();
    const launchedAt = status === "active" ? now : undefined;
    this.db.prepare(`
      UPDATE profiles
      SET status = ?, last_launched_at = COALESCE(?, last_launched_at), updated_at = ?
      WHERE id = ?
    `).run(status, launchedAt ?? null, now, profileId);
    return this.getProfile(profileId);
  }

  markProfileAutomation(profileId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE profiles SET last_automation_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, profileId);
  }

  listProxies(): ProxyConfig[] {
    return (this.db.prepare("SELECT * FROM proxies ORDER BY updated_at DESC, label ASC").all() as unknown as ProxyRow[]).map(
      (row) => this.mapProxy(row)
    );
  }

  getProxy(proxyId: string): ProxyConfig {
    const row = this.db.prepare("SELECT * FROM proxies WHERE id = ?").get(proxyId) as ProxyRow | undefined;
    if (!row) {
      throw new Error(`Proxy ${proxyId} not found.`);
    }
    return this.mapProxy(row);
  }

  createProxy(draft: ProxyDraft): ProxyConfig {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const mode = normalizeProxyMode(draft.mode);
    const usernameSuffixTemplate = normalizeProxyUsernameSuffixTemplate(draft.usernameSuffixTemplate);
    this.db.prepare(`
      INSERT INTO proxies (
        id, label, protocol, host, port, username_enc, password_enc,
        status, mode, username_suffix_template, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      draft.label,
      draft.protocol,
      draft.host,
      draft.port,
      this.secureStore.encrypt(draft.username) ?? null,
      this.secureStore.encrypt(draft.password) ?? null,
      "unknown",
      mode,
      usernameSuffixTemplate,
      draft.notes ?? null,
      now,
      now
    );
    return this.getProxy(id);
  }

  updateProxy(proxyId: string, draft: Partial<ProxyDraft>): ProxyConfig {
    const existing = this.getProxy(proxyId);
    const now = new Date().toISOString();
    const mode = draft.mode === undefined ? existing.mode : normalizeProxyMode(draft.mode);
    const usernameSuffixTemplate =
      draft.usernameSuffixTemplate === undefined
        ? existing.usernameSuffixTemplate ?? null
        : normalizeProxyUsernameSuffixTemplate(draft.usernameSuffixTemplate);
    this.db.prepare(`
      UPDATE proxies
      SET label = ?, protocol = ?, host = ?, port = ?, username_enc = ?, password_enc = ?,
          mode = ?, username_suffix_template = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      draft.label ?? existing.label,
      draft.protocol ?? existing.protocol,
      draft.host ?? existing.host,
      draft.port ?? existing.port,
      this.secureStore.encrypt(draft.username ?? existing.username) ?? null,
      this.secureStore.encrypt(draft.password ?? existing.password) ?? null,
      mode,
      usernameSuffixTemplate,
      draft.notes ?? existing.notes ?? null,
      now,
      proxyId
    );
    return this.getProxy(proxyId);
  }

  updateProxyStatus(proxyId: string, status: ProxyConfig["status"]): ProxyConfig {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE proxies SET status = ?, last_checked_at = ?, updated_at = ? WHERE id = ?")
      .run(status, now, now, proxyId);
    return this.getProxy(proxyId);
  }

  deleteProxy(proxyId: string): void {
    const existing = this.getProxy(proxyId);
    this.db.prepare("DELETE FROM proxies WHERE id = ?").run(proxyId);
    this.logActivity({
      id: crypto.randomUUID(),
      scope: "proxy",
      scopeId: proxyId,
      level: "warning",
      message: `🧹 Proxy ${existing.label} removido.`,
      createdAt: new Date().toISOString()
    });
  }

  bindProxy(profileId: string, proxyId?: string): ProfileSummary {
    this.db.prepare("DELETE FROM profile_proxy_bindings WHERE profile_id = ?").run(profileId);
    if (proxyId) {
      this.db.prepare(`
        INSERT INTO profile_proxy_bindings (profile_id, proxy_id, assigned_at)
        VALUES (?, ?, ?)
      `).run(profileId, proxyId, new Date().toISOString());
    }

    return this.getProfile(profileId);
  }

  listAutomations(): AutomationRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM automations ORDER BY updated_at DESC, kind ASC, name ASC")
        .all() as unknown as AutomationRow[]
    ).map((row) => this.mapAutomation(row));
  }

  getAutomation(automationId: string): AutomationRecord {
    const row = this.db
      .prepare("SELECT * FROM automations WHERE id = ?")
      .get(automationId) as AutomationRow | undefined;
    if (!row) {
      throw new Error(`Automation ${automationId} not found.`);
    }
    return this.mapAutomation(row);
  }

  getSystemAutomationForProfile(profileId: string): AutomationRecord {
    return this.ensureSystemAutomation(profileId);
  }

  createAutomation(draft: AutomationDraft): AutomationRecord {
    if (draft.kind !== ACCOUNT_REGISTRATION_KIND) {
      throw new Error(`Automation kind ${draft.kind} is not supported.`);
    }

    const existing = this.db
      .prepare("SELECT * FROM automations WHERE profile_id = ? AND kind = ?")
      .get(draft.profileId, ACCOUNT_REGISTRATION_KIND) as AutomationRow | undefined;
    if (existing) {
      return this.updateAutomation(existing.id, draft);
    }

    const normalized = this.normalizeAutomationDraft(draft);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    this.db.prepare(`
      INSERT INTO automations (
        id, profile_id, kind, name, description, start_url,
        params_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      draft.profileId,
      normalized.kind,
      normalized.name,
      normalized.description,
      normalized.startUrl,
      JSON.stringify(normalized.params),
      "ready",
      now,
      now
    );
    return this.getAutomation(id);
  }

  updateAutomation(automationId: string, draft: Partial<AutomationDraft>): AutomationRecord {
    const existing = this.getAutomation(automationId);
    const normalized = this.normalizeAutomationDraft(
      {
        profileId: draft.profileId ?? existing.profileId,
        kind: draft.kind ?? existing.kind,
        name: draft.name ?? existing.name,
        description: draft.description ?? existing.description,
        startUrl: draft.startUrl ?? existing.startUrl,
        params: draft.params ?? existing.params
      },
      existing
    );
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE automations
      SET profile_id = ?, kind = ?, name = ?, description = ?, start_url = ?,
          params_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      draft.profileId ?? existing.profileId,
      normalized.kind,
      normalized.name,
      normalized.description,
      normalized.startUrl,
      JSON.stringify(normalized.params),
      now,
      automationId
    );
    return this.getAutomation(automationId);
  }

  markAutomationStatus(automationId: string, status: AutomationRecord["status"]): AutomationRecord {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE automations SET status = ?, last_run_at = ?, updated_at = ? WHERE id = ?")
      .run(status, now, now, automationId);
    return this.getAutomation(automationId);
  }

  listRuns(): AutomationRunRecord[] {
    this.flushDirtyRunLogs();
    return (
      this.db
        .prepare("SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 40")
        .all() as unknown as RunRow[]
    ).map((row) => this.mapRun(row));
  }

  clearRuns(): number {
    this.runLogBuffer.clear();
    this.dirtyRunLogs.clear();
    const result = this.db.prepare("DELETE FROM automation_runs").run();
    return Number(result.changes ?? 0);
  }

  createRun(automationId: string, profileId: string): AutomationRunRecord {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO automation_runs (
        id, automation_id, profile_id, status, started_at, logs_json, metrics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, automationId, profileId, "running", now, "[]", "{}");
    return this.getRun(id);
  }

  getRun(runId: string): AutomationRunRecord {
    this.flushRunLog(runId);
    const row = this.db
      .prepare("SELECT * FROM automation_runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    if (!row) {
      throw new Error(`Run ${runId} not found.`);
    }
    return this.mapRun(row);
  }

  // Acumula a linha de log no buffer em memoria (O(1), sem tocar o banco). A
  // persistencia acontece de forma preguicosa em flushRunLog, disparada pelas
  // leituras (getRun/listRuns) que alimentam o snapshot. Como o renderer so
  // consome logs via snapshot, isso mantem a UI igualmente atualizada e remove
  // o custo O(n^2) de reserializar/reler o array inteiro a cada linha.
  appendRunLog(runId: string, entry: AutomationRunLogEntry): void {
    let logs = this.runLogBuffer.get(runId);
    if (!logs) {
      // Primeira linha do run nesta sessao: carrega o estado atual uma vez.
      logs = this.getRun(runId).logs;
      this.runLogBuffer.set(runId, logs);
    }
    logs.push(entry);
    this.dirtyRunLogs.add(runId);
  }

  private flushRunLog(runId: string): void {
    if (!this.dirtyRunLogs.has(runId)) {
      return;
    }
    this.dirtyRunLogs.delete(runId);
    const logs = this.runLogBuffer.get(runId);
    if (!logs) {
      return;
    }
    this.db
      .prepare("UPDATE automation_runs SET logs_json = ? WHERE id = ?")
      .run(JSON.stringify(logs), runId);
  }

  private flushDirtyRunLogs(): void {
    if (this.dirtyRunLogs.size === 0) {
      return;
    }
    for (const runId of [...this.dirtyRunLogs]) {
      this.flushRunLog(runId);
    }
  }

  updateRun(runId: string, draft: Partial<Pick<AutomationRunRecord, "status" | "finishedAt" | "metrics">>): AutomationRunRecord {
    const existing = this.getRun(runId);
    this.db.prepare(`
      UPDATE automation_runs
      SET status = ?, finished_at = ?, metrics_json = ?
      WHERE id = ?
    `).run(
      draft.status ?? existing.status,
      draft.finishedAt ?? existing.finishedAt ?? null,
      JSON.stringify(draft.metrics ?? existing.metrics),
      runId
    );
    // getRun acima ja persistiu os logs pendentes; ao finalizar o run nao havera
    // mais appends, entao liberamos o buffer em memoria.
    if ((draft.status ?? existing.status) !== "running") {
      this.runLogBuffer.delete(runId);
      this.dirtyRunLogs.delete(runId);
    }
    return this.getRun(runId);
  }

  listActivity(): ActivityLogRecord[] {
    return (
      this.db.prepare("SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 60").all() as unknown as ActivityRow[]
    ).map((row) => this.mapActivity(row));
  }

  clearActivityLogs(): number {
    const result = this.db.prepare("DELETE FROM activity_logs").run();
    return Number(result.changes ?? 0);
  }

  logActivity(activity: ActivityLogRecord): ActivityLogRecord {
    this.db.prepare(`
      INSERT INTO activity_logs (id, scope, scope_id, level, message, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      activity.id,
      activity.scope,
      activity.scopeId ?? null,
      activity.level,
      activity.message,
      activity.details ? JSON.stringify(activity.details) : null,
      activity.createdAt
    );
    return activity;
  }

  getSettings(): AppSettings {
    const row = this.db
      .prepare("SELECT value_json FROM app_settings WHERE key = 'settings'")
      .get() as { value_json: string } | undefined;

    if (!row) {
      this.setSettings(defaultSettings);
      return {
        ...defaultSettings,
        exportDirectory: this.paths.exportsRoot
      };
    }

    const storedSettings = jsonParse<Partial<AppSettings> & { screenLayout?: unknown }>(
      row.value_json,
      {}
    );
    const loadedSettings: AppSettings = {
      ...defaultSettings,
      ...storedSettings,
      screenLayout: migrateScreenLayoutSettings(storedSettings.screenLayout),
      exportDirectory: this.paths.exportsRoot
    };
    const settings = normalizeSettings(loadedSettings);

    if (
      settings.browserChannel !== loadedSettings.browserChannel ||
      JSON.stringify(settings.screenLayout) !== JSON.stringify(storedSettings.screenLayout)
    ) {
      this.setSettings(settings);
    }

    return settings;
  }

  updateSettings(draft: Partial<AppSettings>): AppSettings {
    const next = normalizeSettings({
      ...this.getSettings(),
      ...draft
    });
    this.setSettings(next);
    return next;
  }

  listExports(): ExportRecord[] {
    return (
      this.db.prepare("SELECT * FROM exports ORDER BY created_at DESC LIMIT 20").all() as unknown as ExportRow[]
    ).map((row) => ({
      id: row.id,
      type: row.type,
      path: row.path,
      createdAt: row.created_at,
      metadata: jsonParse(row.metadata_json, {})
    }));
  }

  exportProfiles(profileIds: string[]): ExportRecord {
    const exportId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const exportPath = join(this.paths.exportsRoot, exportId);
    mkdirSync(exportPath, { recursive: true });
    mkdirSync(join(exportPath, "profiles"), { recursive: true });

    const selectedProfiles = this.listProfiles().filter((profile) => profileIds.includes(profile.id));
    const payload: NativeExportPayload = {
      profiles: selectedProfiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        codeName: profile.codeName,
        notes: profile.notes,
        status: profile.status,
        storagePath: profile.storagePath,
        homeUrl: profile.homeUrl,
        proxyId: profile.proxy?.id,
        personaId: profile.personaId,
        tags: profile.tags,
        color: profile.color,
        lastLaunchedAt: profile.lastLaunchedAt,
        lastAutomationAt: profile.lastAutomationAt,
        archivedAt: profile.archivedAt,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt
      })),
      personas: selectedProfiles.map((profile) => profile.persona),
      proxies: this.listProxies().filter((proxy) =>
        selectedProfiles.some((profile) => profile.proxy?.id === proxy.id)
      ),
      accounts: selectedProfiles.flatMap((profile) => (profile.account ? [profile.account] : [])),
      automations: this.listAutomations().filter((automation) =>
        selectedProfiles.some((profile) => profile.id === automation.profileId)
      ),
      activity: this.listActivity().filter((item) =>
        item.scopeId ? selectedProfiles.some((profile) => profile.id === item.scopeId) : false
      ),
      exportedAt: createdAt
    };

    for (const profile of selectedProfiles) {
      if (existsSync(profile.storagePath)) {
        cpSync(profile.storagePath, join(exportPath, "profiles", profile.id), {
          recursive: true,
          force: true
        });
      }
    }

    const manifestPath = join(exportPath, "manifest.predator.json");
    writeFileSync(manifestPath, JSON.stringify(payload, null, 2), "utf8");

    const metadata = {
      profileCount: selectedProfiles.length,
      includesStorage: true
    };
    this.db.prepare(`
      INSERT INTO exports (id, type, path, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(exportId, "profiles", manifestPath, createdAt, JSON.stringify(metadata));

    return {
      id: exportId,
      type: "profiles",
      path: manifestPath,
      createdAt,
      metadata
    };
  }

  importProfiles(importPath: string): DatabaseSnapshot {
    const manifest = jsonParse<NativeExportPayload>(readFileSync(importPath, "utf8"), {
      profiles: [],
      personas: [],
      proxies: [],
      accounts: [],
      automations: [],
      activity: [],
      exportedAt: new Date().toISOString()
    });
    const importRoot = join(importPath, "..");

    for (const proxy of manifest.proxies) {
      const existing = this.listProxies().find((entry) => entry.label === proxy.label && entry.host === proxy.host);
      if (!existing) {
        this.createProxy({
          label: proxy.label,
          protocol: proxy.protocol,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
          notes: proxy.notes
        });
      }
    }

    for (const profile of manifest.profiles) {
      const created = this.createProfile({
        name: profile.name,
        notes: profile.notes,
        homeUrl: profile.homeUrl,
        tags: profile.tags,
        color: profile.color,
        proxyId: profile.proxyId
      });

      const persona = manifest.personas.find((entry) => entry.profileId === profile.id);
      if (persona) {
        this.updatePersona(created.persona, {
          ...persona,
          name: persona.name
        });
      }

      const account = manifest.accounts.find((entry) => entry.profileId === profile.id);
      if (account) {
        this.setProfileAccount(created.id, {
          ...account,
          profileId: created.id
        });
      }

      const sourceStorage = join(importRoot, "profiles", profile.id);
      if (existsSync(sourceStorage)) {
        cpSync(sourceStorage, created.storagePath, {
          recursive: true,
          force: true
        });
      }
    }

    for (const automation of manifest.automations) {
      const importedKind = String(automation.kind);
      if (importedKind !== ACCOUNT_REGISTRATION_KIND && !importedKind.endsWith("account-registration")) {
        continue;
      }

      const profile = this.listProfiles().find((entry) => entry.name === manifest.profiles.find((p) => p.id === automation.profileId)?.name);
      if (profile) {
        this.createAutomation({
          profileId: profile.id,
          kind: ACCOUNT_REGISTRATION_KIND,
          name: automation.name,
          description: automation.description,
          startUrl: automation.startUrl,
          params: automation.params
        });
      }
    }

    this.logActivity({
      id: crypto.randomUUID(),
      scope: "app",
      level: "success",
      message: "📦 Pacote Spider BOT importado com sucesso.",
      details: {
        importPath
      },
      createdAt: new Date().toISOString()
    });

    return this.getSnapshot();
  }

  getSnapshot(): DatabaseSnapshot {
    return {
      profiles: this.listProfiles(),
      proxies: this.listProxies(),
      automations: this.listAutomations(),
      runs: this.listRuns(),
      activity: this.listActivity(),
      pixPhoneKeys: this.listPixPhoneKeys(),
      settings: this.getSettings(),
      exports: this.listExports()
    };
  }

  listPixPhoneKeys(): PixPhoneKeyRecord[] {
    return (this.db
      .prepare("SELECT * FROM pix_phone_keys ORDER BY created_at ASC")
      .all() as unknown as PixPhoneKeyRow[]).map((row) => this.mapPixPhoneKey(row));
  }

  addPixPhoneKeys(input: string): PixPhoneKeyImportResult {
    const now = new Date().toISOString();
    const created: PixPhoneKeyRecord[] = [];
    const skipped: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();

    for (const rawValue of parsePixPhoneInput(input)) {
      const phoneNumber = normalizePixPhoneNumber(rawValue);

      if (!isAcceptedPixPhoneNumber(phoneNumber)) {
        invalid.push(rawValue);
        continue;
      }

      if (seen.has(phoneNumber)) {
        skipped.push(phoneNumber);
        continue;
      }
      seen.add(phoneNumber);

      const phoneHash = hashPixPhoneNumber(phoneNumber);
      const encryptedPhoneNumber = this.secureStore.encrypt(phoneNumber) ?? phoneNumber;
      const existing = this.db
        .prepare("SELECT id, status FROM pix_phone_keys WHERE phone_hash = ? LIMIT 1")
        .get(phoneHash) as { id: string; status: PixPhoneKeyRecord["status"] } | undefined;

      if (existing) {
        skipped.push(phoneNumber);
        continue;
      }

      const id = crypto.randomUUID();
      this.db.prepare(`
        INSERT INTO pix_phone_keys (
          id, phone_number_enc, phone_hash, status, assigned_profile_id,
          assigned_at, reservation_run_id, pending_profile_id, pending_run_id, pending_at,
          used_profile_id, used_account_id, used_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'available', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(id, encryptedPhoneNumber, phoneHash, now, now);

      created.push(this.getPixPhoneKey(id));
    }

    if (created.length) {
      this.logActivity({
        id: crypto.randomUUID(),
        scope: "app",
        level: "success",
        message: `${created.length} chave(s) PIX telefone adicionada(s).`,
        createdAt: now
      });
    }

    return {
      created,
      skipped,
      invalid
    };
  }

  deletePixPhoneKey(pixKeyId: string): void {
    const result = this.db
      .prepare("DELETE FROM pix_phone_keys WHERE id = ? AND status IN ('available', 'rejected')")
      .run(pixKeyId);
    if (result.changes !== 1) {
      throw new Error("Somente chaves PIX disponiveis ou recusadas podem ser excluidas.");
    }
  }

  confirmPixPhoneKeyRegistration(
    pixKeyId: string,
    opts: { profileId: string; origin: string }
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db.prepare(`
        SELECT * FROM pix_phone_keys
        WHERE id = ? AND status = 'pending_confirmation' AND pending_profile_id = ?
      `).get(pixKeyId, opts.profileId) as PixPhoneKeyRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK;");
        return false;
      }

      const current = this.ensureProfileAccount(opts.profileId);
      const now = new Date().toISOString();
      this.setProfileAccount(opts.profileId, {
        ...current,
        pixPhoneKey: this.secureStore.decrypt(row.phone_number_enc) ?? undefined,
        pixKeyRegisteredAt: now,
        pixKeyRegisteredOrigins: mergeRegistrationOrigins(current.pixKeyRegisteredOrigins, opts.origin),
        updatedAt: now
      });

      const removed = this.db.prepare(`
        DELETE FROM pix_phone_keys
        WHERE id = ? AND status = 'pending_confirmation' AND pending_profile_id = ?
      `).run(pixKeyId, opts.profileId);
      if (removed.changes !== 1) {
        throw new Error("Nao foi possivel consumir a chave PIX confirmada.");
      }

      this.db.exec("COMMIT;");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  migrateLegacyUsedPixPhoneKeys(): number {
    const legacy = this.db.prepare("SELECT * FROM pix_phone_keys WHERE status = 'used'").all() as unknown as PixPhoneKeyRow[];
    if (!legacy.length) {
      return 0;
    }

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const row of legacy) {
        if (row.used_profile_id) {
          const profile = this.db.prepare("SELECT id FROM profiles WHERE id = ?").get(row.used_profile_id) as { id: string } | undefined;
          const phoneNumber = this.secureStore.decrypt(row.phone_number_enc) ?? undefined;
          if (profile && phoneNumber) {
            const current = this.ensureProfileAccount(row.used_profile_id);
            this.setProfileAccount(row.used_profile_id, {
              ...current,
              pixPhoneKey: phoneNumber,
              pixKeyRegisteredAt: row.used_at ?? current.pixKeyRegisteredAt ?? new Date().toISOString(),
              pixKeyRegisteredOrigins: mergeRegistrationOrigins(current.pixKeyRegisteredOrigins, "Telefone"),
              updatedAt: new Date().toISOString()
            });
          }
        }
        this.db.prepare("DELETE FROM pix_phone_keys WHERE id = ? AND status = 'used'").run(row.id);
      }
      this.db.exec("COMMIT;");
      return legacy.length;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  markPixPhoneKeyPendingConfirmation(
    pixKeyId: string,
    input: { profileId: string; runId: string }
  ): boolean {
    const now = new Date().toISOString();
    return this.db.prepare(`
      UPDATE pix_phone_keys
      SET status = 'pending_confirmation',
          assigned_profile_id = NULL,
          assigned_at = NULL,
          reservation_run_id = NULL,
          pending_profile_id = ?,
          pending_run_id = ?,
          pending_at = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'reserved'
        AND assigned_profile_id = ?
        AND reservation_run_id = ?
    `).run(input.profileId, input.runId, now, now, pixKeyId, input.profileId, input.runId).changes === 1;
  }

  rejectPixPhoneKey(
    pixKeyId: string,
    input: { profileId: string; reason: "withdrawal-account-already-linked" }
  ): boolean {
    const now = new Date().toISOString();
    return this.db.prepare(`
      UPDATE pix_phone_keys
      SET status = 'rejected',
          assigned_profile_id = NULL,
          assigned_at = NULL,
          reservation_run_id = NULL,
          pending_profile_id = NULL,
          pending_run_id = NULL,
          pending_at = NULL,
          rejected_at = ?,
          rejection_reason = ?,
          updated_at = ?
      WHERE id = ? AND status = 'pending_confirmation' AND pending_profile_id = ?
    `).run(now, input.reason, now, pixKeyId, input.profileId).changes === 1;
  }

  findPendingPixPhoneKey(profileId: string): PixPhoneKeyRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM pix_phone_keys
      WHERE status = 'pending_confirmation' AND pending_profile_id = ?
      ORDER BY pending_at ASC
      LIMIT 1
    `).get(profileId) as PixPhoneKeyRow | undefined;
    return row ? this.mapPixPhoneKey(row) : undefined;
  }

  updatePixPhoneKeyPhoneNumber(pixKeyId: string, input: string): PixPhoneKeyRecord {
    const phoneNumber = normalizePixPhoneNumber(input);
    if (!isAcceptedPixPhoneNumber(phoneNumber)) {
      throw new Error("Informe uma chave PIX em formato de telefone valido.");
    }

    const current = this.getPixPhoneKey(pixKeyId);
    if (current.status !== "available") {
      throw new Error("Somente chaves PIX disponiveis podem ser editadas.");
    }

    const phoneHash = hashPixPhoneNumber(phoneNumber);
    const duplicate = this.db
      .prepare("SELECT id, status FROM pix_phone_keys WHERE phone_hash = ? AND id <> ? LIMIT 1")
      .get(phoneHash, pixKeyId) as { id: string; status: PixPhoneKeyRecord["status"] } | undefined;

    if (duplicate) {
      throw new Error("Esta chave PIX telefone ja esta cadastrada.");
    }

    const encryptedPhoneNumber = this.secureStore.encrypt(phoneNumber) ?? phoneNumber;
    this.db.prepare(`
      UPDATE pix_phone_keys
      SET phone_number_enc = ?, phone_hash = ?, updated_at = ?
      WHERE id = ? AND status = 'available'
    `).run(encryptedPhoneNumber, phoneHash, new Date().toISOString(), pixKeyId);

    return this.getPixPhoneKey(pixKeyId);
  }

  reservePixPhoneKey(profileId: string, runId: string): PixPhoneKeyRecord | undefined {
    const existing = this.db
      .prepare(`
        SELECT * FROM pix_phone_keys
        WHERE status = 'reserved' AND assigned_profile_id = ? AND reservation_run_id = ?
        ORDER BY assigned_at ASC LIMIT 1
      `)
      .get(profileId, runId) as PixPhoneKeyRow | undefined;
    if (existing) {
      return this.getPixPhoneKey(existing.id);
    }

    const row = this.db
      .prepare("SELECT * FROM pix_phone_keys WHERE status = 'available' ORDER BY created_at ASC LIMIT 1")
      .get() as PixPhoneKeyRow | undefined;

    if (!row) {
      return undefined;
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE pix_phone_keys
      SET status = 'reserved',
          assigned_profile_id = ?,
          assigned_at = ?,
          reservation_run_id = ?,
          updated_at = ?
      WHERE id = ? AND status = 'available'
    `).run(profileId, now, runId, now, row.id);

    return this.getPixPhoneKey(row.id);
  }

  releasePixPhoneKeyReservation(pixKeyId: string, runId: string): boolean {
    return this.db.prepare(`
      UPDATE pix_phone_keys
      SET status = 'available',
          assigned_profile_id = NULL,
          assigned_at = NULL,
          reservation_run_id = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'reserved' AND reservation_run_id = ?
    `).run(new Date().toISOString(), pixKeyId, runId).changes === 1;
  }

  recoverInactivePixPhoneKeyReservations(activeRunIds: readonly string[]): number {
    const now = new Date().toISOString();
    const inactiveClause = activeRunIds.length
      ? `reservation_run_id IS NULL OR reservation_run_id NOT IN (${activeRunIds.map(() => "?").join(", ")})`
      : "1 = 1";
    return Number(this.db.prepare(`
      UPDATE pix_phone_keys
      SET status = 'available',
          assigned_profile_id = NULL,
          assigned_at = NULL,
          reservation_run_id = NULL,
          updated_at = ?
      WHERE status = 'reserved' AND (${inactiveClause})
    `).run(now, ...activeRunIds).changes);
  }

  getOrCreateProfileAccount(profileId: string): ProfileAccountRecord {
    return this.ensureProfileAccount(profileId);
  }

  updateProfileAccountPhoneNumber(profileId: string, phoneNumber: string): ProfileAccountRecord {
    const current = this.ensureProfileAccount(profileId);

    return this.setProfileAccount(profileId, {
      ...current,
      phoneCountryCode: "+55",
      phoneNumber: normalizePixPhoneNumber(phoneNumber),
      updatedAt: new Date().toISOString()
    });
  }

  updateProfileAccountPixData(
    profileId: string,
    draft: { cpf?: string; withdrawalPassword?: string }
  ): ProfileAccountRecord {
    const current = this.ensureProfileAccount(profileId);
    const nextCpf = draft.cpf !== undefined ? normalizeCpf(draft.cpf) : current.cpf;
    const nextWithdrawalPassword =
      draft.withdrawalPassword !== undefined
        ? normalizeWithdrawalPassword(draft.withdrawalPassword)
        : current.withdrawalPassword;

    if (draft.cpf !== undefined && nextCpf && !isAcceptedCpf(nextCpf)) {
      throw new Error("Informe um CPF valido com 11 digitos.");
    }
    if (
      draft.withdrawalPassword !== undefined &&
      nextWithdrawalPassword &&
      !isAcceptedWithdrawalPassword(nextWithdrawalPassword)
    ) {
      throw new Error("A senha de saque deve ter exatamente 6 digitos.");
    }

    return this.setProfileAccount(profileId, {
      ...current,
      cpf: nextCpf || undefined,
      withdrawalPassword: nextWithdrawalPassword || undefined,
      updatedAt: new Date().toISOString()
    });
  }

  resolveCpfForProfile(profileId: string): string {
    const account = this.ensureProfileAccount(profileId);
    const cpf = normalizeCpf(account.cpf);
    if (!isAcceptedCpf(cpf)) {
      throw new Error("CPF valido ausente no perfil. Preencha o CPF antes de cadastrar a chave PIX.");
    }

    return cpf;
  }

  setProfileWithdrawalPassword(profileId: string, withdrawalPassword: string): ProfileAccountRecord {
    const normalized = normalizeWithdrawalPassword(withdrawalPassword);
    if (!isAcceptedWithdrawalPassword(normalized)) {
      throw new Error("A senha de saque deve ter exatamente 6 digitos.");
    }

    return this.updateProfileAccountPixData(profileId, {
      withdrawalPassword: normalized
    });
  }

  private ensurePixPhoneKeyLifecycleColumns(): void {
    const rows = this.db.prepare("PRAGMA table_info(pix_phone_keys)").all() as Array<{ name: string }>;
    const existing = new Set(rows.map((row) => row.name));
    const columns: Array<{ name: string; definition: string }> = [
      { name: "reservation_run_id", definition: "reservation_run_id TEXT" },
      { name: "pending_profile_id", definition: "pending_profile_id TEXT" },
      { name: "pending_run_id", definition: "pending_run_id TEXT" },
      { name: "pending_at", definition: "pending_at TEXT" },
      { name: "rejected_at", definition: "rejected_at TEXT" },
      { name: "rejection_reason", definition: "rejection_reason TEXT" }
    ];

    for (const column of columns) {
      if (!existing.has(column.name)) {
        this.db.exec(`ALTER TABLE pix_phone_keys ADD COLUMN ${column.definition};`);
      }
    }
  }

  getPersistedProfileWithdrawalPassword(profileId: string): string | undefined {
    const password = this.ensureProfileAccount(profileId).withdrawalPassword;
    return password && isAcceptedWithdrawalPassword(password) ? password : undefined;
  }

  ensureProfileWithdrawalPassword(profileId: string): string {
    const current = this.ensureProfileAccount(profileId).withdrawalPassword;
    if (current && isAcceptedWithdrawalPassword(current)) {
      return current;
    }

    let nextPassword = randomWithdrawalPassword();
    for (let attempt = 0; attempt < 20 && /^(\d)\1{5}$/.test(nextPassword); attempt += 1) {
      nextPassword = randomWithdrawalPassword();
    }

    this.setProfileWithdrawalPassword(profileId, nextPassword);
    return nextPassword;
  }

  markProfilePixKeyRegistered(profileId: string, origin: string): ProfileAccountRecord {
    const current = this.ensureProfileAccount(profileId);
    return this.setProfileAccount(profileId, {
      ...current,
      pixKeyRegisteredAt: new Date().toISOString(),
      pixKeyRegisteredOrigins: mergeRegistrationOrigins(current.pixKeyRegisteredOrigins, origin),
      updatedAt: new Date().toISOString()
    });
  }

  markProfileAccountRegisteredOrigin(profileId: string, origin: string): ProfileAccountRecord {
    const current = this.ensureProfileAccount(profileId);
    return this.setProfileAccount(profileId, {
      ...current,
      registeredOrigins: mergeRegistrationOrigins(current.registeredOrigins, origin),
      updatedAt: new Date().toISOString()
    });
  }

  updateProfileAccountStatus(
    profileId: string,
    status: ProfileAccountRecord["status"],
    options?: { lastError?: string; registeredAt?: string; registeredOrigin?: string }
  ): ProfileAccountRecord {
    const current = this.ensureProfileAccount(profileId);

    return this.setProfileAccount(profileId, {
      ...current,
      status,
      lastError: options?.lastError,
      registeredAt: options?.registeredAt ?? current.registeredAt,
      registeredOrigins: mergeRegistrationOrigins(current.registeredOrigins, options?.registeredOrigin),
      updatedAt: new Date().toISOString()
    });
  }

  isProfileAccountRegisteredForUrl(profileId: string, url: string): boolean {
    const account = this.ensureProfileAccount(profileId);
    const origin = normalizeRegistrationOrigin(url);
    if (!origin) {
      return false;
    }

    if (account.registeredOrigins.includes(origin)) {
      return true;
    }

    if (account.status !== "registered") {
      return false;
    }

    return false;
  }

  private materializePersona(
    profileId: string,
    profileName: string,
    partial?: Partial<PersonaConfig>
  ): PersonaConfig {
    return {
      ...buildDefaultPersona(profileId, profileName),
      ...partial,
      id: partial?.id ?? crypto.randomUUID(),
      profileId
    };
  }

  private ensureProfileArtifacts(): void {
    const profiles = this.db.prepare("SELECT id, name FROM profiles").all() as Array<{
      id: string;
      name: string;
    }>;

    for (const profile of profiles) {
      this.ensureProfileAccount(profile.id);
      this.ensureSystemAutomation(profile.id);
    }
  }

  private getPixPhoneKey(pixKeyId: string): PixPhoneKeyRecord {
    const row = this.db
      .prepare("SELECT * FROM pix_phone_keys WHERE id = ?")
      .get(pixKeyId) as PixPhoneKeyRow | undefined;

    if (!row) {
      throw new Error(`Chave PIX ${pixKeyId} nao encontrada.`);
    }

    return this.mapPixPhoneKey(row);
  }

  private resolveProfilePlatformId(profileId: string): string {
    const profile = this.db
      .prepare("SELECT home_url FROM profiles WHERE id = ?")
      .get(profileId) as Pick<ProfileRow, "home_url"> | undefined;

    return buildPlatformIdFromUrl(profile?.home_url);
  }

  private ensureProfileAccount(profileId: string): ProfileAccountRecord {
    const platformId = this.resolveProfilePlatformId(profileId);
    const existing = this.db
      .prepare("SELECT * FROM profile_accounts WHERE profile_id = ?")
      .get(profileId) as ProfileAccountRow | undefined;

    if (existing) {
      const current = this.mapProfileAccount(existing);
      const nextPlatformId = current.platformId && current.platformId !== "generic" ? current.platformId : platformId;
      if (current.status !== "registered") {
        const shouldRotatePassword =
          !isAcceptedPlatformPassword(current.password) ||
          !isPreferredPlatformPassword(current.password) ||
          this.isPasswordDuplicateOrSimilar(profileId, current.password) ||
          shouldRotatePasswordAfterFailure(current.lastError);
        const shouldRotateIdentity =
          !isPreferredGeneratedIdentity(current.username, current.realName) ||
          isLegacyGeneratedUsername(current.username) ||
          this.isUsernameDuplicate(profileId, current.username) ||
          isIdentityError(current.lastError);

        if (shouldRotatePassword || shouldRotateIdentity) {
          const nextRealName =
            shouldRotateIdentity && isLegacyGeneratedUsername(current.username) && !isIdentityError(current.lastError)
              ? buildGeneratedRealName()
              : current.realName || buildGeneratedRealName();

          const updatedAccount = this.setProfileAccount(profileId, {
            ...current,
            platformId: nextPlatformId,
            username: shouldRotateIdentity
              ? this.generateUniquePlatformUsername(profileId, nextRealName)
              : current.username,
            password: shouldRotatePassword ? this.generateUniquePlatformPassword(profileId) : current.password,
            realName: nextRealName,
            lastError: undefined
          });
          this.syncAutoProfileName(profileId, updatedAccount);
          return updatedAccount;
        }
      }

      if (nextPlatformId !== current.platformId) {
        const updated = this.setProfileAccount(profileId, {
          ...current,
          platformId: nextPlatformId
        });
        this.syncAutoProfileName(profileId, updated);
        return updated;
      }

      this.syncAutoProfileName(profileId, current);
      return current;
    }

    const now = new Date().toISOString();
    const realName = buildGeneratedRealName();
    const username = this.generateUniquePlatformUsername(profileId, realName);

    const createdAccount = this.setProfileAccount(profileId, {
      id: crypto.randomUUID(),
      profileId,
      platformId,
      username,
      password: this.generateUniquePlatformPassword(profileId),
      phoneCountryCode: "+55",
      phoneNumber: "",
      realName,
      cpf: generateValidCpf(),
      status: "generated",
      generatedAt: now,
      registeredAt: undefined,
      registeredOrigins: [],
      pixPhoneKey: undefined,
      pixKeyRegisteredOrigins: [],
      pixKeyRegisteredAt: undefined,
      lastError: undefined,
      createdAt: now,
      updatedAt: now
    });
    this.syncAutoProfileName(profileId, createdAccount);
    return createdAccount;
  }

  private setProfileAccount(profileId: string, account: ProfileAccountRecord): ProfileAccountRecord {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT * FROM profile_accounts WHERE profile_id = ?")
      .get(profileId) as ProfileAccountRow | undefined;
    const next = {
      ...account,
      id: existing?.id ?? account.id ?? crypto.randomUUID(),
      profileId,
      registeredOrigins: mergeRegistrationOrigins(account.registeredOrigins),
      pixKeyRegisteredOrigins: mergeRegistrationOrigins(account.pixKeyRegisteredOrigins),
      createdAt: existing?.created_at ?? account.createdAt ?? now,
      updatedAt: now
    };
    const encryptedUsername = this.secureStore.encrypt(next.username) ?? next.username;
    const encryptedPassword = this.secureStore.encrypt(next.password) ?? next.password;
    const encryptedPhoneNumber = this.secureStore.encrypt(next.phoneNumber) ?? next.phoneNumber;
    const encryptedRealName = this.secureStore.encrypt(next.realName) ?? next.realName;
    const encryptedCpf = this.secureStore.encrypt(next.cpf) ?? next.cpf ?? null;
    const encryptedWithdrawalPassword =
      this.secureStore.encrypt(next.withdrawalPassword) ?? next.withdrawalPassword ?? null;
    const encryptedPixPhoneKey = this.secureStore.encrypt(next.pixPhoneKey) ?? next.pixPhoneKey ?? null;
    const serializedOrigins = JSON.stringify(next.registeredOrigins);
    const serializedPixOrigins = JSON.stringify(mergeRegistrationOrigins(next.pixKeyRegisteredOrigins));

    this.db.prepare(`
      INSERT INTO profile_accounts (
        id, profile_id, platform_id, username_enc, password_enc, phone_country_code,
        phone_number_enc, real_name_enc, cpf_enc, withdrawal_password_enc, pix_phone_key_enc,
        pix_key_registered_origins_json, pix_key_registered_at, status, last_error, generated_at,
        registered_at, registered_origins_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        platform_id = excluded.platform_id,
        username_enc = excluded.username_enc,
        password_enc = excluded.password_enc,
        phone_country_code = excluded.phone_country_code,
        phone_number_enc = excluded.phone_number_enc,
        real_name_enc = excluded.real_name_enc,
        cpf_enc = excluded.cpf_enc,
        withdrawal_password_enc = excluded.withdrawal_password_enc,
        pix_phone_key_enc = excluded.pix_phone_key_enc,
        pix_key_registered_origins_json = excluded.pix_key_registered_origins_json,
        pix_key_registered_at = excluded.pix_key_registered_at,
        status = excluded.status,
        last_error = excluded.last_error,
        generated_at = excluded.generated_at,
        registered_at = excluded.registered_at,
        registered_origins_json = excluded.registered_origins_json,
        updated_at = excluded.updated_at
    `).run(
      next.id,
      next.profileId,
      next.platformId,
      encryptedUsername,
      encryptedPassword,
      next.phoneCountryCode,
      encryptedPhoneNumber,
      encryptedRealName,
      encryptedCpf,
      encryptedWithdrawalPassword,
      encryptedPixPhoneKey,
      serializedPixOrigins,
      next.pixKeyRegisteredAt ?? null,
      next.status,
      next.lastError ?? null,
      next.generatedAt,
      next.registeredAt ?? null,
      serializedOrigins,
      next.createdAt,
      next.updatedAt
    );

    return this.mapProfileAccount(
      this.db.prepare("SELECT * FROM profile_accounts WHERE profile_id = ?").get(profileId) as unknown as ProfileAccountRow
    );
  }

  private shouldUseAccountProfileName(draft: ProfileDraft): boolean {
    return draft.tags.includes("auto") || /^auto profile\s+\d+$/i.test(draft.name.trim());
  }

  private buildAccountProfileName(account: ProfileAccountRecord): string {
    const label = [account.realName, account.username].filter(Boolean).join(" - ");
    return (label || "Perfil Spider BOT").slice(0, 80);
  }

  private syncAutoProfileName(profileId: string, account: ProfileAccountRecord): void {
    const profile = this.db
      .prepare("SELECT id, name, persona_id FROM profiles WHERE id = ?")
      .get(profileId) as Pick<ProfileRow, "id" | "name" | "persona_id"> | undefined;

    if (!profile) {
      return;
    }

    const tags = this.db.prepare("SELECT tag FROM profile_tags WHERE profile_id = ?").all(profileId) as Array<{
      tag: string;
    }>;
    const isAutomaticProfile = tags.some((entry) => entry.tag === "auto") || /^auto profile\s+\d+$/i.test(profile.name);

    if (!isAutomaticProfile) {
      return;
    }

    const nextName = this.buildAccountProfileName(account);
    if (profile.name === nextName) {
      return;
    }

    const now = new Date().toISOString();
    this.db.prepare("UPDATE profiles SET name = ?, code_name = ?, updated_at = ? WHERE id = ?").run(
      nextName,
      nextName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      now,
      profileId
    );
    this.db.prepare("UPDATE personas SET name = ?, updated_at = ? WHERE id = ?").run(
      nextName,
      now,
      profile.persona_id
    );
  }

  private generateUniquePlatformUsername(profileId: string, realName: string): string {
    const existingUsernames = new Set(this.listExistingAccountUsernames(profileId).map(normalizeUsername));

    for (let attempt = 0; attempt < 96; attempt += 1) {
      const username = buildUsernameCandidate(realName);

      if (isPreferredGeneratedIdentity(username, realName) && !existingUsernames.has(normalizeUsername(username))) {
        return username;
      }
    }

    throw new Error("Nao foi possivel gerar um usuario unico e compativel para a plataforma.");
  }

  private generateUniquePlatformPassword(profileId: string): string {
    const existingPasswords = this.listExistingAccountPasswords(profileId);

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const targetLength = 10 + secureRandomInt(5);
      const minimumLetterCount = 5;
      const minimumDigitCount = 3;
      const remainingLength = Math.max(0, targetLength - minimumLetterCount - minimumDigitCount);
      const extraLetters = secureRandomInt(remainingLength + 1);
      const letterCount = minimumLetterCount + extraLetters;
      const digitCount = targetLength - letterCount;
      const letters = Array.from({ length: letterCount }, () => secureRandomItem(passwordLetters)).join("");
      const digits = Array.from({ length: digitCount }, () => secureRandomItem(passwordDigits)).join("");
      let nextPassword = shuffleString(`${letters}${digits}`);

      if (hasLongRepeatedSequence(nextPassword) || hasSequentialRun(nextPassword)) {
        continue;
      }

      if (/^[0-9]/.test(nextPassword)) {
        nextPassword = shuffleString(`${secureRandomItem(passwordLetters)}${nextPassword.slice(1)}`);
      }

      if (
        isAcceptedPlatformPassword(nextPassword) &&
        isPreferredPlatformPassword(nextPassword) &&
        !existingPasswords.some((existingPassword) => isPasswordTooSimilar(nextPassword, existingPassword))
      ) {
        return nextPassword;
      }
    }

    throw new Error("Nao foi possivel gerar uma senha unica e compativel para a plataforma.");
  }

  private listExistingAccountPasswords(excludeProfileId?: string): string[] {
    const rows = this.db.prepare("SELECT profile_id, password_enc FROM profile_accounts").all() as Array<{
      profile_id: string;
      password_enc: string;
    }>;

    return rows
      .filter((row) => row.profile_id !== excludeProfileId)
      .map((row) => this.secureStore.decrypt(row.password_enc) ?? row.password_enc)
      .filter((password): password is string => Boolean(password));
  }

  private isPasswordDuplicateOrSimilar(profileId: string, password: string): boolean {
    return this.listExistingAccountPasswords(profileId).some((existingPassword) =>
      isPasswordTooSimilar(password, existingPassword)
    );
  }

  private listExistingAccountUsernames(excludeProfileId?: string): string[] {
    const rows = this.db.prepare("SELECT profile_id, username_enc FROM profile_accounts").all() as Array<{
      profile_id: string;
      username_enc: string;
    }>;

    return rows
      .filter((row) => row.profile_id !== excludeProfileId)
      .map((row) => this.secureStore.decrypt(row.username_enc) ?? row.username_enc)
      .filter((username): username is string => Boolean(username));
  }

  private isUsernameDuplicate(profileId: string, username: string): boolean {
    const normalized = normalizeUsername(username);
    return this.listExistingAccountUsernames(profileId).some(
      (existingUsername) => normalizeUsername(existingUsername) === normalized
    );
  }

  private ensureSystemAutomation(profileId: string): AutomationRecord {
    const existing = this.db
      .prepare("SELECT * FROM automations WHERE profile_id = ? AND kind = ?")
      .get(profileId, ACCOUNT_REGISTRATION_KIND) as AutomationRow | undefined;

    if (existing) {
      if (
        existing.name !== "Criar conta da plataforma" ||
        existing.description !== "Preenche automaticamente o popup de cadastro whitelabel com a conta fixa do perfil."
      ) {
        this.db
          .prepare("UPDATE automations SET name = ?, description = ?, updated_at = ? WHERE id = ?")
          .run(
            "Criar conta da plataforma",
            "Preenche automaticamente o popup de cadastro whitelabel com a conta fixa do perfil.",
            new Date().toISOString(),
            existing.id
          );
        return this.getAutomation(existing.id);
      }

      return this.mapAutomation(existing);
    }

    const normalized = this.normalizeAutomationDraft({
      profileId,
      kind: ACCOUNT_REGISTRATION_KIND
    });
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    this.db.prepare(`
      INSERT INTO automations (
        id, profile_id, kind, name, description, start_url,
        params_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      profileId,
      normalized.kind,
      normalized.name,
      normalized.description,
      normalized.startUrl,
      JSON.stringify(normalized.params),
      "ready",
      now,
      now
    );

    return this.getAutomation(id);
  }

  private syncSystemAutomationStartUrl(profileId: string, startUrl: string): void {
    this.db
      .prepare("UPDATE automations SET start_url = ?, updated_at = ? WHERE profile_id = ? AND kind = ?")
      .run(startUrl, new Date().toISOString(), profileId, ACCOUNT_REGISTRATION_KIND);
  }

  private normalizeAutomationDraft(
    draft: AutomationDraft,
    existing?: AutomationRecord
  ): {
    kind: AutomationKind;
    name: string;
    description: string;
    startUrl: string;
    params: Record<string, string>;
  } {
    const kind = draft.kind ?? existing?.kind ?? ACCOUNT_REGISTRATION_KIND;
    if (kind !== ACCOUNT_REGISTRATION_KIND) {
      throw new Error(`Automation kind ${kind} is not supported.`);
    }

    const profileHomeUrl =
      draft.profileId && !existing ? this.getProfile(draft.profileId).homeUrl : undefined;
    const startUrl = draft.startUrl?.trim() || existing?.startUrl || profileHomeUrl || "";
    const platformId = draft.params?.platformId || existing?.params.platformId || buildPlatformIdFromUrl(startUrl);

    return {
      kind,
      name: draft.name?.trim() || existing?.name || "Criar conta da plataforma",
      description:
        draft.description?.trim() ||
        existing?.description ||
        "Preenche automaticamente o popup de cadastro whitelabel com a conta fixa do perfil.",
      startUrl,
      params: {
        ...(existing?.params ?? {}),
        ...(draft.params ?? {}),
        platformId
      }
    };
  }

  private updatePersona(current: PersonaConfig, partial: Partial<PersonaConfig>): void {
    const next: PersonaConfig = {
      ...current,
      ...partial,
      headers: partial.headers ?? current.headers,
      launchArgs: partial.launchArgs ?? current.launchArgs,
      viewport: partial.viewport ?? current.viewport,
      geolocation: partial.geolocation ?? current.geolocation,
      updatedAt: new Date().toISOString()
    };

    this.db.prepare(`
      UPDATE personas
      SET version = ?, name = ?, user_agent = ?, locale = ?, timezone = ?,
          viewport_json = ?, geolocation_json = ?, allow_notifications = ?, allow_clipboard = ?,
          web_rtc_mode = ?, dns_mode = ?, leak_protection = ?, headers_json = ?,
          launch_args_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.version,
      next.name,
      next.userAgent,
      next.locale,
      next.timezone,
      JSON.stringify(next.viewport),
      JSON.stringify(next.geolocation),
      Number(next.allowNotifications),
      Number(next.allowClipboard),
      next.webRtcMode,
      next.dnsMode,
      next.leakProtection,
      JSON.stringify(next.headers),
      JSON.stringify(next.launchArgs),
      next.updatedAt,
      next.id
    );
  }

  private mapProfile(row: ProfileRow, tags: string[], proxyId?: string): ProfileRecord {
    return {
      id: row.id,
      name: row.name,
      codeName: row.code_name,
      notes: row.notes,
      status: row.status,
      storagePath: row.storage_path,
      homeUrl: row.home_url,
      proxyId,
      personaId: row.persona_id,
      tags,
      color: row.color,
      lastLaunchedAt: row.last_launched_at ?? undefined,
      lastAutomationAt: row.last_automation_at ?? undefined,
      archivedAt: row.archived_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapPersona(row: PersonaRow): PersonaConfig {
    return {
      id: row.id,
      profileId: row.profile_id,
      version: row.version,
      name: row.name,
      userAgent: row.user_agent,
      locale: row.locale,
      timezone: row.timezone,
      viewport: jsonParse(row.viewport_json, {
        width: 1440,
        height: 960,
        deviceScaleFactor: 1
      }),
      geolocation: jsonParse(row.geolocation_json, {
        latitude: 0,
        longitude: 0,
        accuracy: 20
      }),
      allowNotifications: Boolean(row.allow_notifications),
      allowClipboard: Boolean(row.allow_clipboard),
      webRtcMode: row.web_rtc_mode,
      dnsMode: row.dns_mode,
      leakProtection: row.leak_protection,
      headers: jsonParse(row.headers_json, []),
      launchArgs: jsonParse(row.launch_args_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapProxy(row: ProxyRow): ProxyConfig {
    return {
      id: row.id,
      label: row.label,
      protocol: row.protocol,
      host: row.host,
      port: row.port,
      username: this.secureStore.decrypt(row.username_enc ?? undefined),
      password: this.secureStore.decrypt(row.password_enc ?? undefined),
      status: row.status,
      mode: normalizeProxyMode(row.mode),
      usernameSuffixTemplate: row.username_suffix_template ?? undefined,
      lastCheckedAt: row.last_checked_at ?? undefined,
      notes: row.notes ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapProfileAccount(row: ProfileAccountRow): ProfileAccountRecord {
    return {
      id: row.id,
      profileId: row.profile_id,
      platformId: row.platform_id || "generic",
      username: this.secureStore.decrypt(row.username_enc) ?? "",
      password: this.secureStore.decrypt(row.password_enc) ?? "",
      phoneCountryCode: row.phone_country_code,
      phoneNumber: this.secureStore.decrypt(row.phone_number_enc) ?? "",
      realName: this.secureStore.decrypt(row.real_name_enc) ?? "",
      cpf: this.secureStore.decrypt(row.cpf_enc ?? undefined) ?? undefined,
      withdrawalPassword: this.secureStore.decrypt(row.withdrawal_password_enc ?? undefined) ?? undefined,
      pixPhoneKey: this.secureStore.decrypt(row.pix_phone_key_enc ?? undefined) ?? undefined,
      pixKeyRegisteredOrigins: mergeRegistrationOrigins(
        jsonParse<string[]>(row.pix_key_registered_origins_json, [])
      ),
      pixKeyRegisteredAt: row.pix_key_registered_at ?? undefined,
      status: row.status,
      lastError: row.last_error ?? undefined,
      generatedAt: row.generated_at,
      registeredAt: row.registered_at ?? undefined,
      registeredOrigins: mergeRegistrationOrigins(jsonParse<string[]>(row.registered_origins_json, [])),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapPixPhoneKey(row: PixPhoneKeyRow): PixPhoneKeyRecord {
    return {
      id: row.id,
      phoneNumber: this.secureStore.decrypt(row.phone_number_enc) ?? "",
      status: row.status,
      assignedProfileId: row.assigned_profile_id ?? undefined,
      assignedAt: row.assigned_at ?? undefined,
      reservationRunId: row.reservation_run_id ?? undefined,
      pendingProfileId: row.pending_profile_id ?? undefined,
      pendingRunId: row.pending_run_id ?? undefined,
      pendingAt: row.pending_at ?? undefined,
      rejectedAt: row.rejected_at ?? undefined,
      rejectionReason: row.rejection_reason ?? undefined,
      usedProfileId: row.used_profile_id ?? undefined,
      usedAccountId: row.used_account_id ?? undefined,
      usedAt: row.used_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapAutomation(row: AutomationRow): AutomationRecord {
    return {
      id: row.id,
      profileId: row.profile_id,
      kind: ACCOUNT_REGISTRATION_KIND,
      name: row.name,
      description: row.description,
      startUrl: row.start_url,
      params: jsonParse(row.params_json, {}),
      status: row.status,
      lastRunAt: row.last_run_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapRun(row: RunRow): AutomationRunRecord {
    return {
      id: row.id,
      automationId: row.automation_id,
      profileId: row.profile_id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      logs: jsonParse(row.logs_json, []),
      metrics: jsonParse(row.metrics_json, {})
    };
  }

  private mapActivity(row: ActivityRow): ActivityLogRecord {
    return {
      id: row.id,
      scope: row.scope,
      scopeId: row.scope_id ?? undefined,
      level: row.level,
      message: row.message,
      details: jsonParse(row.details_json, undefined),
      createdAt: row.created_at
    };
  }
}
