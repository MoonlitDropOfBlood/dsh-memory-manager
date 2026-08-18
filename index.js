/**
 * dsh-memory-manager — Host half.
 *
 * A Cordis "class plugin": this module exports a `MemoryService` extending
 * `TypertRemoteService`. The DSH loader instantiates the class and registers it
 * as the `memoryManager` service; the Typert Gateway exposes its `@Remote`-marked
 * methods to the browser Client half under the `memoryManager` Remote namespace.
 *
 * Responsibilities (ported from ZCode's project memory):
 *   - persistent per-project + global memory store as markdown files under
 *     `<DSH_HOME>/memories/projects/<projectKey>/memory/<name>.md`, with a
 *     regenerated `MEMORY.md` index and `memory_summary.md` per project;
 *   - CRUD Remote methods (`list / get / create / update / delete`);
 *   - `importZCode`: one-click import of an existing ZCode memory directory
 *     (`~/.zcode/cli/memories`), preserving names, types, descriptions and
 *     bodies, deduplicated by project + name.
 *
 * All file I/O goes through `node:fs` directly (the Host half of a formal DSH
 * plugin runs inside the DSH Node process with full privileges, exactly like
 * DSH core code that writes `~/.dsh`); no shell sandbox is involved.
 */

import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { Service } from "@deepseek-ai/cordis";
import {
  MEMORY_TYPES,
  GLOBAL_PROJECT,
  buildListPayload,
  deleteMemory,
  importFromZCode,
  readMemory,
  resolveDshHome,
  resolveZCodeMemoriesDir,
  sanitizeSegment,
  writeMemory,
} from "./memory-core.mjs";

/**
 * Mark one instance method as a Remote export without relying on decorator
 * syntax (Node ESM does not support the proposal decorators here). We drive
 * the same `Remote(name)` decorator manually through a synthetic decorator
 * context and run the registered initializers against the instance.
 */
function markRemoteMethod(instance, method, exportName) {
  const decorator = Remote(method, undefined);
  const initializers = [];
  decorator(undefined, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer: (fn) => initializers.push(fn),
  });
  for (const fn of initializers) fn.call(instance);
}

/** Split a composite id `project/name` into its two sanitized parts. */
function splitId(id) {
  const s = String(id || "");
  const slash = s.indexOf("/");
  if (slash < 0) return { project: GLOBAL_PROJECT, name: sanitizeSegment(s, "") };
  return {
    project: sanitizeSegment(s.slice(0, slash), GLOBAL_PROJECT),
    name: sanitizeSegment(s.slice(slash + 1), ""),
  };
}

export class MemoryService extends TypertRemoteService {
  static inject = ["workspaceRegistry"];

  /**
   * Cordis instantiates class plugins with `new Callback(ctx, config)` — the
   * second argument is the plugin config, NOT the service key. Without an
   * explicit constructor the config would be passed as `serviceKey` and the
   * `validateName` check throws, so the `memoryManager` service would never be
   * registered and the client would stay pending forever.
   */
  constructor(ctx, config) {
    super(ctx, "memoryManager");
    this._ctx = ctx;
  }

  /** Cordis class-plugin initializer: runs after construction, before publish. */
  [Service.init]() {
    markRemoteMethod(this, "list", "list");
    markRemoteMethod(this, "get", "get");
    markRemoteMethod(this, "create", "create");
    markRemoteMethod(this, "update", "update");
    markRemoteMethod(this, "delete", "delete");
    markRemoteMethod(this, "importZCode", "importZCode");
  }

  home() {
    return resolveDshHome();
  }

