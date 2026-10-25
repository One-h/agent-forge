import { z } from "zod";
import { config } from "./config.js";
import type { AppSettings } from "./db.js";
import { LarkAgentResponseError, larkAgentProxyFetch } from "./larkAgentIntegration.js";
import { isLarkReactionEmojiType } from "./larkReactionEmojis.js";

const model = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const chatIds = z.array(z.string().regex(/^oc_[A-Za-z0-9]+$/)).max(200);
const emoji = z.string().refine(isLarkReactionEmojiType);
export const approvalDataSourcesSchema = z.array(z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/).transform(value => value.toLowerCase())).max(100).transform(values => [...new Set(values)]);

export const larkRuntimeSettingsSchema = z.object({
  listenerEnabled: z.boolean(),
  repliesEnabled: z.boolean(),
  interimRepliesEnabled: z.boolean(),
  ownerMessageFastPathEnabled: z.boolean(),
  executionReceiptsEnabled: z.boolean(),
  codexModel: model,
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
  stickerUsageMode: z.enum(["off", "explicit", "natural", "always"]),
  groupSpontaneousRepliesEnabled: z.boolean(),
  groupSpontaneousReplyRate: z.number().min(0).max(1),
  groupSpontaneousReplyCooldownMs: z.number().int().min(0).max(604_800_000),
  groupSpontaneousChatIds: chatIds,
  trustedExecutionEnabled: z.boolean(),
  turnAutoApprovalEnabled: z.boolean(),
  turnAutoApprovalModel: model,
  turnAutoApprovalDataSources: approvalDataSourcesSchema,
  acknowledgeReactionEmoji: emoji,
  groupMessageReactionEnabled: z.boolean(),
  groupMessageReactionEmoji: emoji,
  groupMessageReactionChatIds: chatIds,
  groupContextMessageLimit: z.number().int().min(1).max(200),
  groupContextMaxChars: z.number().int().min(500).max(30_000),
  workspaceRoot: z.string(),
  approverId: z.string(),
  trustedSenderIds: z.array(z.string())
}).strict();

export type RuntimeSettingsPatch = Partial<z.infer<typeof larkRuntimeSettingsSchema>>;
type RuntimeSettingKey = keyof RuntimeSettingsPatch;
type LarkSettingKey = Extract<keyof AppSettings, `lark${string}`>;

let settingsSaveQueue: Promise<void> = Promise.resolve();

// Hold across preflight, remote confirmation, local commit and any compensation.
export function withLarkRuntimeSettingsLock<T>(save: () => Promise<T>): Promise<T> {
  const pending = settingsSaveQueue.then(save);
  settingsSaveQueue = pending.then(() => {}, () => {});
  return pending;
}

// Exhaustive over AppSettings: new global Lark settings must declare their wire name.
export const larkAppSettingFields = {
  larkMessageListenerEnabled: "listenerEnabled",
  larkCodexRepliesEnabled: "repliesEnabled",
  larkExecutionReceiptsEnabled: "executionReceiptsEnabled",
  larkCodexModel: "codexModel",
  larkCodexReasoningEffort: "reasoningEffort",
  larkStickerUsageMode: "stickerUsageMode",
  larkGroupSpontaneousRepliesEnabled: "groupSpontaneousRepliesEnabled",
  larkGroupSpontaneousReplyRate: "groupSpontaneousReplyRate",
  larkGroupSpontaneousReplyCooldownMs: "groupSpontaneousReplyCooldownMs",
  larkGroupSpontaneousChatIds: "groupSpontaneousChatIds",
  larkTrustedExecutionEnabled: "trustedExecutionEnabled",
  larkTurnAutoApprovalEnabled: "turnAutoApprovalEnabled",
  larkTurnAutoApprovalModel: "turnAutoApprovalModel",
  larkTurnAutoApprovalDataSources: "turnAutoApprovalDataSources",
  larkAcknowledgeReactionEmoji: "acknowledgeReactionEmoji",
  larkGroupMessageReactionEnabled: "groupMessageReactionEnabled",
  larkGroupMessageReactionEmoji: "groupMessageReactionEmoji",
  larkGroupMessageReactionChatIds: "groupMessageReactionChatIds",
  larkGroupContextMessageLimit: "groupContextMessageLimit",
  larkGroupContextMaxChars: "groupContextMaxChars"
} as const satisfies Record<LarkSettingKey, RuntimeSettingKey>;

export function larkAppSettingsPatch(settings: Partial<AppSettings>): RuntimeSettingsPatch {
  return Object.fromEntries(Object.entries(larkAppSettingFields)
    .filter(([key]) => settings[key as LarkSettingKey] !== undefined)
    .map(([key, field]) => [field, settings[key as LarkSettingKey]])) as RuntimeSettingsPatch;
}

function settingsRecord(remote: unknown): Record<string, unknown> {
  return remote && typeof remote === "object" && !Array.isArray(remote) ? remote as Record<string, unknown> : {};
}

