import { useEffect, useRef, useState, type FormEvent } from "react";
import type { InstanceRecord } from "../../shared/contracts.js";
import { useInstanceManager } from "../hooks/useInstanceManager.js";
import {
  formatDateTime,
  licenseStatusLabel,
  licenseStatusTone,
  planTypeLabel
} from "../lib/format.js";
import { AlertDialog } from "./AlertDialog.js";
import { Icon } from "./Icon.js";
import { Pill } from "./Pill.js";

type InstanceManagerState = ReturnType<typeof useInstanceManager>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatVersion(version: string | undefined): string {
  return version ? `v${version}` : "v0.0.0";
}

function formatMaybeDate(value: string | undefined): string {
  return value ? formatDateTime(value) : "Nunca";
}

function ManagerTitlebar({ manager }: { manager: InstanceManagerState }) {
  const [licensePopoverOpen, setLicensePopoverOpen] = useState(false);
  const [updatePopoverOpen, setUpdatePopoverOpen] = useState(false);
  const licenseAnchorRef = useRef<HTMLDivElement>(null);
  const updateAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!licensePopoverOpen && !updatePopoverOpen) return;

    const handlePointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      const insideLicense = licenseAnchorRef.current?.contains(target) ?? false;
      const insideUpdate = updateAnchorRef.current?.contains(target) ?? false;
      if (!insideLicense) setLicensePopoverOpen(false);
      if (!insideUpdate) setUpdatePopoverOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLicensePopoverOpen(false);
        setUpdatePopoverOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [licensePopoverOpen, updatePopoverOpen]);

  return (
    <header className="manager-titlebar">
      <div className="titlebar-brand">
        <img src="./07-china.png" alt="" style={{width:22,height:22,borderRadius:4,flexShrink:0}} />
        <strong>Spider BOT</strong>
        <span>Gerenciador</span>
        <span>{formatVersion(manager.appInfo.version)}</span>
      </div>
      <div className="manager-titlebar-actions">
        <div className="topbar-action-wrap" ref={updateAnchorRef}>
          <button
            aria-haspopup="dialog"
            aria-label="Atualizacoes"
            aria-pressed={updatePopoverOpen ? true : undefined}
            className={`titlebar-icon-button update-status-button phase-${manager.updateStatus.phase}${
              updatePopoverOpen ? " active" : ""
            }`}
            onClick={() => {
              setUpdatePopoverOpen((open) => !open);
              setLicensePopoverOpen(false);
            }}
            title={manager.updateStatus.message}
            type="button"
          >
            <Icon name="refresh" size={15} />
          </button>
          {updatePopoverOpen ? <ManagerUpdatePopover manager={manager} /> : null}
        </div>

        <div className="topbar-action-wrap" ref={licenseAnchorRef}>
          <button
            aria-haspopup="dialog"
            aria-label="Licenca"
            aria-pressed={licensePopoverOpen ? true : undefined}
            className={`titlebar-icon-button manager-license-button status-${manager.licenseState.status}${
              licensePopoverOpen ? " active" : ""
            }`}
            onClick={() => {
              setLicensePopoverOpen((open) => !open);
              setUpdatePopoverOpen(false);
            }}
            title={licenseStatusLabel(manager.licenseState.status)}
            type="button"
          >
            <Icon name="shield" size={15} />
          </button>
          {licensePopoverOpen ? <ManagerLicensePopover manager={manager} /> : null}
        </div>
      </div>
      <div className="window-actions">
        <button
          aria-label="Minimizar"
          className="titlebar-icon-button"
          type="button"
          onClick={() => void window.predator.app.minimize()}
        >
          <Icon name="minus" size={15} />
        </button>
        <button
          aria-label="Fechar"
          className="titlebar-icon-button"
          type="button"
          onClick={() => void window.predator.app.close()}
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </header>
  );
}

