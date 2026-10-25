import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const repoRoot = process.cwd();
const databasePath = path.join(repoRoot, "apps/api/data/autofix.sqlite");
const stickerDirectory = path.join(repoRoot, "data/lark-stickers");
const taskDirectory = path.join(repoRoot, "data/tasks/sticker-tag-cleanup-mimo-v2.5");
const thumbnailDirectory = path.join(taskDirectory, "thumbnails");
const checkpointPath = path.join(taskDirectory, "checkpoint.json");
const reportPath = path.join(taskDirectory, "report.json");
const openCodeContextDirectory = path.join(os.tmpdir(), "agent-forge-sticker-tagger-context");
const apiBase = "http://127.0.0.1:4731";
const model = "opencode-go/mimo-v2.5";
const openCodeAttachUrl = argument("--attach", "http://127.0.0.1:4098");

const taxonomy = [
  "开心", "大笑", "兴奋", "得意", "感动", "害羞", "期待", "惊喜", "震惊", "疑惑", "无语", "无奈", "尴尬",
  "嫌弃", "鄙视", "生气", "愤怒", "委屈", "难过", "崩溃", "害怕", "紧张", "疲惫", "困倦", "摆烂", "冷漠",
  "嘲讽", "阴阳怪气", "赞同", "点赞", "拒绝", "否定", "质疑", "吐槽", "反击", "警告", "威胁", "催促",
  "等待", "提醒", "道歉", "感谢", "安慰", "鼓励", "庆祝", "求助", "告别", "问候", "敷衍", "围观", "吃瓜",
  "闭嘴", "哭泣", "鼓掌", "抱抱", "亲亲", "工作", "上班", "加班", "下班", "摸鱼", "开会", "学习", "考试",
  "论文", "吃饭", "睡觉", "恋爱", "聊天", "社交", "任务完成", "报错失败", "猫", "狗", "熊猫头", "仓鼠",
  "小黄脸", "动物", "真人", "卡通", "文字梗", "影视梗", "游戏梗", "动图"
];
const taxonomySet = new Set(taxonomy);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const batchSize = Math.max(1, Math.min(6, Number(argument("--batch-size", "4")) || 4));
const concurrency = Math.max(1, Math.min(6, Number(argument("--concurrency", "4")) || 4));
const limit = Math.max(1, Number(argument("--limit", "9999")) || 9999);
const shouldApply = process.argv.includes("--apply");
const shouldGenerateScenes = process.argv.includes("--scenes");
const onlyFailures = process.argv.includes("--only-failures");
const excludeFailures = process.argv.includes("--exclude-failures");
const sceneBatchSize = Math.max(1, Math.min(30, Number(argument("--scene-batch-size", "20")) || 20));

fs.mkdirSync(thumbnailDirectory, { recursive: true });
fs.mkdirSync(openCodeContextDirectory, { recursive: true });
const database = new Database(databasePath, { readonly: true });
const stickers = database.prepare(`
  SELECT id, name, description, tags, file_name, mime_type
  FROM lark_stickers
  WHERE deleted_at IS NULL
  ORDER BY id
  LIMIT ?
`).all(limit);
database.close();

const checkpoint = fs.existsSync(checkpointPath)
  ? JSON.parse(fs.readFileSync(checkpointPath, "utf8"))
  : { model, taxonomy, results: {}, failures: {}, startedAt: new Date().toISOString() };
checkpoint.scenes ??= {};
checkpoint.sceneFailures ??= {};

