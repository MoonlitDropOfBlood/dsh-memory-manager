#!/usr/bin/env node
/**
 * Verify dsh-memory-manager against a REAL DSH installation (end to end).
 *
 * The checks in `npm test` run against this repository's own node_modules and
 * mirrored contracts, so they can stay green on a DSH release that refuses to
 * load the plugin at all. This script closes that gap against whatever install
 * is actually running (probed through DSH_INSTALL, plus the default Desktop
 * install location; an absent install is a loud skip, never a silent pass):
 *
 *   1. Boot gate — the real `evaluatePluginCompatibility` from the install's
 *      dsh-app-boot. Since DSH 0.2.0 every `@deepseek-ai/dsh` / `@deepseek-ai/
 *      dsh-*` peer range that does not admit the running runtime drops the
 *      whole bundle into skippedBundles BEFORE a single line of plugin code is
 *      imported ("skipping profile bundle ...", the failure mode that took this
 *      plugin down on 0.2.0-rc.1). Also guards that the declared ranges keep
 *      admitting every older runtime we still support.
 *   2. Host activation — the shipped index.js class is imported from a scratch
 *      directory whose node_modules IS the install, so MemoryService binds to
 *      the runtime's own cordis + typert-protocol, and `[Service.init]` runs
 *      against a throwaway DSH_HOME.
 *   3. Host CRUD round trip — list/get/create/update/delete/importZCode/
 *      getConfig/setConfig through the real service class and memory-core on
 *      the temp home (Chinese names included), files and indexes asserted.
 *   4. Real TypertRegistry — the install's registry accepts the Host manifest
 *      AND the client bundle's $mount contribution (dual-shape codec contract).
 *   5. Memory tools — the install's real `defineTool` accepts the three tool
 *      specs and their execute() paths round trip against the temp home with
 *      the real `exec.agent.session.header.cwd` shape.
 *   6. Client bundle — factory + apply() run clean under the real loader
 *      contract (registration id = package name, inject/apply exports,
 *      style tag lifecycle, settings.section registration shape).
 *
 * Run: node verify-real-install.mjs
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG = "@duke-dsh-plugins/dsh-memory-manager";
const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let skips = 0;
const ok = (label) => console.log(`  ok    ${label}`);
const skip = (label, why) => {
  skips += 1;
  console.log(`  skip  ${label} (${why})`);
};
const fail = (label, error) => {
  failures += 1;
  console.error(`  FAIL  ${label}\n        ${error instanceof Error ? error.message : error}`);
};
const attempt = async (label, fn) => {
  try {
    await fn();
    ok(label);
  } catch (error) {
    fail(label, error);
  }
};

const PACKAGE_MANIFEST = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));

// --- locate a real DSH installation ------------------------------------------

function findInstall() {
  const candidates = [
    process.env.DSH_INSTALL,
    path.join(os.homedir(), "AppData", "Roaming", "DeepSeek Harness Desktop", "dsh"),
  ].filter(Boolean);
  for (const root of candidates) {
    if (existsSync(path.join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"))) return root;
  }
  return null;
}

const installRoot = findInstall();
if (installRoot === null) {
  console.log("  skip  real DSH install not found (set DSH_INSTALL to the dsh install directory)");
  console.log("\nNO REAL INSTALL FOUND — nothing was verified against a running DSH build");
  process.exit(2);
}

const installNodeModules = path.join(installRoot, "node_modules");
const installPkg = (name) => path.join(installNodeModules, name, "package.json");
const runtimeVersion = JSON.parse(readFileSync(installPkg("@deepseek-ai/dsh"), "utf8")).version;
console.log(`\nreal DSH install: ${installRoot} (dsh ${runtimeVersion})`);

// Isolate the run: every home() read inside the plugin resolves through
// DSH_HOME, so a throwaway home keeps the real profile untouched.
const tempHome = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-manager-home-"));
process.env.DSH_HOME = tempHome;

// --- cordis-shaped fake context ----------------------------------------------

function runEffect(fn) {
  const cleanups = [];
  const result = fn();
  if (result && typeof result.next === "function") {
    let step = result.next();
    while (!step.done) {
      if (typeof step.value === "function") cleanups.push(step.value);
      step = result.next();
    }
  } else if (typeof result === "function") {
    cleanups.push(result);
  }
  return () => {
    while (cleanups.length > 0) {
      try {
        cleanups.pop()();
      } catch {
        /* disposers are best-effort in tests */
      }
    }
  };
}