function ManagerLicensePopover({ manager }: { manager: InstanceManagerState }) {
  const [email, setEmail] = useState(manager.licenseState.email ?? "");
  const [licenseKey, setLicenseKey] = useState("");
  const [feedback, setFeedback] = useState<string>();
  const { licenseState } = manager;
  const activating = manager.busyAction === "license:activate";

  const runAction = async (operation: () => Promise<unknown>) => {
    setFeedback(undefined);
    try {
      await operation();
    } catch (error) {
      setFeedback(describeError(error));
    }
  };

  const activate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAction(async () => {
      await manager.activateLicense({
        email: email.trim(),
        licenseKey: licenseKey.trim()
      });
      setLicenseKey("");
    });
  };

  return (
    <div className="license-popover manager-popover" role="dialog" aria-label="Licenca">
      <header className="license-popover-head">
        <div className="license-popover-title">
          <h2>Licenca</h2>
          <Pill tone={licenseStatusTone(licenseState.status)}>
            {licenseStatusLabel(licenseState.status)}
          </Pill>
        </div>
      </header>

      <dl className="license-popover-facts">
        <div>
          <dt>Versao</dt>
          <dd>{formatVersion(manager.appInfo.version)}</dd>
        </div>
        <div>
          <dt>E-mail</dt>
          <dd>{licenseState.email ?? "-"}</dd>
        </div>
        <div>
          <dt>Plano</dt>
          <dd>{planTypeLabel(licenseState.planType)}</dd>
        </div>
        <div>
          <dt>Expira em</dt>
          <dd>{licenseState.expiresAt ? formatDateTime(licenseState.expiresAt) : "Sem expirar"}</dd>
        </div>
      </dl>

      {!licenseState.operational && licenseState.status !== "update_required" ? (
        <form className="manager-popover-form" onSubmit={activate}>
          <label>
            <span>E-mail da licenca</span>
            <input
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="cliente@email.com"
            />
          </label>
          <label>
            <span>Chave de ativacao</span>
            <input
              autoComplete="off"
              value={licenseKey}
              onChange={(event) => setLicenseKey(event.target.value)}
              placeholder="SPIDER-..."
            />
          </label>
          <button
            className="primary-button stretch"
            type="submit"
            disabled={activating || !email.trim() || !licenseKey.trim()}
          >
            {activating ? "Ativando..." : "Ativar licenca"}
          </button>
        </form>
      ) : null}

      {feedback ? <p className="license-feedback">{feedback}</p> : null}
    </div>
  );
}

function ManagerUpdatePopover({ manager }: { manager: InstanceManagerState }) {
  const [feedback, setFeedback] = useState<string>();
  const { updateStatus, licenseState } = manager;
  const updateReady = updateStatus.phase === "downloaded";
  const updateBusy =
    manager.busyAction === "updates:check" ||
    manager.busyAction === "updates:install" ||
    updateStatus.phase === "checking" ||
    updateStatus.phase === "downloading";

  const runAction = async (operation: () => Promise<unknown>) => {
    setFeedback(undefined);
    try {
      await operation();
    } catch (error) {
      setFeedback(describeError(error));
    }
  };

  return (
    <div className="license-popover manager-popover" role="dialog" aria-label="Atualizacoes">
      <header className="license-popover-head">
        <div className="license-popover-title">
          <h2>Atualizacao</h2>
          <Pill tone={updateReady ? "success" : licenseState.status === "update_required" ? "warning" : "neutral"}>
            {updateStatus.phase}
          </Pill>
        </div>
      </header>

      <dl className="license-popover-facts">
        <div>
          <dt>Instalada</dt>
          <dd>{formatVersion(manager.appInfo.version)}</dd>
        </div>
        <div>
          <dt>Disponivel</dt>
          <dd>
            {updateStatus.availableVersion || updateStatus.downloadedVersion
              ? formatVersion(updateStatus.availableVersion ?? updateStatus.downloadedVersion)
              : "-"}
          </dd>
        </div>
        <div>
          <dt>Minima exigida</dt>
          <dd>{licenseState.update?.minimumVersion ? formatVersion(licenseState.update.minimumVersion) : "-"}</dd>
        </div>
      </dl>

      <p className="manager-popover-message">{updateStatus.message}</p>

      <div className="manager-popover-actions">
        <button
          className="primary-button"
          type="button"
          disabled={updateBusy}
          onClick={() =>
            void runAction(() => (updateReady ? manager.installUpdate() : manager.checkForUpdates()))
          }
        >
          <Icon name={updateReady ? "refresh" : "search"} size={14} />
          {updateReady ? "Instalar" : "Verificar"}
        </button>
      </div>

      {feedback ? <p className="license-feedback">{feedback}</p> : null}
    </div>
  );
}

