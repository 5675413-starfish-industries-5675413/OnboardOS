import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export type SectionLink = { id: string; label: string };

export function Brand() {
  return <span className="brand"><span className="brand-mark" aria-hidden="true">o</span>onboard<span className="brand-os">OS</span></span>;
}

/** Presentation only. Links expose existing screens; the API still authorizes every action. */
export function WorkspaceShell({ children, area, organization, username, sections = [], onLeave }: {
  children: ReactNode;
  area: string;
  organization?: string;
  username?: string;
  sections?: SectionLink[];
  onLeave?: () => boolean;
}) {
  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="workspace-sidebar">
        <Link to="/app" className="brand-link" aria-label="OnboardOS dashboard" onClick={(e) => { if (onLeave && !onLeave()) e.preventDefault(); }}><Brand /></Link>
        <div className="workspace-context"><span className="workspace-avatar" aria-hidden="true">{(organization ?? "W").slice(0, 1).toUpperCase()}</span><div><strong>{organization ?? "Training workspace"}</strong><span>Workplace simulation</span></div></div>
        <nav aria-label="Workspace navigation">
          <Link className="nav-link" to="/app" aria-current={area === "Overview" ? "page" : undefined} onClick={(e) => { if (onLeave && !onLeave()) e.preventDefault(); }}><span aria-hidden="true">⌂</span>Overview</Link>
          {area !== "Overview" && <span className="nav-link nav-current"><span aria-hidden="true">▤</span>{area}</span>}
          {sections.length > 0 && <><p className="nav-label">On this page</p>{sections.map((section) => <a className="nav-link nav-section" href={`#${section.id}`} key={section.id}>{section.label}</a>)}</>}
        </nav>
        <div className="sidebar-footer"><span className="workspace-avatar" aria-hidden="true">{username?.slice(0, 1).toUpperCase() ?? "O"}</span><div><strong>{username ?? "OnboardOS"}</strong><span>Signed-in workspace</span></div></div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-topbar"><span>Workspace <span className="breadcrumb-divider">/</span> <strong>{area}</strong></span><span className="environment-label">Training environment</span></header>
        <main id="main-content" className="workspace-main" tabIndex={-1}>{children}</main>
        <footer className="workspace-footer">OnboardOS <span>Practice. Evidence. Human review.</span></footer>
      </div>
    </div>
  );
}
