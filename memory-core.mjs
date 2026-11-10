/**
 * dsh-memory-manager — memory-core.mjs
 *
 * Shared, dependency-free memory store core, ported from ZCode's project
 * memory. It is imported by both the Host half (`index.js`) and the standalone
 * verification script (`scripts/self-test.mjs`), so every byte here must stay
 * plain Node ESM with no DSH or third-party imports.
 *
 * Storage layout (mirrors ZCode's `~/.zcode/cli/memories/projects/<p>/`):
 *
 *   <DSH_HOME>/memories/
 *     projects/<projectKey>/
 *       memory/<name>.md         one memory per file (YAML frontmatter + body)
 *       MEMORY.md                regenerated index (ZCode-style)
 *       memory_summary.md        regenerated summary
 *
 * A memory entry is:
 *   {
 *     name, description, type, project, origin,
 *     createdAt, updatedAt,           // epoch milliseconds
 *     body                            // markdown body (get()/write only)
 *   }
 *
 * `type` uses ZCode's vocabulary: user | feedback | reference | project | other.
 * `project` is a sanitized project key; the reserved key "global" holds
 * cross-project memories.
 *
 * Memory lifecycle (v1.5, all fields optional and backward compatible):
 *   - `status`       active (default) | superseded | archived
 *   - `pinned`       never trimmed from the injected index
 *   - `supersedes`   name of the memory this one replaces
 *   - `supersededBy` name of the memory that replaced this one (written on the
 *                    old entry, which stays on disk with status=superseded)
 *   - `ttlDays`      per-entry relevance window override
 *   - `lastUsedAt` / `useCount`  bumped by memory_get, drive ranking
 *   - `forgotAt` / `forgotReason`  tombstones of archived entries
 *   - `archivedFrom` original live path recorded on an archived entry
 *
 * Forgotten memories are NOT deleted: they move to
 * `<project>/.archive/<name>.<ts>.md` (restorable, purgeable) and in-place
 * overwrites leave a pruned snapshot in `<project>/.history/`.
 */

import { readFile, writeFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const MEMORY_TYPES = ["user", "feedback", "reference", "project", "other"];
export const GLOBAL_PROJECT = "global";
export const INDEX_FILE = "MEMORY.md";
export const SUMMARY_FILE = "memory_summary.md";
export const CONFIG_FILE = "config.json";
export const ARCHIVE_DIR = ".archive";
export const HISTORY_DIR = ".history";
export const STATUSES = ["active", "superseded", "archived"];

/** Per-type relevance window (days) before an injected entry is flagged stale. */
export const TYPE_TTL_DAYS = { user: 3650, feedback: 1095, project: 180, reference: 180, other: 365 };

/** How many overwrite snapshots to keep per memory name. */
const HISTORY_KEEP = 5;

/** Files that are generated indexes, never memories. */
const INDEX_FILES = new Set([INDEX_FILE, SUMMARY_FILE]);

// ---- write safety: cross-process lock, atomic rename, conflict detection ----

export const LOCK_DIR = ".lock";
const LOCK_TIMEOUT_MS = 4000;
const LOCK_STALE_MS = 15000;
const LOCK_RETRY_MIN_MS = 25;
const LOCK_RETRY_JITTER_MS = 40;

/** Atomic write: temp file + rename, so a crash never leaves a half-written memory. */
async function atomicWrite(path, text) {
  const tmp = path + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  await writeFile(tmp, text, "utf8");
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** In-process serialization: core mutations are single-flight per process. */
let writeQueue = Promise.resolve();

/**
 * Acquire the store-wide advisory lock (`<DSH_HOME>/memories/.lock`, a
 * directory so acquisition is atomic on every platform). A lock older than
 * LOCK_STALE_MS is taken over: a crashed writer must never wedge the store.
 * Cross-process callers (two DSH sessions, one DSH + one editor) serialize on
 * this directory; in-process callers additionally queue on `writeQueue`.
 */
async function acquireLock(home) {
  const root = memoriesRoot(home);
  await mkdir(root, { recursive: true });
  const lockPath = join(root, LOCK_DIR);
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        const busy = new Error("memory store is busy (write lock timeout)");
        busy.code = "store-busy";
        throw busy;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, LOCK_RETRY_MIN_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS)),
      );
    }
  }
}

/**
 * Run one mutation under the store lock. Internal helpers named `*Unlocked`
 * must be used inside the callback — nesting this function would deadlock the
 * in-process queue.
 */