function LicenseFacts({ manager }: { manager: InstanceManagerState }) {
  const { appInfo, licenseState } = manager;
  const minimumVersion = licenseState.update?.minimumVersion;

  return (
    <dl className="manager-license-facts">
      <div>
        <dt>Status</dt>
        <dd>{licenseStatusLabel(licenseState.status)}</dd>
      </div>
      <div>
        <dt>Versao instalada</dt>
        <dd>{formatVersion(appInfo.version)}</dd>
      </div>
      <div>
        <dt>Plano</dt>
        <dd>{planTypeLabel(licenseState.planType)}</dd>
      </div>
      <div>
        <dt>Expira em</dt>
        <dd>{licenseState.expiresAt ? formatDateTime(licenseState.expiresAt) : "Sem expirar"}</dd>
      </div>
      {licenseState.email ? (
        <div>
          <dt>E-mail</dt>
          <dd>{licenseState.email}</dd>
        </div>
      ) : null}
      <div>
        <dt>Ultima validacao</dt>
        <dd>{formatMaybeDate(licenseState.lastValidatedAt)}</dd>
      </div>
      {minimumVersion ? (
        <div>
          <dt>Versao minima</dt>
          <dd>{formatVersion(minimumVersion)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function ActivationGate({ manager }: { manager: InstanceManagerState }) {
  const [email, setEmail] = useState(manager.licenseState.email ?? "");
  const [licenseKey, setLicenseKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const { licenseState, updateStatus } = manager;
  const updateRequired = licenseState.status === "update_required";
  const updateReady = updateStatus.phase === "downloaded";
  const updateBusy =
    manager.busyAction === "updates:check" ||
    manager.busyAction === "updates:install" ||
    updateStatus.phase === "checking" ||
    updateStatus.phase === "downloading";
  const activating = manager.busyAction === "license:activate";

  const handleActivation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFeedback(undefined);

    try {
      await manager.activateLicense({
        email: email.trim(),
        licenseKey: licenseKey.trim()
      });
      setLicenseKey("");
    } catch (error) {
      setFeedback(describeError(error));
    }
  };

  const runAction = async (operation: () => Promise<unknown>) => {
    setFeedback(undefined);
    try {
      await operation();
    } catch (error) {
      setFeedback(describeError(error));
    }
  };

  return (
    <main className="instance-activation-main">
      <section className={`instance-activation-panel${updateRequired ? " update-required" : ""}`}>
        <div className="instance-activation-head">
          <div className="manager-license-icon" aria-hidden="true">
            <Icon name={updateRequired ? "refresh" : "shield"} size={22} />
          </div>
          <div className="instance-activation-copy">
            <div className="manager-license-title">
              <h1>{updateRequired ? "Atualizacao obrigatoria" : "Ativar Spider BOT"}</h1>
              <Pill tone={licenseStatusTone(licenseState.status)}>
                {licenseStatusLabel(licenseState.status)}
              </Pill>
            </div>
            <p>
              {updateRequired
                ? licenseState.message || "Atualize o Spider BOT para continuar usando o sistema."
                : licenseState.message || "Insira o e-mail e a chave de licenca recebidos na compra."}
            </p>
          </div>
        </div>

        <LicenseFacts manager={manager} />

        {updateRequired ? (
          <div className="instance-activation-update">
            <div>
              <strong>Uso bloqueado ate atualizar</strong>
              <span>
                Versao atual {formatVersion(manager.appInfo.version)}
                {licenseState.update?.minimumVersion
                  ? `; minimo exigido ${formatVersion(licenseState.update.minimumVersion)}`
                  : ""}.
              </span>
              <small>{updateStatus.message}</small>
            </div>
            <div className="instance-activation-update-actions">
              <button
                className="primary-button"
                type="button"
                disabled={updateBusy}
                onClick={() =>
                  void runAction(() =>
                    updateReady ? manager.installUpdate() : manager.checkForUpdates()
                  )
                }
              >
                <Icon name={updateReady ? "refresh" : "search"} size={14} />
                {updateReady ? "Instalar" : "Verificar update"}
              </button>
            </div>
          </div>
        ) : (
          <form className="instance-activation-form" onSubmit={handleActivation} noValidate>
            <label>
              <span>E-mail da licenca</span>
              <input
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="cliente@email.com"
                required
              />
            </label>
            <label className="activation-key-label">
              <span>Chave de ativacao</span>
              <div className="activation-key-input-wrap">
                <input
                  autoComplete="off"
                  type={showKey ? "text" : "password"}
                  value={licenseKey}
                  onChange={(event) => setLicenseKey(event.target.value)}
                  placeholder="SPIDER-..."
                  required
                />
                <button
                  type="button"
                  className="activation-key-toggle"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Ocultar chave" : "Mostrar chave"}
                  title={showKey ? "Ocultar chave" : "Mostrar chave"}
                >
                  <Icon name={showKey ? "hide" : "show"} size={14} />
                </button>
              </div>
            </label>
            <button
              className="primary-button activation-submit"
              type="submit"
              disabled={activating || !email.trim() || !licenseKey.trim()}
            >
              {activating ? (
                <>
                  <span className="activation-spinner" />
                  Ativando...
                </>
              ) : (
                <>
                  <Icon name="shield" size={15} />
                  Ativar licenca
                </>
              )}
            </button>
          </form>
        )}

        {feedback ? (
          <div className="activation-feedback" role="alert">
            <Icon name="alert" size={14} />
            <span>{feedback}</span>
          </div>
        ) : null}

        <div className="instance-activation-actions">
          <button
            className="ghost-button"
            type="button"
            disabled={updateBusy}
            onClick={() =>
              void runAction(() =>
                updateReady ? manager.installUpdate() : manager.checkForUpdates()
              )
            }
          >
            <Icon name={updateReady ? "refresh" : "search"} size={14} />
            {updateBusy
              ? "Verificando..."
              : updateReady
                ? "Instalar atualizacao"
                : "Verificar atualizacao"}
          </button>
          {updateStatus.message ? (
            <small className="instance-activation-update-hint">{updateStatus.message}</small>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function InstanceCard({
  instance,
  manager
}: {
  instance: InstanceRecord;
  manager: InstanceManagerState;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [errorDialog, setErrorDialog] = useState<string>();
  const [nameDraft, setNameDraft] = useState(instance.name);
  const running = instance.status === "running";
  const opening = manager.busyAction === `instances:open:${instance.id}`;
  const stopping = manager.busyAction === `instances:stop:${instance.id}`;
  const deleting = manager.busyAction === `instances:delete:${instance.id}`;
  const savingRename = manager.busyAction === `instances:rename:${instance.id}`;

  const runAction = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      setErrorDialog(describeError(error));
    }
  };

  const startRename = () => {
    setNameDraft(instance.name);
    setEditingName(true);
  };

  const submitRename = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === instance.name) {
      setEditingName(false);
      return;
    }
    setEditingName(false);
    void runAction(() => manager.renameInstance(instance.id, trimmed));
  };

  const cancelRename = () => {
    setEditingName(false);
  };

  const handleRenameKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") submitRename();
    if (event.key === "Escape") cancelRename();
  };

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    void runAction(() => manager.deleteInstance(instance.id));
  };

  const cancelDelete = () => {
    setConfirmDelete(false);
  };

  return (
    <article className="instance-card">
      <div className="instance-card-header">
        <div>
          <span>{running ? "Aberta" : "Parada"}</span>
          {editingName ? (
            <div className="instance-rename-inline">
              <input
                className="instance-rename-input"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={handleRenameKey}
                autoFocus
              />
              <button className="ghost-button" type="button" disabled={savingRename} onClick={submitRename}>
                {savingRename ? "..." : "OK"}
              </button>
              <button className="ghost-button" type="button" onClick={cancelRename}>
                ✕
              </button>
            </div>
          ) : (
            <strong title={instance.name}>{instance.name}</strong>
          )}
        </div>
        <Pill tone={running ? "success" : "neutral"}>{running ? "Rodando" : "Parada"}</Pill>
      </div>

      <dl className="instance-stats">
        <div>
          <dt>Perfis</dt>
          <dd>{instance.profileCount}</dd>
        </div>
        <div>
          <dt>Proxies</dt>
          <dd>{instance.proxyCount}</dd>
        </div>
        <div>
          <dt>Pix</dt>
          <dd>{instance.pixPhoneKeyCount}</dd>
        </div>
      </dl>

      <div className="instance-meta">
        <span>Criada em {formatDateTime(instance.createdAt)}</span>
        <span>Ultimo acesso {formatMaybeDate(instance.lastOpenedAt)}</span>
      </div>

      <div className="instance-card-actions">
        {confirmDelete ? (
          <div className="instance-card-confirm">
            <span className="instance-card-confirm-label">Excluir "{instance.name}"?</span>
            <div className="instance-card-confirm-actions">
              <button
                className="danger-button"
                type="button"
                disabled={deleting}
                onClick={handleDelete}
              >
                {deleting ? "Excluindo..." : "Sim, excluir"}
              </button>
              <button
                className="ghost-button"
                type="button"
                disabled={deleting}
                onClick={cancelDelete}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              className={running ? "danger-button" : "primary-button"}
              type="button"
              disabled={opening || stopping}
              onClick={() =>
                void runAction(() =>
                  running ? manager.stopInstance(instance.id) : manager.openInstance(instance.id)
                )
              }
            >
              <Icon name={running ? "stop" : "play"} size={14} />
              {running ? (stopping ? "Parando..." : "Parar") : opening ? "Abrindo..." : "Iniciar"}
            </button>
            <button className="ghost-button" type="button" disabled={savingRename || editingName} onClick={startRename}>
              {savingRename ? "Renomeando..." : "Renomear"}
            </button>
            <button className="danger-button" type="button" disabled={deleting} onClick={handleDelete}>
              {deleting ? "Excluindo..." : "Excluir"}
            </button>
          </>
        )}
      </div>

      <AlertDialog
        message={errorDialog ?? ""}
        onClose={() => setErrorDialog(undefined)}
        open={Boolean(errorDialog)}
        title="Nao foi possivel concluir a acao"
      />
    </article>
  );
}

function InstanceWorkspace({ manager }: { manager: InstanceManagerState }) {
  const [name, setName] = useState("");
  const [errorDialog, setErrorDialog] = useState<string>();
  const creating = manager.busyAction === "instances:create";

  const createInstance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await manager.createInstance(name.trim() || undefined);
      setName("");
    } catch (error) {
      setErrorDialog(describeError(error));
    }
  };

  return (
    <main className="instance-manager-main">
      <section className="instance-manager-header">
        <div>
          <h1>Instancias</h1>
          <p>Abra ambientes isolados com banco, perfis, Pix, proxies e automacoes separados.</p>
        </div>
        <form className="instance-create-form" onSubmit={createInstance}>
          <label>
            <span>Nome da nova instancia</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: Operacao principal"
            />
          </label>
          <button className="primary-button" type="submit" disabled={creating}>
            <Icon name="plus" size={14} />
            {creating ? "Criando..." : "Criar"}
          </button>
        </form>
      </section>

      {manager.instances.length ? (
        <section className="instance-grid">
          {manager.instances.map((instance) => (
            <InstanceCard key={instance.id} instance={instance} manager={manager} />
          ))}
        </section>
      ) : (
        <section className="instance-empty">
          <Icon name="profiles" size={24} />
          <span>Nenhuma instancia criada ainda.</span>
        </section>
      )}

      <AlertDialog
        message={errorDialog ?? ""}
        onClose={() => setErrorDialog(undefined)}
        open={Boolean(errorDialog)}
        title="Nao foi possivel criar a instancia"
      />
    </main>
  );
}

export function InstanceManager() {
  const manager = useInstanceManager();

  return (
    <div className="instance-manager-shell">
      <ManagerTitlebar manager={manager} />
      {manager.licenseState.operational ? (
        <InstanceWorkspace manager={manager} />
      ) : (
        <ActivationGate manager={manager} />
      )}
    </div>
  );
}
