import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FilePenLine,
  LoaderCircle,
  MessageSquareText,
  PlayCircle,
  ShieldCheck,
  Terminal
} from "lucide-react";
import type { ReactNode } from "react";
import type { LarkExecutionApproval } from "../api";
import { formatTime } from "../i18n";

type TimelineTone = "neutral" | "running" | "success" | "warning" | "danger" | "info";

type TimelineEvent = {
  key: string;
  at: number;
  title: string;
  summary?: string;
  detail?: string;
  detailExpanded?: boolean;
  tone: TimelineTone;
  icon: ReactNode;
};

type RawCodexEvent = {
  method?: string;
  emittedAtMs?: number;
  params?: {
    item?: Record<string, unknown>;
    turn?: Record<string, unknown>;
  };
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shortText(value: string | null, max = 2_400): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max)}\n…已省略其余内容` : value;
}

function eventTime(event: RawCodexEvent): number {
  return numberValue(event.emittedAtMs) ?? 0;
}

function durationLabel(durationMs: number | null): string | undefined {
  if (durationMs === null) return undefined;
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} 秒`;
  return `${Math.floor(durationMs / 60_000)} 分 ${Math.round((durationMs % 60_000) / 1_000)} 秒`;
}

function parseJsonLines(stdout: string): RawCodexEvent[] {
  const events: RawCodexEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RawCodexEvent;
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
      // Keep malformed or legacy output available in the raw event foldout.
    }
  }
  return events;
}

function commandEvent(item: Record<string, unknown>, at: number, key: string): TimelineEvent {
  const status = stringValue(item.status);
  const exitCode = numberValue(item.exitCode);
  const failed = status === "failed" || (exitCode !== null && exitCode !== 0);
  const declined = status === "declined" || status === "cancelled";
  const running = status === "inProgress";
  const command = stringValue(item.command);
  const output = stringValue(item.aggregatedOutput);
  return {
    key,
    at,
    title: running ? "正在执行命令" : declined ? "命令未执行" : failed ? "命令执行失败" : "命令执行完成",
    summary: [command, durationLabel(numberValue(item.durationMs))].filter(Boolean).join(" · "),
    detail: shortText(output),
    tone: running ? "running" : declined ? "warning" : failed ? "danger" : "success",
    icon: running ? <LoaderCircle size={16} /> : failed ? <CircleAlert size={16} /> : <Terminal size={16} />
  };
}

function completedItemEvent(item: Record<string, unknown>, at: number, key: string): TimelineEvent | null {
  const type = stringValue(item.type);
  if (type === "userMessage") {
    return { key, at, title: "收到消息", summary: "消息已加入当前 Codex 会话", tone: "info", icon: <MessageSquareText size={16} /> };
  }
  if (type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === "string").join("\n") : null;
    return { key, at, title: "完成一轮分析", detail: shortText(summary), tone: "neutral", icon: <BrainCircuit size={16} /> };
  }
  if (type === "agentMessage") {
    const phase = stringValue(item.phase);
    return {
      key,
      at,
      title: phase === "final_answer" ? "生成最终回复" : "发送阶段进展",
      detail: shortText(stringValue(item.text)),
      detailExpanded: phase !== "final_answer",
      tone: phase === "final_answer" ? "success" : "info",
      icon: phase === "final_answer" ? <Bot size={16} /> : <MessageSquareText size={16} />
    };
  }
  if (type === "commandExecution") return commandEvent(item, at, key);
  if (type === "fileChange") {
    const status = stringValue(item.status);
    const failed = status === "failed";
    return {
      key,
      at,
      title: failed ? "文件修改失败" : "文件修改完成",
      summary: stringValue(item.path) ?? undefined,
      tone: failed ? "danger" : "success",
      icon: failed ? <CircleAlert size={16} /> : <FilePenLine size={16} />
    };
  }
  return null;
}