function withWriteLock(home, fn) {
  const run = async () => {
    const release = await acquireLock(home);
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  const next = writeQueue.then(run, run);
  writeQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

/** Resolve the DSH home directory (same rule as @deepseek-ai/dsh-home-paths). */
export function resolveDshHome() {
  const env = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  return env && env.length > 0 ? env : join(homedir(), ".dsh");
}

/** Default ZCode memory directory: `~/.zcode/cli/memories`. */
export function resolveZCodeMemoriesDir() {
  return join(homedir(), ".zcode", "cli", "memories");
}

/**
 * Sanitize a name / project key into a safe single path segment:
 * keeps Unicode letters, digits, `_` and `-`; replaces everything else with
 * `-`; collapses runs; trims separators; caps length. CJK names survive.
 */
export function sanitizeSegment(input, fallback = "") {
  const value = String(input ?? "").trim();
  const out = value
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return out || fallback;
}

/** Memory root under a DSH home. */
export function memoriesRoot(home) {
  return join(home, "memories");
}

/** Per-project directory (creates nothing). */
export function projectDir(home, project) {
  return join(memoriesRoot(home), "projects", sanitizeSegment(project, GLOBAL_PROJECT));
}

/** Directory holding the memory markdown files of one project. */
export function memoryDir(home, project) {
  return join(projectDir(home, project), "memory");
}

/** Absolute path of one memory file. */
export function memoryPath(home, project, name) {
  return join(memoryDir(home, project), sanitizeSegment(name, "") + ".md");
}

/** Directory holding forgotten (archived) memories of one project. */
export function archiveDir(home, project) {
  return join(projectDir(home, project), ARCHIVE_DIR);
}

/** Directory holding overwrite snapshots of one project. */
export function historyDir(home, project) {
  return join(projectDir(home, project), HISTORY_DIR);
}

/** True when the project directory holds nothing worth keeping. */
function projectIsEmpty(home, project) {
  const dir = projectDir(home, project);
  if (!existsSync(dir)) return true;
  const live = existsSync(memoryDir(home, project)) ? readdirSync(memoryDir(home, project)).filter((f) => f.endsWith(".md")) : [];
  if (live.length > 0) return false;
  const archived = existsSync(archiveDir(home, project)) ? readdirSync(archiveDir(home, project)).filter((f) => f.endsWith(".md")) : [];
  if (archived.length > 0) return false;
  const history = existsSync(historyDir(home, project)) ? readdirSync(historyDir(home, project)).filter((f) => f.endsWith(".md")) : [];
  return history.length === 0;
}

/** Remove the project directory once it holds no live, archived or history files. */
async function cleanupProject(home, project) {
  if (!projectIsEmpty(home, project)) return false;
  const dir = projectDir(home, project);
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  return true;
}

/** Map a workspace path to a project key (basename slug, `global` when blank). */
export function projectKeyFromPath(workspacePath) {
  if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) return GLOBAL_PROJECT;
  const base = workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  return sanitizeSegment(base, GLOBAL_PROJECT);
}

/**
 * Human label for a project key: strip ZCode-style trailing `-<16 hex>` so
 * `hrouter-beb03a33e80b027c` displays as `hrouter`. Falls back to the key.
 */
export function projectLabel(project) {
  const s = String(project || "");
  const m = /^(.+?)-[0-9a-fA-F]{16}$/.exec(s);
  return m ? m[1] : s;
}

/**
 * Migrate legacy hash-suffixed project directories (ZCode-style
 * `<name>-<16hex>`) to their friendly keys so imported memories match the
 * workspace slugs a user would pick in the UI. When the friendly project
 * already exists, memory files are merged (existing names win). The `project`
 * frontmatter field of every moved memory is rewritten to the new key, and
 * affected projects' indexes are regenerated. Idempotent and cheap.
 *
 * @returns {{ moved: number, merged: number }}
 */
async function migrateProjectKeysUnlocked(home) {
  const root = join(memoriesRoot(home), "projects");
  const result = { moved: 0, merged: 0 };
  if (!existsSync(root)) return result;
  const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  const affected = new Set();
  for (const d of dirs) {
    const m = /^(.+?)-[0-9a-fA-F]{16}$/.exec(d.name);
    if (!m) continue;
    const friendly = sanitizeSegment(m[1], "");
    if (!friendly || friendly === d.name) continue;
    const srcDir = join(root, d.name);
    const srcMem = join(srcDir, "memory");
    if (!existsSync(srcMem)) continue;
    const dstMem = memoryDir(home, friendly);
    await mkdir(dstMem, { recursive: true });
    const files = (await readdir(srcMem)).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const target = join(dstMem, f);
      if (existsSync(target)) {
        result.merged += 1;
        continue;
      }
      const p = join(srcMem, f);
      const text = await readFile(p, "utf8");
      const { fields, body } = parseFrontmatter(text);
      const st = await stat(p);
      const entry = normalizeEntry(fields, body, st.mtimeMs);
      const stored = { ...entry, project: friendly };
      await atomicWrite(target, serializeMemory(stored));
      result.moved += 1;
    }
    await rm(srcDir, { recursive: true, force: true });
    affected.add(friendly);
  }
  for (const key of affected) {
    const entries = await listProjectMemories(home, key);
    await writeIndexes(home, key, entries);
  }
  return result;
}

/** Locked one-shot migration of legacy hash-suffixed project directories. */
export async function migrateProjectKeys(home) {
  return withWriteLock(home, () => migrateProjectKeysUnlocked(home));
}

/** YAML-safe scalar: numbers pass through, risky strings get double-quoted. */
export function yamlScalar(value) {
  if (typeof value === "number") return String(value);
  const s = String(value ?? "");
  if (s.length === 0) return '""';
  // Plain scalars may contain Unicode letters/numbers (incl. CJK), `_`, `-`,
  // `.`, `:`, spaces — anything riskier gets quoted.
  if (
    /^[\p{L}\p{N}_][\p{L}\p{N}_.:\- ]*$/u.test(s) &&
    !s.includes(": ") &&
    !/[#{}[\],&*!|>'"%@`]/.test(s) &&
    !/^\s|\s$/.test(s)
  ) {
    return s;
  }
  return JSON.stringify(s);
}

/** Parse a `key: value` YAML frontmatter block tolerantly (flat + ZCode nested). */
export function parseFrontmatter(text) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const raw = match[1];
  const body = text.slice(match[0].length).replace(/^\r?\n/, "").replace(/\r?\n+$/, "");
  const fields = {};
  const lines = raw.split(/\r?\n/);
  let inMeta = false;
  let i = 0;
  const unquote = (s) => {
    const t = s.trim();
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
      return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return t;
  };
  while (i < lines.length) {
    const line = lines[i];
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (top) {
      const key = top[1];
      const inline = top[2].trim();
      inMeta = key === "metadata";
      if (inMeta && inline.startsWith("{")) {
        for (const mm of inline.matchAll(/([A-Za-z0-9_]+)\s*:\s*([^,}]+)/g)) {
          fields["metadata." + mm[1]] = unquote(mm[2]);
        }
        inMeta = false;
        i += 1;
        continue;
      }
      const cont = [];
      let j = i + 1;
      while (j < lines.length && !inMeta && /^[ \t]+\S/.test(lines[j])) {
        cont.push(lines[j].trim());
        j += 1;
      }
      const value = [inline, ...cont].join(" ").trim();
      fields[key] = value === "" && !inMeta ? "" : unquote(value);
      i = j;
      continue;
    }
    const sub = /^[ \t]+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (inMeta && sub) {
      fields["metadata." + sub[1]] = unquote(sub[2]);
    }
    i += 1;
  }
  return { fields, body };
}

