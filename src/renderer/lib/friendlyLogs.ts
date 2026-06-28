import type {
  ActivityLevel,
  ActivityLogRecord,
  AutomationRunLogEntry
} from "../../shared/contracts.js";
import { formatRelativeTime } from "./format.js";

export type FriendlyLogTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface FriendlyLogLine {
  emoji: string;
  label: string;
  meta: string;
  title: string;
  tone: FriendlyLogTone;
  when: string;
}

const scopeLabels: Record<ActivityLogRecord["scope"], string> = {
  app: "Sistema",
  automation: "Rotina",
  profile: "Navegador",
  proxy: "Proxy",
  runtime: "Browser"
};

const scopeEmojis: Record<ActivityLogRecord["scope"], string> = {
  app: "⚙️",
  automation: "🤖",
  profile: "🧩",
  proxy: "🛰️",
  runtime: "🌐"
};

const levelLabels: Record<ActivityLevel, string> = {
  error: "Atenção",
  info: "Info",
  success: "OK",
  warning: "Aviso"
};

const levelTones: Record<ActivityLevel, FriendlyLogTone> = {
  error: "danger",
  info: "info",
  success: "success",
  warning: "warning"
};

const levelEmojis: Record<ActivityLevel, string> = {
  error: "🚨",
  info: "ℹ️",
  success: "✅",
  warning: "⚠️"
};

const runtimeStatusCopy: Record<string, Pick<FriendlyLogLine, "emoji" | "title" | "tone">> = {
  active: {
    emoji: "🌐",
    title: "Navegador aberto e pronto.",
    tone: "success"
  },
  error: {
    emoji: "🚨",
    title: "O navegador encontrou um erro.",
    tone: "danger"
  },
  idle: {
    emoji: "🧹",
    title: "Navegador fechado.",
    tone: "neutral"
  },
  launching: {
    emoji: "🚀",
    title: "Abrindo navegador isolado...",
    tone: "info"
  },
  stopping: {
    emoji: "⏹️",
    title: "Fechando navegador...",
    tone: "warning"
  }
};

function friendlyWhen(value?: string): string {
  const raw = formatRelativeTime(value);
  if (raw === "Never") {
    return "nunca";
  }
  if (raw === "just now") {
    return "agora";
  }
  return raw.replace("m ago", " min atrás").replace("h ago", " h atrás").replace("d ago", " d atrás");
}

function removeLeadingEmoji(message: string): string {
  return message.replace(/^[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\uFE0F?\s*/u, "").trim();
}

// Defesa em profundidade: mensagens nao catalogadas nao devem vazar artefatos
// tecnicos para o usuario. Remove restos de interpolacao (`${...}`), dumps de
// objeto/JSON (`{...}`), tokens com nome de funcao (`algumaCoisa()` / camelCase
// longo) e colapsa espacos. Se sobrar pouco texto util, devolve string vazia
// para o chamador cair no titulo generico.
function sanitizeFallbackText(message: string): string {
  const cleaned = message
    .replace(/\$\{[^}]*\}/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\b[a-z][a-zA-Z0-9]*\([^)]*\)/g, "")
    .replace(/\b[a-z]+[A-Z][a-zA-Z]{6,}\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
  // Exige ao menos uma palavra com vogal para evitar res\u00EDduos sem sentido.
  return /[aeiou\u00E1\u00E9\u00ED\u00F3\u00FA\u00E2\u00EA\u00F4]/i.test(cleaned) && cleaned.length >= 3 ? cleaned : "";
}

function splitProfilePrefix(message: string): { prefix?: string; text: string } {
  const match = message.match(/^\[([^\]]+)]\s*(.*)$/);
  if (!match) {
    return { text: message };
  }

  return {
    prefix: match[1],
    text: match[2] ?? ""
  };
}

function readableProxyStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "healthy":
      return "pronto para uso";
    case "degraded":
      return "instável";
    case "offline":
      return "offline";
    default:
      return status;
  }
}