function saveCheckpoint() {
  checkpoint.updatedAt = new Date().toISOString();
  fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function thumbnailFor(sticker) {
  const source = path.join(stickerDirectory, path.basename(sticker.file_name));
  const destination = path.join(thumbnailDirectory, `${sticker.id}.png`);
  if (fs.existsSync(destination)) return destination;
  const converted = spawnSync("sips", ["-s", "format", "png", "-Z", "512", source, "--out", destination], { encoding: "utf8" });
  return converted.status === 0 && fs.existsSync(destination) ? destination : source;
}

function buildPrompt(batch) {
  const items = batch.map((sticker, index) => `${index + 1}. id=${sticker.id}；名称=${JSON.stringify(sticker.name)}；格式=${sticker.mime_type}`).join("\n");
  return `你在整理 Agent 表情包库。按附件顺序逐张看图，给每张图选择 2–6 个可用于聊天召回的中文标签。

标签体系（只能从中选择）：${taxonomy.join("、")}。

规则：
1. 优先描述情绪与沟通意图，其次是场景和主体；不要输出“表情包”“图片”“梗图”等无召回价值的词。
2. gif 和 动图是同义格式标签，只能使用“动图”；附件对应原图格式为 image/gif 时必须含“动图”，其他格式不得含“动图”。
3. “哭泣”已经包含哭、流泪；“点赞”已经包含赞；不要输出近义重复标签。
4. 根据真实画面和文字判断，不要因为名称误导而盲从。标签应适合 Agent 决定何时发送。
5. 必须覆盖以下全部 id，不能新增或遗漏。只输出 JSON 数组，不要 Markdown、解释或代码块，格式为 [{"id":"stk_xxx","tags":["无语","吐槽","猫"]}]。

附件与资产对应：
${items}`;
}

function parseModelResult(text, batch) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("模型没有返回 JSON 数组");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("模型结果不是数组");
  const expected = new Set(batch.map((sticker) => sticker.id));
  const results = [];
  for (const item of parsed) {
    if (!item || typeof item.id !== "string" || !expected.has(item.id) || !Array.isArray(item.tags)) continue;
    const sticker = batch.find((candidate) => candidate.id === item.id);
    const tags = [...new Set(item.tags.filter((tag) => typeof tag === "string" && taxonomySet.has(tag)))];
    const animated = sticker.mime_type === "image/gif";
    const normalized = tags.filter((tag) => tag !== "动图");
    if (animated) normalized.push("动图");
    if (normalized.length < 2 || normalized.length > 6) throw new Error(`${item.id} 的有效标签数为 ${normalized.length}`);
    results.push({ id: item.id, tags: normalized });
  }
  if (results.length !== expected.size || new Set(results.map((item) => item.id)).size !== expected.size) {
    throw new Error(`模型返回 ${results.length}/${expected.size} 个有效资产`);
  }
  return results;
}

function buildScenePrompt(batch) {
  const items = batch.map((sticker, index) => {
    const tags = checkpoint.results[sticker.id]?.tags ?? [];
    return `${index + 1}. id=${sticker.id}；名称=${JSON.stringify(sticker.name)}；视觉标签=${tags.join("、")}`;
  }).join("\n");
  return `你在整理 Agent 表情包库。根据资产名称和已经过图片识别的视觉标签，为每项写一条具体的中文适用场景。

规则：
1. 每条 18–55 个汉字，说明“什么时候发”和“表达什么语气”，让 Agent 能据此召回。
2. 不复述图片画面，不写来源，不出现 fabiaoqing、表情包、图片、按当前情绪酌情使用等废话。
3. 不要统一套模板；结合名称和标签区分吐槽、安慰、拒绝、庆祝等真实用途。
4. 必须覆盖以下全部 id，不能新增或遗漏。只输出以 id 为键的 JSON 对象，不要 Markdown、解释或代码块，格式为 {"stk_xxx":"对方说出离谱内容时，用无语又带点嫌弃的语气吐槽。"}。

资产列表：
${items}`;
}

function parseSceneResult(text, batch) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("场景模型没有返回 JSON 对象");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("场景模型结果不是对象");
  const expected = new Set(batch.map((sticker) => sticker.id));
  const results = [];
  for (const [id, rawDescription] of Object.entries(parsed)) {
    if (!expected.has(id) || typeof rawDescription !== "string") continue;
    const description = rawDescription.trim().replace(/\s+/g, " ");
    if (description.length < 12 || description.length > 90 || /fabiaoqing|按当前.*情绪|表情包|图片/i.test(description)) {
      throw new Error(`${id} 的适用场景不合格`);
    }
    results.push({ id, description });
  }
  if (results.length !== expected.size || new Set(results.map((item) => item.id)).size !== expected.size) {
    throw new Error(`场景模型返回 ${results.length}/${expected.size} 个有效资产`);
  }
  return results;
}