/** Parse a loose YAML boolean (`true` / `1` / `yes`). */
function yamlBool(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/** Serialize a memory entry to the markdown file text (flat frontmatter). */
export function serializeMemory(entry) {
  const head = [
    "---",
    "name: " + yamlScalar(entry.name),
    "description: " + yamlScalar(entry.description || ""),
    "type: " + yamlScalar(entry.type || "other"),
    "project: " + yamlScalar(entry.project || GLOBAL_PROJECT),
    "origin: " + yamlScalar(entry.origin || "manual"),
    "createdAt: " + yamlScalar(Number(entry.createdAt) || 0),
    "updatedAt: " + yamlScalar(Number(entry.updatedAt) || 0),
  ];
  // Lifecycle fields are written only when they carry information, so legacy
  // files and ZCode-imported files keep their exact original shape.
  if (entry.status && entry.status !== "active") head.push("status: " + yamlScalar(entry.status));
  if (entry.pinned === true) head.push("pinned: true");
  if (entry.supersedes) head.push("supersedes: " + yamlScalar(entry.supersedes));
  if (entry.supersededBy) head.push("supersededBy: " + yamlScalar(entry.supersededBy));
  if (Number(entry.ttlDays) > 0) head.push("ttlDays: " + yamlScalar(Number(entry.ttlDays)));
  if (Number(entry.lastUsedAt) > 0) head.push("lastUsedAt: " + yamlScalar(Number(entry.lastUsedAt)));
  if (Number(entry.useCount) > 0) head.push("useCount: " + yamlScalar(Number(entry.useCount)));
  if (Number(entry.forgotAt) > 0) head.push("forgotAt: " + yamlScalar(Number(entry.forgotAt)));
  if (entry.forgotReason) head.push("forgotReason: " + yamlScalar(entry.forgotReason));
  if (entry.archivedFrom) head.push("archivedFrom: " + yamlScalar(entry.archivedFrom));
  head.push("---");
  const body = String(entry.body ?? "");
  return head.join("\n") + "\n\n" + body.replace(/^\r?\n/, "") + (body.trim().length > 0 ? "\n" : "");
}

/** Normalize parsed fields + optional file mtime into a memory entry. */
export function normalizeEntry(fields, body, mtimeMs = 0) {
  const meta = {};
  for (const key of Object.keys(fields)) {
    if (key.startsWith("metadata.")) meta[key.slice("metadata.".length)] = fields[key];
  }
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  const name = sanitizeSegment(fields.name || "", "");
  const rawType = String(fields.type || meta.type || "other").trim();
  const rawStatus = String(fields.status || "active").trim();
  return {
    name,
    description: String(fields.description || "").trim(),
    type: MEMORY_TYPES.includes(rawType) ? rawType : "other",
    project: sanitizeSegment(fields.project || GLOBAL_PROJECT, GLOBAL_PROJECT),
    origin: String(fields.origin || meta.originSessionId || "manual").trim(),
    createdAt: num(fields.createdAt) || 0,
    updatedAt: num(fields.updatedAt) || mtimeMs,
    status: STATUSES.includes(rawStatus) ? rawStatus : "active",
    pinned: yamlBool(fields.pinned),
    supersedes: String(fields.supersedes || "").trim(),
    supersededBy: String(fields.supersededBy || "").trim(),
    ttlDays: num(fields.ttlDays),
    lastUsedAt: num(fields.lastUsedAt),
    useCount: num(fields.useCount),
    forgotAt: num(fields.forgotAt),
    forgotReason: String(fields.forgotReason || "").trim(),
    archivedFrom: String(fields.archivedFrom || "").trim(),
    body: String(body ?? ""),
  };
}

function fmtDate(ms) {
  if (!ms) return "unknown";
  const d = new Date(ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/** Regenerate `MEMORY.md` and `memory_summary.md` for one project. */
export async function writeIndexes(home, project, entries) {
  const dir = projectDir(home, project);
  await mkdir(dir, { recursive: true });
  const sorted = [...entries].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const lines = [
    "# DSH Project Memory",
    "",
    "This file is maintained by dsh-memory-manager. It is an index; each memory file under `memory/` contains the memory body.",
    "",
    "## Memory Index",
    "",
  ];
  for (const e of sorted) {
    const flags = [];
    if (e.pinned) flags.push("pinned");
    if (e.status === "superseded") flags.push(e.supersededBy ? "superseded by " + e.supersededBy : "superseded");
    lines.push(
      "- [" + e.name + "](memory/" + e.name + ".md) — " + (e.description || "(no description)") +
        " (type: " + e.type + ", updated: " + fmtDate(e.updatedAt) + (flags.length ? ", " + flags.join(", ") : "") + ")"
    );
  }
  await writeFile(join(dir, INDEX_FILE), lines.join("\n") + "\n", "utf8");

  const active = entries.filter((e) => (e.status || "active") === "active");
  const superseded = entries.filter((e) => e.status === "superseded");
  const byType = {};
  for (const e of active) byType[e.type] = (byType[e.type] || 0) + 1;
  const parts = Object.keys(byType)
    .sort()
    .map((t) => t + ": " + byType[t]);
  const extras = [];
  if (superseded.length > 0) extras.push("已被取代 " + superseded.length + " 条");
  const summaryLines = [
    "# Memory Summary",
    "",
    "Project `" + project + "` — " + active.length + " 条有效记忆" + (parts.length ? "（" + parts.join(" / ") + "）" : "") + "。",
  ];
  if (extras.length > 0) summaryLines.push("", extras.join("；"));
  summaryLines.push("", "Last updated: " + fmtDate(Date.now()), "");
  await writeFile(join(dir, SUMMARY_FILE), summaryLines.join("\n"), "utf8");
}

/** Read and parse one memory file; returns null when it does not exist. */
export async function readMemory(home, project, name) {
  const cleanName = sanitizeSegment(name, "");
  if (!cleanName) return null;
  const p = memoryPath(home, project, cleanName);
  if (!existsSync(p)) return null;
  const text = await readFile(p, "utf8");
  const st = await stat(p);
  const { fields, body } = parseFrontmatter(text);
  return normalizeEntry(fields, body, st.mtimeMs);
}

/** Read every live memory file of one project directory into summary rows. */
async function readProjectEntries(home, projectKey) {
  const key = sanitizeSegment(projectKey, GLOBAL_PROJECT);
  const dir = memoryDir(home, key);
  const out = [];
  if (!existsSync(dir)) return out;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const p = join(dir, file);
    const text = await readFile(p, "utf8");
    const info = await stat(p);
    const { fields, body } = parseFrontmatter(text);
    const entry = normalizeEntry(fields, body, info.mtimeMs);
    out.push({
      id: key + "/" + entry.name,
      name: entry.name,
      description: entry.description,
      type: entry.type,
      project: entry.project || key,
      origin: entry.origin,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      status: entry.status,
      pinned: entry.pinned,
      supersedes: entry.supersedes,
      supersededBy: entry.supersededBy,
      ttlDays: entry.ttlDays,
      lastUsedAt: entry.lastUsedAt,
      useCount: entry.useCount,
      size: text.length,
    });
  }
  return out;
}

/** List all memories across projects (no bodies). */
export async function listMemories(home) {
  const projectsRoot = join(memoriesRoot(home), "projects");
  const out = [];
  let projectKeys = [];
  if (existsSync(projectsRoot)) {
    projectKeys = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
  for (const project of projectKeys) out.push(...(await readProjectEntries(home, project)));
  return out;
}

/**
 * List one project's live memories. Mutations and index regeneration only need
 * this project (plus nothing else), so they must not walk the whole store.
 */
export async function listProjectMemories(home, project) {
  return readProjectEntries(home, sanitizeSegment(project, GLOBAL_PROJECT));
}

/** Keep only the newest HISTORY_KEEP snapshots for one memory name. */
async function pruneHistory(home, project, baseName) {
  const dir = historyDir(home, project);
  if (!existsSync(dir)) return;
  const files = (await readdir(dir)).filter((f) => f.startsWith(baseName + ".") && f.endsWith(".md"));
  if (files.length <= HISTORY_KEEP) return;
  const rows = [];
  for (const f of files) rows.push({ f, t: (await stat(join(dir, f))).mtimeMs });
  rows.sort((a, b) => b.t - a.t);
  for (const row of rows.slice(HISTORY_KEEP)) await rm(join(dir, row.f), { force: true });
}

/**
 * Snapshot the current file text into `<project>/.history/` before an
 * overwrite, so a bad `memory_save`/edit can always be recovered (and audited).
 */
async function snapshotHistory(home, project, name, text) {
  const dir = historyDir(home, project);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, sanitizeSegment(name, "memory") + "." + Date.now() + ".md"), text, "utf8");
  await pruneHistory(home, project, sanitizeSegment(name, "memory"));
}

/**
 * Create or fully replace a memory. Returns the stored entry (with body).
 * When `name` changes and an `oldName` is given, the old file is removed.
 * Lifecycle fields (status/pinned/supersedes/useCount/...) are inherited from
 * the existing entry unless the caller passes them explicitly, so a plain
 * content overwrite never silently drops a pin or breaks a supersede chain.
 *
 * Concurrency: runs under the store lock and writes atomically. When the
 * caller passes `expectedUpdatedAt` (the version it based its decision on) and
 * the on-disk entry has moved on, the write fails with `code: "write-conflict"`
 * instead of clobbering the newer content; `expectedUpdatedAt` is ignored for
 * a brand-new memory.
 */
async function writeMemoryUnlocked(home, entry) {
  const project = sanitizeSegment(entry.project, GLOBAL_PROJECT);
  const name = sanitizeSegment(entry.name, "");
  if (!name) throw new Error("invalid name: empty after sanitization");
  const dir = memoryDir(home, project);
  await mkdir(dir, { recursive: true });
  const oldName = entry.oldName ? sanitizeSegment(entry.oldName, "") : null;
  const prev = await readMemory(home, project, oldName || name);
  const expected = Number(entry.expectedUpdatedAt);
  if (prev && expected > 0 && prev.updatedAt !== expected) {
    const conflict = new Error(
      "memory changed since it was read (current updatedAt " + prev.updatedAt + ", expected " + expected + ")",
    );
    conflict.code = "write-conflict";
    conflict.current = prev;
    throw conflict;
  }
  const prevPath = memoryPath(home, project, oldName || name);
  const now = Date.now();
  const stored = {
    name,
    description: String(entry.description ?? "").trim(),
    type: MEMORY_TYPES.includes(String(entry.type)) ? entry.type : "other",
    project,
    origin: String(entry.origin || (prev && prev.origin) || "manual").trim(),
    createdAt: Number(entry.createdAt) || (prev && prev.createdAt) || now,
    updatedAt: now,
    status: STATUSES.includes(String(entry.status || (prev && prev.status) || "active").trim())
      ? String(entry.status || (prev && prev.status) || "active").trim()
      : "active",
    pinned: entry.pinned === undefined ? Boolean(prev && prev.pinned) : entry.pinned === true,
    supersedes: String(entry.supersedes !== undefined ? entry.supersedes : (prev && prev.supersedes) || "").trim(),
    supersededBy: String(entry.supersededBy !== undefined ? entry.supersededBy : (prev && prev.supersededBy) || "").trim(),
    ttlDays: Number(entry.ttlDays) || (prev && prev.ttlDays) || 0,
    lastUsedAt: Number(entry.lastUsedAt) || (prev && prev.lastUsedAt) || 0,
    useCount: Number(entry.useCount) || (prev && prev.useCount) || 0,
    body: String(entry.body ?? ""),
  };
  if (entry.snapshotHistory && prev && existsSync(prevPath)) {
    await snapshotHistory(home, project, prev.name, await readFile(prevPath, "utf8"));
  }
  if (oldName && oldName !== name) {
    const oldPath = memoryPath(home, project, oldName);
    if (existsSync(oldPath)) await rm(oldPath, { force: true });
  }
  await atomicWrite(memoryPath(home, project, name), serializeMemory(stored));
  const projectEntries = await listProjectMemories(home, project);
  await writeIndexes(home, project, projectEntries);
  return stored;
}

/** Locked, atomic, conflict-checking `writeMemory` (see `writeMemoryUnlocked`). */
export async function writeMemory(home, entry) {
  return withWriteLock(home, () => writeMemoryUnlocked(home, entry));
}

/** Delete one memory; returns true when a file was actually removed. */
async function deleteMemoryUnlocked(home, project, name) {
  const cleanProject = sanitizeSegment(project, GLOBAL_PROJECT);
  const cleanName = sanitizeSegment(name, "");
  if (!cleanProject || !cleanName) return false;
  const p = memoryPath(home, cleanProject, cleanName);
  let removed = false;
  if (existsSync(p)) {
    await rm(p, { force: true });
    removed = true;
  }
  const projectEntries = await listProjectMemories(home, cleanProject);
  if (projectEntries.length === 0) {
    await cleanupProject(home, cleanProject);
  } else {
    await writeIndexes(home, cleanProject, projectEntries);
  }
  return removed;
}

/** Locked permanent delete (the UI uses `archiveMemory` instead). */
export async function deleteMemory(home, project, name) {
  return withWriteLock(home, () => deleteMemoryUnlocked(home, project, name));
}

// ---- lifecycle: forget / archive / restore / purge ------------------------

/** Epoch-ms suffix encoded in an archive filename: `<name>.<ts>.md`. */
function archiveStamp(file) {
  const m = /^(.+)\.(\d{10,})\.md$/.exec(file);
  return m ? { name: m[1], stamp: Number(m[2]) } : { name: "", stamp: 0 };
}

/**
 * Soft-forget one memory: move it into `<project>/.archive/` with a tombstone
 * (`forgotAt` / `forgotReason`) instead of deleting it. Returns null when the
 * memory does not exist. Archived files never re-enter the injected index and
 * are restorable through `restoreArchived`.
 */
async function archiveMemoryUnlocked(home, project, name, reason = "") {
  const cleanProject = sanitizeSegment(project, GLOBAL_PROJECT);
  const cleanName = sanitizeSegment(name, "");
  if (!cleanName) return null;
  const entry = await readMemory(home, cleanProject, cleanName);
  if (!entry) return null;
  const dir = archiveDir(home, cleanProject);
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  const file = cleanName + "." + now + ".md";
  const archived = {
    ...entry,
    status: "archived",
    forgotAt: now,
    forgotReason: String(reason || "").trim(),
    archivedFrom: "memory/" + cleanName + ".md",
  };
  await atomicWrite(join(dir, file), serializeMemory(archived));
  const live = memoryPath(home, cleanProject, cleanName);
  if (existsSync(live)) await rm(live, { force: true });
  const rest = await listProjectMemories(home, cleanProject);
  if (rest.length > 0) await writeIndexes(home, cleanProject, rest);
  else await cleanupProject(home, cleanProject);
  return { id: cleanProject + "/" + cleanName, name: cleanName, project: cleanProject, file, archivedAt: now };
}

/** Locked soft forget (moves the file into the recycle bin). */
export async function archiveMemory(home, project, name, reason = "") {
  return withWriteLock(home, () => archiveMemoryUnlocked(home, project, name, reason));
}

/**
 * List archived (forgotten) memories, newest first. `project` narrows the scan.
 * Each row keeps the original composite id plus the archive filename so a
 * caller can restore or purge exactly one tombstone.
 */
export async function listArchived(home, project) {
  const root = join(memoriesRoot(home), "projects");
  const out = [];
  if (!existsSync(root)) return out;
  const wanted = project ? sanitizeSegment(project, GLOBAL_PROJECT) : "";
  const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const key of dirs) {
    if (wanted && key !== wanted) continue;
    const dir = archiveDir(home, key);
    if (!existsSync(dir)) continue;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8");
      const st = await stat(join(dir, file));
      const { fields, body } = parseFrontmatter(text);
      const entry = normalizeEntry(fields, body, st.mtimeMs);
      const stamp = archiveStamp(file);
      out.push({
        id: key + "/" + entry.name,
        name: entry.name,
        description: entry.description,
        type: entry.type,
        project: key,
        origin: entry.origin,
        archivedAt: entry.forgotAt || stamp.stamp || st.mtimeMs,
        reason: entry.forgotReason,
        file,
        supersedes: entry.supersedes,
        supersededBy: entry.supersededBy,
      });
    }
  }
  out.sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  return out;
}

