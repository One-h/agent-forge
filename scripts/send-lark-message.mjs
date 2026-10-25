import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

const recipient = argument("--to").trim();
const text = argument("--text").trim();
const dryRun = process.argv.includes("--dry-run");
if (!recipient || !text) {
  console.error("Usage: node scripts/send-lark-message.mjs --to <name|open_id> --text <message> [--dry-run]");
  process.exit(2);
}

const configuredPath = process.env.DATABASE_PATH || "apps/api/data/autofix.sqlite";
const databasePath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(repoRoot, configuredPath);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

function findContacts(exact) {
  const predicate = exact
    ? "lower(c.open_id) = lower(?) OR lower(c.name) = lower(?) OR lower(a.alias) = lower(?)"
    : "lower(c.open_id) LIKE lower(?) OR lower(c.name) LIKE lower(?) OR lower(a.alias) LIKE lower(?)";
  const value = exact ? recipient : `%${recipient}%`;
  return db.prepare(`
    SELECT DISTINCT c.open_id AS openId, c.name, c.enterprise_email AS email
    FROM lark_contacts c
    LEFT JOIN lark_contact_aliases a ON a.open_id = c.open_id
    WHERE c.is_activated = 1 AND (${predicate})
    ORDER BY c.name, c.open_id
    LIMIT 10
  `).all(value, value, value);
}

let matches = findContacts(true);
if (matches.length === 0) matches = findContacts(false);
db.close();

if (matches.length === 0) {
  console.error(`No active Lark contact matched: ${recipient}`);
  process.exit(3);
}
if (matches.length > 1) {
  console.error(JSON.stringify({ error: "ambiguous_recipient", recipient, matches }, null, 2));
  process.exit(4);
}

const target = matches[0];
if (dryRun) {
  console.log(JSON.stringify({ ok: true, dryRun: true, recipient: target, text }, null, 2));
  process.exit(0);
}

const result = spawnSync(
  "lark-cli",
  ["im", "+messages-send", "--as", "bot", "--user-id", target.openId, "--text", text],
  { cwd: repoRoot, encoding: "utf8" }
);
if (result.status !== 0) {
  console.error((result.stderr || result.stdout || `lark-cli exited with code ${result.status}`).trim());
  process.exit(result.status ?? 1);
}

let response = null;
try {
  response = JSON.parse(result.stdout);
} catch {
  response = result.stdout.trim();
}
console.log(JSON.stringify({ ok: true, recipient: target, response }, null, 2));
