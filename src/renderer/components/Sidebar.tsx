import type { AppSection } from "../../shared/contracts.js";
import { Icon } from "./Icon.js";

const sections: Array<{ id: AppSection; label: string; icon: Parameters<typeof Icon>[0]["name"] }> = [
  { id: "dashboard", label: "Inicio", icon: "dashboard" },
  { id: "profiles", label: "Contas", icon: "profiles" },
  { id: "proxies", label: "Proxies", icon: "proxies" },
  { id: "pix-keys", label: "Chaves PIX", icon: "pixKeys" },
  { id: "screens", label: "Telas", icon: "screens" },
  { id: "activity", label: "Log", icon: "activity" }
];

export function Sidebar({
  activeSection,
  onSectionChange,
  activeSessions,
  totalProfiles
}: {
  activeSection: AppSection;
  onSectionChange: (section: AppSection) => void;
  activeSessions: number;
  totalProfiles: number;
}) {
  return (
    <aside className="app-header" aria-label="Navegacao principal">
      <nav className="nav-list" aria-label="Secoes principais">
        {sections.map((section) => (
          <button
            key={section.id}
            aria-label={section.label}
            className={`nav-item ${activeSection === section.id ? "active" : ""}`}
            data-label={section.label}
            onClick={() => onSectionChange(section.id)}
            title={section.label}
            type="button"
          >
            <Icon name={section.icon} size={18} />
            <span>{section.label}</span>
          </button>
        ))}
      </nav>

      <div className="header-right">
        <div className="header-meta">
          <div className="sidebar-pill">
            <span>{activeSessions}</span>
            <small>sessoes</small>
          </div>
          <div className="sidebar-pill muted">
            <span>{totalProfiles}</span>
            <small>perfis</small>
          </div>
        </div>
      </div>
    </aside>
  );
}
