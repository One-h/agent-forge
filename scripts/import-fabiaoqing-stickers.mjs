const sourceBase = "https://fabiaoqing.com";
const defaultApiBase = "http://127.0.0.1:4731";
const userAgent = "Agent-Forge-Sticker-Importer/1.0 (+local personal library)";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const limit = Math.max(1, Math.min(10_000, Number(argument("--limit", "1000")) || 1000));
const startPage = Math.max(1, Number(argument("--start-page", "1")) || 1);
const delayMs = Math.max(250, Number(argument("--delay-ms", "900")) || 900);
const apiBase = argument("--api-base", defaultApiBase).replace(/\/$/, "");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanLabel(alt, index) {
  const value = decodeHtml(alt)
    .replace(/[-_]?发表情.*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return (value.split(/\s+-\s+/u)[0] || `表情包 ${index}`).slice(0, 80);
}

const tagKeywords = [
  "无语", "离谱", "震惊", "开心", "大笑", "笑死", "生气", "愤怒", "委屈", "哭", "流泪", "疑问", "问号",
  "点赞", "赞", "鼓掌", "庆祝", "谢谢", "拒绝", "不可以", "闭嘴", "嘲讽", "吃瓜", "看戏", "摆烂", "睡觉",
  "上班", "下班", "摸鱼", "猫", "狗", "熊猫", "仓鼠", "小黄脸", "奥特曼", "动图", "gif", "亲亲", "抱抱"
];

function deriveTags(label, url) {
  const haystack = `${label} ${url}`.toLowerCase();
  const tags = tagKeywords.filter((tag) => haystack.includes(tag.toLowerCase()));
  if (/\.gif(?:$|\?)/i.test(url) && !tags.includes("动图")) tags.push("动图");
  return [...new Set(tags)].slice(0, 12);
}

function pageItems(html) {
  const items = [];
  const regex = /<img\b[^>]*(?:data-original|src)="(https?:\/\/[^"\s]+)"[^>]*alt="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const url = decodeHtml(match[1]);
    if (!/^https:\/\/img\.soutula\.com\//i.test(url)) continue;
    items.push({ url, alt: decodeHtml(match[2]) });
  }
  return items;
}

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.ok) return response;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await sleep(attempt * 1_000);
  }
  throw lastError ?? new Error(`Unable to fetch ${url}`);
}

function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const header = buffer.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  if (header.startsWith("BM")) return "image/bmp";
  return null;
}

async function downloadItem(item, index) {
  try {
    const response = await fetchWithRetry(item.url, {
      headers: { "User-Agent": userAgent, Referer: `${sourceBase}/` }
    }, 2);
    const announcedSize = Number(response.headers.get("content-length") ?? "0");
    if (announcedSize > 2 * 1024 * 1024) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > 2 * 1024 * 1024) return null;
    const mimeType = detectImage(buffer);
    if (!mimeType) return null;
    const name = cleanLabel(item.alt, index);
    return {
      name,
      description: `${name}。来源：fabiaoqing.com，按当前聊天情绪酌情使用。`.slice(0, 300),
      tags: deriveTags(name, item.url),
      fileName: new URL(item.url).pathname.split("/").pop() || `sticker-${index}`,
      mimeType,
      dataBase64: buffer.toString("base64"),
      sourceUrl: item.url,
      sourceSite: "fabiaoqing.com"
    };
  } catch {
    return null;
  }
}

async function uploadBatch(files) {
  if (files.length === 0) return [];
  const response = await fetchWithRetry(`${apiBase}/api/lark/stickers/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files })
  }, 2);
  return response.json();
}

async function main() {
  const robots = await fetchWithRetry(`${sourceBase}/robots.txt`, { headers: { "User-Agent": userAgent } });
  const robotsText = await robots.text();
  if (/Disallow:\s*\/bqb\//i.test(robotsText)) throw new Error("robots.txt disallows /bqb/ crawling");

  const existingResponse = await fetchWithRetry(`${apiBase}/api/lark/stickers`);
  const existing = await existingResponse.json();
  const seenUrls = new Set(existing.map((sticker) => sticker.sourceUrl).filter(Boolean));
  let imported = 0;
  let downloaded = 0;
  let skipped = 0;
  let page = startPage;

  while (imported < limit && page <= 3_323) {
    const pageUrl = `${sourceBase}/bqb/lists/type/hot/page/${page}.html`;
    const response = await fetchWithRetry(pageUrl, { headers: { "User-Agent": userAgent } });
    const candidates = pageItems(await response.text()).filter((item) => !seenUrls.has(item.url));
    for (const item of candidates) seenUrls.add(item.url);

    for (let offset = 0; offset < candidates.length && imported < limit; offset += 5) {
      const remaining = limit - imported;
      const slice = candidates.slice(offset, offset + Math.min(5, remaining));
      const files = (await Promise.all(slice.map((item, index) => downloadItem(item, imported + downloaded + index + 1)))).filter(Boolean);
      downloaded += files.length;
      skipped += slice.length - files.length;
      if (files.length > 0) {
        const created = await uploadBatch(files.slice(0, remaining));
        imported += created.length;
        skipped += files.length - created.length;
      }
      await sleep(250);
    }

    process.stdout.write(`\rpage=${page} imported=${imported}/${limit} downloaded=${downloaded} skipped=${skipped}`);
    page += 1;
    if (imported < limit) await sleep(delayMs);
  }
  process.stdout.write("\n");
  console.log(JSON.stringify({ status: imported === limit ? "success" : "warning", imported, requested: limit, downloaded, skipped, lastPage: page - 1, source: sourceBase }, null, 2));
  if (imported < limit) process.exitCode = 1;
}

await main();
