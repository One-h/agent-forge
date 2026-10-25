import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

type ConfirmDialogProps = {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
};

export function ConfirmDialog({ title, description, confirmLabel, destructive = false, onCancel, onConfirm }: ConfirmDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  const confirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm();
      onCancel();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="confirmationLayer" role="presentation">
      <button className="confirmationBackdrop" aria-label="关闭确认窗口" disabled={submitting} onClick={onCancel} />
      <section className="confirmationDialog" aria-describedby="confirmation-description" aria-modal="true" aria-labelledby="confirmation-title" role="dialog">
        <div className="confirmationIcon" aria-hidden="true"><AlertTriangle size={20} /></div>
        <div>
          <h2 id="confirmation-title">{title}</h2>
          <div className="subtle" id="confirmation-description">{description}</div>
        </div>
        <div className="confirmationActions">
          <button className="ghostButton" disabled={submitting} onClick={onCancel} type="button">取消</button>
          <button className={destructive ? "dangerButton" : "primaryButton"} disabled={submitting} onClick={() => void confirm()} type="button">
            {submitting ? "处理中..." : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
