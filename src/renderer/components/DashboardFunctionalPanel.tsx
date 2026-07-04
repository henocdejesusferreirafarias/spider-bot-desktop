export function DashboardFunctionalPanel({
  multipleLinksEnabled,
  captchaSolverEnabled,
  useProxyOnFactory,
  domainBlockEnabled,
  selectedLinkCount,
  totalLinkCount,
  totalProxyCount,
  blockedDomainCount,
  onToggleCaptchaSolver,
  onToggleMultipleLinks,
  onToggleUseProxyOnFactory,
  onToggleDomainBlock,
  onManageLinks,
  onManageDomains
}: {
  multipleLinksEnabled: boolean;
  captchaSolverEnabled: boolean;
  useProxyOnFactory: boolean;
  domainBlockEnabled: boolean;
  selectedLinkCount: number;
  totalLinkCount: number;
  totalProxyCount: number;
  blockedDomainCount: number;
  onToggleCaptchaSolver: (enabled: boolean) => void;
  onToggleMultipleLinks: (enabled: boolean) => void;
  onToggleUseProxyOnFactory: (enabled: boolean) => void;
  onToggleDomainBlock: (enabled: boolean) => void;
  onManageLinks: () => void;
  onManageDomains: () => void;
}) {
  return (
    <div className="dashboard-functions clean">
      <label className="feature-toggle large">
        <input
          checked={multipleLinksEnabled}
          onChange={(event) => onToggleMultipleLinks(event.target.checked)}
          type="checkbox"
        />
        <div>
          <strong>Múltiplos Links</strong>
          <small>
            {multipleLinksEnabled
              ? `${selectedLinkCount}/${totalLinkCount} link(s) selecionado(s)`
              : "Usa apenas o link unico do rodapé"}
          </small>
        </div>
        <button
          className="primary-button feature-toggle-action"
          disabled={!multipleLinksEnabled}
          onClick={(e) => {
            e.preventDefault();
            onManageLinks();
          }}
          type="button"
        >
          Links
        </button>
      </label>

      <label className="feature-toggle large">
        <input
          checked={captchaSolverEnabled}
          onChange={(event) => onToggleCaptchaSolver(event.target.checked)}
          type="checkbox"
        />
        <div>
          <strong>Captcha Killer (BETA)</strong>
          <small>
            {captchaSolverEnabled
              ? "Captcha resolvido automaticamente"
              : "Captcha será resolvido manualmente"}
          </small>
        </div>
      </label>

      <label className="feature-toggle large">
        <input
          checked={useProxyOnFactory}
          onChange={(event) => onToggleUseProxyOnFactory(event.target.checked)}
          type="checkbox"
        />
        <div>
          <strong>Usar proxy</strong>
          <small>
            {totalProxyCount === 0
              ? "Nenhum proxy cadastrado. Cadastre um na aba Proxies"
              : useProxyOnFactory
                ? `Usando ${totalProxyCount} proxy(s)`
                : `Nenhum proxy usado`}
          </small>
        </div>
      </label>

      <label className="feature-toggle large">
        <input
          checked={domainBlockEnabled}
          onChange={(event) => onToggleDomainBlock(event.target.checked)}
          type="checkbox"
        />
        <div>
          <strong>Bloquear domínios</strong>
          <small>
            {domainBlockEnabled
              ? `Bloqueando ${blockedDomainCount} dominio(s)`
              : "Nenhum domínio bloqueado"}
          </small>
        </div>
        <button
          className="primary-button feature-toggle-action"
          disabled={!domainBlockEnabled}
          onClick={(e) => {
            e.preventDefault();
            onManageDomains();
          }}
          type="button"
        >
          Domínios
        </button>
      </label>
    </div>
  );
}
