import { useState } from "react";
import type { NavigationMode } from "../../shared/contracts.js";
import { Icon } from "./Icon.js";

export function QuickLaunchPanel({
  navigationMode,
  busy,
  onLaunch,
}: {
  navigationMode: NavigationMode;
  busy?: boolean;
  onLaunch: (url: string, triggerAutomation: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [feedback, setFeedback] = useState("");

  const trimmed = url.trim();
  const canLaunch = Boolean(trimmed) && !busy;

  const launch = (triggerAutomation: boolean) => {
    if (!trimmed) {
      setFeedback("Informe o link antes de abrir.");
      return;
    }
    setFeedback("");
    onLaunch(trimmed, triggerAutomation);
    setUrl("");
  };

  return (
    <div className="quick-launch-panel">
      <div className="quick-launch-title">
        <Icon name="plus" size={12} />
        <span>Novo Perfil (com janelas abertas)</span>
      </div>
      <div className="quick-launch-row">
        <label className="quick-launch-url">
          <input
            disabled={busy}
            onChange={(event) => {
              setUrl(event.target.value);
              if (feedback) setFeedback("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") launch(false);
            }}
            placeholder="https://link-de-indicacao.com"
            value={url}
          />
        </label>
        <button
          className="ghost-button quick-launch-btn"
          disabled={!canLaunch}
          onClick={() => launch(false)}
          title="Abrir navegador no link (sem cadastro automático)"
          type="button"
        >
          <Icon name="play" size={13} />
          <span>Abrir</span>
        </button>
        <button
          className="primary-button quick-launch-btn"
          disabled={!canLaunch}
          onClick={() => launch(true)}
          title="Abrir navegador e iniciar cadastro automático"
          type="button"
        >
          <Icon name="rocket" size={13} />
          <span>Abrir + Cadastrar</span>
        </button>
      </div>
      {feedback ? (
        <span className="quick-launch-feedback">{feedback}</span>
      ) : null}
    </div>
  );
}