function translateKnownMessage(
  rawMessage: string,
  scope: ActivityLogRecord["scope"],
  status?: string
): Pick<FriendlyLogLine, "emoji" | "title" | "tone"> {
  const split = splitProfilePrefix(removeLeadingEmoji(rawMessage));
  const prefix = split.prefix;
  const text = removeLeadingEmoji(split.text);
  const lower = text.toLowerCase();
  const withPrefix = (title: string) => (prefix ? `${prefix}: ${title}` : title);

  if (lower.includes("abrindo navegador") || lower.includes("launching isolated browser")) {
    return { emoji: "🚀", title: withPrefix("Abrindo navegador isolado..."), tone: "info" };
  }
  if (lower.includes("navegador aberto") || lower.includes("profile context ready")) {
    return { emoji: "🌐", title: withPrefix("Navegador aberto e pronto."), tone: "success" };
  }
  if (lower.includes("já estava aberto") || lower.includes("already active")) {
    return { emoji: "🌐", title: withPrefix("Navegador já estava aberto."), tone: "success" };
  }
  if (lower.includes("fechando navegador") || lower.includes("stopping browser")) {
    return { emoji: "⏹️", title: withPrefix("Fechando navegador..."), tone: "warning" };
  }
  if (lower.includes("navegador fechado") || lower.includes("profile stopped") || lower.includes("context closed")) {
    return { emoji: "🧹", title: withPrefix("Navegador fechado."), tone: "neutral" };
  }
  if (lower.includes("já estava fechado") || lower.includes("already stopped")) {
    return { emoji: "🧹", title: withPrefix("Navegador já estava fechado."), tone: "neutral" };
  }
  if (lower.includes("sem proxy para manter") || lower.includes("launching without proxy")) {
    return {
      emoji: "🛟",
      title: withPrefix("Proxy instável detectado. Abrindo sem proxy para manter internet."),
      tone: "warning"
    };
  }

  const profileCreated = text.match(/^Profile (.+) created\.$/i);
  if (profileCreated) {
    return {
      emoji: "🧩",
      title: `${profileCreated[1]} preparado para abrir o link.`,
      tone: "success"
    };
  }
  const profileUpdated = text.match(/^Profile (.+) updated\.$/i);
  if (profileUpdated) {
    return {
      emoji: "⚙️",
      title: `Preferências de ${profileUpdated[1]} salvas.`,
      tone: "info"
    };
  }
  const profileDeleted = text.match(/^Profile (.+) deleted\.$/i);
  if (profileDeleted) {
    return {
      emoji: "🧹",
      title: `${profileDeleted[1]} removido da área de trabalho.`,
      tone: "warning"
    };
  }
  if (lower === "profile archived.") {
    return { emoji: "📦", title: "Perfil movido para arquivados.", tone: "warning" };
  }

  const proxyChecked = text.match(/^Proxy (.+) checked: (.+)\.$/i);
  if (proxyChecked) {
    return {
      emoji: proxyChecked[2]?.toLowerCase() === "healthy" ? "✅" : "⚠️",
      title: `Teste de proxy concluído: ${proxyChecked[1]} está ${readableProxyStatus(proxyChecked[2] ?? "")}.`,
      tone: proxyChecked[2]?.toLowerCase() === "healthy" ? "success" : "warning"
    };
  }
  const proxyDeleted = text.match(/^Proxy (.+) deleted\.$/i);
  if (proxyDeleted) {
    return {
      emoji: "🧹",
      title: `Proxy ${proxyDeleted[1]} removido.`,
      tone: "warning"
    };
  }

  const automationStarted = text.match(/^Automation (.+) started\.$/i);
  if (automationStarted) {
    return { emoji: "🤖", title: `Rotina ${automationStarted[1]} iniciada.`, tone: "info" };
  }
  const automationFinished = text.match(/^Automation (.+) finished\.$/i);
  if (automationFinished) {
    return { emoji: "✅", title: `Rotina ${automationFinished[1]} concluída.`, tone: "success" };
  }
  const automationCancelled = text.match(/^Automation (.+) cancelled\.$/i);
  if (automationCancelled) {
    return { emoji: "⏹️", title: `Rotina ${automationCancelled[1]} interrompida.`, tone: "warning" };
  }
  const automationFailed = text.match(/^Automation (.+) failed\.$/i);
  if (automationFailed) {
    return { emoji: "🚨", title: `Rotina ${automationFailed[1]} parou com erro.`, tone: "danger" };
  }

  if (lower.includes("cancellation requested") || lower.includes("parada solicitada")) {
    return { emoji: "⏹️", title: withPrefix("Parada solicitada pelo usuário."), tone: "warning" };
  }
  if (lower.includes("automation cancelled")) {
    return { emoji: "⏹️", title: withPrefix("Rotina interrompida."), tone: "warning" };
  }
  if (lower.includes("unknown automation failure")) {
    return { emoji: "🚨", title: withPrefix("A rotina parou por um erro inesperado."), tone: "danger" };
  }

  if (lower.startsWith("opening ")) {
    return { emoji: "🌐", title: withPrefix(`Abrindo ${text.replace(/^opening\s+/i, "")}`), tone: "info" };
  }
  if (lower.startsWith("ready:")) {
    return { emoji: "✅", title: withPrefix(`Página pronta: ${text.replace(/^ready:\s*/i, "")}`), tone: "success" };
  }
  if (lower.includes("screenshot saved")) {
    return { emoji: "📸", title: withPrefix("Captura de tela salva."), tone: "success" };
  }
  if (lower.includes("workspace seeded")) {
    return { emoji: "✅", title: "Ambiente inicial preparado com dados de exemplo.", tone: "success" };
  }
  if (lower.includes("runtime initialized")) {
    return { emoji: "⚙️", title: "Spider BOT pronto para operar localmente.", tone: "info" };
  }
  if (lower.includes("proxy health checks pending")) {
    return { emoji: "⚠️", title: "Proxies aguardam o primeiro teste de conexão.", tone: "warning" };
  }
  if (lower.includes("native predator import completed")) {
    return { emoji: "📦", title: "Pacote importado com sucesso.", tone: "success" };
  }

  // Milestones em portugues emitidos pela automacao (apos a limpeza dos logs
  // tecnicos). Damos emoji/tom proprios; o restante cai no fallback higienizado.
  if (lower.includes("login automatico concluido") || lower.includes("login automático concluído")) {
    return { emoji: "🔓", title: withPrefix("Login concluído."), tone: "success" };
  }
  const contaRegistrada = text.match(/^Conta (.+) registrada na plataforma\.?$/i);
  if (contaRegistrada) {
    return { emoji: "✅", title: withPrefix(`Conta ${contaRegistrada[1]} registrada.`), tone: "success" };
  }
  if (lower.includes("conta pix phone cadastrada")) {
    return { emoji: "🔑", title: withPrefix("Chave PIX cadastrada para recebimento."), tone: "success" };
  }
  if (lower.startsWith("cadastro pix") && lower.includes("iniciado")) {
    return { emoji: "🔑", title: withPrefix("Cadastrando chave PIX..."), tone: "info" };
  }
  if (lower.includes("tela de saques aberta") || lower.includes("abrindo tela de saques")) {
    return { emoji: "💸", title: withPrefix("Tela de saque aberta."), tone: "info" };
  }
  if (lower.includes("valor e senha de saque preenchidos")) {
    return { emoji: "✍️", title: withPrefix("Valor e senha de saque preenchidos; confirme manualmente."), tone: "success" };
  }
  if (lower.includes("preparando cadastro da plataforma")) {
    return { emoji: "📝", title: withPrefix("Preparando cadastro..."), tone: "info" };
  }
  if (lower.includes("deposito manual iniciado") || lower.includes("depósito manual iniciado")) {
    return { emoji: "💰", title: withPrefix("Depósito iniciado."), tone: "info" };
  }
  const depositoVerificado = text.match(/^Deposito (.+) verificado/i);
  if (depositoVerificado) {
    return { emoji: "✅", title: withPrefix(`Depósito ${depositoVerificado[1]} confirmado.`), tone: "success" };
  }
  if (lower.includes("acao manual necessaria") || lower.includes("ação manual necessária")) {
    return { emoji: "✋", title: withPrefix(text), tone: "warning" };
  }
  if (lower.includes("captcha") && (lower.includes("resolvido") || lower.includes("resolvida"))) {
    return { emoji: "🧩", title: withPrefix("Captcha resolvido."), tone: "success" };
  }
  if (lower.includes("captcha detectado") || lower.includes("aguardando solucao manual do captcha")) {
    return { emoji: "🧩", title: withPrefix("Captcha aguardando solução manual."), tone: "warning" };
  }

  if (scope === "runtime" && status && runtimeStatusCopy[status]) {
    return runtimeStatusCopy[status];
  }

  const safeText = sanitizeFallbackText(text || rawMessage);
  return {
    emoji: scopeEmojis[scope] ?? levelEmojis.info,
    title: withPrefix(safeText || "Etapa concluída."),
    tone: levelTones.info
  };
}

