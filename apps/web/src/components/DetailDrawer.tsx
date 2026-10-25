import type { ReactNode } from "react";
import { X } from "lucide-react";

type DetailDrawerProps = {
  kicker?: string;
  title: string;
  actions?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
  onClose: () => void;
};

export function DetailDrawer({ kicker, title, actions, footer, className, children, onClose }: DetailDrawerProps) {
  return (
    <div className="drawerLayer" role="presentation">
      <button className="drawerBackdrop" aria-label="关闭详情面板" onClick={onClose} />
      <aside className={`detailDrawer${footer ? " detailDrawerWithFooter" : ""}${className ? ` ${className}` : ""}`} aria-label={title}>
        <header className="drawerHeader">
          <div className="drawerTitle">
            {kicker && <p className="eyebrow">{kicker}</p>}
            <h2>{title}</h2>
          </div>
          <div className="drawerActions">
            {actions}
            <button className="iconButton" onClick={onClose} title="关闭">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="drawerBody">{children}</div>
        {footer && <footer className="drawerFooter">{footer}</footer>}
      </aside>
    </div>
  );
}
