import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyableId({ label, value }: { label: string; value: string }) {
  const [copiedValue, setCopiedValue] = useState("");
  const copied = copiedValue === value;
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  return <span className="copyableId">
    <span>{label}</span><code>{value}</code>
    <button className="iconButton" type="button" onClick={() => void copy()} aria-label={copied ? `已复制 ${label}` : `复制 ${label}`} title={copied ? "已复制" : `复制 ${label}`}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
    {failed && <span role="alert">复制失败，请手动选择 ID</span>}
  </span>;
}
