import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityLogRecord,
  AutomationRunRecord,
  AutomationStatus,
  ProfileSummary
} from "../../shared/contracts.js";
import {
  friendlyActivityLog,
  friendlyRunLog,
  type FriendlyLogTone
} from "../lib/friendlyLogs.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

type Filter = "all" | "activity" | "runs" | "attention";

interface FriendlyLine {
  id: string;
  timestamp: number;
  tone: FriendlyLogTone;
  emoji: string;
  title: string;
  scope: string;
}

interface RunGroup {
  kind: "run";
  id: string;
  timestamp: number;
  profileId: string;
  profileName: string;
  status: AutomationStatus;
  durationMs?: number;
  lines: FriendlyLine[];
}

interface ActivityItem {
  kind: "activity";
  id: string;
  timestamp: number;
  profileId?: string;
  line: FriendlyLine;
}

type TimelineItem = RunGroup | ActivityItem;

const filterOptions: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Tudo" },
  { id: "activity", label: "Atividade" },
  { id: "runs", label: "Execuções" },
  { id: "attention", label: "Atenções" }
];

const statusCopy: Record<AutomationStatus, { label: string; tone: FriendlyLogTone }> = {
  draft: { label: "Rascunho", tone: "neutral" },
  ready: { label: "Pronta", tone: "info" },
  running: { label: "Em execução", tone: "info" },
  succeeded: { label: "Concluída", tone: "success" },
  failed: { label: "Falhou", tone: "danger" },
  cancelled: { label: "Interrompida", tone: "warning" }
};

const isAttention = (tone: FriendlyLogTone) => tone === "danger" || tone === "warning";

function extractPrefixName(message: string): string | undefined {
  const match = message.match(/^[^\w]*\[([^\]]+)]/);
  return match?.[1]?.trim() || undefined;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return "--:--:--";
  return new Date(timestamp).toLocaleTimeString("pt-BR", { hour12: false });
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleDateString("pt-BR");
}

function formatDuration(durationMs?: number): string | undefined {
  if (!durationMs || durationMs < 0) return undefined;
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function buildTimeline(
  activity: ActivityLogRecord[],
  runs: AutomationRunRecord[],
  profileNames: Map<string, string>
): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const entry of activity) {
    const friendly = friendlyActivityLog(entry);
    items.push({
      kind: "activity",
      id: `activity-${entry.id}`,
      timestamp: Date.parse(entry.createdAt) || 0,
      profileId: entry.scope === "profile" ? entry.scopeId : undefined,
      line: {
        id: `activity-${entry.id}`,
        timestamp: Date.parse(entry.createdAt) || 0,
        tone: friendly.tone,
        emoji: friendly.emoji,
        title: friendly.title,
        scope: entry.scope
      }
    });
  }

  for (const run of runs) {
    const lines: FriendlyLine[] = run.logs.map((logEntry, index) => {
      const friendly = friendlyRunLog(logEntry);
      return {
        id: `run-${run.id}-${index}`,
        timestamp: Date.parse(logEntry.timestamp) || 0,
        tone: friendly.tone,
        emoji: friendly.emoji,
        title: friendly.title,
        scope: "automation"
      };
    });

    const firstPrefix = run.logs.map((entry) => extractPrefixName(entry.message)).find(Boolean);
    const profileName =
      profileNames.get(run.profileId) ?? firstPrefix ?? "Perfil removido";
    const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : undefined;
    const startedAt = Date.parse(run.startedAt) || 0;

    items.push({
      kind: "run",
      id: `run-${run.id}`,
      timestamp: startedAt,
      profileId: run.profileId,
      profileName,
      status: run.status,
      durationMs: finishedAt && startedAt ? finishedAt - startedAt : undefined,
      lines
    });
  }

  items.sort((a, b) => a.timestamp - b.timestamp);
  return items;
}

function timelineToText(items: TimelineItem[]): string {
  const blocks: string[] = [];
  for (const item of items) {
    if (item.kind === "activity") {
      blocks.push(`[${formatTime(item.timestamp)}] ${item.line.scope} — ${item.line.title}`);
      continue;
    }
    const duration = formatDuration(item.durationMs);
    const header = `=== Rotina · ${item.profileName} · ${statusCopy[item.status].label}${
      duration ? ` · ${duration}` : ""
    } (${formatDate(item.timestamp)} ${formatTime(item.timestamp)}) ===`;
    const body = item.lines.map((line) => `  [${formatTime(line.timestamp)}] ${line.title}`);
    blocks.push([header, ...body].join("\n"));
  }
  return blocks.join("\n");
}

