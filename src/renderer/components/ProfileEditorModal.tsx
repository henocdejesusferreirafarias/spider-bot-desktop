import { useEffect, useState } from "react";
import type { PersonaConfig, ProfileDraft, ProfileSummary, ProxyConfig } from "../../shared/contracts.js";
import { Modal } from "./Modal.js";

const defaultViewport = {
  width: 1366,
  height: 768,
  deviceScaleFactor: 1
};

const defaultGeolocation = {
  latitude: -23.5505,
  longitude: -46.6333,
  accuracy: 100
};

const defaultDraft: ProfileDraft = {
  name: "",
  notes: "",
  homeUrl: "https://example.com",
  tags: [],
  color: "#d6d6d6",
  proxyId: undefined,
  accountCpf: "",
  withdrawalPassword: "",
  persona: {
    name: "Persona padrao",
    userAgent: "",
    locale: "pt-BR",
    timezone: "America/Sao_Paulo",
    viewport: defaultViewport,
    geolocation: defaultGeolocation,
    allowNotifications: false,
    allowClipboard: true,
    webRtcMode: "relay-only",
    dnsMode: "proxy-first",
    leakProtection: "strict",
    headers: [],
    launchArgs: []
  }
};

function draftFromProfile(profile?: ProfileSummary): ProfileDraft {
  if (!profile) {
    return defaultDraft;
  }

  return {
    name: profile.name,
    notes: profile.notes,
    homeUrl: profile.homeUrl,
    tags: profile.tags,
    color: profile.color,
    proxyId: profile.proxy?.id,
    accountCpf: profile.account?.cpf ?? "",
    withdrawalPassword: profile.account?.withdrawalPassword ?? "",
    persona: {
      name: profile.persona.name,
      userAgent: profile.persona.userAgent,
      locale: profile.persona.locale,
      timezone: profile.persona.timezone,
      viewport: profile.persona.viewport,
      geolocation: profile.persona.geolocation,
      allowNotifications: profile.persona.allowNotifications,
      allowClipboard: profile.persona.allowClipboard,
      webRtcMode: profile.persona.webRtcMode,
      dnsMode: profile.persona.dnsMode,
      leakProtection: profile.persona.leakProtection,
      headers: profile.persona.headers,
      launchArgs: profile.persona.launchArgs
    }
  };
}