/**
 * Restore one archived memory back into the live store. `file` selects a
 * specific tombstone; without it the newest archive of that name is used.
 * Refuses with `reason: "name-taken"` when a live memory already owns the name
 * (restoring over live data silently would be worse than failing).
 *
 * @returns {{ restored: boolean, entry?: object, file?: string, reason?: string }}
 */
async function restoreArchivedUnlocked(home, project, name, file = "") {
  const cleanProject = sanitizeSegment(project, GLOBAL_PROJECT);
  const cleanName = sanitizeSegment(name, "");
  if (!cleanName) return { restored: false, reason: "not-found" };
  const dir = archiveDir(home, cleanProject);
  if (!existsSync(dir)) return { restored: false, reason: "not-found" };
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  let candidates = files.filter((f) => archiveStamp(f).name === cleanName);
  let target = "";
  const explicit = String(file || "").trim();
  if (explicit) {
    const base = explicit.split(/[\\/]/).pop();
    if (!candidates.includes(base)) return { restored: false, reason: "not-found" };
    target = base;
  } else if (candidates.length > 0) {
    const rows = [];
    for (const f of candidates) rows.push({ f, t: archiveStamp(f).stamp || (await stat(join(dir, f))).mtimeMs });
    rows.sort((a, b) => b.t - a.t);
    target = rows[0].f;
  } else {
    return { restored: false, reason: "not-found" };
  }
  const live = memoryPath(home, cleanProject, cleanName);
  if (existsSync(live)) return { restored: false, reason: "name-taken", file: target };
  const text = await readFile(join(dir, target), "utf8");
  const { fields, body } = parseFrontmatter(text);
  const entry = normalizeEntry(fields, body);
  const restoredAt = Date.now();
  const restored = {
    name: cleanName,
    description: entry.description,
    type: entry.type,
    project: cleanProject,
    origin: entry.origin,
    createdAt: entry.createdAt || restoredAt,
    updatedAt: entry.updatedAt || restoredAt,
    status: "active",
    pinned: entry.pinned,
    supersedes: entry.supersedes,
    supersededBy: entry.supersededBy,
    ttlDays: entry.ttlDays,
    lastUsedAt: entry.lastUsedAt,
    useCount: entry.useCount,
    // A restore is an explicit human/agent decision: keep it injectable even
  };
  await mkdir(memoryDir(home, cleanProject), { recursive: true });
  await atomicWrite(live, serializeMemory(restored));
  await rm(join(dir, target), { force: true });
  await writeIndexes(home, cleanProject, await listProjectMemories(home, cleanProject));
  return { restored: true, entry: restored, file: target };
}

