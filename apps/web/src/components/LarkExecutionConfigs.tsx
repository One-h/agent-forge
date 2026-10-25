import { Fragment } from "react";
import type { LarkExecutionConfig } from "../api";
import "./larkExecutionConfigs.css";

export function executionValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "未知";
}

function executionTime(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString("zh-CN");
}

function reasoningText(value: unknown): string {
  switch (value) {
    case "none": return "无";
    case "minimal": return "最低";
    case "low": return "低";
    case "medium": return "中";
    case "high": return "高";
    case "xhigh": return "更高";
    case "max": return "最高";
    case "ultra": return "超高";
    default: return executionValue(value);
  }
}

export function executionRounds(configs: LarkExecutionConfig[]) {
  const rounds: Array<{ threadId: string; turnId: string; records: LarkExecutionConfig[] }> = [];
  for (const config of configs) {
    // Missing IDs must not collapse unrelated historical records into one turn.
    const round = typeof config.threadId === "string" && config.threadId.trim()
      && typeof config.turnId === "string" && config.turnId.trim()
      ? rounds.find((item) => item.threadId === config.threadId && item.turnId === config.turnId)
      : undefined;
    if (round) round.records.push(config);
    else rounds.push({ threadId: config.threadId, turnId: config.turnId, records: [config] });
  }
  return rounds;
}

function ConfigValues({ config }: { config: LarkExecutionConfig }) {
  const persona = config.persona;
  const version = typeof persona?.version === "number" && Number.isSafeInteger(persona.version) && persona.version >= 0
    ? `v${persona.version}` : "版本未知";
  const mode = persona?.mode === "default" ? "默认" : persona?.mode === "custom" ? "自定义" : "未知";
  const hash = executionValue(config.globalPromptHash);
  const rows = [
    ["模型", executionValue(config.model)],
    ["思考等级", reasoningText(config.reasoningEffort)],
    ["审批策略", config.approvalPolicy === "never" ? "不请求审批" : config.approvalPolicy === "on-request" ? "按需审批" : executionValue(config.approvalPolicy)],
    ["沙箱", config.sandbox === "danger-full-access" ? "完全权限" : config.sandbox === "read-only" ? "只读" : config.sandbox === "workspace-write" || config.sandbox === "workspaceWrite" ? "工作区可写" : executionValue(config.sandbox)],
    ["可信范围", config.trustScope === "trusted" ? "可信" : config.trustScope === "untrusted" ? "不可信" : "未知"],
    ["工作区", executionValue(config.workspaceRoot)],
    ["人设", `${persona?.mode === "default" && !persona.name ? "全局默认" : executionValue(persona?.name)} · ${version} · ${mode}`],
    ["全局提示词 Hash", hash.length > 16 ? `${hash.slice(0, 12)}…` : hash],
  ];
  return <dl className="meta larkExecutionMeta">
    {rows.map(([label, value]) => <Fragment key={label}>
      <dt>{label}</dt>
      <dd title={label === "全局提示词 Hash" ? hash : value}>{value}</dd>
    </Fragment>)}
  </dl>;
}

export function LarkExecutionConfigs({ configs }: { configs?: LarkExecutionConfig[] }) {
  const rounds = executionRounds(configs ?? []);
  return <section className="panel larkExecutionConfigs" aria-label="本轮执行配置">
    <h3>本轮执行配置</h3>
    {rounds.length === 0 ? <p className="muted">暂无本轮配置记录</p> : rounds.map((round, index) =>
      <div className="larkExecutionRound" key={index}>
        <h4>轮次 {index + 1}</h4>
        <dl className="meta larkExecutionMeta">
          <dt>会话 ID</dt><dd className="mono" title={executionValue(round.threadId)}>{executionValue(round.threadId)}</dd>
          <dt>Turn ID</dt><dd className="mono" title={executionValue(round.turnId)}>{executionValue(round.turnId)}</dd>
        </dl>
        {round.records.map((config, recordIndex) => <div className="larkExecutionRecord" key={recordIndex}>
          <div className="larkExecutionRecordHeader">
            <strong>{config.action === "turn/start" ? "开始轮次" : config.action === "turn/steer" ? "轮内补充" : "操作未知"}</strong>
            <span className="muted">{config.source === "accepted-request" ? "已接受参数" : "来源未知"} · {executionTime(config.recordedAt)}</span>
          </div>
          <ConfigValues config={config} />
        </div>)}
      </div>)}
  </section>;
}
