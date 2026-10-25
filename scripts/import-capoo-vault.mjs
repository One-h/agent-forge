import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultSourceDir = path.join(repoRoot, "data", "imports", "capoo-vault");
const defaultApiBase = "http://127.0.0.1:4731";
const maxStickerBytes = 2 * 1024 * 1024;
const batchSize = 20;
const capooSourceUrl = "https://github.com/CST-Cat/capoo-vault";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function usage() {
  console.log(`Import a locally downloaded Capoo Vault asset pack into Agent Forge.

The source directory is runtime-only and must contain:
  data/stickers.json
  gifs-vault/<set>/<gif>

Usage:
  npm run stickers:import:capoo -- --source-dir data/imports/capoo-vault --limit 200
  npm run stickers:import:capoo -- --source-dir data/imports/capoo-vault --offset 200 --limit 800 --apply

Options:
  --source-dir <dir>   Capoo Vault runtime download directory (default: data/imports/capoo-vault)
  --offset <n>         Skip the first <n> manifest entries for incremental imports (default: 0)
  --limit <n>          Maximum eligible stickers to inspect/import (default: 200)
  --apply              Upload eligible stickers; without it, only write a dry-run report
  --api-base <url>     Agent Forge API (default: http://127.0.0.1:4731)
  --filter-work-chat   Exclude unsuitable work-chat labels (off by default)
  --report <path>      Report JSON path (default: <source-dir>/reports/capoo-import-<timestamp>.json)
`);
}

function resolveInput(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function parseLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 200;
}

function parseOffset(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, 100_000) : 0;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const blockedTerms = [
  "便便", "马桶", "舔", "裸体", "色情", "性暗示", "血", "砍", "杀", "枪", "刀", "暴力", "殴打", "中指", "辱骂"
];

function rejectedReason(item) {
  const text = [item.emotion, item.action, item.scene, item.description, ...(Array.isArray(item.tags) ? item.tags : [])]
    .map(normalizeText).join(" ");
  return blockedTerms.find((term) => text.includes(term)) ?? null;
}

function imagePath(sourceDir, item) {
  const candidates = [
    path.join(sourceDir, "gifs-vault", item.set, item.gif),
    path.join(sourceDir, "gifs", item.set, item.gif),
    path.join(sourceDir, item.set, item.gif)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function imageMimeType(buffer) {
  const header = buffer.subarray(0, 12).toString("ascii");
  return header.startsWith("GIF87a") || header.startsWith("GIF89a") ? "image/gif" : null;
}

function forgeFile(item, absolutePath) {
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.length === 0 || buffer.length > maxStickerBytes) return { error: "图片为空或超过 2 MB" };
  if (imageMimeType(buffer) !== "image/gif") return { error: "不是有效 GIF" };
  const tags = [...new Set(["capoo", "咖波", normalizeText(item.emotion), normalizeText(item.action), ...(Array.isArray(item.tags) ? item.tags.map(normalizeText) : [])]
    .map((tag) => tag.slice(0, 30))
    .filter(Boolean))].slice(0, 12);
  const name = [normalizeText(item.emotion), normalizeText(item.action)].filter(Boolean).join(" · ").slice(0, 80) || "Capoo 表情";
  return {
    file: {
      name,
      description: normalizeText(item.description).slice(0, 300),
      tags,
      fileName: path.basename(absolutePath),
      mimeType: "image/gif",
      dataBase64: buffer.toString("base64"),
      sourceUrl: capooSourceUrl,
      sourceSite: `Capoo Vault/${normalizeText(item.set)}`.slice(0, 200)
    },
    sizeBytes: buffer.length
  };
}

async function upload(apiBase, files) {
  const response = await fetch(`${apiBase}/api/lark/stickers/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files })
  });
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(body.error ?? `上传失败：HTTP ${response.status}`);
  return Array.isArray(body) ? body : [];
}

async function main() {
  if (process.argv.includes("--help")) return usage();
  const sourceDir = resolveInput(argument("--source-dir", defaultSourceDir));
  const manifestPath = path.join(sourceDir, "data", "stickers.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`缺少 Capoo 标注文件：${manifestPath}`);
  const entries = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(entries)) throw new Error("data/stickers.json 不是数组");
  const offset = parseOffset(argument("--offset", "0"));
  const limit = parseLimit(argument("--limit", "200"));
  const apply = process.argv.includes("--apply");
  const filterWorkChat = process.argv.includes("--filter-work-chat");
  const apiBase = argument("--api-base", defaultApiBase).replace(/\/$/, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = resolveInput(argument("--report", path.join(sourceDir, "reports", `capoo-import-${stamp}.json`)));
  const report = { source: capooSourceUrl, sourceDir, mode: apply ? "apply" : "dry-run", offset, limit, selected: [], skipped: [], imported: [], duplicates: 0 };
  const batch = [];

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const created = await upload(apiBase, batch);
    report.imported.push(...created.map((sticker) => ({ id: sticker.id, name: sticker.name })));
    report.duplicates += batch.length - created.length;
    batch.length = 0;
  };

  for (const item of entries.slice(offset)) {
    if (report.selected.length >= limit) break;
    const label = `${normalizeText(item.set)}/${normalizeText(item.gif)}`;
    const reason = filterWorkChat ? rejectedReason(item) : null;
    if (reason) {
      report.skipped.push({ item: label, reason: `工作群过滤：${reason}` });
      continue;
    }
    const absolutePath = imagePath(sourceDir, item);
    if (!absolutePath) {
      report.skipped.push({ item: label, reason: "本地 GIF 不存在" });
      continue;
    }
    const result = forgeFile(item, absolutePath);
    if (result.error) {
      report.skipped.push({ item: label, reason: result.error });
      continue;
    }
    report.selected.push({ item: label, name: result.file.name, tags: result.file.tags, sizeBytes: result.sizeBytes });
    if (apply) {
      batch.push(result.file);
      if (batch.length >= batchSize) {
        await flushBatch();
      }
    }
  }
  if (apply) await flushBatch();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ mode: report.mode, offset: report.offset, selected: report.selected.length, imported: report.imported.length, duplicates: report.duplicates, skipped: report.skipped.length, reportPath }, null, 2));
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
