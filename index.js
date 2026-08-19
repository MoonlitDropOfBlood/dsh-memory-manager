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
  buildMemoryContextSync,
  deleteMemory,
  importFromZCode,
  listMemories,
  migrateProjectKeys,
  projectKeyFromPath,
  projectLabel,
  readConfigSync,
  readMemory,
  resolveDshHome,
  resolveZCodeMemoriesDir,
  sanitizeSegment,
  writeConfig,
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

/**
 * Resolve the target project for a memory tool call: an explicit `project`
 * argument wins ("global" selects the cross-project store); otherwise the
 * calling session's workspace cwd determines the project key. Throws when
 * neither is available — saving to the wrong project is worse than failing.
 */
function resolveToolProject(exec, projectArg) {
  const explicit = typeof projectArg === "string" ? projectArg.trim() : "";
  if (explicit) {
    return explicit === GLOBAL_PROJECT ? GLOBAL_PROJECT : sanitizeSegment(explicit, GLOBAL_PROJECT);
  }
  const agent = exec && exec.agent;
  const header = agent && agent.session && agent.session.header;
  const cwd = header && typeof header.cwd === "string" ? header.cwd : "";
  if (!cwd) {
    throw new Error('无法确定当前会话的工作区项目；请显式传入 project 参数（"global" 表示全局记忆）。');
  }
  return projectKeyFromPath(cwd);
}

/** Shared output item schema for the memory tools (leaf JSON fields only). */
const TOOL_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    name: { type: "string", required: true },
    description: { type: "string", required: true },
    type: { type: "string", required: true },
    project: { type: "string", required: true },
    label: { type: "string", required: true },
    origin: { type: "string", required: true },
    createdAt: { type: "number", required: true },
    updatedAt: { type: "number", required: true },
    body: { type: "string" },
  },
};

/** Compact per-item line for memory_list rendering. */
function renderListLine(m) {
  const desc = m.description ? " — " + m.description : "";
  return `- [${m.type}] ${m.id}${desc}`;
}

