import type { ReactNode } from "react";

export function SectionCard({
  title,
  subtitle,
  actions,
  chrome = "default",
  children
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  chrome?: "default" | "bare";
  children: ReactNode;
}) {
  return (
    <section className={`section-card ${chrome === "bare" ? "bare" : ""}`}>
      {chrome === "default" ? (
        <div className="section-card-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {actions ? <div className="section-card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
