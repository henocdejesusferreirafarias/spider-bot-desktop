import { Icon } from "./Icon.js";

export function BulkStartStopButton({
  running,
  disabled,
  onRun,
  onStop
}: {
  running: boolean;
  disabled?: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  return (
    <button
      aria-label={running ? "Parar perfis selecionados" : "Iniciar perfis selecionados"}
      className={`bulk-start-stop-button ${running ? "is-stop" : ""}`}
      disabled={disabled}
      onClick={running ? onStop : onRun}
      type="button"
    >
      <Icon name={running ? "stop" : "play"} size={12} />
      <span>{running ? "Parar" : "Iniciar"}</span>
    </button>
  );
}
