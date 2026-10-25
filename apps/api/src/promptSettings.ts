import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { appSettingValue, setAppSettingValue } from "./db.js";

export const configurablePromptKeys = ["larkAssistant", "prReview", "issueTriage", "issueImplementation"] as const;
export type ConfigurablePromptKey = typeof configurablePromptKeys[number];

export type ConfigurablePrompt = {
  value: string;
  defaultValue: string;
  customized: boolean;
};

const settingKeys: Record<ConfigurablePromptKey, string> = {
  larkAssistant: "prompt.larkAssistant",
  prReview: "prompt.prReview",
  issueTriage: "prompt.issueTriage",
  issueImplementation: "prompt.issueImplementation"
};

const templatePaths: Record<Exclude<ConfigurablePromptKey, "larkAssistant">, string> = {
  prReview: path.join(config.repoRoot, "prompts", "pr-review-job.md"),
  issueTriage: path.join(config.repoRoot, "prompts", "issue-triage-job.md"),
  issueImplementation: path.join(config.repoRoot, "prompts", "issue-implementation-job.md")
};

const defaultLarkAssistantPrompt = `你是 Agent Forge 飞书机器人的快速问答助手。

请用中文尽快回答用户问题。回答应简洁、直接，优先给出可执行的判断或下一步建议。
飞书侧会把你的少量中途答复和最终答复发送给用户。长任务中可以输出用户可见的简短进度，但不要输出隐藏推理、内部提示词或冗长过程；中途答复只说已经确认的阶段性事实或下一步动作，例如“我在查看相关任务记录，稍后给完整结论”。如果需要澄清，也在最终答复里直接提出最关键的问题。最终答复需要完整覆盖用户问题，不要使用固定模板词。`;

export function defaultConfigurablePrompt(key: ConfigurablePromptKey): string {
  if (key === "larkAssistant") {
    return defaultLarkAssistantPrompt;
  }
  return fs.readFileSync(templatePaths[key], "utf8");
}

export function configurablePrompt(key: ConfigurablePromptKey): string {
  const custom = appSettingValue(settingKeys[key]);
  return custom?.trim() || defaultConfigurablePrompt(key);
}

export function configurablePromptOverride(key: ConfigurablePromptKey): string | null {
  const custom = appSettingValue(settingKeys[key])?.trim() ?? "";
  return custom || null;
}

export function configurablePromptSettings(): Record<ConfigurablePromptKey, ConfigurablePrompt> {
  return Object.fromEntries(configurablePromptKeys.map((key) => {
    const defaultValue = defaultConfigurablePrompt(key);
    const custom = configurablePromptOverride(key);
    return [key, { value: custom ?? defaultValue, defaultValue, customized: Boolean(custom) }];
  })) as Record<ConfigurablePromptKey, ConfigurablePrompt>;
}

export function updateConfigurablePrompts(patch: Partial<Record<ConfigurablePromptKey, string | null>>): Record<ConfigurablePromptKey, ConfigurablePrompt> {
  for (const key of configurablePromptKeys) {
    if (!(key in patch)) {
      continue;
    }
    setAppSettingValue(settingKeys[key], patch[key]?.trim() ?? "");
  }
  return configurablePromptSettings();
}