export function SystemLogsView({
  activity,
  runs,
  profiles,
  onClear
}: {
  activity: ActivityLogRecord[];
  runs: AutomationRunRecord[];
  profiles: ProfileSummary[];
  onClear: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [profileFilter, setProfileFilter] = useState<string>("all");
  const [autoFollow, setAutoFollow] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  const profileNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const profile of profiles) {
      map.set(profile.id, profile.name);
    }
    return map;
  }, [profiles]);

  const timeline = useMemo(
    () => buildTimeline(activity, runs, profileNames),
    [activity, runs, profileNames]
  );

  // Perfis que realmente aparecem nos logs (para popular o seletor sem ruído).
  const profileOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of timeline) {
      if (item.kind === "run") {
        seen.set(item.profileId, item.profileName);
      } else if (item.profileId) {
        seen.set(item.profileId, profileNames.get(item.profileId) ?? "Perfil");
      }
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1], "pt-BR"));
  }, [timeline, profileNames]);

  const counts = useMemo(() => {
    let activityCount = 0;
    let runCount = 0;
    let attentionCount = 0;
    for (const item of timeline) {
      if (item.kind === "activity") {
        activityCount += 1;
        if (isAttention(item.line.tone)) attentionCount += 1;
      } else {
        runCount += item.lines.length;
        attentionCount += item.lines.filter((line) => isAttention(line.tone)).length;
      }
    }
    return {
      all: activityCount + runCount,
      activity: activityCount,
      runs: runCount,
      attention: attentionCount
    };
  }, [timeline]);

  const visibleItems = useMemo(() => {
    const needle = search.trim().toLowerCase();

    const matchLine = (line: FriendlyLine) => {
      if (filter === "attention" && !isAttention(line.tone)) return false;
      if (needle && !line.title.toLowerCase().includes(needle)) return false;
      return true;
    };

    const result: TimelineItem[] = [];
    for (const item of timeline) {
      if (filter === "activity" && item.kind !== "activity") continue;
      if (filter === "runs" && item.kind !== "run") continue;

      if (item.kind === "activity") {
        if (profileFilter !== "all" && item.profileId !== profileFilter) continue;
        if (!matchLine(item.line)) continue;
        result.push(item);
        continue;
      }

      if (profileFilter !== "all" && item.profileId !== profileFilter) continue;
      const headerMatchesSearch =
        !needle ||
        item.profileName.toLowerCase().includes(needle) ||
        statusCopy[item.status].label.toLowerCase().includes(needle);
      const lines = item.lines.filter((line) => {
        if (filter === "attention" && !isAttention(line.tone)) return false;
        if (needle && !headerMatchesSearch && !line.title.toLowerCase().includes(needle)) return false;
        return true;
      });
      if (lines.length === 0 && !(headerMatchesSearch && filter !== "attention")) continue;
      result.push({ ...item, lines });
    }
    return result;
  }, [timeline, filter, search, profileFilter]);

  const handleClear = () => {
    if (timeline.length === 0) return;
    setClearConfirmOpen(true);
  };

  const confirmClear = () => {
    setClearConfirmOpen(false);
    onClear();
  };

  const toggleCollapsed = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(timelineToText(visibleItems));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const handleExport = () => {
    const blob = new Blob([timelineToText(visibleItems)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    anchor.href = url;
    anchor.download = `spider-logs-${stamp}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (autoFollow && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [visibleItems, autoFollow]);

  const handleScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    setAutoFollow(distanceFromBottom < 24);
  };

  const jumpToLatest = () => {
    setAutoFollow(true);
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  };

  const visibleEventCount = visibleItems.reduce(
    (total, item) => total + (item.kind === "run" ? item.lines.length : 1),
    0
  );

  return (
    <>
      <div className="system-logs-view">
        <header className="system-logs-toolbar">
          <div className="system-logs-filters" role="tablist">
            {filterOptions.map((option) => (
              <button
                aria-pressed={filter === option.id}
                className={`system-logs-filter ${filter === option.id ? "active" : ""}`}
                key={option.id}
                onClick={() => setFilter(option.id)}
                role="tab"
                type="button"
              >
                {option.label}
                <span className="system-logs-filter-count">{counts[option.id]}</span>
              </button>
            ))}
          </div>
          <div className="system-logs-meta">
            <span>{visibleEventCount} evento{visibleEventCount === 1 ? "" : "s"}</span>
            <button
              className="ghost-button"
              disabled={visibleItems.length === 0}
              onClick={handleCopy}
              type="button"
            >
              {copied ? "Copiado!" : "Copiar"}
            </button>
            <button
              className="ghost-button"
              disabled={visibleItems.length === 0}
              onClick={handleExport}
              type="button"
            >
              Exportar
            </button>
            <button
              className="ghost-button"
              disabled={timeline.length === 0}
              onClick={handleClear}
              type="button"
            >
              Limpar
            </button>
          </div>
        </header>

        <div className="system-logs-subbar">
          <input
            className="system-logs-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar nos logs…"
            type="search"
            value={search}
          />
          <select
            className="system-logs-profile-filter"
            onChange={(event) => setProfileFilter(event.target.value)}
            value={profileFilter}
          >
            <option value="all">Todos os perfis</option>
            {profileOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className="system-logs-stream" onScroll={handleScroll} ref={streamRef}>
          {visibleItems.length === 0 ? (
            <div className="system-logs-empty">
              <span className="system-logs-prompt">$</span>
              <span>{search || profileFilter !== "all" ? "Nenhum evento encontrado." : "Aguardando eventos…"}</span>
            </div>
          ) : (
            <ul className="system-logs-list">
              {visibleItems.map((item, index) => {
                const previous = visibleItems[index - 1];
                const newDay = !previous || formatDate(previous.timestamp) !== formatDate(item.timestamp);
                const divider = newDay ? (
                  <div className="system-logs-day-divider">
                    <span>{formatDate(item.timestamp) || "Hoje"}</span>
                  </div>
                ) : null;

                if (item.kind === "activity") {
                  return (
                    <li className="system-logs-day-group" key={item.id}>
                      {divider}
                      <div className={`system-log-line ${item.line.tone}`}>
                        <span className="system-log-time">{formatTime(item.timestamp)}</span>
                        <span className="system-log-icon" aria-hidden="true">
                          {item.line.emoji}
                        </span>
                        <span className="system-log-title">{item.line.title}</span>
                      </div>
                    </li>
                  );
                }

                const isCollapsed = collapsed.has(item.id);
                const duration = formatDuration(item.durationMs);
                const status = statusCopy[item.status];
                return (
                  <li className="system-logs-day-group" key={item.id}>
                    {divider}
                    <div className="system-log-run">
                      <button
                        aria-expanded={!isCollapsed}
                        className="system-log-run-header"
                        onClick={() => toggleCollapsed(item.id)}
                        type="button"
                      >
                        <span className="system-log-run-caret" aria-hidden="true">
                          {isCollapsed ? "▸" : "▾"}
                        </span>
                        <span className="system-log-time">{formatTime(item.timestamp)}</span>
                        <span className="system-log-run-profile">{item.profileName}</span>
                        <span className={`system-log-run-status ${status.tone}`}>{status.label}</span>
                        {duration ? <span className="system-log-run-duration">{duration}</span> : null}
                        <span className="system-log-run-count">{item.lines.length}</span>
                      </button>
                      {!isCollapsed ? (
                        <div className="system-log-run-body">
                          {item.lines.map((line) => (
                            <div className={`system-log-line ${line.tone}`} key={line.id}>
                              <span className="system-log-time">{formatTime(line.timestamp)}</span>
                              <span className="system-log-icon" aria-hidden="true">
                                {line.emoji}
                              </span>
                              <span className="system-log-title">{line.title}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {!autoFollow && visibleItems.length > 0 ? (
            <button className="system-logs-jump" onClick={jumpToLatest} type="button">
              ↓ Acompanhar
            </button>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        confirmLabel="Limpar logs"
        message="Apagar todos os logs de atividade e execucoes? Esta acao nao pode ser desfeita."
        onCancel={() => setClearConfirmOpen(false)}
        onConfirm={confirmClear}
        open={clearConfirmOpen}
        title="Limpar logs"
      />
    </>
  );
}