async function runOpenCode(batch, _workerIndex) {
  const directoryQuery = `directory=${encodeURIComponent(openCodeContextDirectory)}`;
  const sessionResponse = await fetch(`${openCodeAttachUrl}/session?${directoryQuery}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Sticker tag batch ${batch[0].id}`,
      model: { providerID: "opencode-go", id: "mimo-v2.5" }
    })
  });
  if (!sessionResponse.ok) throw new Error(`OpenCode 创建会话失败：HTTP ${sessionResponse.status} ${await sessionResponse.text()}`);
  const session = await sessionResponse.json();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const fileParts = batch.map((sticker) => {
      const thumbnail = thumbnailFor(sticker);
      return {
        type: "file",
        mime: "image/png",
        filename: path.basename(thumbnail),
        url: `data:image/png;base64,${fs.readFileSync(thumbnail).toString("base64")}`
      };
    });
    const promptResponse = await fetch(`${openCodeAttachUrl}/session/${session.id}/message?${directoryQuery}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: { providerID: "opencode-go", modelID: "mimo-v2.5" },
        agent: "orchestrator",
        tools: {},
        parts: [...fileParts, { type: "text", text: buildPrompt(batch) }]
      })
    });
    if (!promptResponse.ok) throw new Error(`OpenCode 识图失败：HTTP ${promptResponse.status} ${await promptResponse.text()}`);
    const message = await promptResponse.json();
    const text = message.parts?.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim() ?? "";
    return parseModelResult(text, batch);
  } finally {
    clearTimeout(timer);
    await fetch(`${openCodeAttachUrl}/session/${session.id}?${directoryQuery}`, { method: "DELETE" }).catch(() => null);
  }
}

async function runSceneOpenCode(batch) {
  const directoryQuery = `directory=${encodeURIComponent(openCodeContextDirectory)}`;
  const sessionResponse = await fetch(`${openCodeAttachUrl}/session?${directoryQuery}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Sticker scene batch ${batch[0].id}`,
      model: { providerID: "opencode-go", id: "mimo-v2.5" }
    })
  });
  if (!sessionResponse.ok) throw new Error(`OpenCode 创建场景会话失败：HTTP ${sessionResponse.status} ${await sessionResponse.text()}`);
  const session = await sessionResponse.json();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const promptResponse = await fetch(`${openCodeAttachUrl}/session/${session.id}/message?${directoryQuery}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: { providerID: "opencode-go", modelID: "mimo-v2.5" },
        agent: "orchestrator",
        tools: {},
        format: {
          type: "json_schema",
          retryCount: 2,
          schema: {
            type: "object",
            additionalProperties: false,
            required: batch.map((sticker) => sticker.id),
            properties: Object.fromEntries(batch.map((sticker) => [
              sticker.id,
              {
                  type: "string",
                  minLength: 12,
                  maxLength: 90,
                  pattern: "^(?!.*(?:fabiaoqing|表情包|图片|按当前)).{12,90}$"
              }
            ]))
          }
        },
        parts: [{ type: "text", text: buildScenePrompt(batch) }]
      })
    });
    if (!promptResponse.ok) throw new Error(`OpenCode 场景整理失败：HTTP ${promptResponse.status} ${await promptResponse.text()}`);
    const message = await promptResponse.json();
    const textParts = message.parts?.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim() ?? "";
    const text = textParts || (message.info?.structured ? JSON.stringify(message.info.structured) : "");
    return parseSceneResult(text, batch);
  } finally {
    clearTimeout(timer);
    await fetch(`${openCodeAttachUrl}/session/${session.id}?${directoryQuery}`, { method: "DELETE" }).catch(() => null);
  }
}

async function classifyBatch(batch, workerIndex) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const results = await runOpenCode(batch, workerIndex);
      for (const result of results) {
        checkpoint.results[result.id] = result;
        delete checkpoint.failures[result.id];
      }
      saveCheckpoint();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  for (const sticker of batch) checkpoint.failures[sticker.id] = String(lastError);
  saveCheckpoint();
}

