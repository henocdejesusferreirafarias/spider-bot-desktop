import { Icon } from "./Icon.js";

export function StartStopButton({
  running,
  disabled,
  compact,
  onRun,
  onStop
}: {
  running: boolean;
  disabled?: boolean;
  compact?: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  return (
    <button
      aria-label={running ? "Parar perfil" : "Iniciar perfil"}
      className={`footer-play-button ${running ? "is-stop" : ""} ${compact ? "compact" : ""}`}
      disabled={disabled}
      onClick={running ? onStop : onRun}
      type="button"
    >
      <Icon name={running ? "stop" : "play"} size={compact ? 12 : 14} />
    </button>
  );
}