export function readableLarkRuntimeSetting(remote: unknown, key: RuntimeSettingKey): boolean {
  const values = settingsRecord(remote);
  return Object.hasOwn(values, key) && larkRuntimeSettingsSchema.shape[key].safeParse(values[key]).success;
}

export function readLarkAppSettings(remote: unknown): Partial<AppSettings> {
  const values = settingsRecord(remote);
  return Object.fromEntries(Object.entries(larkAppSettingFields)
    .filter(([, field]) => readableLarkRuntimeSetting(values, field))
    .map(([key, field]) => [key, Array.isArray(values[field]) ? [...new Set(values[field])] : values[field]])) as Partial<AppSettings>;
}

function stringSet(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? [...new Set(value)].sort() : null;
}

function confirmed(remote: unknown, patch: RuntimeSettingsPatch): boolean {
  const values = settingsRecord(remote);
  return Object.entries(patch).every(([key, value]) => {
    if (!readableLarkRuntimeSetting(values, key as RuntimeSettingKey)) return false;
    if (!Array.isArray(value)) return values[key] === value;
    const actual = stringSet(values[key]);
    const expected = stringSet(value);
    return actual !== null && expected !== null && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
  });
}

function failure(message: string, statusCode = 502): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

async function writeConfirmed(patch: RuntimeSettingsPatch): Promise<void> {
  const remote = await larkAgentProxyFetch("/v1/settings", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch)
  });
  if (!confirmed(remote, patch)) throw failure("Lark Agent did not confirm the runtime settings PATCH response");
  if (!confirmed(await larkAgentProxyFetch("/v1/settings"), patch)) {
    throw failure("Lark Agent did not confirm the runtime settings readback");
  }
}

// A single snapshot, write and compensation batch for every settings entry point.
export async function syncLarkRuntimeSettings(
  input: RuntimeSettingsPatch,
  options: { allowLegacyBackup?: boolean } = {}
): Promise<(cause?: unknown) => Promise<void>> {
  const patch = larkRuntimeSettingsSchema.partial().parse(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)));
  const legacyApproval = options.allowLegacyBackup && patch.turnAutoApprovalModel === "gpt-6.1-sol";
  const hasApproval = patch.turnAutoApprovalEnabled !== undefined || patch.turnAutoApprovalModel !== undefined;
  if (!config.larkAgentUrl) {
    if (hasApproval && !(legacyApproval && patch.turnAutoApprovalEnabled === false)) {
      throw failure("Lark Agent is not configured for turn auto-approval", 409);
    }
    return async () => {};
  }
  if (Object.keys(patch).length === 0) return async () => {};
  let current: Record<string, unknown>;
  try { current = settingsRecord(await larkAgentProxyFetch("/v1/settings")); }
  catch { throw failure("Lark Agent runtime settings are unavailable"); }
  const previous: RuntimeSettingsPatch = {};
  for (const key of Object.keys(patch) as RuntimeSettingKey[]) {
    if (key === "turnAutoApprovalModel" && current.turnAutoApprovalModelConfigurable !== true) {
      if (legacyApproval) { delete patch[key]; continue; }
      throw failure("Lark Agent does not support turn auto-approval model settings yet", 409);
    }
    if (!readableLarkRuntimeSetting(current, key)) {
      // Legacy restores send only supported optional fields; permission fields remain mandatory.
      if (options.allowLegacyBackup && !Object.hasOwn(current, key) && !["trustedExecutionEnabled", "workspaceRoot", "approverId", "trustedSenderIds"].includes(key)
          && (key !== "turnAutoApprovalEnabled" || (legacyApproval && patch[key] === false))) {
        delete patch[key];
        continue;
      }
      throw failure(`Lark Agent does not support the requested runtime setting: ${key}`, 409);
    }
    Object.assign(previous, { [key]: current[key] });
  }
  if (Object.keys(patch).length === 0) return async () => {};
  const approvalBatch = patch.turnAutoApprovalEnabled !== undefined || patch.turnAutoApprovalModel !== undefined;
  const rollback = async (cause?: unknown) => {
    try { await writeConfirmed(previous); }
    catch { throw failure("Lark Agent runtime settings state is unknown because rollback could not be confirmed"); }
    if (cause !== undefined) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const statusCode = approvalBatch ? 502 : cause && typeof cause === "object" && "statusCode" in cause ? Number(cause.statusCode) : 500;
      throw failure(`${message}; previous remote ${approvalBatch ? "turn auto-approval setting" : "runtime settings"} restored`, statusCode);
    }
  };
  try { await writeConfirmed(patch); }
  catch (error) {
    // Explicit validation/busy rejections are atomic; ambiguous writes need compensation.
    if (error instanceof LarkAgentResponseError && [400, 409, 422].includes(error.statusCode)) throw error;
    await rollback(failure(error instanceof Error ? error.message : String(error)));
    throw error;
  }
  return rollback;
}
