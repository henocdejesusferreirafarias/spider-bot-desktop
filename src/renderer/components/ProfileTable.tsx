import type { ProfileSummary } from "../../shared/contracts.js";
import {
  formatTimeFirstDate,
  profileStatusLabel,
  profileStatusTone
} from "../lib/format.js";
import { resolveProfileWindowStatus } from "../lib/profileWindowStatus.js";
import { Icon } from "./Icon.js";

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Trunca no meio preservando o início e o fim (ex.: "vivianegome2s" -> "vivia...2s").
// Usado nas colunas estreitas (User, Senha, Saque) onde o início/fim
// carregam mais informacao do que o meio.
function truncateMiddle(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }
  const keep = maxLen - 1; // reserva 1 char para o "..."
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function ProfileTable({
  profiles,
  selectedProfileIds,
  openProfileIds,
  onToggleProfile,
  onEdit,
  onDelete
}: {
  profiles: ProfileSummary[];
  selectedProfileIds: Set<string>;
  openProfileIds: Set<string>;
  busyAction: string | null;
  onLaunch: (profileId: string) => void;
  onStop: (profileId: string) => void;
  onToggleProfile: (profileId: string) => void;
  onDetail: (profile: ProfileSummary) => void;
  onEdit: (profile: ProfileSummary) => void;
  onDelete: (profileId: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="profiles-table">
        <thead>
          <tr>
            {/* Selecao em massa fica na toolbar acima da tabela (botao "Selecionar todos"). */}
            <th className="profiles-table-checkbox-cell" aria-label="Selecao" />
            <th>Data/Hora</th>
            <th>Casa</th>
            <th>User</th>
            <th>Senha</th>
            <th>Saque</th>
            <th>Proxy</th>
            <th className="profiles-table-window-status-cell">Status</th>
            <th className="profiles-table-actions-cell">Edit</th>
            <th className="profiles-table-actions-cell">Del</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => {
            const checked = selectedProfileIds.has(profile.id);
            const account = profile.account;
            // Data/Hora = ultima abertura do perfil. Reflete a vida util real da
            // conta (o usuario quer saber "quando foi usada por ultimo", nao
            // quando foi gerada). Fallback em cascata:
            //   1) profile.lastLaunchedAt  -> o caso comum (foi aberta alguma vez)
            //   2) account.generatedAt     -> conta gerada mas nunca aberta
            //   3) profile.createdAt       -> perfil vazio, sem account
            const dataHoraSource =
              profile.lastLaunchedAt ?? account?.generatedAt ?? profile.createdAt;
            const windowStatus = resolveProfileWindowStatus(
              profile.status,
              openProfileIds.has(profile.id)
            );
            const windowStatusLabel = profileStatusLabel(windowStatus);
            return (
              <tr key={profile.id} className={checked ? "selected" : ""}>
                <td className="profiles-table-checkbox-cell">
                  <input
                    aria-label={`Selecionar ${profile.name}`}
                    checked={checked}
                    onChange={() => onToggleProfile(profile.id)}
                    onClick={(event) => event.stopPropagation()}
                    type="checkbox"
                  />
                </td>
                <td title={dataHoraSource}>
                  {formatTimeFirstDate(dataHoraSource)}
                </td>
                <td>
                  <span className="profile-platform-url" title={profile.homeUrl}>
                    {extractDomain(profile.homeUrl)}
                  </span>
                </td>
                <td className="selectable-text" title={account?.username}>
                  {account ? truncateMiddle(account.username, 14) : "—"}
                </td>
                <td className="selectable-text" title={account?.password}>
                  {account ? truncateMiddle(account.password, 14) : "—"}
                </td>
                <td className="selectable-text" title={account?.withdrawalPassword}>
                  {account?.withdrawalPassword ? truncateMiddle(account.withdrawalPassword, 14) : "—"}
                </td>
                <td>{profile.proxy?.label ?? "Sem proxy"}</td>
                <td className="profiles-table-window-status-cell">
                  <span
                    aria-label={`Status da janela: ${windowStatusLabel}`}
                    className={`status-pill window-status-pill ${profileStatusTone(windowStatus)}`}
                    data-status={windowStatus}
                    title={`Janela ${windowStatusLabel.toLocaleLowerCase("pt-BR")}`}
                  >
                    <span aria-hidden="true" className="window-status-dot" />
                    {windowStatusLabel}
                  </span>
                </td>
                <td className="profiles-table-actions-cell">
                  <button
                    aria-label={`Editar ${profile.name}`}
                    className="row-inline-button"
                    onClick={() => onEdit(profile)}
                    type="button"
                  >
                    Edit
                  </button>
                </td>
                <td className="profiles-table-actions-cell">
                  <button
                    aria-label={`Excluir ${profile.name}`}
                    className="row-inline-button danger"
                    onClick={() => onDelete(profile.id)}
                    type="button"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
