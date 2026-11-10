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
import { existsSync, readdirSync } from "node:fs";
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
  check("config default injectBody false", cfg.injectBody === false);
  const ctxOff = await core.writeConfig(HOME, { autoLoad: false });
  check("config persist false", ctxOff.autoLoad === false);
  const emptyCtx = core.buildMemoryContextSync(HOME, "D:\\proj\\demo");
  check("autoLoad off => empty context", emptyCtx === "");
  await core.writeConfig(HOME, { autoLoad: true });
  const ctx1 = core.buildMemoryContextSync(HOME, "D:\\proj\\demo");
  check("index mode includes project memory line", ctx1.includes("[reference] legacy-note"));
  check("index mode omits body", !ctx1.includes("old body"));
  check("index mode points to memory tools", ctx1.includes("memory_get") && ctx1.includes("memory_save"));
  check("context includes global memory", ctx1.includes("global-note"));
  const ctx2 = core.buildMemoryContextSync(HOME, "D:\\proj\\unknown-proj");
  check("unknown workspace still gets global", ctx2.includes("global-note") && !ctx2.includes("[reference] legacy-note"));
  const cfgSync = core.readConfigSync(HOME);
  check("readConfigSync matches", cfgSync.autoLoad === true && cfgSync.injectBody === false);

  section("injectBody mode (legacy full-body injection)");
  const bodyCfg = await core.writeConfig(HOME, { injectBody: true });
  check("injectBody persisted, autoLoad preserved", bodyCfg.injectBody === true && bodyCfg.autoLoad === true);
  const ctxBody = core.buildMemoryContextSync(HOME, "D:\\proj\\demo");
  check("body mode includes body clip", ctxBody.includes("old body"));
  check("body mode keeps index line", ctxBody.includes("[reference] legacy-note"));
  const ctxBodyGlobal = core.buildMemoryContextSync(HOME, "D:\\proj\\unknown-proj");
  check("body mode still scopes projects", ctxBodyGlobal.includes("global-note") && !ctxBodyGlobal.includes("[reference] legacy-note"));
  await core.writeConfig(HOME, { injectBody: false });
  check("injectBody toggled back off", core.readConfigSync(HOME).injectBody === false);

  section("lifecycle: forget / recycle bin / restore / purge");
  await core.writeMemory(HOME, { name: "to-forget", description: "即将被遗忘", type: "reference", project: "life-proj", body: "v0" });
  const arch = await core.archiveMemory(HOME, "life-proj", "to-forget", "已过时");
  check("forget moves the file out of the live dir", !existsSync(core.memoryPath(HOME, "life-proj", "to-forget")));
  check("forget writes an archive file", Boolean(arch && existsSync(join(core.archiveDir(HOME, "life-proj"), arch.file))));
  const archList = await core.listArchived(HOME, "life-proj");
  check("archive list carries tombstone + reason", archList.length === 1 && archList[0].reason === "已过时" && archList[0].name === "to-forget");
  check("archived entry has no live row", (await core.listMemories(HOME)).every((m) => m.name !== "to-forget"));
  check("archived entry is not injected", !core.buildMemoryContextSync(HOME, "D:\\proj\\life-proj").includes("to-forget"));
  const restored = await core.restoreArchived(HOME, "life-proj", "to-forget");
  check("restore brings the memory back", restored.restored === true && restored.entry.name === "to-forget");
  check("restored entry is injected again", core.buildMemoryContextSync(HOME, "D:\\proj\\life-proj").includes("to-forget"));
  const noBin = await core.restoreArchived(HOME, "life-proj", "to-forget");
  check("restore without a tombstone reports not-found", noBin.restored === false && noBin.reason === "not-found");
  await core.archiveMemory(HOME, "life-proj", "to-forget", "conflict test");
  await core.writeMemory(HOME, { name: "to-forget", description: "同名新记忆", type: "reference", project: "life-proj", body: "v1" });
  const taken = await core.restoreArchived(HOME, "life-proj", "to-forget");
  check("restore refuses to overwrite a live memory", taken.restored === false && taken.reason === "name-taken");
  const purged = await core.purgeArchived(HOME, "life-proj", "to-forget");
  check("purge removes tombstones only", purged === 1 && (await core.listArchived(HOME, "life-proj")).length === 0);
  check("purge kept the live memory", existsSync(core.memoryPath(HOME, "life-proj", "to-forget")));
  check("forget on a missing memory returns null", (await core.archiveMemory(HOME, "life-proj", "missing-memory", "x")) === null);

  section("lifecycle: correct replaces with an audit chain");
  await core.writeMemory(HOME, { name: "old-fact", description: "旧结论：用 V1 装饰器", type: "project", project: "life-proj", body: "V1" });
  const corrected = await core.correctMemory(HOME, { name: "new-fact", description: "新结论：一律用 V2 装饰器", type: "project", project: "life-proj", body: "V2", replaces: "old-fact" });
  check("correct writes the replacement", corrected.corrected === true && corrected.replaced === "old-fact" && corrected.entry.name === "new-fact");
  const oldEntry = await core.readMemory(HOME, "life-proj", "old-fact");
  check("old entry kept as superseded", Boolean(oldEntry) && oldEntry.status === "superseded" && oldEntry.supersededBy === "new-fact");
  const newEntry = await core.readMemory(HOME, "life-proj", "new-fact");
  check("new entry records supersedes", Boolean(newEntry) && newEntry.supersedes === "old-fact");
  const lifecycleCtx = core.buildMemoryContextSync(HOME, "D:\\proj\\life-proj");
  check("superseded entry is not injected", !lifecycleCtx.includes("old-fact"));
  check("replacement entry is injected", lifecycleCtx.includes("new-fact"));
  const lifeIndex = await readFile(join(core.projectDir(HOME, "life-proj"), "MEMORY.md"), "utf8");
  check("index marks the supersede chain", lifeIndex.includes("superseded by new-fact"));
  const sameName = await core.correctMemory(HOME, { name: "new-fact", description: "再次修正", type: "project", project: "life-proj", body: "V2.1", replaces: "new-fact" });
  check("same-name correction keeps a history snapshot", sameName.corrected === true && readdirSync(core.historyDir(HOME, "life-proj")).length >= 1);
  const noReplaces = await core.correctMemory(HOME, { name: "x-fact", description: "x", type: "other", project: "life-proj", body: "x", replaces: "does-not-exist" });
  check("correct against a missing target fails loud", noReplaces.corrected === false && noReplaces.reason === "replaces-not-found");

  section("similarity: duplicate hint without false positives");
  await core.writeMemory(HOME, { name: "arkui-v2-state-required", description: "HarmonyOS UI 状态装饰器一律用 V2（@ObservedV2/@Trace/@Local/@Param）", type: "reference", project: "sim-proj", body: "x" });
  const sim = await core.findSimilarMemories(HOME, { name: "arkui-v2-state-required-copy", description: "HarmonyOS ArkUI 状态装饰器一律用 V2 装饰器", type: "reference", project: "sim-proj" }, { limit: 3 });
  check("near-duplicate name is detected", sim.length >= 1 && sim[0].id === "sim-proj/arkui-v2-state-required" && sim[0].score >= 0.72);
  const unrelated = await core.findSimilarMemories(HOME, { name: "npm-registry-mirror-lag", description: "npm 镜像滞后导致按版本号安装失败", type: "reference", project: "sim-proj" }, { limit: 3 });
  check("unrelated topic is not flagged", unrelated.length === 0);
  const crossProject = await core.findSimilarMemories(HOME, { name: "arkui-v2-state-required", description: "HarmonyOS UI 状态装饰器一律用 V2", type: "reference", project: "other-proj" }, { limit: 3 });
  check("another project's same-name memory is not a duplicate", crossProject.every((s) => s.id !== "sim-proj/arkui-v2-state-required"));

  section("injection: provenance, ranking, stale flag, cap");
  await core.writeMemory(HOME, { name: "human-rule", description: "用户亲口说的硬规则", type: "user", project: "cap-proj", origin: "manual", body: "x" });
  await core.writeMemory(HOME, { name: "ai-note", description: "AI 自己总结的技术笔记", type: "reference", project: "cap-proj", origin: "agent", body: "x" });
  const capCtx = core.buildMemoryContextSync(HOME, "D:\\proj\\cap-proj");
  check("index shows human provenance", capCtx.includes("（人工,"));
  check("index shows AI provenance", capCtx.includes("（AI,"));
  await core.writeMemory(HOME, { name: "pinned-rule", description: "置顶的硬规则", type: "feedback", project: "cap-proj", origin: "manual", pinned: true, body: "x" });
  const pinnedCtx = core.buildMemoryContextSync(HOME, "D:\\proj\\cap-proj");
  const pinnedLines = pinnedCtx.split("\n").filter((l) => l.startsWith("- "));
  check("pinned entry ranks first", pinnedLines.length > 0 && pinnedLines[0].includes("pinned-rule"));
  check("pinned entry is marked", pinnedLines[0].includes("置顶"));
  const staleEntry = await core.writeMemory(HOME, { name: "stale-project-note", description: "180 天前写的项目约定", type: "project", project: "cap-proj", body: "x" });
  await writeFile(
    core.memoryPath(HOME, "cap-proj", "stale-project-note"),
    core.serializeMemory({ ...staleEntry, updatedAt: Date.now() - 200 * 86400000, lastUsedAt: 0 }),
    "utf8",
  );
  check("stale project memory is flagged", core.buildMemoryContextSync(HOME, "D:\\proj\\cap-proj").includes("可能过时"));
  for (let i = 0; i < 30; i += 1) {
    await core.writeMemory(HOME, { name: "cap-" + i, description: "cap item " + i, type: "other", project: "cap2-proj", body: "x" });
  }
  await core.writeMemory(HOME, { name: "cap-pinned", description: "must survive the cap", type: "other", project: "cap2-proj", pinned: true, body: "x" });
  const capCtx2 = core.buildMemoryContextSync(HOME, "D:\\proj\\cap2-proj");
  // Count only the project section: the global section (created by earlier
  // tests) is injected alongside it and would otherwise inflate the count.
  const projectSection = capCtx2.split("### 全局记忆")[0];
  const capLines = projectSection.split("\n").filter((l) => l.startsWith("- "));
  check("index caps at maxItems", capLines.length > 0 && capLines.length <= 24);
  check("pinned entry survives the item cap", capLines.some((l) => l.includes("cap-pinned")));
  check("trimmed heading reports the injected prefix", capCtx2.includes("注入前 24 条"));

  section("touch: usage counter feeds ranking");
  const touched = await core.touchMemory(HOME, "sim-proj", "arkui-v2-state-required");
  check("touch bumps counters", Boolean(touched) && touched.useCount === 1 && touched.lastUsedAt > 0);
  const rereadTouched = await core.readMemory(HOME, "sim-proj", "arkui-v2-state-required");
  check("touch persists on disk", Boolean(rereadTouched) && rereadTouched.useCount === 1);

  section("write safety: lock, atomic write, conflict detection");
  await core.writeMemory(HOME, { name: "race-note", description: "并发写测试", type: "reference", project: "race-proj", body: "v1" });
  const snapshot = await core.readMemory(HOME, "race-proj", "race-note");
  const [winner, loser] = await Promise.allSettled([
    core.writeMemory(HOME, { name: "race-note", description: "并发写测试", type: "reference", project: "race-proj", body: "v2", expectedUpdatedAt: snapshot.updatedAt }),
    core.writeMemory(HOME, { name: "race-note", description: "并发写测试", type: "reference", project: "race-proj", body: "v3", expectedUpdatedAt: snapshot.updatedAt }),
  ]);
  check("exactly one concurrent write wins", winner.status === "fulfilled" && loser.status === "rejected");
  check("the losing write reports write-conflict", loser.reason && loser.reason.code === "write-conflict");
  const raceAfter = await core.readMemory(HOME, "race-proj", "race-note");
  check("the surviving content is one of the two writes", raceAfter && ["v2", "v3"].includes(raceAfter.body));
  const raceDir = core.memoryDir(HOME, "race-proj");
  check("no temp files are left behind", readdirSync(raceDir).every((f) => !f.endsWith(".tmp")));
  check("the store lock is released", !existsSync(join(core.memoriesRoot(HOME), core.LOCK_DIR)));
  let staleError = null;
  try {
    await core.writeMemory(HOME, { name: "race-note", description: "并发写测试", type: "reference", project: "race-proj", body: "v4", expectedUpdatedAt: 1 });
  } catch (error) {
    staleError = error;
  }
  check("a stale expectedUpdatedAt is rejected", staleError && staleError.code === "write-conflict");
  const scoped = await core.listProjectMemories(HOME, "race-proj");
  check("project-scoped listing stays scoped", scoped.length === 1 && scoped[0].name === "race-note");
  const cfgAfter = JSON.parse(await readFile(join(core.memoriesRoot(HOME), "config.json"), "utf8"));
  check("config write stays valid JSON", typeof cfgAfter.autoLoad === "boolean");

  section("similarity: semantic (paraphrase) detection");
  await core.writeMemory(HOME, { name: "link-install-from-npm", description: "把插件从 npm 包改成本地路径 link 安装的具体步骤", type: "reference", project: "sim2-proj", body: "x" });
  const paraphrase = await core.findSimilarMemories(HOME, { name: "dsh-plugin-local-link-install", description: "插件从 npm 包切成 link 安装的做法（本地路径）", type: "reference", project: "sim2-proj" });
  check("paraphrased duplicate with a different name is detected", paraphrase.length >= 1 && paraphrase[0].id === "sim2-proj/link-install-from-npm");
  const unrelatedSem = await core.findSimilarMemories(HOME, { name: "npm-registry-mirror-lag", description: "npm 镜像滞后导致按版本号安装失败", type: "reference", project: "sim2-proj" });
  check("unrelated npm topic stays quiet", unrelatedSem.length === 0);
  check("semanticSimilarity is exported", typeof core.semanticSimilarity === "function" && core.semanticSimilarity({ name: "a", description: "b" }, { name: "a", description: "b" }) >= 0.99);

  section("stats report lifecycle counts");
  const lifePayload = await core.buildListPayload(HOME, { project: "life-proj" });
  check("superseded counted separately", lifePayload.stats.superseded === 1);
  check("archived counted separately", typeof lifePayload.stats.archived === "number");
  check("list payload carries archivedItems", Array.isArray(lifePayload.archivedItems));
  check("superseded row still listed for audit", lifePayload.items.some((m) => m.name === "old-fact" && m.status === "superseded"));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("Failures:\n  - " + failures.join("\n  - "));
    process.exitCode = 1;
  }
} finally {
  await rm(HOME, { recursive: true, force: true });
  await rm(ZCODE, { recursive: true, force: true });
}
