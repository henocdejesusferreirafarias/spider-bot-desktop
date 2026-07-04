import { StartStopButton } from "./StartStopButton.js";

export function OperationFooter({
  operationUrl,
  multipleLinksEnabled,
  selectedLinkCount,
  running,
  profileCount,
  activeSessionCount,
  proxyHealth,
  runningLabel,
  compact,
  onOperationUrlChange,
  onOpenLinks,
  onRun,
  onStop
}: {
  operationUrl: string;
  multipleLinksEnabled: boolean;
  selectedLinkCount: number;
  running?: boolean;
  profileCount: number;
  activeSessionCount: number;
  proxyHealth: string;
  runningLabel?: string;
  compact?: boolean;
  onOperationUrlChange: (value: string) => void;
  onOpenLinks: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const playDisabled = !running && (multipleLinksEnabled ? selectedLinkCount === 0 : !operationUrl.trim());

  return (
    <footer className={`operation-footer ${compact ? "compact" : ""}`}>
      {multipleLinksEnabled ? (
        <button className="operation-url multi-link" disabled={running} onClick={onOpenLinks} type="button">
          {selectedLinkCount > 0
            ? `${selectedLinkCount} link(s) de indicacao selecionado(s)`
            : "Clique Aqui Para Adicionar os Links de Indicacao"}
        </button>
      ) : (
        <label className="operation-url">
          <input
            disabled={running}
            onChange={(event) => onOperationUrlChange(event.target.value)}
            placeholder="https://site-alvo.com"
            value={operationUrl}
          />
        </label>
      )}

      <StartStopButton
        disabled={playDisabled}
        onRun={onRun}
        onStop={onStop}
        running={Boolean(running)}
      />

      <div className="footer-status-strip">
        <span>Contas: <strong>{profileCount}</strong></span>
        <span>Rodando: <strong>{activeSessionCount}</strong></span>
        <span>Proxies: <strong>{proxyHealth}</strong></span>
        {running ? <span className="footer-live">{runningLabel ?? "Criando..."}</span> : null}
      </div>
    </footer>
  );
}
