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
 */

import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const MEMORY_TYPES = ["user", "feedback", "reference", "project", "other"];
export const GLOBAL_PROJECT = "global";
export const INDEX_FILE = "MEMORY.md";
export const SUMMARY_FILE = "memory_summary.md";

/** Files that are generated indexes, never memories. */
const INDEX_FILES = new Set([INDEX_FILE, SUMMARY_FILE]);

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
export async function migrateProjectKeys(home) {
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
      await writeFile(target, serializeMemory(stored), "utf8");
      result.moved += 1;
    }
    await rm(srcDir, { recursive: true, force: true });
    affected.add(friendly);
  }
  for (const key of affected) {
    const entries = (await listMemories(home)).filter((e) => e.project === key);
    await writeIndexes(home, key, entries);
  }
  return result;
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
    "---",
  ].join("\n");
  const body = String(entry.body ?? "");
  return head + "\n\n" + body.replace(/^\r?\n/, "") + (body.trim().length > 0 ? "\n" : "");
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
  return {
    name,
    description: String(fields.description || "").trim(),
    type: MEMORY_TYPES.includes(String(fields.type || meta.type || "other").trim())
      ? String(fields.type || meta.type || "other").trim()
      : "other",
    project: sanitizeSegment(fields.project || GLOBAL_PROJECT, GLOBAL_PROJECT),
    origin: String(fields.origin || meta.originSessionId || "manual").trim(),
    createdAt: num(fields.createdAt) || 0,
    updatedAt: num(fields.updatedAt) || mtimeMs,
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
    lines.push(
      "- [" + e.name + "](memory/" + e.name + ".md) — " + (e.description || "(no description)") +
        " (type: " + e.type + ", updated: " + fmtDate(e.updatedAt) + ")"
    );
  }
  await writeFile(join(dir, INDEX_FILE), lines.join("\n") + "\n", "utf8");

  const byType = {};
  for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1;
  const parts = Object.keys(byType)
    .sort()
    .map((t) => t + ": " + byType[t]);
  const summary = [
    "# Memory Summary",
    "",
    "Project `" + project + "` — " + entries.length + " 条记忆" + (parts.length ? "（" + parts.join(" / ") + "）" : "") + "。",
    "",
    "Last updated: " + fmtDate(Date.now()),
    "",
  ].join("\n");
  await writeFile(join(dir, SUMMARY_FILE), summary, "utf8");
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

/** List all memories across projects (no bodies). */
export async function listMemories(home) {
  const root = memoriesRoot(home);
  const projectsRoot = join(root, "projects");
  const out = [];
  let projectKeys = [];
  if (existsSync(projectsRoot)) {
    projectKeys = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
  for (const project of projectKeys) {
    const dir = memoryDir(home, project);
    if (!existsSync(dir)) continue;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const p = join(dir, file);
      const text = await readFile(p, "utf8");
      const st = await stat(p);
      const { fields, body } = parseFrontmatter(text);
      const entry = normalizeEntry(fields, body, st.mtimeMs);
      out.push({
        id: sanitizeSegment(project, GLOBAL_PROJECT) + "/" + entry.name,
        name: entry.name,
        description: entry.description,
        type: entry.type,
        project: entry.project || sanitizeSegment(project, GLOBAL_PROJECT),
        origin: entry.origin,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        size: text.length,
      });
    }
  }
  return out;
}

/**
 * Create or fully replace a memory. Returns the stored entry (with body).
 * When `name` changes and an `oldName` is given, the old file is removed.
 */
export async function writeMemory(home, entry) {
  const project = sanitizeSegment(entry.project, GLOBAL_PROJECT);
  const name = sanitizeSegment(entry.name, "");
  if (!name) throw new Error("invalid name: empty after sanitization");
  const dir = memoryDir(home, project);
  await mkdir(dir, { recursive: true });
  const oldName = entry.oldName ? sanitizeSegment(entry.oldName, "") : null;
  if (oldName && oldName !== name) {
    const oldPath = memoryPath(home, project, oldName);
    if (existsSync(oldPath)) await rm(oldPath, { force: true });
  }
  const now = Date.now();
  const stored = {
    name,
    description: String(entry.description ?? "").trim(),
    type: MEMORY_TYPES.includes(String(entry.type)) ? entry.type : "other",
    project,
    origin: String(entry.origin || "manual").trim(),
    createdAt: Number(entry.createdAt) || now,
    updatedAt: now,
    body: String(entry.body ?? ""),
  };
  await writeFile(memoryPath(home, project, name), serializeMemory(stored), "utf8");
  const all = await listMemories(home);
  const projectEntries = all.filter((e) => e.project === project);
  await writeIndexes(home, project, projectEntries);
  return stored;
}

/** Delete one memory; returns true when a file was actually removed. */
export async function deleteMemory(home, project, name) {
  const cleanProject = sanitizeSegment(project, GLOBAL_PROJECT);
  const cleanName = sanitizeSegment(name, "");
  if (!cleanProject || !cleanName) return false;
  const p = memoryPath(home, cleanProject, cleanName);
  let removed = false;
  if (existsSync(p)) {
    await rm(p, { force: true });
    removed = true;
  }
  const all = await listMemories(home);
  const projectEntries = all.filter((e) => e.project === cleanProject);
  if (projectEntries.length === 0) {
    const dir = projectDir(home, cleanProject);
    if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  } else {
    await writeIndexes(home, cleanProject, projectEntries);
  }
  return removed;
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

  const projectCounts = {};
  const typeCounts = {};
  for (const m of all) {
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

  const labeledItems = items.map((m) => ({
    ...m,
    label: m.project === GLOBAL_PROJECT ? "全局" : projectLabel(m.project),
  }));

  return { items: labeledItems, projects, stats: { total: all.length, byType } };
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
