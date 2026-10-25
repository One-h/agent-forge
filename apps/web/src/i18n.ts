const statusLabels: Record<string, string> = {
  all: "全部",
  answered: "已回答",
  archived: "已归档",
  blocked: "已阻塞",
  closed: "已关闭",
  completed: "已完成",
  configured: "已配置",
  debug: "调试",
  done: "已完成",
  "easy-direct": "可直接处理",
  failed: "失败",
  "hard-human-handoff": "需人工接手",
  idle: "空闲",
  info: "信息",
  longterm: "长期任务",
  missing: "缺失",
  "mid-human-review": "需要人工复核",
  monitoring: "监控中",
  none: "无",
  not_mentioned: "未提及",
  no_reply: "已处理（未回复）",
  open: "开放",
  pending: "等待中",
  posted: "已发布",
  pr_created: "已创建 PR",
  queued: "排队中",
  review: "待评审",
  reviewed: "已评审",
  running: "运行中",
  sent: "已发送",
  starting: "启动中",
  stale: "需重新评审",
  stopped: "已停止",
  timeout: "超时",
  todo: "待处理",
  unknown: "未知",
  warn: "警告",
  error: "错误"
};

export function statusText(value: string | null | undefined): string {
  if (!value) return "-";
  return statusLabels[value] ?? value;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN");
}

export function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "-";
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export function itemKindText(value: string | null | undefined): string {
  if (value === "issue") return "问题";
  if (value === "pull" || value === "pr") return "PR";
  return value ?? "-";
}

export function modeText(value: string | null | undefined): string {
  if (value === "review_only") return "仅评审";
  if (value === "issue_triage") return "问题分析";
  if (value === "issue_implementation") return "代码修复";
  if (value === "implementation") return "代码修复";
  return value ?? "-";
}
