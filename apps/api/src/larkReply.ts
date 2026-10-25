import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";

export function larkReplyIdempotencyKey(kind: string, seed: string): string {
  const hash = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16);
  return `afc-${kind}-${hash}`;
}

export function larkAtTag(openId: string, displayName = ""): string {
  return `<at user_id="${openId}">${displayName}</at>`;
}

export function sendLarkTextReply(
  messageId: string,
  text: string,
  idempotencyKey: string
): { ok: true } | { ok: false; error: string } {
  const result = spawnSync(
    "lark-cli",
    ["im", "+messages-reply", "--as", "bot", "--message-id", messageId, "--text", text, "--idempotency-key", idempotencyKey],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  if (result.status === 0) {
    return { ok: true };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export function larkReplyMediaFlag(relativePath: string): "--image" | "--file" {
  return imageExtensions.has(path.extname(relativePath).toLowerCase()) ? "--image" : "--file";
}

export function buildLarkMediaReplyArgs(messageId: string, relativePath: string, idempotencyKey: string): string[] {
  return [
    "im",
    "+messages-reply",
    "--as",
    "bot",
    "--message-id",
    messageId,
    larkReplyMediaFlag(relativePath),
    relativePath,
    "--idempotency-key",
    idempotencyKey
  ];
}

export function sendLarkMediaReply(
  messageId: string,
  taskDir: string,
  relativePath: string,
  idempotencyKey: string
): { ok: true } | { ok: false; error: string } {
  const result = spawnSync("lark-cli", buildLarkMediaReplyArgs(messageId, relativePath, idempotencyKey), {
    cwd: taskDir,
    encoding: "utf8"
  });
  if (result.status === 0) {
    return { ok: true };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export function uploadLarkReplyImage(taskDir: string, relativePath: string): { ok: true; imageKey: string } | { ok: false; error: string } {
  const result = spawnSync(
    "lark-cli",
    ["im", "images", "create", "--as", "bot", "--data", JSON.stringify({ image_type: "message" }), "--file", relativePath],
    { cwd: taskDir, encoding: "utf8" }
  );
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { data?: { image_key?: unknown }; image_key?: unknown };
    const imageKey = typeof parsed.data?.image_key === "string" ? parsed.data.image_key : parsed.image_key;
    return typeof imageKey === "string" && imageKey ? { ok: true, imageKey } : { ok: false, error: "Lark image upload returned no image_key" };
  } catch {
    return { ok: false, error: "Lark image upload returned invalid JSON" };
  }
}

export function buildLarkImagePostReplyArgs(messageId: string, imageKeys: string[], idempotencyKey: string): string[] {
  const content = {
    zh_cn: {
      content: imageKeys.map((imageKey) => [{ tag: "img", image_key: imageKey }])
    }
  };
  return [
    "im",
    "+messages-reply",
    "--as",
    "bot",
    "--message-id",
    messageId,
    "--msg-type",
    "post",
    "--content",
    JSON.stringify(content),
    "--idempotency-key",
    idempotencyKey
  ];
}

export function sendLarkImagePostReply(
  messageId: string,
  taskDir: string,
  imagePaths: string[],
  idempotencyKey: string
): { ok: true; imageCount: number } | { ok: false; error: string } {
  const imageKeys: string[] = [];
  for (const imagePath of imagePaths) {
    const uploaded = uploadLarkReplyImage(taskDir, imagePath);
    if (!uploaded.ok) {
      return uploaded;
    }
    imageKeys.push(uploaded.imageKey);
  }
  const result = spawnSync("lark-cli", buildLarkImagePostReplyArgs(messageId, imageKeys, idempotencyKey), {
    cwd: taskDir,
    encoding: "utf8"
  });
  if (result.status === 0) {
    return { ok: true, imageCount: imageKeys.length };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export type LarkExecutionApprovalCardInput = {
  requester: string;
  originalMessage: string;
  operation: string;
  operationCount?: number;
  cwd: string | null;
  reason: string | null;
  approvalToken: string;
};

export type LarkExecutionApprovalResultCardInput = Omit<LarkExecutionApprovalCardInput, "approvalToken"> & {
  status: "approved" | "rejected" | "expired" | "failed";
  approvalScope: "once" | "turn";
  decidedAt: string;
};

function compactCardText(value: string | null, maxLength: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "-";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function buildLarkExecutionApprovalCard(input: LarkExecutionApprovalCardInput): Record<string, unknown> {
  const operationLabel = input.operationCount && input.operationCount > 1
    ? `**待执行操作（${input.operationCount} 项）**`
    : "**待执行操作**";
  const details = [
    `**请求人**：${compactCardText(input.requester, 120)}`,
    `**原始消息**：${compactCardText(input.originalMessage, 500)}`,
    `${operationLabel}：${compactCardText(input.operation, 800)}`,
    input.cwd ? `**工作目录**：${compactCardText(input.cwd, 300)}` : null,
    input.reason ? `**原因**：${compactCardText(input.reason, 300)}` : null
  ].filter((value): value is string => Boolean(value));
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "Codex 执行授权" }
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: details.join("\n") } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "允许本次" },
            value: { action: "approve", approval_token: input.approvalToken }
          },
          {
            tag: "button",
            type: "default",
            text: { tag: "plain_text", content: "允许当前任务" },
            value: { action: "approve-turn", approval_token: input.approvalToken }
          },
          {
            tag: "button",
            type: "default",
            text: { tag: "plain_text", content: "拒绝" },
            value: { action: "reject", approval_token: input.approvalToken }
          }
        ]
      },
      {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content: input.operationCount && input.operationCount > 1
            ? `“允许本次”会放行当前批次的 ${input.operationCount} 项操作；“允许当前任务”还会自动放行当前 Codex turn 内的后续受限操作。审批 10 分钟后失效。`
            : "“允许本次”只放行当前操作；“允许当前任务”会自动放行当前 Codex turn 内的后续受限操作。审批 10 分钟后失效。"
        }]
      }
    ]
  };
}

