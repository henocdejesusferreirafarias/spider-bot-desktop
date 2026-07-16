import { useState } from "react";
import type { ProfileSummary } from "../../shared/contracts.js";
import { formatRelativeTime, profileStatusTone } from "../lib/format.js";
import { maskPixPhoneKey } from "../lib/mask-sensitive-value.js";
import { Modal } from "./Modal.js";

function DetailItem({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value ?? "-"}</strong>
    </div>
  );
}

function SecretDetailItem({ label, value }: { label: string; value?: string }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="detail-item">
      <span>{label}</span>
      <div className="detail-secret">
        <strong>{visible && value ? value : value ? "••••••" : "-"}</strong>
        {value ? (
          <button
            className="detail-secret-toggle"
            onClick={() => setVisible((v) => !v)}
            title={visible ? "Ocultar" : "Mostrar"}
            type="button"
          >
            {visible ? "ocultar" : "mostrar"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function maskCpf(value?: string): string | undefined {
  const digits = value?.replace(/\D+/g, "") ?? "";
  if (digits.length !== 11) {
    return value;
  }

  return `${digits.slice(0, 3)}.***.***-${digits.slice(9)}`;
}

export function ProfileDetailModal({
  open,
  profile,
  onClose,
  onEdit
}: {
  open: boolean;
  profile?: ProfileSummary;
  onClose: () => void;
  onEdit: (profile: ProfileSummary) => void;
}) {
  if (!profile) {
    return null;
  }

  return (
    <Modal
      footer={
        <>
          <button className="ghost-button" onClick={onClose} type="button">
            Fechar
          </button>
          <button className="primary-button" onClick={() => onEdit(profile)} type="button">
            Editar perfil
          </button>
        </>
      }
      onClose={onClose}
      open={open}
      subtitle="Resumo operacional, storage isolado e persona ativa."
      title="Detalhes do perfil"
    >
      <div className="profile-detail-head">
        <span className="profile-color" style={{ background: profile.color }} />
        <div>
          <strong>{profile.name}</strong>
          <span>{profile.codeName}</span>
        </div>
        <span className={`status-pill ${profileStatusTone(profile.status)}`}>{profile.status}</span>
      </div>

      <div className="detail-grid">
        <DetailItem label="Storage" value={profile.storagePath} />
        <DetailItem label="URL inicial" value={profile.homeUrl} />
        <DetailItem label="Proxy" value={profile.proxy?.label ?? "Sem proxy"} />
        <DetailItem label="Automacoes" value={profile.automationCount} />
        <DetailItem label="Ultimo launch" value={formatRelativeTime(profile.lastLaunchedAt)} />
        <DetailItem label="Criado" value={formatRelativeTime(profile.createdAt)} />
      </div>

      <div className="modal-subsection">
        <strong>Conta vinculada</strong>
        <span>{profile.account?.platformId ?? "Aguardando geracao"}</span>
      </div>

      <div className="detail-grid">
        <DetailItem label="Usuario" value={profile.account?.username} />
        <DetailItem label="Senha" value={profile.account?.password} />
        <DetailItem
          label="Celular"
          value={
            profile.account?.phoneNumber
              ? `${profile.account.phoneCountryCode} ${profile.account.phoneNumber}`
              : "Telefone sera gerado no cadastro"
          }
        />
        <DetailItem label="Nome real" value={profile.account?.realName} />
        <DetailItem label="CPF" value={maskCpf(profile.account?.cpf)} />
        <SecretDetailItem label="Senha de saque" value={profile.account?.withdrawalPassword} />
        <DetailItem label="Chave PIX" value={maskPixPhoneKey(profile.account?.pixPhoneKey)} />
        <DetailItem label="PIX cadastrado" value={formatRelativeTime(profile.account?.pixKeyRegisteredAt)} />
        <DetailItem label="Status da conta" value={profile.account?.status} />
        <DetailItem label="Gerada em" value={formatRelativeTime(profile.account?.generatedAt)} />
      </div>

      {profile.account?.lastError ? (
        <div className="profile-notes">
          <strong>Ultimo erro da conta</strong>
          <p>{profile.account.lastError}</p>
        </div>
      ) : null}

      <div className="modal-subsection">
        <strong>Persona</strong>
        <span>Contrato v{profile.persona.version}</span>
      </div>

      <div className="detail-grid">
        <DetailItem label="Nome" value={profile.persona.name} />
        <DetailItem label="Locale" value={profile.persona.locale} />
        <DetailItem label="Timezone" value={profile.persona.timezone} />
        <DetailItem
          label="Viewport"
          value={`${profile.persona.viewport.width}x${profile.persona.viewport.height} @${profile.persona.viewport.deviceScaleFactor}`}
        />
        <DetailItem label="WebRTC" value={profile.persona.webRtcMode} />
        <DetailItem label="DNS" value={profile.persona.dnsMode} />
        <DetailItem label="Leak" value={profile.persona.leakProtection} />
        <DetailItem label="User-agent" value={profile.persona.userAgent || "Padrao do Chrome"} />
      </div>

      <div className="profile-notes">
        <strong>Tags e notas</strong>
        <p>{profile.tags.length ? profile.tags.join(", ") : "Sem tags."}</p>
        <p>{profile.notes || "Sem notas."}</p>
      </div>
    </Modal>
  );
}