/** Small owned wire object for one memory (leaf fields only, no Host refs). */
function toItem(entry) {
  return {
    id: entry.project + "/" + entry.name,
    name: entry.name,
    description: entry.description,
    type: entry.type,
    project: entry.project,
    label: entry.project === GLOBAL_PROJECT ? "全局" : projectLabel(entry.project),
    origin: entry.origin,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    body: entry.body,
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
    markRemoteMethod(this, "getConfig", "getConfig");
    markRemoteMethod(this, "setConfig", "setConfig");

    // Small per-cwd cache for the injected prompt context (sync prompt API).
    this._contextCache = null;

    // Best-effort one-time migration of legacy ZCode hash-suffixed project
    // directories (`<name>-<16hex>` → `<name>`), so imported memories match
    // the workspace slugs the UI suggests. Fire-and-forget: it never blocks
    // startup or the Remote methods (listMemories reads the disk each call).
    migrateProjectKeys(this.home())
      .then((r) => {
        if (r && (r.moved > 0 || r.merged > 0)) {
          console.log(`[dsh-memory-manager] migrated project keys: ${r.moved} moved, ${r.merged} merged`);
        }
      })
      .catch((error) => {
        console.error("[dsh-memory-manager] project key migration failed:", error);
      });

    // Auto-load: register a system-prompt section (ZCode-style memory
    // injection). Every model step of every session gets the current
    // workspace's project memories plus the global memories as a compact
    // block, so the agent automatically sees them. The section's text
    // provider is synchronous, so it reads through the small cache and the
    // sync context builder.
    const systemPrompt = this._ctx.get("systemPrompt");
    if (systemPrompt && typeof systemPrompt.section === "function") {
      systemPrompt.section({
        name: "dsh-memory-manager",
        order: 90,
        text: (context) => {
          try {
            const agent = context && context.agent;
            const header = agent && agent.session && agent.session.header;
            const cwd = header && typeof header.cwd === "string" ? header.cwd : "";
            if (!cwd) return "";
            const now = Date.now();
            if (this._contextCache && this._contextCache.key === cwd && now - this._contextCache.ts < 3000) {
              return this._contextCache.text;
            }
            const text = buildMemoryContextSync(this.home(), cwd);
            this._contextCache = { key: cwd, ts: now, text };
            return text;
          } catch (error) {
            console.error("[dsh-memory-manager] prompt context failed:", error);
            return "";
          }
        },
      });
    }

    // Agent feedback loop: register the memory_save / memory_get / memory_list
    // model tools so the agent can read full bodies on demand and write back
    // durable memories itself. `defineTool` comes from @deepseek-ai/dsh-tools;
    // it is imported dynamically so a deployment where that package is not
    // resolvable only loses the tools, not the whole memory service.
    const tools = this._ctx.get("tools");
    if (tools && typeof tools.register === "function") {
      import("@deepseek-ai/dsh-tools")
        .then(({ defineTool }) => this._registerMemoryTools(tools, defineTool))
        .catch((error) => {
          console.error("[dsh-memory-manager] memory tools registration failed:", error);
        });
    } else {
      console.warn("[dsh-memory-manager] tools service unavailable; memory_save / memory_get / memory_list not registered");
    }
  }

  /**
   * Register the agent-facing memory tools plus their prompt guidance section.
   * `tools.register` disposers are fiber-scoped, so plugin disposal unregisters
   * them automatically.
   */
  _registerMemoryTools(tools, defineTool) {
    const home = () => this.home();
    const invalidate = () => {
      this._contextCache = null;
    };

    const systemPrompt = this._ctx.get("systemPrompt");
    if (systemPrompt && typeof systemPrompt.section === "function") {
      systemPrompt.section({
        name: "tool:memory",
        order: 100,
        text:
          "持久记忆工具：注入的「记忆」段落是索引，只含名称与描述；用 memory_get 按名称读取完整内容。" +
          "当对话中出现值得长期保留的信息——用户偏好、对你的纠正/反馈、项目约定或技术参考——用 memory_save 保存（同名即更新，project 传 \"global\" 存为跨项目全局记忆）。" +
          "用 memory_list 跨项目搜索已有记忆。不要保存一次性任务状态或临时上下文。",
      });
    }

    tools.register(
      defineTool({
        name: "memory_save",
        description:
          "保存一条持久记忆（用户偏好、对助手的纠正/反馈、技术参考、项目约定等），之后每轮对话都会注入它的名称与描述。同项目内同名记忆会被更新。只保存值得长期保留的信息，不要保存一次性任务状态。",
        parameters: {
          name: {
            type: "string",
            required: true,
            description: "记忆名称，建议短横线 slug，可含中文；同项目内唯一，同名即更新。",
          },
          description: {
            type: "string",
            required: true,
            description: "一句话描述，会常驻每轮注入的记忆索引，请写清要点。",
          },
          type: {
            type: "string",
            required: true,
            enum: MEMORY_TYPES,
            description:
              "记忆类型：user（用户画像/偏好）、feedback（对助手的反馈/纠正）、reference（外部资料/技术参考）、project（项目约定/事实）、other。",
          },
          body: {
            type: "string",
            required: true,
            description: "记忆的完整 Markdown 正文。",
          },
          project: {
            type: "string",
            description: '目标项目 key；省略时为当前会话工作区项目，传 "global" 保存为跨项目全局记忆。',
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              saved: { type: "boolean", required: true },
              updated: { type: "boolean", required: true },
              id: { type: "string", required: true },
            },
          },
          render: (_args, value) => [
            {
              type: "text",
              text: value.updated ? `已更新记忆 ${value.id}。` : `已保存新记忆 ${value.id}。`,
            },
          ],
        },
        execute: async (args, exec) => {
          const project = resolveToolProject(exec, args.project);
          const existing = await readMemory(home(), project, args.name);
          const stored = await writeMemory(home(), {
            name: args.name,
            description: args.description,
            type: args.type,
            project,
            origin: existing ? existing.origin : "agent",
            createdAt: existing ? existing.createdAt : undefined,
            body: args.body,
          });
          invalidate();
          return { saved: true, updated: Boolean(existing), id: stored.project + "/" + stored.name };
        },
      }),
    );

    tools.register(
      defineTool({
        name: "memory_get",
        description:
          "按名称读取一条持久记忆的完整内容。注入的记忆索引只含名称与描述，需要全文时用这个工具。",
        parameters: {
          name: {
            type: "string",
            required: true,
            description: "记忆名称（索引中显示的名称）。",
          },
          project: {
            type: "string",
            description: '所在项目 key；省略时为当前会话工作区项目，传 "global" 读取全局记忆。',
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              found: { type: "boolean", required: true },
              item: TOOL_ITEM_SCHEMA,
            },
          },
          render: (args, value) => {
            if (!value.found || !value.item) {
              return [{ type: "text", text: `记忆不存在：${args.name}。可用 memory_list 搜索正确名称。` }];
            }
            const it = value.item;
            return [
              {
                type: "text",
                text:
                  `# ${it.name}\n\n` +
                  `- id: ${it.id}\n- 类型: ${it.type}\n- 描述: ${it.description || "（无）"}\n- 更新于: ${new Date(it.updatedAt).toISOString().slice(0, 10)}\n\n` +
                  (it.body || "（无正文）"),
              },
            ];
          },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          const project = resolveToolProject(exec, args.project);
          const entry = await readMemory(home(), project, args.name);
          return entry ? { found: true, item: toItem(entry) } : { found: false };
        },
      }),
    );

    tools.register(
      defineTool({
        name: "memory_list",
        description:
          "搜索/列出持久记忆（可按关键词与项目过滤），返回名称、描述、类型与项目，不含正文；需要全文用 memory_get。",
        parameters: {
          query: {
            type: "string",
            description: "按名称/描述模糊过滤的关键词（不区分大小写）；省略则列出全部。",
          },
          project: {
            type: "string",
            description: '只看某个项目 key（或 "global"）；省略为全部项目。',
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              total: { type: "number", required: true },
              items: {
                type: "array",
                required: true,
                items: TOOL_ITEM_SCHEMA,
              },
            },
          },
          render: (_args, value) => {
            if (value.total === 0) return [{ type: "text", text: "没有找到匹配的记忆。" }];
            const lines = value.items.map(renderListLine);
            const suffix = value.total > value.items.length ? `\n（共 ${value.total} 条，仅显示前 ${value.items.length} 条，请用 query 缩小范围）` : "";
            return [{ type: "text", text: lines.join("\n") + suffix }];
          },
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
          let items = await listMemories(home());
          const projectArg = typeof args.project === "string" ? args.project.trim() : "";
          if (projectArg) {
            const key = projectArg === GLOBAL_PROJECT ? GLOBAL_PROJECT : sanitizeSegment(projectArg, GLOBAL_PROJECT);
            items = items.filter((m) => m.project === key);
          }
          const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
          if (q) {
            items = items.filter(
              (m) =>
                m.name.toLowerCase().includes(q) ||
                String(m.description || "").toLowerCase().includes(q),
            );
          }
          items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          const total = items.length;
          const capped = items.slice(0, 50).map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description,
            type: m.type,
            project: m.project,
            label: m.project === GLOBAL_PROJECT ? "全局" : projectLabel(m.project),
            origin: m.origin,
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
          }));
          return { total, items: capped };
        },
      }),
    );
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
        value: { item: toItem(entry) },
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
      this._contextCache = null;
      return {
        ok: true,
        value: { item: toItem(stored) },
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
      this._contextCache = null;
      return {
        ok: true,
        value: { item: toItem(stored) },
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
      this._contextCache = null;
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
      this._contextCache = null;
      return { ok: true, value: result };
    } catch (error) {
      return { ok: false, error: { code: "import-failed", message: String(error && error.message ? error.message : error) } };
    }
  }

  async getConfig() {
    try {
      return { ok: true, value: { config: readConfigSync(this.home()) } };
    } catch (error) {
      return { ok: false, error: { code: "config-failed", message: String(error && error.message ? error.message : error) } };
    }
  }

  async setConfig(request) {
    try {
      const r = request || {};
      // Only merge explicitly provided booleans; an absent field must not
      // clobber the stored value (undefined would be dropped by JSON and the
      // field would silently revert to its default).
      const patch = {};
      if (typeof r.autoLoad === "boolean") patch.autoLoad = r.autoLoad;
      if (typeof r.injectBody === "boolean") patch.injectBody = r.injectBody;
      const config = await writeConfig(this.home(), patch);
      this._contextCache = null;
      return { ok: true, value: { config } };
    } catch (error) {
      return { ok: false, error: { code: "config-failed", message: String(error && error.message ? error.message : error) } };
    }
  }
}

export default MemoryService;