/** Locked restore of one archived memory. */
export async function restoreArchived(home, project, name, file = "") {
  return withWriteLock(home, () => restoreArchivedUnlocked(home, project, name, file));
}

/**
 * Permanently drop archived tombstones: one exact `file` when given, otherwise
 * every archive of that name. Returns the number of files removed. Live
 * memories are never touched.
 */
async function purgeArchivedUnlocked(home, project, name, file = "") {
  const cleanProject = sanitizeSegment(project, GLOBAL_PROJECT);
  const cleanName = sanitizeSegment(name, "");
  if (!cleanName) return 0;
  const dir = archiveDir(home, cleanProject);
  if (!existsSync(dir)) return 0;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  const explicit = String(file || "").trim();
  const victims = explicit
    ? files.filter((f) => f === explicit.split(/[\\/]/).pop() && archiveStamp(f).name === cleanName)
    : files.filter((f) => archiveStamp(f).name === cleanName);
  for (const f of victims) await rm(join(dir, f), { force: true });
  await cleanupProject(home, cleanProject);
  return victims.length;
}

/** Locked purge of archived tombstones. */
export async function purgeArchived(home, project, name, file = "") {
  return withWriteLock(home, () => purgeArchivedUnlocked(home, project, name, file));
}

/**
 * Correct a memory by writing its replacement and linking the chain: the new
 * entry records `supersedes = replaces`, the old entry stays on disk with
 * `status: superseded` + `supersededBy = name` (so it is no longer injected,
 * never silently overwritten). Same-name in-place corrections snapshot the
 * previous version into `.history/`.
 *
 * @returns {{ corrected: boolean, entry?: object, replaced?: string, reason?: string }}
 */
async function correctMemoryUnlocked(home, entry) {
  const project = sanitizeSegment(entry.project, GLOBAL_PROJECT);
  const name = sanitizeSegment(entry.name, "");
  const replaces = sanitizeSegment(entry.replaces, "");
  if (!name) return { corrected: false, reason: "invalid-name" };
  if (!replaces) return { corrected: false, reason: "replaces-required" };
  const old = await readMemory(home, project, replaces);
  if (!old) return { corrected: false, reason: "replaces-not-found" };
  if (old.name !== name) {
    await atomicWrite(
      memoryPath(home, project, old.name),
      serializeMemory({ ...old, status: "superseded", supersededBy: name }),
    );
  }
  const stored = await writeMemoryUnlocked(home, {
    name,
    description: entry.description,
    type: entry.type,
    project,
    origin: entry.origin || (old && old.origin) || "agent",
    body: entry.body,
    pinned: entry.pinned,
    supersedes: old.name === name ? old.supersedes : replaces,
    snapshotHistory: old.name === name,
  });
  return { corrected: true, entry: stored, replaced: old.name };
}

/** Locked supersede-chain correction. */
export async function correctMemory(home, entry) {
  return withWriteLock(home, () => correctMemoryUnlocked(home, entry));
}

