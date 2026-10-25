import fs from "node:fs";
import path from "node:path";

const defaultApiBase = "http://127.0.0.1:4731";
const maxStickerBytes = 2 * 1024 * 1024;
const userAgent = "Agent-Forge-Sticker-Agent/1.0 (+local expression asset library)";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function help() {
  console.log(`Add one image to the local Agent expression asset library.

Usage:
  npm run stickers:add -- --url <https://...> --name <name> [options]
  npm run stickers:add -- --file </absolute/path> --name <name> [options]

Options:
  --description <text>       When and how the Agent should use it
  --tags <a,b,c>             Comma-separated retrieval tags
  --source-url <url>         Original public source when --file is used
  --source-site <name>       Source label shown in the asset library
  --api-base <url>           Agent Forge API (default: ${defaultApiBase})
  --help                     Show this help
`);
}

function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mimeType: "image/png", extension: ".png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mimeType: "image/jpeg", extension: ".jpg" };
  const header = buffer.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return { mimeType: "image/gif", extension: ".gif" };
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return { mimeType: "image/webp", extension: ".webp" };
  if (header.startsWith("BM")) return { mimeType: "image/bmp", extension: ".bmp" };
  return null;
}

async function downloadImage(url) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("--url 只支持 http 或 https 图片地址");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(parsed, {
      headers: { "User-Agent": userAgent },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
    const announcedSize = Number(response.headers.get("content-length") ?? "0");
    if (announcedSize > maxStickerBytes) throw new Error("图片超过 2 MB");
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, sourceUrl: response.url || parsed.toString() };
  } finally {
    clearTimeout(timer);
  }
}

function readLocalImage(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error("--file 必须使用绝对路径");
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("--file 不是普通文件");
  if (stat.size <= 0 || stat.size > maxStickerBytes) throw new Error("图片为空或超过 2 MB");
  return fs.readFileSync(filePath);
}

async function main() {
  if (process.argv.includes("--help")) {
    help();
    return;
  }
  const remoteUrl = argument("--url");
  const localFile = argument("--file");
  if (Boolean(remoteUrl) === Boolean(localFile)) throw new Error("必须且只能提供 --url 或 --file");

  const name = argument("--name").trim();
  if (!name) throw new Error("必须提供 --name，写清图片表达");
  const description = argument("--description").trim();
  const tags = argument("--tags").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
  const apiBase = argument("--api-base", defaultApiBase).replace(/\/$/, "");

  const downloaded = remoteUrl ? await downloadImage(remoteUrl) : null;
  const buffer = downloaded?.buffer ?? readLocalImage(localFile);
  if (buffer.length === 0 || buffer.length > maxStickerBytes) throw new Error("图片为空或超过 2 MB");
  const detected = detectImage(buffer);
  if (!detected) throw new Error("只支持 PNG、JPG、GIF、WEBP 或 BMP 图片");

  const sourceUrl = argument("--source-url", downloaded?.sourceUrl ?? "").trim();
  const sourceSite = argument("--source-site", sourceUrl ? new URL(sourceUrl).hostname : "Agent 生成").trim();
  const fileName = localFile ? path.basename(localFile) : path.basename(new URL(sourceUrl).pathname) || `agent-sticker${detected.extension}`;
  const response = await fetch(`${apiBase}/api/lark/stickers/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: [{
        name: name.slice(0, 80),
        description: description.slice(0, 300),
        tags: tags.slice(0, 12),
        fileName,
        mimeType: detected.mimeType,
        dataBase64: buffer.toString("base64"),
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(sourceSite ? { sourceSite: sourceSite.slice(0, 200) } : {})
      }]
    })
  });
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(result.error ?? `写入表达资产库失败：HTTP ${response.status}`);
  const created = Array.isArray(result) ? result[0] : null;
  console.log(JSON.stringify(created
    ? { status: "created", sticker: created }
    : { status: "duplicate", message: "同一图片已存在，未重复添加" }, null, 2));
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
