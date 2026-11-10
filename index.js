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
  archiveMemory,
  buildListPayload,
  buildMemoryContextSync,
  correctMemory,
  deleteMemory,
  DUPLICATE_THRESHOLD,
  findSimilarMemories,
  importFromZCode,
  isStaleMemory,
  listMemories,
  migrateProjectKeys,
  projectKeyFromPath,
  projectLabel,
  purgeArchived,
  readConfigSync,
  readMemory,
  resolveDshHome,
  resolveZCodeMemoriesDir,
  restoreArchived,
  sanitizeSegment,
  touchMemory,
  writeConfig,
  writeMemory,
  similarityScore,
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
    status: { type: "string" },
    pinned: { type: "boolean" },
    supersedes: { type: "string" },
    supersededBy: { type: "string" },
    useCount: { type: "number" },
    lastUsedAt: { type: "number" },
    body: { type: "string" },
  },
};

/** Compact per-item line for memory_list rendering. */
function renderListLine(m) {
  const desc = m.description ? " — " + m.description : "";
  const pin = m.pinned ? "📌 " : "";
  return `- [${m.type}] ${pin}${m.id}${desc}`;
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
    status: entry.status || "active",
    pinned: Boolean(entry.pinned),
    supersedes: entry.supersedes || "",
    supersededBy: entry.supersededBy || "",
    useCount: Number(entry.useCount) || 0,
    lastUsedAt: Number(entry.lastUsedAt) || 0,
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
    markRemoteMethod(this, "forget", "forget");
    markRemoteMethod(this, "restore", "restore");
    markRemoteMethod(this, "purge", "purge");
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
          "持久记忆工具：注入的「记忆」段落是索引，只含名称与描述，括号里的来源（人工/AI/导入）与日期表示证据强度——你自己写下的旧结论要打折看待，标「可能过时」的先核实再采信。" +
          "用 memory_get 按名称读取全文；对话中出现值得长期保留的信息（用户偏好、对你的纠正/反馈、项目约定或技术参考）时用 memory_save 保存（同名即更新、pinned 可置顶）。" +
          "旧结论被推翻或被纠正时用 memory_correct 取代旧条目（保留审计链、旧条目不再注入），不要新开一条互相矛盾的记忆；确定某条记忆错误或无关时用 memory_forget 让它退出索引（可恢复）；" +
          "记忆索引增长、或怀疑有陈旧内容时用 memory_review 列出过时/重复/已取代的条目。不要保存一次性任务状态或临时上下文。",
      });
    }

    tools.register(
      defineTool({
        name: "memory_save",
        description:
          "保存一条持久记忆（用户偏好、对助手的纠正/反馈、技术参考、项目约定等），之后每轮对话都会注入它的名称与描述。同项目内同名记忆会被更新（旧内容自动留快照）。" +
          "新建时会检测相似记忆并提示，避免重复建档。只保存值得长期保留的信息，不要保存一次性任务状态。",
        parameters: {
          name: {
            type: "string",
            required: true,
            description: "记忆名称，建议短横线 slug，可含中文；同项目内唯一，同名即更新。",
          },
          description: {
            type: "string",
            required: true,
            description: "一句话描述，会常驻每轮注入的记忆索引，请写清要点（越具体越有用）。",
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
          pinned: {
            type: "boolean",
            description: "置顶：注入索引时永远排在前面、不会被条数上限挤掉。仅用于最关键的用户偏好或硬约定。",
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
              conflict: { type: "boolean" },
              similar: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string", required: true },
                    name: { type: "string", required: true },
                    description: { type: "string", required: true },
                    score: { type: "number", required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) => {
            if (value.saved === false) {
              return [
                {
                  type: "text",
                  text:
                    `保存失败：记忆 ${value.id} 在你读取之后被其他会话修改了（并发写冲突）。` +
                    `先用 memory_get 重读最新内容，再基于新内容重新保存；不要覆盖别人的更新。`,
                },
              ];
            }
            const lines = [
              {
                type: "text",
                text: value.updated ? `已更新记忆 ${value.id}（旧内容已留快照）。` : `已保存新记忆 ${value.id}。`,
              },
            ];
            if (value.similar && value.similar.length > 0) {
              const hint = value.similar
                .map((s) => `${s.id}（相似度 ${s.score}）`)
                .join("、");
              lines.push({
                type: "text",
                text:
                  `⚠️ 已存在相似记忆：${hint}。如果这是对旧记忆的纠正/更新，请改用 memory_correct 指定 replaces，` +
                  `否则会留下两条并列且可能矛盾的记忆。`,
              });
            }
            return lines;
          },
        },
        execute: async (args, exec) => {
          const project = resolveToolProject(exec, args.project);
          const existing = await readMemory(home(), project, args.name);
          const nextType = MEMORY_TYPES.includes(String(args.type)) ? args.type : "other";
          const nextDescription = String(args.description ?? "").trim();
          const changed =
            !existing ||
            existing.body !== String(args.body ?? "") ||
            existing.description !== nextDescription ||
            existing.type !== nextType;
          let stored;
          try {
            stored = await writeMemory(home(), {
              name: args.name,
              description: nextDescription,
              type: nextType,
              project,
              origin: existing ? existing.origin : "agent",
              createdAt: existing ? existing.createdAt : undefined,
              body: args.body,
              pinned: args.pinned === undefined ? Boolean(existing && existing.pinned) : args.pinned === true,
              snapshotHistory: Boolean(existing) && changed,
              expectedUpdatedAt: existing ? existing.updatedAt : undefined,
            });
          } catch (error) {
            if (error && error.code === "write-conflict") {
              invalidate();
              return {
                saved: false,
                updated: true,
                conflict: true,
                id: project + "/" + sanitizeSegment(args.name, ""),
                similar: [],
              };
            }
            throw error;
          }
          invalidate();
          const similar = existing
            ? []
            : await findSimilarMemories(
                home(),
                { name: stored.name, description: stored.description, type: stored.type, project },
                { limit: 3 },
              ).catch(() => []);
          return {
            saved: true,
            updated: Boolean(existing),
            id: stored.project + "/" + stored.name,
            similar,
          };
        },
      }),
    );

    tools.register(
      defineTool({
        name: "memory_get",
        description:
          "按名称读取一条持久记忆的完整内容。注入的记忆索引只含名称与描述，需要全文时用这个工具。读取会累计使用次数，影响该记忆在索引中的排序权重。",
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
            const meta = [
              `- id: ${it.id}`,
              `- 类型: ${it.type}`,
              `- 描述: ${it.description || "（无）"}`,
              `- 来源: ${it.origin}${it.pinned ? "（置顶）" : ""}`,
              `- 状态: ${it.status}${it.supersededBy ? "（已被 " + it.supersededBy + " 取代）" : ""}`,
              `- 更新于: ${new Date(it.updatedAt).toISOString().slice(0, 10)}`,
              it.useCount ? `- 读取次数: ${it.useCount}` : "",
            ]
              .filter(Boolean)
              .join("\n");
            return [
              {
                type: "text",
                text: `# ${it.name}\n\n${meta}\n\n` + (it.body || "（无正文）"),
              },
            ];
          },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          const project = resolveToolProject(exec, args.project);
          const entry = await readMemory(home(), project, args.name);
          if (!entry) return { found: false };
          await touchMemory(home(), project, entry.name).catch(() => null);
          return { found: true, item: toItem(entry) };
        },
      }),
    );

    tools.register(
      defineTool({
        name: "memory_list",
        description:
          "搜索/列出有效持久记忆（可按关键词与项目过滤），返回名称、描述、类型与项目，不含正文；需要全文用 memory_get。已被取代与已归档的条目默认不出现（用 memory_review 查看）。",
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
          let items = (await listMemories(home())).filter((m) => (m.status || "active") === "active");
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
            pinned: Boolean(m.pinned),
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
          }));
          return { total, items: capped };
        },
      }),
    );

    tools.register(
      defineTool({
        name: "memory_forget",
        description:
          "让一条记忆退出索引（软遗忘）：把它移到项目回收站并留下遗忘原因，之后不再注入上下文，但可恢复。" +
          "当一条记忆被证伪、过时、或你发现自己之前保存了错误结论时用它，不要留着它继续误导后续对话。",
        parameters: {
          name: {
            type: "string",
            required: true,
            description: "要遗忘的记忆名称（索引中的名称）。",
          },
          reason: {
            type: "string",
            description: "遗忘原因（一句话），会作为墓志铭保留在回收站，便于以后判断是否要恢复。",
          },
          project: {
            type: "string",
            description: '记忆所在项目 key；省略时为当前会话工作区项目，传 "global" 指向全局记忆。',
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              forgotten: { type: "boolean", required: true },
              id: { type: "string", required: true },
            },
          },
          render: (args, value) => [
            {
              type: "text",
              text: value.forgotten
                ? `已让记忆 ${value.id} 退出索引（可从设置页「记忆管理 → 回收站」恢复）。`
                : `没有找到可遗忘的记忆：${args.name}。用 memory_list 确认名称。`,
            },
          ],
        },
        execute: async (args, exec) => {
          const project = resolveToolProject(exec, args.project);
          const archived = await archiveMemory(home(), project, args.name, args.reason || "agent decided it was wrong or obsolete");
          invalidate();
          return archived
            ? { forgotten: true, id: archived.id }
            : { forgotten: false, id: project + "/" + sanitizeSegment(args.name, "") };
        },
      }),
    );

    tools.register(
      defineTool({
        name: "memory_correct",
        description:
          "用一条新记忆取代一条旧记忆（保留审计链）：旧条目留在磁盘上标记为「已被取代」且不再注入上下文，新条目记录它取代了谁。" +
          "发现旧结论被推翻、用户纠正了之前的偏好时用它，而不是 memory_save 新开一条，否则两条矛盾记忆会并列注入。",
        parameters: {
          replaces: {
            type: "string",
            required: true,
            description: "被取代的旧记忆名称。",
          },
          name: {
            type: "string",
            required: true,
            description: "新记忆名称；可与旧名称相同（同项目内同名表示原地纠正，旧版本会自动留快照）。",
          },
          description: {
            type: "string",
            required: true,
            description: "新记忆的一句话描述（进入索引）。",
          },
          type: {
            type: "string",
            required: true,
            enum: MEMORY_TYPES,
            description: "记忆类型，通常与旧记忆一致。",
          },
          body: {
            type: "string",
            required: true,
            description: "新记忆的完整 Markdown 正文。",
          },
          project: {
            type: "string",
            description: '项目 key；省略时为当前会话工作区项目，传 "global" 指向全局记忆。',
          },
          pinned: {
            type: "boolean",
            description: "新记忆是否置顶。",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              corrected: { type: "boolean", required: true },
              id: { type: "string" },
              replaced: { type: "string" },
              reason: { type: "string" },
            },
          },
          render: (args, value) => {
            if (!value.corrected) {
              const why =
                value.reason === "replaces-not-found"
                  ? `找不到要取代的记忆：${args.replaces}，请用 memory_list 确认名称。`
                  : `取代失败（${value.reason || "unknown"}）。`;
              return [{ type: "text", text: why }];
            }
            return [
              {
                type: "text",
                text: `已用 ${value.id} 取代 ${value.replaced}（旧条目保留可审计、不再注入上下文）。`,
              },
            ];
          },
        },
        execute: async (args, exec) => {
          const project = resolveToolProject(exec, args.project);
          const r = await correctMemory(home(), {
            project,
            name: args.name,
            description: args.description,
            type: args.type,
            body: args.body,
            replaces: args.replaces,
            pinned: args.pinned,
          });
          invalidate();
          if (!r.corrected) return { corrected: false, reason: r.reason || "unknown" };
          return { corrected: true, id: r.entry.project + "/" + r.entry.name, replaced: r.replaced };
        },
      }),
    );

    tools.register(
      defineTool({
        name: "memory_review",
        description:
          "列出需要清理的记忆：可能过时（超过类型的相关期仍未被读取/更新）、长期未被读取、疑似重复、已被取代。" +
          "用它定期体检，然后把该纠正的用 memory_correct 取代、该忘的用 memory_forget 移出索引。",
        parameters: {
          project: {
            type: "string",
            description: '只看某个项目 key（或 "global"）；省略为全部项目。',
          },
          limit: {
            type: "number",
            description: "最多返回多少条（默认 20，上限 50）。",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              count: { type: "number", required: true },
              items: {
                type: "array",
                required: true,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string", required: true },
                    name: { type: "string", required: true },
                    type: { type: "string", required: true },
                    status: { type: "string", required: true },
                    reasons: { type: "array", required: true, items: { type: "string" } },
                  },
                },
              },
            },
          },
          render: (_args, value) => {
            if (value.count === 0) return [{ type: "text", text: "记忆库很干净：没有过时、重复或已被取代的条目。" }];
            const lines = value.items.map((it) => `- ${it.id}（${it.type}）：${it.reasons.join("；")}`);
            return [
              {
                type: "text",
                text:
                  lines.join("\n") +
                  `\n\n共 ${value.count} 条需要关注。纠正/更新用 memory_correct，确认无用用 memory_forget。`,
              },
            ];
          },
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
          const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
          let items = await listMemories(home());
          const projectArg = typeof args.project === "string" ? args.project.trim() : "";
          if (projectArg) {
            const key = projectArg === GLOBAL_PROJECT ? GLOBAL_PROJECT : sanitizeSegment(projectArg, GLOBAL_PROJECT);
            items = items.filter((m) => m.project === key);
          }
          const now = Date.now();
          const rows = [];
          const active = items.filter((m) => (m.status || "active") === "active");
          for (const m of items) {
            const reasons = [];
            let severity = 0;
            if (m.status === "superseded") {
              reasons.push(m.supersededBy ? `已被 ${m.supersededBy} 取代` : "已被取代");
              severity = 1;
            } else {
              const ageDays = Math.round((now - Math.max(m.lastUsedAt || 0, m.updatedAt || 0)) / 86400000);
              if (isStaleMemory(m, now)) {
                reasons.push(`可能过时（${ageDays} 天未更新/未读取）`);
                severity = Math.max(severity, 3);
              }
              if (!m.useCount && ageDays > 60) {
                reasons.push(`长期未被读取（${ageDays} 天）`);
                severity = Math.max(severity, 2);
              }
            }
            if (reasons.length > 0) rows.push({ m, reasons, severity });
          }
          if (active.length > 1 && active.length <= 300) {
            for (let i = 0; i < active.length; i++) {
              for (let j = i + 1; j < active.length; j++) {
                const score = similarityScore(active[i], active[j], active);
                if (score < DUPLICATE_THRESHOLD) continue;
                const pair = [
                  { m: active[i], other: active[j] },
                  { m: active[j], other: active[i] },
                ];
                for (const { m, other } of pair) {
                  let row = rows.find((r) => r.m.id === m.id);
                  if (!row) {
                    row = { m, reasons: [], severity: 4 };
                    rows.push(row);
                  }
                  row.reasons.push(`疑似重复：${other.id}`);
                  row.severity = Math.max(row.severity, 4);
                }
              }
            }
          }
          rows.sort((a, b) => b.severity - a.severity || (a.m.updatedAt || 0) - (b.m.updatedAt || 0));
          return {
            count: Math.min(rows.length, limit),
            items: rows.slice(0, limit).map((r) => ({
              id: r.m.id,
              name: r.m.name,
              type: r.m.type,
              status: r.m.status || "active",
              reasons: r.reasons,
            })),
          };
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
      const archivedItems = (payload.archivedItems || []).map((a) => ({
        ...a,
        label: a.project === GLOBAL_PROJECT ? "全局" : projectLabel(a.project),
      }));
      return {
        ok: true,
        value: {
          items: payload.items,
          projects: payload.projects,
          stats: payload.stats,
          archivedItems,
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
        pinned: r.pinned,
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
      const nextName = r.name !== undefined ? r.name : existing.name;
      const nextBody = r.body !== undefined ? r.body : existing.body;
      const nextDescription = r.description !== undefined ? r.description : existing.description;
      const nextType = r.type !== undefined ? r.type : existing.type;
      const changed =
        nextName !== existing.name ||
        nextBody !== existing.body ||
        nextDescription !== existing.description ||
        nextType !== existing.type;
      const expectedUpdatedAt = Number(r.expectedUpdatedAt) > 0 ? Number(r.expectedUpdatedAt) : undefined;
      let stored;
      try {
        stored = await writeMemory(this.home(), {
          name: nextName,
          description: nextDescription,
          type: nextType,
          project: r.project !== undefined ? r.project : existing.project,
          origin: r.origin !== undefined ? r.origin : existing.origin,
          body: nextBody,
          pinned: r.pinned !== undefined ? r.pinned : existing.pinned,
          snapshotHistory: changed,
          oldName: existing.name,
          expectedUpdatedAt,
        });
      } catch (error) {
        if (error && error.code === "write-conflict") {
          return { ok: false, error: { code: "stale-write", message: "记忆已被其他会话修改，请刷新后重试" } };
        }
        throw error;
      }
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

  /**
   * Soft-forget one memory (the UI's 删除 button): move it into the project's
   * recycle bin with a tombstone instead of destroying it.
   */
  async forget(request) {
    try {
      const { project, name } = splitId(request && request.id);
      const archived = await archiveMemory(this.home(), project, name, (request && request.reason) || "user removed it from the settings page");
      this._contextCache = null;
      if (!archived) return { ok: false, error: { code: "not-found", message: "记忆不存在或已删除" } };
      return { ok: true, value: { forgotten: true, file: archived.file } };
    } catch (error) {
      return { ok: false, error: { code: "forget-failed", message: String(error && error.message ? error.message : error) } };
    }
  }

  /** Restore one archived memory back into the live index. */
  async restore(request) {
    try {
      const { project, name } = splitId(request && request.id);
      const r = await restoreArchived(this.home(), project, name, (request && request.file) || "");
      this._contextCache = null;
      if (!r.restored) {
        const taken = r.reason === "name-taken";
        return {
          ok: false,
          error: {
            code: taken ? "name-taken" : "not-found",
            message: taken ? "同名记忆仍存在，无法恢复；请先遗忘或改名现有记忆" : "回收站中没有这条记忆",
          },
        };
      }
      return { ok: true, value: { item: toItem(r.entry) } };
    } catch (error) {
      return { ok: false, error: { code: "restore-failed", message: String(error && error.message ? error.message : error) } };
    }
  }

  /** Permanently purge one (or every) archived tombstone of a memory name. */
  async purge(request) {
    try {
      const { project, name } = splitId(request && request.id);
      const purged = await purgeArchived(this.home(), project, name, (request && request.file) || "");
      this._contextCache = null;
      if (purged === 0) return { ok: false, error: { code: "not-found", message: "回收站中没有这条记忆" } };
      return { ok: true, value: { purged } };
    } catch (error) {
      return { ok: false, error: { code: "purge-failed", message: String(error && error.message ? error.message : error) } };
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