export function buildLarkExecutionApprovalResultCard(input: LarkExecutionApprovalResultCardInput): Record<string, unknown> {
  const status = input.status === "approved"
    ? input.approvalScope === "turn"
      ? { label: "已允许当前任务", template: "green", note: "当前 Codex turn 内的后续受限操作将自动放行；新 turn 会重新审批。" }
      : { label: "已允许本次", template: "green", note: "Codex 已继续执行当前操作，后续受限操作仍需审批。" }
    : input.status === "rejected"
      ? { label: "已拒绝", template: "red", note: "该操作未执行。" }
      : input.status === "expired"
        ? { label: "已过期", template: "grey", note: "该操作未执行，请重新发送指令。" }
        : { label: "处理失败", template: "red", note: "审批请求处理失败，请重新发送指令。" };
  const details = [
    `**状态**：${status.label}`,
    `**请求人**：${compactCardText(input.requester, 120)}`,
    `**原始消息**：${compactCardText(input.originalMessage, 500)}`,
    `**待执行操作**：${compactCardText(input.operation, 800)}`,
    input.cwd ? `**工作目录**：${compactCardText(input.cwd, 300)}` : null,
    input.reason ? `**原因**：${compactCardText(input.reason, 300)}` : null,
    `**处理时间**：${new Date(input.decidedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`
  ].filter((value): value is string => Boolean(value));
  return {
    config: { wide_screen_mode: true },
    header: {
      template: status.template,
      title: { tag: "plain_text", content: `Codex 执行授权 · ${status.label}` }
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: details.join("\n") } },
      { tag: "note", elements: [{ tag: "plain_text", content: status.note }] }
    ]
  };
}

export function sendLarkExecutionApprovalCard(
  approverOpenId: string,
  input: LarkExecutionApprovalCardInput,
  idempotencyKey: string
): { ok: true; messageId: string | null } | { ok: false; error: string } {
  const result = spawnSync(
    "lark-cli",
    [
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--user-id",
      approverOpenId,
      "--msg-type",
      "interactive",
      "--content",
      JSON.stringify(buildLarkExecutionApprovalCard(input)),
      "--idempotency-key",
      idempotencyKey
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  if (result.status === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as { data?: { message_id?: unknown } };
      return { ok: true, messageId: typeof parsed.data?.message_id === "string" ? parsed.data.message_id : null };
    } catch {
      return { ok: true, messageId: null };
    }
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export function updateLarkExecutionApprovalCard(
  messageId: string,
  input: LarkExecutionApprovalResultCardInput
): { ok: true } | { ok: false; error: string } {
  const result = spawnSync(
    "lark-cli",
    [
      "api",
      "PATCH",
      `/open-apis/im/v1/messages/${messageId}`,
      "--as",
      "bot",
      "--data",
      JSON.stringify({ content: JSON.stringify(buildLarkExecutionApprovalResultCard(input)) })
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  if (result.status === 0) {
    return { ok: true };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export function updatePendingLarkExecutionApprovalCard(
  messageId: string,
  input: LarkExecutionApprovalCardInput
): { ok: true } | { ok: false; error: string } {
  const result = spawnSync(
    "lark-cli",
    [
      "api",
      "PATCH",
      `/open-apis/im/v1/messages/${messageId}`,
      "--as",
      "bot",
      "--data",
      JSON.stringify({ content: JSON.stringify(buildLarkExecutionApprovalCard(input)) })
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  if (result.status === 0) {
    return { ok: true };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}

export function buildLarkReactionArgs(messageId: string, emojiType: string): string[] {
  return [
    "im",
    "reactions",
    "create",
    "--as",
    "bot",
    "--params",
    JSON.stringify({ message_id: messageId }),
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: emojiType } })
  ];
}

export function sendLarkReaction(messageId: string, emojiType: string): { ok: true } | { ok: false; error: string } {
  const result = spawnSync("lark-cli", buildLarkReactionArgs(messageId, emojiType), { cwd: process.cwd(), encoding: "utf8" });
  if (result.status === 0) {
    return { ok: true };
  }
  return { ok: false, error: (result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim() };
}