function codexEvents(stdout: string): TimelineEvent[] {
  const raw = parseJsonLines(stdout);
  const completedItems = new Set<string>();
  for (const event of raw) {
    if (event.method === "item/completed") {
      const id = stringValue(event.params?.item?.id);
      if (id) completedItems.add(id);
    }
  }

  const events: TimelineEvent[] = [];
  for (const [index, event] of raw.entries()) {
    const at = eventTime(event);
    const key = `${event.method ?? "event"}-${at}-${index}`;
    if (event.method === "turn/started") {
      events.push({ key, at, title: "开始处理", summary: "Codex 已开始处理这条消息", tone: "info", icon: <PlayCircle size={16} /> });
      continue;
    }
    if (event.method === "turn/completed") {
      const turn = event.params?.turn ?? {};
      const failed = stringValue(turn.status) === "failed" || Boolean(turn.error);
      events.push({
        key,
        at,
        title: failed ? "处理失败" : "处理完成",
        summary: durationLabel(numberValue(turn.durationMs)),
        detail: shortText(stringValue(turn.error)),
        tone: failed ? "danger" : "success",
        icon: failed ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />
      });
      continue;
    }
    if (event.method === "item/completed" && event.params?.item) {
      const itemEvent = completedItemEvent(event.params.item, at, key);
      if (itemEvent) events.push(itemEvent);
      continue;
    }
    if (event.method === "item/started" && event.params?.item) {
      const item = event.params.item;
      const id = stringValue(item.id);
      if (id && completedItems.has(id)) continue;
      if (stringValue(item.type) === "commandExecution") events.push(commandEvent(item, at, key));
    }
  }
  return events;
}

function approvalTitle(approval: LarkExecutionApproval): string {
  if (approval.status === "approved") return approval.approvalScope === "turn" ? "当前任务已授权" : "本次操作已授权";
  if (approval.status === "rejected") return "审批已拒绝";
  if (approval.status === "expired") return "审批已过期";
  if (approval.status === "failed") return "审批发送失败";
  return "等待执行审批";
}

function approvalTone(status: LarkExecutionApproval["status"]): TimelineTone {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  if (status === "rejected" || status === "failed") return "danger";
  return "neutral";
}

function approvalEvents(approvals: LarkExecutionApproval[]): TimelineEvent[] {
  return approvals.map((approval) => ({
    key: `approval-${approval.id}`,
    at: Date.parse(approval.decidedAt ?? approval.createdAt),
    title: approvalTitle(approval),
    summary: approval.operation,
    detail: shortText([
      `审批人：${approval.approverId}`,
      `授权范围：${approval.approvalScope === "turn" ? "当前 turn" : "当前操作"}`,
      approval.cwd ? `工作目录：${approval.cwd}` : null,
      approval.reason ? `原因：${approval.reason}` : null,
      approval.cardError ? `错误：${approval.cardError}` : null
    ].filter(Boolean).join("\n")),
    tone: approvalTone(approval.status),
    icon: approval.status === "pending" ? <Clock3 size={16} /> : <ShieldCheck size={16} />
  }));
}

export function CodexEventTimeline({ stdout, approvals }: { stdout: string | null; approvals: LarkExecutionApproval[] }) {
  const events = [...codexEvents(stdout ?? ""), ...approvalEvents(approvals)].sort((left, right) => left.at - right.at);
  return (
    <article className="panel codexTimelinePanel">
      <div className="sectionHeader compact">
        <div>
          <h3>Codex 执行过程</h3>
          <p className="subtle">已过滤增量输出和协议噪声</p>
        </div>
        <span className="muted">{events.length} 个关键事件</span>
      </div>
      {events.length > 0 ? (
        <div className="codexTimeline">
          {events.map((event) => (
            <div className={`codexTimelineEvent ${event.tone}`} key={event.key}>
              <div className="codexTimelineMarker" aria-hidden="true">{event.icon}</div>
              <div className="codexTimelineContent">
                <div className="codexTimelineHeading">
                  <strong>{event.title}</strong>
                  <time>{event.at ? formatTime(new Date(event.at).toISOString()) : "-"}</time>
                </div>
                {event.summary && <p>{event.summary}</p>}
                {event.detail && event.detailExpanded && <div className="codexTimelineMessage">{event.detail}</div>}
                {event.detail && !event.detailExpanded && <details><summary>查看详情</summary><pre>{event.detail}</pre></details>}
              </div>
            </div>
          ))}
        </div>
      ) : <div className="emptyState small">还没有可展示的 Codex 事件。</div>}
      {stdout && <details className="rawEventDetails"><summary>查看原始事件</summary><pre className="log artifactLog">{stdout}</pre></details>}
    </article>
  );
}
