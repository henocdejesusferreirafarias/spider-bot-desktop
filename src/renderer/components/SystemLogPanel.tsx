import type { ActivityLogRecord } from "../../shared/contracts.js";
import { friendlyActivityLog, type FriendlyLogTone } from "../lib/friendlyLogs.js";

function toneClass(tone: FriendlyLogTone) {
  switch (tone) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "danger":
      return "danger";
    case "info":
      return "info";
    default:
      return "neutral";
  }
}

const PANEL_LIMIT = 8;

export function SystemLogPanel({
  activity,
  onOpenActivity,
  onClear
}: {
  activity: ActivityLogRecord[];
  onOpenActivity: () => void;
  onClear: () => void;
}) {
  const attentionCount = activity.filter(
    (entry) => entry.level === "error" || entry.level === "warning"
  ).length;
  const recent = activity.slice(0, PANEL_LIMIT);

  return (
    <aside className="system-log-panel">
      <div className="system-log-header">
        <div>
          <h3>
            Logs
            {attentionCount > 0 ? (
              <span className="system-log-attention-badge">{attentionCount}</span>
            ) : null}
          </h3>
          <p>Eventos da operação</p>
        </div>
        <div className="system-log-actions">
          <button className="ghost-button" onClick={onOpenActivity} type="button">
            Abrir
          </button>
          <button className="danger-button" onClick={onClear} type="button">
            Limpar
          </button>
        </div>
      </div>

      <div className="system-log-frame">
        <div className="system-log-list">
          {recent.length ? (
            recent.map((entry) => {
              const line = friendlyActivityLog(entry);

              return (
                <article className="system-log-entry" key={entry.id}>
                  <span className={`system-log-emoji ${toneClass(line.tone)}`}>{line.emoji}</span>
                  <div className="system-log-copy">
                    <strong>{line.title}</strong>
                    <span>{line.meta}</span>
                  </div>
                </article>
              );
            })
          ) : (
            <div className="system-log-empty">
              <strong>🟢 Tudo quieto por enquanto.</strong>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