async function runPool(batches) {
  let next = 0;
  let completed = 0;
  async function worker(workerIndex) {
    while (next < batches.length) {
      const index = next;
      next += 1;
      await classifyBatch(batches[index], workerIndex);
      completed += 1;
      console.log(`batches=${completed}/${batches.length} tagged=${Object.keys(checkpoint.results).length}/${stickers.length} failures=${Object.keys(checkpoint.failures).length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, (_, index) => worker(index)));
}

async function classifySceneBatch(batch) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const results = await runSceneOpenCode(batch);
      for (const result of results) {
        checkpoint.scenes[result.id] = result;
        delete checkpoint.sceneFailures[result.id];
      }
      saveCheckpoint();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  for (const sticker of batch) checkpoint.sceneFailures[sticker.id] = String(lastError);
  saveCheckpoint();
}

async function runScenePool(batches) {
  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < batches.length) {
      const index = next;
      next += 1;
      await classifySceneBatch(batches[index]);
      completed += 1;
      console.log(`scene_batches=${completed}/${batches.length} scenes=${stickers.filter((sticker) => checkpoint.scenes[sticker.id]).length}/${stickers.length} failures=${stickers.filter((sticker) => checkpoint.sceneFailures[sticker.id] && !checkpoint.scenes[sticker.id]).length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
}

async function applyResults() {
  const missing = stickers.filter((sticker) => !checkpoint.results[sticker.id]);
  if (missing.length > 0) throw new Error(`还有 ${missing.length} 张没有有效标签，拒绝写入数据库`);
  const missingScenes = stickers.filter((sticker) => !checkpoint.scenes[sticker.id]);
  if (missingScenes.length > 0) throw new Error(`还有 ${missingScenes.length} 张没有有效适用场景，拒绝写入数据库`);
  let updated = 0;
  let unchanged = 0;
  for (const sticker of stickers) {
    const nextTags = checkpoint.results[sticker.id].tags;
    const nextDescription = checkpoint.scenes[sticker.id].description;
    const previousTags = JSON.parse(sticker.tags);
    if (JSON.stringify(previousTags) === JSON.stringify(nextTags) && sticker.description === nextDescription) {
      unchanged += 1;
      continue;
    }
    const response = await fetch(`${apiBase}/api/lark/stickers/${sticker.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: nextTags, description: nextDescription })
    });
    if (!response.ok) throw new Error(`${sticker.id} 更新失败：HTTP ${response.status} ${await response.text()}`);
    updated += 1;
  }
  return { updated, unchanged };
}

const pending = stickers.filter((sticker) => {
  if (checkpoint.results[sticker.id]) return false;
  if (onlyFailures) return Boolean(checkpoint.failures[sticker.id]);
  if (excludeFailures) return !checkpoint.failures[sticker.id];
  return true;
});
const batches = [];
for (let index = 0; index < pending.length; index += batchSize) batches.push(pending.slice(index, index + batchSize));
if (batches.length > 0) await runPool(batches);

if (shouldGenerateScenes) {
  const pendingScenes = stickers.filter((sticker) => checkpoint.results[sticker.id] && !checkpoint.scenes[sticker.id]);
  const sceneBatches = [];
  for (let index = 0; index < pendingScenes.length; index += sceneBatchSize) sceneBatches.push(pendingScenes.slice(index, index + sceneBatchSize));
  if (sceneBatches.length > 0) await runScenePool(sceneBatches);
}

const summary = {
  model,
  total: stickers.length,
  tagged: stickers.filter((sticker) => checkpoint.results[sticker.id]).length,
  scenes: stickers.filter((sticker) => checkpoint.scenes[sticker.id]).length,
  failures: stickers.filter((sticker) => checkpoint.failures[sticker.id] && !checkpoint.results[sticker.id]).length,
  applied: false,
  finishedAt: new Date().toISOString()
};
if (shouldApply) {
  summary.applyResult = await applyResults();
  summary.applied = true;
}
fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (summary.tagged !== summary.total || summary.failures > 0) process.exitCode = 1;