export function friendlyActivityLog(entry: ActivityLogRecord): FriendlyLogLine {
  const status = typeof entry.details?.status === "string" ? entry.details.status : undefined;
  const translated = translateKnownMessage(entry.message, entry.scope, status);
  const tone =
    entry.level === "error" || translated.tone === "danger"
      ? "danger"
      : translated.tone === "info" && entry.level !== "info"
        ? levelTones[entry.level]
        : translated.tone;
  const when = friendlyWhen(entry.createdAt);

  return {
    emoji: translated.emoji,
    label: levelLabels[entry.level],
    meta: `${scopeLabels[entry.scope]} • ${when}`,
    title: translated.title,
    tone,
    when
  };
}

export function friendlyRunLog(entry: AutomationRunLogEntry): FriendlyLogLine {
  const translated = translateKnownMessage(entry.message, "automation");
  const tone =
    entry.level === "error" || translated.tone === "danger"
      ? "danger"
      : translated.tone === "info" && entry.level !== "info"
        ? levelTones[entry.level]
        : translated.tone;
  const when = friendlyWhen(entry.timestamp);

  return {
    emoji: translated.emoji || levelEmojis[entry.level],
    label: levelLabels[entry.level],
    meta: `Rotina • ${when}`,
    title: translated.title,
    tone,
    when
  };
}
