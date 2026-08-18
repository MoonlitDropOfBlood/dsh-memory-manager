#!/usr/bin/env node
/**
 * Standalone end-to-end self-test for the dsh-memory-manager core.
 *
 * Exercises `memory-core.mjs` against a throwaway DSH home and a simulated
 * ZCode memory directory — no DSH process involved. Run with:
 *
 *   node scripts/self-test.mjs
 *
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../memory-core.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectThrow(label, fn) {
  try {
    await fn();
    check(label, false, "expected an error but none was thrown");
  } catch {
    check(label, true);
  }
}

function section(title) {
  console.log(`\n== ${title}`);
}

const HOME = await mkdtemp(join(tmpdir(), "dsh-memory-test-"));
const ZCODE = await mkdtemp(join(tmpdir(), "dsh-memory-zcode-"));

try {
  section("sanitizeSegment / path safety");
  check("keeps latin slug", core.sanitizeSegment("Hello World!") === "Hello-World");
  check("keeps CJK names", core.sanitizeSegment("以后复杂问题都要先生成计划") === "以后复杂问题都要先生成计划");
  check("blocks traversal", core.sanitizeSegment("../../etc/passwd") === "etc-passwd");
  check("blocks absolute", core.sanitizeSegment("C:\\Windows\\System32") === "C-Windows-System32");
  check("empty falls back", core.sanitizeSegment("", "global") === "global");
  check("projectKeyFromPath basename", core.projectKeyFromPath("D:\\ai-projects\\dsh\\dsh-archive-manager") === "dsh-archive-manager");
  check("projectKeyFromPath global", core.projectKeyFromPath("") === "global");

  section("parseFrontmatter (DSH + ZCode formats)");
  const mine = core.parseFrontmatter(
    "---\nname: my-memory\ndescription: 带 冒号: 的描述\ntype: feedback\nproject: demo\norigin: manual\ncreatedAt: 1700000000000\nupdatedAt: 1700000000000\n---\n\n正文内容"
  );
  check("flat fields parsed", mine.fields.name === "my-memory" && mine.fields.type === "feedback" && mine.fields.project === "demo");
  check("body preserved", mine.body === "正文内容");
  const zcode = core.parseFrontmatter(
    "---\nname: dsh-plugin-client-remote-mount\ndescription: DSH 第三方插件的浏览器端 remote.<ns> 服务必须自己\n  ctx.remote.$mount()；dsh-api-remotes 只硬编码挂载五个官方命名空间\nmetadata:\n  node_type: memory\n  type: reference\n  originSessionId: sess_f02e87c9\n---\n\nbody"
  );
  check("zcode nested metadata type", zcode.fields["metadata.type"] === "reference");
  check("zcode nested origin", zcode.fields["metadata.originSessionId"] === "sess_f02e87c9");
  check("zcode multi-line description joined", zcode.fields.description.includes("ctx.remote.$mount()"));
  check("zcode no frontmatter", core.parseFrontmatter("plain text").fields.name === undefined);

  section("write / read / serialize roundtrip");
  const e1 = await core.writeMemory(HOME, {
    name: "用户偏好-中文记忆",
    description: "default to .docx over PDF",
    type: "feedback",
    project: "demo-proj",
    body: "第一行\n第二行",
  });
  check("created entry returned", e1.name === "用户偏好-中文记忆" && e1.project === "demo-proj" && e1.type === "feedback" && e1.createdAt > 0);
  const r1 = await core.readMemory(HOME, "demo-proj", "用户偏好-中文记忆");
  check("read roundtrip body", r1 && r1.body === "第一行\n第二行");
  check("read roundtrip desc", r1 && r1.description === "default to .docx over PDF");
  const raw1 = await readFile(core.memoryPath(HOME, "demo-proj", "用户偏好-中文记忆"), "utf8");
  check("file has frontmatter", raw1.startsWith("---\nname: 用户偏好-中文记忆"));
  check("index written", existsSync(join(core.projectDir(HOME, "demo-proj"), "MEMORY.md")));
  check("summary written", existsSync(join(core.projectDir(HOME, "demo-proj"), "memory_summary.md")));
  const indexText = await readFile(join(core.projectDir(HOME, "demo-proj"), "MEMORY.md"), "utf8");
  check("index lists memory", indexText.includes("用户偏好-中文记忆") && indexText.includes("type: feedback"));

  section("update / rename");
  const oldPath = core.memoryPath(HOME, "demo-proj", "用户偏好-中文记忆");
  const u1 = await core.writeMemory(HOME, {
    name: "renamed-memory",
    description: "updated",
    type: "user",
    project: "demo-proj",
    body: "new body",
    oldName: "用户偏好-中文记忆",
  });
  check("rename returns new name", u1.name === "renamed-memory" && u1.type === "user");
  check("old file removed", !existsSync(oldPath));
  check("new file exists", existsSync(core.memoryPath(HOME, "demo-proj", "renamed-memory")));
  const r2 = await core.readMemory(HOME, "demo-proj", "renamed-memory");
  check("updated body", r2 && r2.body === "new body");

  section("global + second project + list payload");
  await core.writeMemory(HOME, { name: "global-note", description: "cross project", type: "project", project: "global", body: "g" });
  await core.writeMemory(HOME, { name: "ref-a", description: "reference a", type: "reference", project: "demo-proj", body: "a" });
  const payload = await core.buildListPayload(HOME, {});
  check("total counts", payload.stats.total === 3);
  check("byType counts", payload.stats.byType.user === 1 && payload.stats.byType.reference === 1 && payload.stats.byType.project === 1);
  check("two projects listed", payload.projects.length === 2);
  const filtered = await core.buildListPayload(HOME, { project: "demo-proj" });
  check("project filter", filtered.items.length === 2 && filtered.items.every((m) => m.project === "demo-proj"));
  const qfilter = await core.buildListPayload(HOME, { query: "reference" });
  check("query filter by description", qfilter.items.length === 1 && qfilter.items[0].name === "ref-a");

  section("delete + project cleanup");
  const d1 = await core.deleteMemory(HOME, "demo-proj", "ref-a");
  check("deleted true", d1 === true);
  check("file gone", !existsSync(core.memoryPath(HOME, "demo-proj", "ref-a")));
  const d2 = await core.deleteMemory(HOME, "demo-proj", "does-not-exist");
  check("delete missing false", d2 === false);
  await core.deleteMemory(HOME, "demo-proj", "renamed-memory");
  check("project dir removed when empty", !existsSync(core.projectDir(HOME, "demo-proj")));

  section("importFromZCode");
  const zProj = join(ZCODE, "projects", "hrouter-beb03a33e80b027c");
  await mkdir(join(zProj, "memory"), { recursive: true });
  await mkdir(join(zProj, "topics"), { recursive: true });
  await writeFile(
    join(zProj, "memory", "feedback-prefers-editable-formats.md"),
    "---\nname: feedback-prefers-editable-formats\ndescription: default to .docx over PDF for documents\nmetadata:\n  node_type: memory\n  type: feedback\n  originSessionId: sess_abc\n---\n\n默认用 .docx 而不是 PDF。"
  );
  await writeFile(
    join(zProj, "memory", "用户偏好.md"),
    "---\nname: 用户偏好\ndescription: 中文记忆\nmetadata:\n  node_type: memory\n  type: user\n  originSessionId: sess_xyz\n---\n\n中文正文"
  );
  await writeFile(
    join(zProj, "topics", "topic-1.md"),
    "---\nname: topic-1\ndescription: a topic\ntype: reference\n---\n\ntopic body"
  );
  const imp1 = await core.importFromZCode(ZCODE, HOME);
  check("import total 3", imp1.total === 3 && imp1.imported === 3 && imp1.skipped === 0);
  check("import project keyed", imp1.projects.length === 1 && imp1.projects[0].project === "hrouter-beb03a33e80b027c");
  const imp1r = await core.readMemory(HOME, "hrouter-beb03a33e80b027c", "用户偏好");
  check("imported CJK memory body", imp1r && imp1r.body === "中文正文");
  check("imported type from metadata", imp1r && imp1r.type === "user");
  check("imported origin mapped", imp1r && imp1r.origin === "sess_xyz");
  const imp1t = await core.readMemory(HOME, "hrouter-beb03a33e80b027c", "topic-1");
  check("imported topics dir", imp1t && imp1t.type === "reference");
  const imp2 = await core.importFromZCode(ZCODE, HOME);
  check("re-import dedupes (skipped)", imp2.imported === 0 && imp2.skipped === 3);
  check("import wrote index", existsSync(join(core.projectDir(HOME, "hrouter-beb03a33e80b027c"), "MEMORY.md")));
  const noZcode = await core.importFromZCode(join(HOME, "nope"), HOME);
  check("missing zcode dir is a no-op", noZcode.total === 0 && noZcode.imported === 0);

  section("invalid name rejected");
  await expectThrow("write with empty name throws", () =>
    core.writeMemory(HOME, { name: "   ", project: "global", body: "x" })
  );

  section("migrateProjectKeys (hash-suffixed -> friendly)");
  await core.writeMemory(HOME, { name: "legacy-note", description: "old", type: "reference", project: "demo-abcdef0123456789", body: "old body" });
  // pre-existing friendly project that a second hash project must merge into
  await core.writeMemory(HOME, { name: "existing-note", description: "exists", type: "user", project: "merge", body: "existing" });
  await core.writeMemory(HOME, { name: "legacy-merge-note", description: "to merge", type: "project", project: "merge-0123456789abcdef", body: "merge body" });
  const mig1 = await core.migrateProjectKeys(HOME);
  check("migration moved files (incl. imported hrouter)", mig1.moved >= 4 && mig1.merged === 0);
  check("hash dir removed", !existsSync(join(core.memoriesRoot(HOME), "projects", "demo-abcdef0123456789")));
  check("imported hrouter project migrated", !existsSync(join(core.memoriesRoot(HOME), "projects", "hrouter-beb03a33e80b027c")));
  const migHr = await core.readMemory(HOME, "hrouter", "用户偏好");
  check("imported memory rekeyed to friendly project", migHr && migHr.project === "hrouter" && migHr.body === "中文正文");
  const migNote = await core.readMemory(HOME, "demo", "legacy-note");
  check("migrated memory rekeyed", migNote && migNote.project === "demo" && migNote.body === "old body");
  const mergeDir = core.projectDir(HOME, "merge");
  check("merge target has both", existsSync(join(mergeDir, "memory", "existing-note.md")) && existsSync(join(mergeDir, "memory", "legacy-merge-note.md")));
  const mergeNote = await core.readMemory(HOME, "merge", "legacy-merge-note");
  check("merged memory rekeyed", mergeNote && mergeNote.project === "merge");
  check("merge index regenerated", existsSync(join(mergeDir, "MEMORY.md")));
  const mig2 = await core.migrateProjectKeys(HOME);
  check("migration idempotent", mig2.moved === 0 && mig2.merged === 0);
  const labeled = await core.buildListPayload(HOME, {});
  const demoItem = labeled.items.find((m) => m.name === "legacy-note");
  check("list payload has friendly label", demoItem && demoItem.label === "demo");

  section("config + auto-load prompt context (sync)");
  await core.writeConfig(HOME, { autoLoad: true });
  const cfg = await core.readConfig(HOME);
  check("config roundtrip", cfg.autoLoad === true);
  const ctxOff = await core.writeConfig(HOME, { autoLoad: false });
  check("config persist false", ctxOff.autoLoad === false);
  const emptyCtx = core.buildMemoryContextSync(HOME, "D:\\proj\\demo");
  check("autoLoad off => empty context", emptyCtx === "");
  await core.writeConfig(HOME, { autoLoad: true });
  const ctx1 = core.buildMemoryContextSync(HOME, "D:\\proj\\demo");
  check("context includes project memory", ctx1.includes("[reference] legacy-note") && ctx1.includes("old body"));
  check("context includes global memory", ctx1.includes("global-note"));
  const ctx2 = core.buildMemoryContextSync(HOME, "D:\\proj\\unknown-proj");
  check("unknown workspace still gets global", ctx2.includes("global-note") && !ctx2.includes("[reference] legacy-note"));
  const cfgSync = core.readConfigSync(HOME);
  check("readConfigSync matches", cfgSync.autoLoad === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("Failures:\n  - " + failures.join("\n  - "));
    process.exitCode = 1;
  }
} finally {
  await rm(HOME, { recursive: true, force: true });
  await rm(ZCODE, { recursive: true, force: true });
}