export function ProfileEditorModal({
  open,
  profile,
  proxies,
  busy,
  onClose,
  onSubmit
}: {
  open: boolean;
  profile?: ProfileSummary;
  proxies: ProxyConfig[];
  busy?: boolean;
  onClose: () => void;
  onSubmit: (draft: ProfileDraft) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<ProfileDraft>(defaultDraft);
  const [tagsText, setTagsText] = useState("");
  const [launchArgsText, setLaunchArgsText] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }

    const nextDraft = draftFromProfile(profile);
    setDraft(nextDraft);
    setTagsText(nextDraft.tags.join(", "));
    setLaunchArgsText(nextDraft.persona?.launchArgs?.join("\n") ?? "");
  }, [open, profile]);

  const persona: Partial<PersonaConfig> = {
    ...defaultDraft.persona,
    ...draft.persona,
    viewport: {
      ...defaultViewport,
      ...draft.persona?.viewport
    },
    geolocation: {
      ...defaultGeolocation,
      ...draft.persona?.geolocation
    }
  };

  const updatePersona = (nextPersona: Partial<PersonaConfig>) => {
    setDraft((current) => ({
      ...current,
      persona: {
        ...current.persona,
        ...nextPersona
      }
    }));
  };

  const submit = async () => {
    const name = draft.name.trim();
    if (!name) {
      return;
    }

    await onSubmit({
      ...draft,
      name,
      proxyId: draft.proxyId || undefined,
      accountCpf: draft.accountCpf?.replace(/\D+/g, "") || undefined,
      withdrawalPassword: draft.withdrawalPassword?.replace(/\D+/g, "") || undefined,
      tags: tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      persona: {
        ...draft.persona,
        launchArgs: launchArgsText
          .split("\n")
          .map((flag) => flag.trim())
          .filter(Boolean)
      }
    });
    onClose();
  };

  return (
    <Modal
      footer={
        <>
          <button className="ghost-button" onClick={onClose} type="button">
            Cancelar
          </button>
          <button className="primary-button" disabled={busy || !draft.name.trim()} onClick={() => void submit()} type="button">
            {profile ? "Salvar perfil" : "Criar perfil"}
          </button>
        </>
      }
      onClose={onClose}
      open={open}
      subtitle="Storage, proxy e persona ficam isolados por perfil."
      title={profile ? "Editar perfil" : "Novo perfil"}
    >
      <div className="modal-form-grid">
        <label>
          <span>Nome</span>
          <input onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} value={draft.name} />
        </label>
        <label>
          <span>Cor</span>
          <input
            onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))}
            type="color"
            value={draft.color}
          />
        </label>
        <label>
          <span>URL inicial</span>
          <input onChange={(event) => setDraft((current) => ({ ...current, homeUrl: event.target.value }))} value={draft.homeUrl} />
        </label>
        <label>
          <span>Proxy ativo</span>
          <select
            onChange={(event) => setDraft((current) => ({ ...current, proxyId: event.target.value || undefined }))}
            value={draft.proxyId ?? ""}
          >
            <option value="">Sem proxy</option>
            {proxies.map((proxy) => (
              <option key={proxy.id} value={proxy.id}>
                {proxy.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>CPF PIX</span>
          <input
            inputMode="numeric"
            maxLength={14}
            onChange={(event) => setDraft((current) => ({ ...current, accountCpf: event.target.value }))}
            placeholder="00000000000"
            value={draft.accountCpf ?? ""}
          />
        </label>
        <label>
          <span>Senha de saque</span>
          <input
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setDraft((current) => ({ ...current, withdrawalPassword: event.target.value }))}
            placeholder="6 digitos"
            type="password"
            value={draft.withdrawalPassword ?? ""}
          />
        </label>
        <label className="span-2">
          <span>Tags</span>
          <input onChange={(event) => setTagsText(event.target.value)} placeholder="ads, cliente-a, aquecimento" value={tagsText} />
        </label>
        <label className="span-2">
          <span>Notas</span>
          <textarea
            onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
            rows={2}
            value={draft.notes}
          />
        </label>
      </div>

      <div className="modal-subsection">
        <strong>Persona</strong>
        <span>Identidade configuravel, sem prometer evasao de controles externos.</span>
      </div>

      <div className="modal-form-grid">
        <label>
          <span>Nome da persona</span>
          <input onChange={(event) => updatePersona({ name: event.target.value })} value={persona.name ?? ""} />
        </label>
        <label>
          <span>User-agent</span>
          <input onChange={(event) => updatePersona({ userAgent: event.target.value })} value={persona.userAgent ?? ""} />
        </label>
        <label>
          <span>Locale</span>
          <input onChange={(event) => updatePersona({ locale: event.target.value })} value={persona.locale ?? ""} />
        </label>
        <label>
          <span>Timezone</span>
          <input onChange={(event) => updatePersona({ timezone: event.target.value })} value={persona.timezone ?? ""} />
        </label>
        <label>
          <span>Viewport W</span>
          <input
            min={240}
            onChange={(event) =>
              updatePersona({
                viewport: {
                  ...defaultViewport,
                  ...persona.viewport,
                  width: Number(event.target.value) || defaultViewport.width
                }
              })
            }
            type="number"
            value={persona.viewport?.width ?? defaultViewport.width}
          />
        </label>
        <label>
          <span>Viewport H</span>
          <input
            min={240}
            onChange={(event) =>
              updatePersona({
                viewport: {
                  ...defaultViewport,
                  ...persona.viewport,
                  height: Number(event.target.value) || defaultViewport.height
                }
              })
            }
            type="number"
            value={persona.viewport?.height ?? defaultViewport.height}
          />
        </label>
        <label>
          <span>WebRTC</span>
          <select
            onChange={(event) => updatePersona({ webRtcMode: event.target.value as PersonaConfig["webRtcMode"] })}
            value={persona.webRtcMode ?? "relay-only"}
          >
            <option value="default">default</option>
            <option value="relay-only">relay-only</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <label>
          <span>DNS</span>
          <select
            onChange={(event) => updatePersona({ dnsMode: event.target.value as PersonaConfig["dnsMode"] })}
            value={persona.dnsMode ?? "proxy-first"}
          >
            <option value="system">system</option>
            <option value="secure">secure</option>
            <option value="proxy-first">proxy-first</option>
          </select>
        </label>
        <label>
          <span>Latitude</span>
          <input
            onChange={(event) =>
              updatePersona({
                geolocation: {
                  ...defaultGeolocation,
                  ...persona.geolocation,
                  latitude: Number(event.target.value) || defaultGeolocation.latitude
                }
              })
            }
            type="number"
            value={persona.geolocation?.latitude ?? defaultGeolocation.latitude}
          />
        </label>
        <label>
          <span>Longitude</span>
          <input
            onChange={(event) =>
              updatePersona({
                geolocation: {
                  ...defaultGeolocation,
                  ...persona.geolocation,
                  longitude: Number(event.target.value) || defaultGeolocation.longitude
                }
              })
            }
            type="number"
            value={persona.geolocation?.longitude ?? defaultGeolocation.longitude}
          />
        </label>
        <label className="span-2">
          <span>Launch flags</span>
          <textarea onChange={(event) => setLaunchArgsText(event.target.value)} rows={3} value={launchArgsText} />
        </label>
      </div>
    </Modal>
  );
}
