import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";

export function LarkRefreshButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="iconButton" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
    <RefreshCw size={16} aria-hidden="true" />
  </button>;
}

export function LarkWorkspaceHeader({ title, id, icon, actions }: {
  title: string; id?: string; icon: ReactNode; actions?: ReactNode;
}) {
  return <header className="larkWorkspaceHeader">
    <div className="larkWorkspaceHeading">
      <span className="larkWorkspaceMark" aria-hidden="true">{icon}</span>
      <h2 id={id}>{title}</h2>
    </div>
    {actions && <div className="larkWorkspaceActions">{actions}</div>}
  </header>;
}