function makeCtx(extra = {}) {
  const ctx = {
    root: { fiber: null, registry: { counter: 1 }, reflect: null },
    extend: () => ctx,
    logger: { warn() {}, error() {} },
    on() {
      return () => {};
    },
    get(name) {
      return extra[name];
    },
    reflect: {
      props: Object.create(null),
      provide(name) {
        ctx.reflect.props[name] = { type: "service" };
        return () => {
          delete ctx.reflect.props[name];
        };
      },
    },
    effect(fn) {
      return runEffect(fn);
    },
  };
  ctx.root.reflect = ctx.reflect;
  return Object.assign(ctx, extra);
}

// ---------------------------------------------------------------------------
// 1. The boot gate: would dsh-app-boot drop this bundle from the profile?
// ---------------------------------------------------------------------------

console.log("\n[1] profile bundle boot gate (dsh-app-boot compatibility)");

const appBootFile = path.join(installNodeModules, "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
if (!existsSync(appBootFile)) {
  skip("dsh-app-boot", `${appBootFile} not present`);
} else {
  const { evaluatePluginCompatibility } = await import(pathToFileURL(appBootFile).href);
  if (typeof evaluatePluginCompatibility !== "function") {
    skip("evaluatePluginCompatibility", "this dsh build has no peer compatibility gate");
  } else {
    // No exemptions: a fix must be a truthful range, never a granted bypass.
    const issue = evaluatePluginCompatibility(PACKAGE_MANIFEST, {});
    if (issue === undefined) {
      ok(`peerDependencies admit the running dsh ${runtimeVersion} (no exemption needed)`);
    } else {
      fail(
        `peerDependencies admit the running dsh ${runtimeVersion}`,
        new Error(
          `dsh would skip this bundle: ${JSON.stringify(issue.peers)} ` +
            `(declared ${JSON.stringify(PACKAGE_MANIFEST.peerDependencies)})`,
        ),
      );
    }
    // The 0.2.0 widening must never silently drop the older runtimes this
    // plugin still supports (the app-boot predicate, mirrored: every
    // @deepseek-ai/dsh / @deepseek-ai/dsh-* peer must admit the runtime).
    let semver;
    try {
      semver = createRequire(installPkg("@deepseek-ai/dsh"))("semver");
    } catch (error) {
      skip("older-runtime peer coverage", `semver not resolvable from the dsh install (${error.message})`);
    }
    if (semver) {
      const dshPeers = Object.entries(PACKAGE_MANIFEST.peerDependencies).filter(
        ([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"),
      );
      for (const runtime of ["0.1.0-rc.7", "0.1.5", "0.1.7", runtimeVersion]) {
        const rejected = dshPeers.filter(([, range]) => !semver.satisfies(runtime, range, { includePrerelease: true }));
        if (rejected.length === 0) {
          ok(`peerDependencies still admit dsh ${runtime}`);
        } else {
          fail(
            `peerDependencies still admit dsh ${runtime}`,
            new Error(`incompatible: ${rejected.map(([n, r]) => `${n}@${r}`).join(", ")}`),
          );
        }
      }
    }
    // Market-facing declaration: dshmarket reads the top-level engines.dsh
    // first, falls back to dsh.engines.dsh, and conjuncts the result with the
    // dsh* peer ranges — the effective declaration must admit 0.2.0 too.
    const enginesDsh =
      (typeof PACKAGE_MANIFEST.engines && PACKAGE_MANIFEST.engines && PACKAGE_MANIFEST.engines.dsh) ||
      (PACKAGE_MANIFEST.dsh && PACKAGE_MANIFEST.dsh.engines && PACKAGE_MANIFEST.dsh.engines.dsh);
    if (semver && typeof enginesDsh === "string") {
      if (semver.satisfies(runtimeVersion, enginesDsh, { includePrerelease: true })) {
        ok(`engines.dsh (${enginesDsh}) admits the running dsh ${runtimeVersion}`);
      } else {
        fail(`engines.dsh (${enginesDsh}) admits the running dsh ${runtimeVersion}`, new Error(`dshmarket would flag ${runtimeVersion} as incompatible`));
      }
    } else {
      skip("engines.dsh coverage", "no engines.dsh declared in any shape");
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Host activation against the install's own cordis + typert-protocol.
// ---------------------------------------------------------------------------

console.log(`\n[2] host activation on dsh ${runtimeVersion}`);

/**
 * index.js resolves `@deepseek-ai/*` from its own directory's node_modules,
 * which here pins the repo's devDependencies. Re-import the shipped bytes from
 * a scratch directory whose node_modules IS the dsh installation, so the class
 * binds to the runtime under test. `./memory-core.mjs` is relative, so it is
 * copied alongside.
 */
async function loadHostAgainstInstall() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-manager-host-"));
  symlinkSync(installNodeModules, path.join(scratch, "node_modules"), "junction");
  writeFileSync(path.join(scratch, "package.json"), JSON.stringify({ name: "host-under-test", type: "module" }));
  writeFileSync(path.join(scratch, "index.js"), readFileSync(path.join(here, "index.js")));
  writeFileSync(path.join(scratch, "memory-core.mjs"), readFileSync(path.join(here, "memory-core.mjs")));
  const module = await import(pathToFileURL(path.join(scratch, "index.js")).href);
  const { Service } = await import(
    pathToFileURL(path.join(installNodeModules, "@deepseek-ai", "cordis", "lib", "index.js")).href
  );
  const { remoteMethods } = await import(
    pathToFileURL(path.join(installNodeModules, "@deepseek-ai", "dsh-typert-protocol", "lib", "index.js")).href
  );
  return { ...module, Service, remoteMethods, scratch };
}

const EXPECTED_REMOTE_METHODS = ["list", "get", "create", "update", "delete", "importZCode", "getConfig", "setConfig"];

let host = null;
await attempt("index.js imports against the installation's cordis/typert-protocol", async () => {
  host = await loadHostAgainstInstall();
});

if (host) {
  let instance = null;
  await attempt(`MemoryService activates and marks all ${EXPECTED_REMOTE_METHODS.length} remote methods on dsh ${runtimeVersion}`, async () => {
    instance = new host.MemoryService(makeCtx(), {});
    instance[host.Service.init]();
    const methods = host.remoteMethods(instance).map((m) => m.method);
    for (const expected of EXPECTED_REMOTE_METHODS) {
      if (!methods.includes(expected)) throw new Error(`remoteMethods missing "${expected}" (got ${JSON.stringify(methods)})`);
    }
    if (instance.name !== "memoryManager") throw new Error(`service key is ${instance.name}`);
    if (!instance.home() || !instance.home().startsWith(tempHome)) {
      throw new Error(`home() escaped the throwaway DSH_HOME: ${instance.home()}`);
    }
  });

  // --- 3. Host CRUD round trip through the real service ---------------------

  console.log("\n[3] host CRUD round trip (real service class + memory-core)");

  if (instance) {
    await attempt("create → list → get round trip (Chinese name, file + index on disk)", async () => {
      const created = await instance.create({
        name: "中文记忆-端到端",
        description: "verify-real-install 冒烟",
        type: "reference",
        project: "global",
        body: "# 正文\n\n端到端内容。",
      });
      if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
      const id = created.value.item.id;
      if (id !== "global/中文记忆-端到端") throw new Error(`unexpected id ${id}`);
      const file = path.join(tempHome, "memories", "projects", "global", "memory", "中文记忆-端到端.md");
      if (!existsSync(file)) throw new Error(`memory file missing at ${file}`);
      if (!existsSync(path.join(tempHome, "memories", "projects", "global", "MEMORY.md"))) {
        throw new Error("MEMORY.md index was not regenerated");
      }
      const listed = await instance.list({ query: "端到端" });
      if (!listed.ok) throw new Error(`list failed: ${JSON.stringify(listed.error)}`);
      if (listed.value.stats.total < 1) throw new Error("list did not see the new memory");
      if (!Array.isArray(listed.value.types) || listed.value.types.length === 0) throw new Error("list payload lost types");
      const got = await instance.get({ id });
      if (!got.ok) throw new Error(`get failed: ${JSON.stringify(got.error)}`);
      if (!String(got.value.item.body).includes("端到端内容")) throw new Error("body did not round trip");
    });

    await attempt("update renames and rewrites (old file gone, new file correct)", async () => {
      const before = await instance.get({ id: "global/中文记忆-端到端" });
      const updated = await instance.update({
        id: "global/中文记忆-端到端",
        name: "renamed-e2e",
        type: "project",
        body: "# 更新后的正文",
      });
      if (!updated.ok) throw new Error(`update failed: ${JSON.stringify(updated.error)}`);
      if (updated.value.item.id !== "global/renamed-e2e") throw new Error(`unexpected new id ${updated.value.item.id}`);
      if (existsSync(path.join(tempHome, "memories", "projects", "global", "memory", "中文记忆-端到端.md"))) {
        throw new Error("old file survived the rename");
      }
      const reread = await instance.get({ id: "global/renamed-e2e" });
      if (!reread.ok) throw new Error(`re-read failed: ${JSON.stringify(reread.error)}`);
      if (reread.value.item.type !== "project") throw new Error("type change lost");
      if (!String(reread.value.item.body).includes("更新后的正文")) throw new Error("body change lost");
    });

    await attempt("importZCode imports a synthetic ZCode tree and skips duplicates on re-run", async () => {
      const zcode = mkdtempSync(path.join(os.tmpdir(), "dsh-memory-manager-zcode-"));
      try {
        const proj = path.join(zcode, "projects", "proj-x");
        mkdirSync(path.join(proj, "memory"), { recursive: true });
        mkdirSync(path.join(proj, "topics"), { recursive: true });
        writeFileSync(path.join(proj, "memory", "znote.md"), "---\nname: znote\ndescription: 来自 ZCode\ntype: reference\n---\n\nZCode 正文\n");
        writeFileSync(path.join(proj, "topics", "ztopic.md"), "---\nname: ztopic\ndescription: 主题记忆\ntype: project\n---\n\n主题正文\n");
        writeFileSync(path.join(proj, "MEMORY.md"), "- [reference] znote — 来自 ZCode\n"); // index, never a memory
        const first = await instance.importZCode({ source: zcode });
        if (!first.ok) throw new Error(`import failed: ${JSON.stringify(first.error)}`);
        if (first.value.imported !== 2) throw new Error(`expected 2 imported, got ${JSON.stringify(first.value)}`);
        const second = await instance.importZCode({ source: zcode });
        if (!second.ok) throw new Error(`re-import failed: ${JSON.stringify(second.error)}`);
        if (second.value.skipped !== 2 || second.value.imported !== 0) {
          throw new Error(`re-import should skip everything, got ${JSON.stringify(second.value)}`);
        }
      } finally {
        rmSync(zcode, { recursive: true, force: true });
      }
    });

    await attempt("getConfig / setConfig round trip (partial merge keeps the other field)", async () => {
      const before = await instance.getConfig();
      if (!before.ok) throw new Error(`getConfig failed: ${JSON.stringify(before.error)}`);
      const flipped = await instance.setConfig({ injectBody: !before.value.config.injectBody });
      if (!flipped.ok) throw new Error(`setConfig failed: ${JSON.stringify(flipped.error)}`);
      if (flipped.value.config.injectBody === before.value.config.injectBody) throw new Error("injectBody did not flip");
      if (flipped.value.config.autoLoad !== before.value.config.autoLoad) throw new Error("autoLoad was clobbered by a partial set");
      const after = await instance.getConfig();
      if (after.value.config.injectBody !== flipped.value.config.injectBody) throw new Error("config did not persist");
    });

    await attempt("delete removes the file and cleans the empty project", async () => {
      const removed = await instance.delete({ id: "global/renamed-e2e" });
      if (!removed.ok) throw new Error(`delete failed: ${JSON.stringify(removed.error)}`);
      if (existsSync(path.join(tempHome, "memories", "projects", "global", "memory", "renamed-e2e.md"))) {
        throw new Error("file survived delete");
      }
      const missing = await instance.get({ id: "global/renamed-e2e" });
      if (missing.ok !== false || missing.error.code !== "not-found") throw new Error("deleted memory still readable");
      const gone = await instance.delete({ id: "global/renamed-e2e" });
      if (gone.ok !== false || gone.error.code !== "not-found") throw new Error("second delete should report not-found");
    });
  }
}

// --- 4 + 5. Client bundle (real factory/apply) and real TypertRegistry ------

console.log("\n[4] client bundle apply under the real loader contract");

// Minimal but observable DOM: enough for the bundle's style tag + nav icon
// observer, and it records what happened so the assertions below are real.
function makeDom() {
  const appended = [];
  const element = (tag) => ({
    tagName: tag,
    textContent: "",
    remove() {
      this.removed = true;
    },
  });
  const head = { appendChild: (el) => appended.push(el) };
  return {
    appended,
    head,
    createElement: (tag) => element(tag),
    querySelectorAll: () => [],
    body: {},
  };
}

let CLIENT_REMOTE = null;
let clientResult = null;
try {
  globalThis.window = {
    __ModuleLoader__: {
      load: (registration) => {
        clientResult = registration;
      },
    },
  };
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {}

    disconnect() {}
  };
  await import(pathToFileURL(path.join(here, "client.js")).href);
  if (!clientResult) throw new Error("client.js never called window.__ModuleLoader__.load");
  if (clientResult.id !== PKG) throw new Error(`registration id ${clientResult.id} must equal the package name ${PKG} (client-modules route check)`);

  const dom = makeDom();
  const effects = [];
  const mounted = [];
  const slotRegistrations = [];
  const stubRemote = {
    $mount: async (contribution) => {
      mounted.push(contribution);
      return () => {};
    },
  };
  const ctx = {
    remote: stubRemote,
    get: (name) => (name === "remote.memoryManager" ? { list: async () => ({ ok: true, value: {} }) } : {}),
    effect: (fn) => {
      const disposer = fn();
      effects.push(typeof disposer === "function" ? disposer : () => {});
      return disposer;
    },
    slots: {
      inject: (name, register) => {
        if (name !== "settings.section") throw new Error(`unexpected slot ${name}`);
        register();
      },
      register: (declaration, component) => {
        slotRegistrations.push({ declaration, component });
      },
    },
  };
  globalThis.document = dom;
  const moduleExports = clientResult.factory((spec) => {
    if (spec === "react" || spec === "react/jsx-runtime") {
      return { createElement: () => null, useState: (v) => [v, () => {}], useCallback: (f) => f, useEffect: () => {}, useMemo: (f) => f() };
    }
    if (spec === "@deepseek-ai/dsh-client-ui-primitives") return { Button: () => null };
    throw new Error(`client.js factory must not require unexpected module: ${spec}`);
  });
  if (typeof moduleExports.apply !== "function") throw new Error("client module must export apply()");
  if (!Array.isArray(moduleExports.inject) || !moduleExports.inject.includes("slots") || !moduleExports.inject.includes("remote")) {
    throw new Error(`client module inject must be ["slots","remote"], got ${JSON.stringify(moduleExports.inject)}`);
  }
  await moduleExports.apply(ctx);

  if (mounted.length !== 1) throw new Error(`apply() must mount exactly one Remote contribution, got ${mounted.length}`);
  CLIENT_REMOTE = mounted[0];
  if (!CLIENT_REMOTE || !Array.isArray(CLIENT_REMOTE.descriptors) || CLIENT_REMOTE.descriptors.length !== 8) {
    throw new Error("CLIENT_REMOTE must carry the 8 memoryManager descriptors");
  }
  if (dom.appended.length !== 1 || dom.appended[0].removed) throw new Error("apply() must inject exactly one live style tag");
  if (effects.length < 2) throw new Error(`apply() must register its cleanup effects, got ${effects.length}`);
  effects.forEach((dispose) => dispose());
  if (!dom.appended[0].removed) throw new Error("style tag was not removed by the effect disposer");
  const section = slotRegistrations.find((r) => r.declaration.name === "settings.section");
  if (!section) throw new Error("apply() never registered the settings.section slot");
  if (section.declaration.id !== "memory-manager" || section.declaration.order !== 30) {
    throw new Error(`settings.section declaration mismatch: ${JSON.stringify(section.declaration)}`);
  }
  if (typeof section.declaration.label !== "function" || section.declaration.label() !== "记忆管理") {
    throw new Error("settings.section label() must return the 记忆管理 label");
  }
  if (typeof section.component !== "function") throw new Error("settings.section must carry the page component");
  ok("client bundle registers, applies, and cleans up (style, effects, settings.section)");
} catch (error) {
  fail("client bundle apply under the real loader contract", error);
} finally {
  delete globalThis.document;
  delete globalThis.MutationObserver;
  delete globalThis.window;
}

console.log("\n[5] real TypertRegistry accepts Host manifest + Client descriptors");

{
  const registryFile = path.join(installNodeModules, "@deepseek-ai", "dsh-typert-registry", "lib", "index.js");
  if (!existsSync(registryFile) || !CLIENT_REMOTE) {
    skip("TypertRegistry", !existsSync(registryFile) ? `${registryFile} not present` : "client contribution unavailable");
  } else {
    await attempt("registry.register(TYPERT) + registry.remotes.register(CLIENT_REMOTE)", async () => {
      const { TypertRegistry } = await import(pathToFileURL(registryFile).href);
      const { TYPERT } = await import(pathToFileURL(path.join(here, "typert.host.js")).href);
      const stubCtx = {
        reflect: { provide() {} },
        logger: { warn() {} },
        effect(fn) {
          const iterator = fn();
          iterator.next();
          return () => {};
        },
      };
      const registry = new TypertRegistry(stubCtx);
      registry.register(TYPERT);
      registry.remotes.register(CLIENT_REMOTE);
    });
  }
}

console.log("\n[6] memory tools through the installation's real dsh-tools");

{
  const toolsFile = path.join(installNodeModules, "@deepseek-ai", "dsh-tools", "lib", "index.js");
  if (!existsSync(toolsFile) || !host) {
    skip("dsh-tools", !existsSync(toolsFile) ? `${toolsFile} not present` : "host module unavailable");
  } else {
    await attempt("defineTool accepts memory_save / memory_get / memory_list specs (real DSL validator)", async () => {
      const { defineTool } = await import(pathToFileURL(toolsFile).href);
      const instance = new host.MemoryService(makeCtx(), {});
      instance[host.Service.init]();
      const registered = [];
      const sections = [];
      const fakeTools = { register: (tool) => registered.push(tool) };
      const fakeSystemPrompt = { section: (s) => sections.push(s) };
      // Rebind the private registration with the real defineTool + capture.
      host.MemoryService.prototype._registerMemoryTools.call(instance, fakeTools, defineTool);
      // _registerMemoryTools reads systemPrompt via ctx — patch a ctx that has it.
      if (registered.length !== 3) {
        throw new Error(`expected 3 tools registered, got ${registered.length}: ${registered.map((t) => t.name).join(", ")}`);
      }
      for (const expected of ["memory_save", "memory_get", "memory_list"]) {
        if (!registered.some((t) => t.name === expected)) throw new Error(`tool ${expected} missing`);
      }
      const workspaceDir = path.join(tempHome, "workspace-proj");
      mkdirSync(workspaceDir, { recursive: true });
      const exec = { agent: { session: { header: { cwd: workspaceDir } } } };

      const saved = await registered[0].execute({ name: "tool-e2e", description: "工具回路", type: "user", body: "偏好内容" }, exec);
      if (!saved || saved.saved !== true || saved.updated !== false) throw new Error(`memory_save returned ${JSON.stringify(saved)}`);
      if (!saved.id.startsWith("workspace-proj/")) throw new Error(`memory_save ignored the session cwd: ${saved.id}`);
      if (!existsSync(path.join(tempHome, "memories", "projects", "workspace-proj", "memory", "tool-e2e.md"))) {
        throw new Error("memory_save did not write through the session cwd");
      }

      const updated = await registered[0].execute({ name: "tool-e2e", description: "工具回路", type: "user", body: "偏好内容2" }, exec);
      if (!updated || updated.updated !== true) throw new Error(`memory_save upsert broke: ${JSON.stringify(updated)}`);

      const got = await registered[1].execute({ name: "tool-e2e" }, exec);
      if (!got || got.found !== true || !got.item || !String(got.item.body).includes("偏好内容2")) {
        throw new Error(`memory_get returned ${JSON.stringify(got)}`);
      }

      const listed = await registered[2].execute({ query: "工具回路" }, exec);
      if (!listed || listed.total !== 1 || listed.items.length !== 1) throw new Error(`memory_list returned ${JSON.stringify(listed)}`);
    });
  }
}

// --- summary -----------------------------------------------------------------

rmSync(tempHome, { recursive: true, force: true });
if (host && host.scratch) rmSync(host.scratch, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}${skips > 0 ? ` (${skips} skipped)` : ""}`);
process.exit(failures === 0 ? 0 : 1);
