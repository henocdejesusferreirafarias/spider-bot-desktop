import type { AutomationRecord, AutomationRunRecord, ProfileSummary } from "../../shared/contracts.js";
import { formatRelativeTime } from "../lib/format.js";
import { Icon } from "./Icon.js";

export function AutomationManager({
  automations,
  profiles,
  runs,
  busyAction,
  onRun,
  onCancel
}: {
  automations: AutomationRecord[];
  profiles: ProfileSummary[];
  runs: AutomationRunRecord[];
  busyAction?: string;
  onRun: (automationId: string) => Promise<unknown>;
  onCancel: (runId: string) => Promise<unknown>;
}) {
  return (
    <div className="manager-stack">
      <div className="manager-toolbar">
        <span>{automations.length} rotina(s) fixas do sistema</span>
      </div>

      <div className="manager-list compact">
        {automations.map((automation) => {
          const profile = profiles.find((entry) => entry.id === automation.profileId);
          const running = runs.find((run) => run.automationId === automation.id && run.status === "running");

          return (
            <article className="manager-card" key={automation.id}>
              <div className="manager-row-title">
                <div>
                  <strong>{automation.name}</strong>
                  <span>{profile?.name ?? "Perfil desconhecido"}</span>
                </div>
                <span className={`status-pill ${automation.status === "succeeded" ? "success" : automation.status === "failed" ? "danger" : "neutral"}`}>
                  {running ? "running" : automation.status}
                </span>
              </div>
              <p>{automation.description || automation.startUrl}</p>
              <div className="manager-card-meta">
                <span>{automation.startUrl}</span>
                <span>Conta: {profile?.account?.username ?? "gerando..."}</span>
                <span>Ultima execucao: {formatRelativeTime(automation.lastRunAt)}</span>
              </div>
              <div className="manager-card-actions">
                {running ? (
                  <button className="ghost-button" onClick={() => void onCancel(running.id)} type="button">
                    Cancelar
                  </button>
                ) : (
                  <button
                    className="ghost-button"
                    disabled={busyAction === `automation:run:${automation.id}`}
                    onClick={() => void onRun(automation.id)}
                    type="button"
                  >
                    {busyAction === `automation:run:${automation.id}` ? "Rodando..." : "Executar"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {!automations.length ? (
        <div className="empty-state inline">
          <Icon name="automations" size={18} />
          <p>Nenhuma rotina fixa disponivel ainda. Crie um perfil para provisionar a automacao de cadastro.</p>
        </div>
      ) : null}
    </div>
  );
}