  /** Optional workspace slugs the Client suggests when choosing a project. */
  workspaceHints() {
    const registry = this._ctx.get("workspaceRegistry");
    if (!registry || typeof registry.list !== "function") return [];
    try {
      return registry
        .list()
        .map((ws) => {
          const path = ws && (ws.path || ws.cwd);
          if (typeof path !== "string" || path.length === 0) return null;
          return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
        })
        .filter(Boolean)
        .map((label) => sanitizeSegment(label, ""))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async list(request = {}) {
    try {
      const payload = await buildListPayload(this.home(), {
        query: request && request.query,
        project: request && request.project,
        type: request && request.type,
      });
      return {
        ok: true,
        value: {
          items: payload.items,
          projects: payload.projects,
          stats: payload.stats,
          workspaces: this.workspaceHints(),
          types: MEMORY_TYPES,
          globalProject: GLOBAL_PROJECT,
        },
      };
    } catch (error) {
      return { ok: false, error: { code: "list-failed", message: String(error && error.message ? error.message : error) } };
    }
  }

  async get(request) {
    try {
      const { project, name } = splitId(request && request.id);
      const entry = await readMemory(this.home(), project, name);
      if (!entry) return { ok: false, error: { code: "not-found", message: "记忆不存在" } };
      return {
        ok: true,
        value: {
          item: {
            id: entry.project + "/" + entry.name,
            name: entry.name,
            description: entry.description,
            type: entry.type,
            project: entry.project,
            origin: entry.origin,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            body: entry.body,
          },
        },
      };
    } catch (error) {
      return { ok: false, error: { code: "get-failed", message: String(error && error.message ? error.message : error) } };
    }
  }

  async create(request) {
    try {
      const r = request || {};
      if (!r.name || String(r.name).trim().length === 0) {
        return { ok: false, error: { code: "invalid-name", message: "名称不能为空" } };
      }
      const stored = await writeMemory(this.home(), {
        name: r.name,
        description: r.description,
        type: r.type,
        project: r.project,
        origin: r.origin,
        body: r.body,
      });
      return {
        ok: true,
        value: {
          item: {
            id: stored.project + "/" + stored.name,
            name: stored.name,
            description: stored.description,
            type: stored.type,
            project: stored.project,
            origin: stored.origin,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            body: stored.body,
          },
        },
      };
    } catch (error) {
      return { ok: false, error: { code: "create-failed", message: String(error && error.message ? error.message : error) } };
    }
  }

  async update(request) {
    try {
      const r = request || {};
      const { project, name } = splitId(r.id);
      const existing = await readMemory(this.home(), project, name);
      if (!existing) return { ok: false, error: { code: "not-found", message: "记忆不存在" } };
      const stored = await writeMemory(this.home(), {
        name: r.name !== undefined ? r.name : existing.name,
        description: r.description !== undefined ? r.description : existing.description,
        type: r.type !== undefined ? r.type : existing.type,
        project: r.project !== undefined ? r.project : existing.project,
        origin: r.origin !== undefined ? r.origin : existing.origin,
        body: r.body !== undefined ? r.body : existing.body,
        oldName: existing.name,
      });
      return {
        ok: true,
        value: {
          item: {
            id: stored.project + "/" + stored.name,
            name: stored.name,
            description: stored.description,
            type: stored.type,
            project: stored.project,
            origin: stored.origin,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            body: stored.body,
          },
        },
      };
    } catch (error) {
      return { ok: false, error: { code: "update-failed", message: String(error && error.message ? error.message : error) } };
    }
  }

  async delete(request) {
    try {
      const { project, name } = splitId(request && request.id);
      const removed = await deleteMemory(this.home(), project, name);
      if (!removed) return { ok: false, error: { code: "not-found", message: "记忆不存在或已删除" } };
      return { ok: true, value: { deleted: true } };
    } catch (error) {
      return { ok: false, error: { code: "delete-failed", message: String(error && error.message ? error.message : error) } };
    }
  }

  async importZCode(request = {}) {
    try {
      const zcodeDir = request && request.source
        ? String(request.source)
        : resolveZCodeMemoriesDir();
      const result = await importFromZCode(zcodeDir, this.home());
      return { ok: true, value: result };
    } catch (error) {
      return { ok: false, error: { code: "import-failed", message: String(error && error.message ? error.message : error) } };
    }
  }
}

export default MemoryService;