/** Bump `useCount` / `lastUsedAt` after a successful read (ranking signal). */
async function touchMemoryUnlocked(home, project, name) {
  const cleanProject = sanitizeSegment(project, GLOBAL_PROJECT);
  const cleanName = sanitizeSegment(name, "");
  if (!cleanName) return null;
  const entry = await readMemory(home, cleanProject, cleanName);
  if (!entry) return null;
  const next = { ...entry, useCount: (entry.useCount || 0) + 1, lastUsedAt: Date.now() };
  await atomicWrite(memoryPath(home, cleanProject, cleanName), serializeMemory(next));
  return next;
}

/** Locked usage-counter bump (`memory_get` calls this best-effort). */
export async function touchMemory(home, project, name) {
  return withWriteLock(home, () => touchMemoryUnlocked(home, project, name));
}

// ---- similarity (duplicate / near-duplicate detection) --------------------

function normText(value) {
  return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigramSet(text) {
  const set = new Set();
  for (let i = 0; i + 1 < text.length; i++) set.add(text.slice(i, i + 2));
  return set;
}

/** Dice coefficient over character bigrams (works for CJK and latin slugs). */
export function diceCoefficient(a, b) {
  const na = normText(a);
  const nb = normText(b);
  if (na.length === 0 || nb.length === 0) return na === nb ? 1 : 0;
  if (na === nb) return 1;
  const A = bigramSet(na);
  const B = bigramSet(nb);
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}

/** Tokenize for semantic similarity: latin words + CJK character bigrams. */
function tokenizeForSimilarity(text) {
  const raw = String(text ?? "").toLowerCase();
  const tokens = [];
  for (const match of raw.matchAll(/[a-z0-9][a-z0-9._-]*/g)) tokens.push(match[0]);
  const cjkRuns = raw.match(/[㐀-鿿]+/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

/** Term-frequency bag of one entry; name tokens weigh double. */
function termVector(entry) {
  const bag = new Map();
  const add = (tokens, weight) => {
    for (const token of tokens) bag.set(token, (bag.get(token) || 0) + weight);
  };
  add(tokenizeForSimilarity((entry && entry.name) || ""), 2);
  add(tokenizeForSimilarity((entry && entry.description) || ""), 1);
  return bag;
}

/**
 * TF-IDF cosine over the supplied corpus (the live store). Unlike plain
 * character bigrams it survives paraphrase: two memories saying the same thing
 * with different wording share rare terms (`ctx.remote.$mount`, `@ObservedV2`,
 * `deveco` …), which idf weighting makes visible.
 */
export function semanticSimilarity(a, b, corpus = null) {
  const docs = [a || {}, b || {}];
  if (Array.isArray(corpus)) {
    for (const row of corpus) docs.push(row || {});
  }
  const vectors = docs.map(termVector);
  const df = new Map();
  for (const vector of vectors) {
    for (const token of vector.keys()) df.set(token, (df.get(token) || 0) + 1);
  }
  const idf = (token) => Math.log((vectors.length + 1) / ((df.get(token) || 0) + 1)) + 1;
  const weight = (vector) => {
    const out = new Map();
    for (const [token, tf] of vector) out.set(token, tf * idf(token));
    return out;
  };
  const va = weight(vectors[0]);
  const vb = weight(vectors[1]);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [token, x] of va) {
    normA += x * x;
    const y = vb.get(token);
    if (y) dot += x * y;
  }
  for (const x of vb.values()) normB += x * x;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Cosine scores on short, sparse memory text sit low even for real duplicates
 * (measured: unrelated same-domain pairs top out ~0.19, a paraphrased duplicate
 * scores ~0.47-0.60 on a 71-memory store). SEMANTIC_FLOOR is the empirical
 * corpus noise floor; above it the cosine is mapped into the same [0,1] space
 * as the bigram score so both signals share one threshold.
 */
export const SEMANTIC_FLOOR = 0.28;
const SEMANTIC_BASE = 0.62;
const SEMANTIC_SPAN = 0.38;

/**
 * Second, paraphrase-only tier: a moderate cosine plus a genuinely rewritten
 * description. Calibrated so the live store (2485 pairs) yields zero false
 * positives, while e.g. "npm 包改成本地 link 安装" vs "插件切成 link 安装" (cosine
 * 0.34, description Dice 0.67) is still surfaced as a duplicate hint.
 */
const SEMANTIC_TIER_MIN = 0.30;
const SEMANTIC_TIER_DESC_DICE = 0.55;
const SEMANTIC_TIER_SCORE = 0.74;

/** Map a raw cosine into the bigram-score space (0 at the floor, 1 at equal). */
function semanticScore(semantic) {
  if (semantic <= SEMANTIC_FLOOR) return 0;
  const t = (semantic - SEMANTIC_FLOOR) / (1 - SEMANTIC_FLOOR);
  return SEMANTIC_BASE + SEMANTIC_SPAN * t;
}

/** Combined name+description similarity in [0,1]. */
export function similarityScore(a, b, corpus = null) {
  const nameA = normText(a.name);
  const nameB = normText(b.name);
  const descA = normText(a.description);
  const descB = normText(b.description);
  const nameDice = diceCoefficient(a.name, b.name);
  const descDice = diceCoefficient(a.description, b.description);
  let score = nameDice;
  if (nameDice >= 0.35) score = Math.max(score, 0.35 * nameDice + 0.65 * descDice);
  if (nameA && nameB) {
    const shorter = Math.min(nameA.length, nameB.length);
    if (shorter >= 6 && (nameA.includes(nameB) || nameB.includes(nameA))) score = Math.max(score, 0.92);
  }
  if (a.type && b.type && a.type === b.type) score += 0.03;
  const semantic = semanticSimilarity(a, b, corpus);
  score = Math.max(score, semanticScore(semantic));
  if (semantic >= SEMANTIC_TIER_MIN && descDice >= SEMANTIC_TIER_DESC_DICE) {
    score = Math.max(score, SEMANTIC_TIER_SCORE);
  }
  return Math.min(1, score);
}

/**
 * Minimum combined score that warrants a "similar memory exists" hint.
 * Calibrated against the live store (71 memories / 2485 pairs): unrelated
 * same-prefix topics top out around 0.71, so 0.72 keeps the hint quiet for
 * distinct facts while still catching real near-duplicates (~0.95+).
 */
export const SIMILAR_THRESHOLD = 0.72;

/** Threshold for the review tool's "suspected duplicate" bucket. */
export const DUPLICATE_THRESHOLD = 0.82;

/**
 * Find live memories that look like duplicates of a candidate entry (same
 * project plus global scope). Returns at most `limit` rows, newest first among
 * equals; empty when nothing crosses SIMILAR_THRESHOLD.
 */
export async function findSimilarMemories(home, entry, { limit = 3 } = {}) {
  const project = sanitizeSegment(entry.project, GLOBAL_PROJECT);
  const name = sanitizeSegment(entry.name, "");
  const all = await listMemories(home);
  const rows = [];
  for (const m of all) {
    if ((m.status || "active") !== "active") continue;
    if (m.project !== project && m.project !== GLOBAL_PROJECT) continue;
    if (m.name === name && m.project === project) continue;
    const score = similarityScore(entry, m, all);
    if (score >= SIMILAR_THRESHOLD) rows.push({ id: m.id, name: m.name, description: m.description, type: m.type, score: Math.round(score * 100) / 100 });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}

/** Aggregate list() payload: items + project summaries + overall stats. */
export async function buildListPayload(home, { query = "", project, type } = {}) {
  const all = await listMemories(home);
  const q = String(query || "").trim().toLowerCase();
  let items = all;
  if (q) {
    items = items.filter((m) =>
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q) ||
      String(m.body || "").toLowerCase().includes(q)
    );
  }
  if (project) items = items.filter((m) => m.project === project);
  if (type) items = items.filter((m) => m.type === type);
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const activeAll = all.filter((m) => (m.status || "active") === "active");
  const projectCounts = {};
  const typeCounts = {};
  for (const m of activeAll) {
    projectCounts[m.project] = (projectCounts[m.project] || 0) + 1;
    typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
  }
  const projects = Object.keys(projectCounts)
    .sort()
    .map((key) => ({
      key,
      label: key === GLOBAL_PROJECT ? "全局" : projectLabel(key),
      count: projectCounts[key],
    }));
  const byType = {};
  for (const t of MEMORY_TYPES) byType[t] = typeCounts[t] || 0;

  const archived = await listArchived(home);
  const stats = {
    total: activeAll.length,
    byType,
    superseded: all.length - activeAll.length,
    archived: archived.length,
    pinned: activeAll.filter((m) => m.pinned).length,
  };

  const labeledItems = items.map((m) => ({
    ...m,
    label: m.project === GLOBAL_PROJECT ? "全局" : projectLabel(m.project),
  }));

  return { items: labeledItems, projects, stats, archivedItems: archived };
}

/**
 * Import memories from an existing ZCode memory directory
 * (`~/.zcode/cli/memories`, i.e. `<home>/.zcode/cli/memories`). Scans each
 * project's `memory/` and `topics/` directories, parses ZCode frontmatter and
 * writes them into this store under sanitized project keys, skipping entries
 * whose name already exists in the target project.
 *
 * @returns {{ imported: number, skipped: number, total: number, projects: Array<{source, project, imported, skipped}> }}
 */
export async function importFromZCode(zcodeMemoriesDir, home) {
  const projectsRoot = join(zcodeMemoriesDir, "projects");
  const result = { imported: 0, skipped: 0, total: 0, projects: [] };
  if (!existsSync(projectsRoot)) return result;
  const dirs = (await readdir(projectsRoot, { withFileTypes: true })).filter((d) => d.isDirectory());
  for (const dir of dirs) {
    const project = sanitizeSegment(dir.name, GLOBAL_PROJECT);
    const candidates = [];
    for (const sub of ["memory", "topics"]) {
      const subDir = join(projectsRoot, dir.name, sub);
      if (!existsSync(subDir)) continue;
      for (const file of (await readdir(subDir)).filter((f) => f.endsWith(".md") && !INDEX_FILES.has(f))) {
        candidates.push(join(subDir, file));
      }
    }
    if (candidates.length === 0) continue;
    const existing = new Set((await listMemories(home)).filter((m) => m.project === project).map((m) => m.name));
    let imported = 0;
    let skipped = 0;
    for (const file of candidates) {
      const text = await readFile(file, "utf8");
      const st = await stat(file);
      const { fields, body } = parseFrontmatter(text);
      const entry = normalizeEntry(fields, body, st.mtimeMs);
      if (!entry.name || existing.has(entry.name)) {
        skipped += 1;
        result.skipped += 1;
        result.total += 1;
        continue;
      }
      const bodyText = body.replace(/^\r?\n/, "");
      await writeMemory(home, {
        name: entry.name,
        description: entry.description,
        type: entry.type,
        project,
        origin: entry.origin,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        body: bodyText,
      });
      existing.add(entry.name);
      imported += 1;
      result.imported += 1;
      result.total += 1;
    }
    result.projects.push({
      source: dir.name,
      project,
      imported,
      skipped,
    });
  }
  return result;
}

// ---- auto-load context (prompt injection) --------------------------------

/** Read the plugin config (`autoLoad` / `injectBody`). Defaults: autoLoad on, injectBody off (index-only injection). */
export async function readConfig(home) {
  const p = join(memoriesRoot(home), CONFIG_FILE);
  if (!existsSync(p)) return { autoLoad: true, injectBody: false };
  try {
    const c = JSON.parse(await readFile(p, "utf8"));
    return { autoLoad: c.autoLoad !== false, injectBody: c.injectBody === true };
  } catch {
    return { autoLoad: true, injectBody: false };
  }
}

/** Synchronous variant used by the prompt provider. */
export function readConfigSync(home) {
  const p = join(memoriesRoot(home), CONFIG_FILE);
  if (!existsSync(p)) return { autoLoad: true, injectBody: false };
  try {
    const c = JSON.parse(readFileSync(p, "utf8"));
    return { autoLoad: c.autoLoad !== false, injectBody: c.injectBody === true };
  } catch {
    return { autoLoad: true, injectBody: false };
  }
}

/** Merge a patch into the plugin config and persist it. */
async function writeConfigUnlocked(home, patch) {
  const cur = await readConfig(home);
  const next = { ...cur, ...(patch || {}) };
  await mkdir(memoriesRoot(home), { recursive: true });
  await atomicWrite(join(memoriesRoot(home), CONFIG_FILE), JSON.stringify(next, null, 2));
  return next;
}

/** Locked, atomic config merge. */
export async function writeConfig(home, patch) {
  return withWriteLock(home, () => writeConfigUnlocked(home, patch));
}

/**
 * Synchronous memory rows for one project, used by the prompt section.
 * Reads only `<projects>/<key>/memory/` — never walks the whole store.
 */
function listProjectMemoriesSync(home, projectKey) {
  const key = sanitizeSegment(projectKey, GLOBAL_PROJECT);
  const memDir = join(memoriesRoot(home), "projects", key, "memory");
  const out = [];
  if (!existsSync(memDir)) return out;
  let files = [];
  try {
    files = readdirSync(memDir).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const p = join(memDir, f);
      const info = statSync(p);
      const text = readFileSync(p, "utf8");
      const { fields, body } = parseFrontmatter(text);
      const entry = normalizeEntry(fields, body, info.mtimeMs);
      out.push({
        id: key + "/" + entry.name,
        name: entry.name,
        description: entry.description,
        type: entry.type,
        project: entry.project || key,
        origin: entry.origin,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        status: entry.status,
        pinned: entry.pinned,
        ttlDays: entry.ttlDays,
        lastUsedAt: entry.lastUsedAt,
        useCount: entry.useCount,
        supersededBy: entry.supersededBy,
        body,
      });
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

/** Ranking weights per memory type (pinned dominates everything else). */
const TYPE_WEIGHT = { user: 40, feedback: 34, project: 26, reference: 16, other: 10 };
const ONE_DAY_MS = 86400000;

/** Relevance window for one entry: explicit ttlDays, else its type default. */
function ttlFor(entry) {
  const explicit = Number(entry && entry.ttlDays);
  if (explicit > 0) return explicit;
  return TYPE_TTL_DAYS[(entry && entry.type) || "other"] || 365;
}

/** Days since the entry was last used or updated. */
function entryAgeDays(entry, now) {
  const ts = Math.max(Number(entry.lastUsedAt) || 0, Number(entry.updatedAt) || 0);
  return ts ? (now - ts) / ONE_DAY_MS : 3650;
}

/** True when a non-pinned entry is older than its relevance window. */
export function isStaleMemory(entry, now = Date.now()) {
  return !entry.pinned && entryAgeDays(entry, now) > ttlFor(entry);
}

/** Relevance score used only for ordering the injected index. */
function rankScore(entry, now) {
  let score = entry.pinned ? 1000 : 0;
  score += TYPE_WEIGHT[entry.type] || TYPE_WEIGHT.other;
  score += Math.min(20, (Number(entry.useCount) || 0) * 2);
  score += Math.max(0, 30 - entryAgeDays(entry, now) / 6);
  return score;
}

/** Short provenance label so the model can discount self-authored memories. */
function originTag(origin) {
  const value = String(origin || "manual").toLowerCase();
  if (value === "manual" || value === "user") return "人工";
  if (value === "agent" || value === "ai") return "AI";
  return "导入";
}

/**
 * Build the compact markdown block injected into the model prompt for one
 * workspace: the workspace project's memories plus global memories, ranked
 * (pinned > type > usage > recency) and capped per section and in total.
 *
 * Each line carries its provenance and age — `[type] name — description (AI,
 * 2026-10-30)` — so the model can tell a human-stated fact from its own earlier
 * summary, and a `可能过时` flag when a non-pinned entry outlived its
 * relevance window. Superseded and archived entries are never injected.
 *
 * Two injection modes:
 *   - index mode (default, `injectBody: false`): one compact line per memory;
 *     bodies are read on demand through the `memory_get` tool.
 *   - body mode (`injectBody: true`, legacy ZCode-style): additionally appends
 *     the flattened body truncated to `maxBodyChars`.
 *
 * Empty when autoLoad is off or there is nothing to inject. Synchronous —
 * the prompt section API is sync.
 *
 * @returns {string} the memory context block, or "" when nothing applies.
 */
export function buildMemoryContextSync(
  home,
  workspacePath,
  { maxItems = 24, maxBodyChars = 400, maxDescChars = 160, maxTotalChars = 6000 } = {},
) {
  const config = readConfigSync(home);
  if (config.autoLoad === false) return "";
  const injectBody = config.injectBody === true;
  const project = projectKeyFromPath(workspacePath);
  const now = Date.now();
  const projectRows = listProjectMemoriesSync(home, project).filter((m) => (m.status || "active") === "active");
  const globalRows = listProjectMemoriesSync(home, GLOBAL_PROJECT).filter((m) => (m.status || "active") === "active");
  if (projectRows.length === 0 && globalRows.length === 0) return "";

  const rankAndPick = (arr) =>
    arr
      .map((m) => ({ m, score: rankScore(m, now) }))
      .sort((a, b) => b.score - a.score || (b.m.updatedAt || 0) - (a.m.updatedAt || 0))
      .slice(0, maxItems)
      .map((row) => row.m);

  const projectAll = projectRows;
  const globalAll = globalRows;
  const projectItems = rankAndPick(projectAll);
  const globalItems = rankAndPick(globalAll);
  if (projectItems.length === 0 && globalItems.length === 0) return "";

  const sections = [];
  let budget = maxTotalChars;
  const headingText = (label, total, injected) =>
    "### " + label + "（" + total + " 条" + (injected < total ? "，注入前 " + injected + " 条" : "") + "）";
  const pushItems = (sectionLabel, totalItems, items) => {
    if (items.length === 0) return;
    const heading = headingText(sectionLabel, totalItems, items.length);
    const block = [heading];
    let used = heading.length + 2;
    for (const m of items) {
      const rawDesc = String(m.description || "").replace(/\s+/g, " ").trim();
      const descText = rawDesc.length > maxDescChars ? rawDesc.slice(0, maxDescChars) + "…" : rawDesc;
      const desc = descText ? " — " + descText : "";
      const meta = [originTag(m.origin), fmtDate(m.updatedAt)];
      if (m.pinned) meta.push("置顶");
      if (isStaleMemory(m, now)) meta.push("可能过时");
      let line;
      if (injectBody) {
        const body = String(m.body || "")
          .replace(/[ \t]+/g, " ")
          .replace(/\s*\n\s*/g, " ")
          .trim();
        const clipped = body.length > maxBodyChars ? body.slice(0, maxBodyChars) + "…" : body;
        line = `- [${m.type}] ${m.name}${desc}（${meta.join(", ")}）${clipped ? "\n  " + clipped : ""}`;
      } else {
        line = `- [${m.type}] ${m.name}${desc}（${meta.join(", ")}）`;
      }
      used += line.length + 1;
      if (used > budget) break;
      block.push(line);
    }
    if (block.length > 1) {
      sections.push(block.join("\n"));
      budget -= block.join("\n").length + 1;
    }
  };

  const label = project === GLOBAL_PROJECT ? "全局" : projectLabel(project);
  if (project !== GLOBAL_PROJECT) pushItems("项目记忆（" + label + "）", projectAll.length, projectItems);
  pushItems("全局记忆", globalAll.length, globalItems);
  if (sections.length === 0) return "";

  const pointer = injectBody
    ? "以下是持久记忆，仅在与当前任务相关时参考；括号里的来源（人工/AI/导入）与日期表示证据强度，AI 自己写下的旧结论要打折看待。" +
      "发现值得长期保留的用户偏好、纠正/反馈或项目约定时，用 memory_save 工具保存（同名即更新）；旧结论被推翻时用 memory_correct 取代它，确定无用时用 memory_forget 让它退出索引（可恢复）。"
    : "以下是持久记忆的索引，只含名称与描述；括号里的来源（人工/AI/导入）与日期表示证据强度，AI 自己写下的旧结论要打折看待，标「可能过时」的需先核实再采信。" +
      "某条与当前任务相关时，用 memory_get 工具按名称读取完整内容；发现值得长期保留的用户偏好、纠正/反馈或项目约定时，用 memory_save 工具保存（同名即更新、可用 pinned 置顶）；旧结论被推翻时用 memory_correct 取代它，确定无用时用 memory_forget 让它退出索引（可恢复），memory_review 可列出过时/重复/已取代的条目。";

  return (
    "## 记忆（dsh-memory-manager）\n\n" +
    pointer +
    "\n\n" +
    sections.join("\n\n")
  );
}
