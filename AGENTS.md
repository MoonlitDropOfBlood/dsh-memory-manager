# AGENTS.md — dsh-memory-manager

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"，记录了本项目踩过的大量坑。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）插件**：把 **ZCode 的项目记忆**移植到 DSH，并在 Web UI 的**设置**面板里提供完整的记忆管理页面。

- 记忆 = 带 YAML frontmatter 的 Markdown 文件，落盘在 `<DSH_HOME>/memories/projects/<projectKey>/memory/<name>.md`。
- 每个项目目录自动维护 `MEMORY.md`（ZCode 风格索引）与 `memory_summary.md`（摘要）。
- 记忆类型沿用 ZCode：`user` / `feedback` / `reference` / `project` / `other`。
- 支持**一键从 ZCode 导入**（`~/.zcode/cli/memories`，含各项目的 `memory/` 与 `topics/`），按项目 + 名称去重。

## 目录结构

```
dsh-memory-manager/
├── package.json          # ESM 双面包：dsh.client: {platform:"web"} + exports(., /client, /typert, /package.json)
├── index.js              # Host 半：MemoryService（TypertRemoteService 子类，类插件）
├── client.js             # Client 半：window.__ModuleLoader__.load bundle（设置「记忆管理」页 + Remote 调用）
├── typert.host.js        # Typert Host manifest：memoryManager Remote 服务的 schema/调用描述
├── memory-core.mjs       # 零依赖记忆核心：frontmatter 解析/序列化、路径清洗、索引生成、ZCode 导入、生命周期（回收站/取代链/相似度/注入排序）
├── cordis.patch.yml      # dsh bundle patch（挂载行）
├── scripts/self-test.mjs # 独立核心自测：临时 DSH_HOME 上跑 CRUD/索引/导入（不依赖 DSH 进程）
├── scripts/test-typert-contract.mjs # typert 双形态 codec 契约测试（Host manifest + client bundle 实跑）
├── .github/workflows/release.yml  # 打 v* 标签时构建并发布 GitHub Release
├── AGENTS.md             # 本文件
├── README.md
└── LICENSE               # MIT
```

## 关键机制

### 1. DSH 正式插件 = 三件套（Host / Client / Typert）

与 `dsh-archive-manager` / `dsh-token-stats` 完全相同的模式：

| 文件 | 作用 | 被谁加载 |
|---|---|---|
| `index.js` | Host 半：Cordis **类插件**（导出 Service 类），注册 `memoryManager` 服务 | cordis loader（composition `insert` 行） |
| `client.js` | Client 半：浏览器 UI bundle | `client-modules`（扫描 `dsh.client` 声明 → 注入 `window.__DSH_BOOT__`） |
| `typert.host.js` | 描述 `memoryManager` 服务的 Remote 方法（wire schema / invocation） | `typert-loader`（扫描包的 `./typert` 导出） |

关键名字必须一致：类名 `MemoryService`、服务键 `memoryManager`、invocation id `dsh-memory-manager#memoryManager/<method>`、`package.json` exports 含 `./package.json`。

**strict codec 必须是双形态**（0.1.7-rc.1 加载不上的根因，v1.4.0 修复）：DSH 0.1.7 把 codec 校验契约从 `codec.schema`（活的 zod 实例）换成了 `codec.create()` 工厂——
- `<= 0.1.5` 的 typert-loader/registry 校验 `typeof codec.schema.parse === "function"`，忽略 `create`；
- `>= 0.1.7` 校验 `typeof codec.create === "function"`（宿主网关运行时也调 `codec.create().parse(...)`），忽略 `schema`。

两边各查各的字段，所以每个 strict codec **同时带 `schema` 和 `create: () => schema`** 就能通过所有 0.1.x 校验器（已实测 0.1.0-rc.7 / 0.1.5 / 0.1.6-alpha.2 / 0.1.7-rc.1 四个版本的 `validateTypertManifest` 全 PASS）。`typert.host.js` 与 `client.js` 的 `CLIENT_REMOTE` 都要照此写；回归由 `scripts/test-typert-contract.mjs` 把守（含跑真实 client bundle 抓 `$mount` 的贡献）。

**0.2.0 的启动闸门会静默禁用整包（v1.4.2 修复的加载根因）**：DSH 0.2.0 起 `dsh-app-boot` 在 import 任何插件代码之前对每个 bundle 跑 `evaluatePluginCompatibility`——遍历 `peerDependencies` 里名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的条目，逐条 `semver.satisfies(runtime, range, { includePrerelease: true })`，任一不满足就 `row.disabled = true`（stderr 一行 `skipping profile bundle ...`），插件代码一行都没被 import，现象即"加载不上"。本插件命中的 peer 是 `@deepseek-ai/dsh-typert-protocol`，范围必须写成**显式双线** `^0.1.0-rc.7 || ^0.2.0-rc.1`（注意 `^0.2.0` 不匹配 `0.2.0-rc.1`，prerelease 必须显式写 rc 线），并与顶层 `engines.dsh` 同步（dshmarket 读三声明合取）。0.2.0-rc.1 上逐面复核**全部未变**：typert codec 仍只认 `create()` 工厂（双形态继续必需）、`TypertRemoteService`/`Remote`/`remoteMethods`、cordis `Service.init`、`systemPrompt.section({name,order,text})`、`tools` 服务与 `defineTool` DSL、`exec.agent.session.header.cwd`、`settings.section` 槽（id/order/label）、`__ModuleLoader__.load` bundle 契约、`ctx.remote.$mount`、`workspaceRegistry.list()`。回归由 `npm run e2e`（`verify-real-install.mjs`）把守：真闸门 + 真安装的 cordis/typert-protocol 上激活 + 真 TypertRegistry + 真 dsh-tools 工具回路 + client bundle apply，全绿且零跳过才算数。

**0.2.2 的设置壳换了导航图标的来源（v1.4.4 修复的"一行两个图标"根因）**：DSH 0.2.2-rc.1 的设置壳新增槽 `settings.section.icon`，导航行的图形不再由壳统一画通用齿轮，而是按行 id 从这个槽取（`renderSlot('settings.section.icon', { size: 16, active }, { only: row.id, fallback: <壳自带齿轮> })`）。**`settings.section` 本身仍然只投影 `id/order/label`**——图标必须单独注册，且注册 id 要等于 section id，否则该行永远只剩壳的齿轮。宿主没声明这个槽时 `ctx.slots.inject` 的回调根本不会被调用（不抛错），旧宿主天然安全；版本区间不用动（启动闸门用 `includePrerelease: true`，`^0.2.0-rc.1` 已覆盖 0.2.2-rc.1）。实现细节见第 3 节「设置导航图标」。0.2.2-rc.1 实机核验（隔离 profile + 真浏览器）：注册后「记忆管理」行只渲染插件自己的 brain 图标（壳的齿轮仅作 fallback，不再出现），旧 CSS 路径全程不给该行打标记（DOM 形状门控生效），一行只有一个图标。

### 2. Host 半：类插件 + Remote 方法

```js
export class MemoryService extends TypertRemoteService {
  static inject = ["workspaceRegistry"];
  constructor(ctx, config) { super(ctx, "memoryManager"); }  // 必须传精确服务键
  [Service.init]() {
    markRemoteMethod(this, "list", "list");
    // ... create / update / delete / get / forget / restore / purge / importZCode / getConfig / setConfig
  }
}
```

- 文件 I/O 直接 `import ... from "node:fs/promises"`。正式插件的 Host 半由 loader 用标准 `import()` 加载（见 `cordis-plugin-loader` 的 `EntryTree.import`），拥有完整 Node 权限，和 DSH 核心写 `~/.dsh` 一样，**不需要**走 `ctx.shell` 沙箱。记忆目录在 DSH_HOME 内，用 `node:fs` 最稳。
- Remote 标记用 `markRemoteMethod(instance, method, exportName)` 手动驱动 `Remote()` 装饰器（Node ESM 不支持装饰器语法），在 `[Service.init]()` 中调用。

### 3. Client 半：bundle 格式 + 自挂载 Remote

- `window.__ModuleLoader__.load({ id, factory })` 格式；`exports.inject = ["slots", "remote"]`。
- **必须自挂载** Remote 命名空间：`await ctx.remote.$mount(CLIENT_REMOTE)`（`dsh-api-remotes` 只挂载官方命名空间）；浏览器无 zod，codec 用 passthrough schema。调用走 `ctx.get("remote.memoryManager")`（不要写进 inject）。
- **设置页**注册：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "memory-manager", order: 30, label: () => SETTINGS_LABEL }, MemoryManagerPage))`。
- **设置导航图标**（宿主版本决定走哪条，两条路径**互斥**，绝不同框）：
  - **DSH >= 0.2.2：原生槽**。0.2.2-rc.1 的设置壳（`client-ui-settings-general`）新增槽 `settings.section.icon`（`kind: 'list'` / `scope: 'root'` / `inline: true`，owner props `{ size: number, active: boolean }`），导航行图形统一渲染在 `<span class="navIcon">` 里，壳按行 id 取：`renderSlot('settings.section.icon', { size: 16, active }, { only: row.id, fallback: <壳自带齿轮> })`。注册形状 `ctx.slots.inject("settings.section.icon", () => ctx.slots.register({ name: "settings.section.icon", id: "memory-manager", order: 30, label: () => SETTINGS_LABEL }, MemoryNavIcon))`——**注册 id 必须等于 `settings.section` 的 id**（本插件两边都是 `memory-manager`）：未匹配的 id 永不渲染，壳的齿轮只是"没人注册时"的 fallback。组件 `MemoryNavIcon` 画 Lucide "brain"（24×24、stroke 2、`currentColor`，尺寸取 owner 的 `size`，默认 16），与旧 CSS mask 是同一个图形，用户看到的图标不变。
  - **DSH <= 0.2.1：CSS 兜底**。旧宿主没有该槽（`ctx.slots.inject` 的回调不会被调用，不抛错），壳只投影 `id/order/label`，并把通用齿轮画成导航按钮的**直接 `<svg>` 子节点**。client.js 的 `markLegacySettingsNavRow()` 用 MutationObserver 给 `[role="dialog"] nav button` 中文本等于 section label、**且按钮含直接 `<svg>` 子节点**（`hasLegacyGear()`）的行打 `data-dsh-memory-manager-settings-nav` 标记，CSS 再隐藏 `>svg:first-child` 齿轮、用 `currentColor` mask 画 brain（16px，跟随原生 hover/active 颜色）。
  - **为什么必须按 DOM 形状门控**：0.2.2 的按钮子节点是 `span.navIcon` + `span.navLabel`，没有直接 `<svg>`，所以一行都不会被标记、旧 CSS 全程失效。反过来若在 0.2.2 上还按老逻辑标记，旧规则 `button > svg:first-child` 已匹配不到（齿轮挪进了 span），自定义 brain 会**和壳齿轮同框渲染**（一行两个图标）——这正是本次修的 bug。换图标：新路径改 `MemoryNavIcon` 的 path，旧路径改 CSS 里 data URI 的 SVG path（Lucide，24×24，stroke-width 2，stroke 用 black——mask 只取 alpha）。
- CSS 用 `document.createElement("style")` + `ctx.effect(() => () => styleTag.remove())`；颜色一律用 `--dsw-alias-*` / `--dsw-specific-*` / `--dsw-shadow-lv2`。

### 4. Remote 返回包络（重要）

网关对 Remote 返回值的包裹在不同插件里有两种形态（archive-manager 直接读 `res.ok`，token-stats 说 `res.value` 才是 Host 返回包络）。**不要赌形态**，客户端统一用 `unwrap(res)`：

```js
function unwrap(res) {
  if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || { code: "transport", message: "调用失败" } };
  const v = res.value;
  if (v && typeof v === "object" && typeof v.ok === "boolean") return v; // Host 包络
  return { ok: true, value: v };
}
```

Host 方法一律返回 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。

### 5. 记忆核心（memory-core.mjs）

- 所有存储逻辑集中在 `memory-core.mjs`，**零 DSH/第三方依赖**，可被 `index.js` 与 `scripts/self-test.mjs` 共用。
- `sanitizeSegment`：清洗项目/名称为安全路径片段，保留 Unicode 字母数字（**中文记忆名必须能保留**），替换其余字符为 `-`，阻断 `../`、绝对路径等穿越。
- `yamlScalar`：普通标量直接输出（允许 Unicode 字母/数字、`_`、`-`、`.`、`:`、空格）；含特殊字符才 JSON 双引号包裹。**不要**用仅限 ASCII 的宽松正则，否则中文名会被无谓地加引号。
- `parseFrontmatter`：容忍扁平 frontmatter（本项目）与 ZCode 嵌套 `metadata: { node_type, type, originSessionId }` 两种格式；description 的多行续行会合并。
- 正文 roundtrip：写入时正文末尾补一个换行、解析时去掉首/尾空行，保证 `body` 精确往返。
- 每次写/删记忆后重写该项目 `MEMORY.md` 索引与 `memory_summary.md`（索引行标注 pinned / superseded）；项目目录只有在「无 live 记忆 + 无 `.archive/` 归档 + 无 `.history/` 快照」时才会被清理（`cleanupProject`）。
- `importFromZCode`：**必须跳过** `MEMORY.md` / `memory_summary.md`（它们是索引不是记忆），否则导入统计里会出现"跳过"噪音。
- 复合 id = `<projectKey>/<name>`（两者都已被清洗、不含 `/`），客户端用它做 `get/update/delete`。
- **写安全（v1.5）**：所有变更走 `withWriteLock`（进程内队列 + 跨进程目录锁 `<DSH_HOME>/memories/.lock`，`mkdir` 原子获取，超过 `LOCK_STALE_MS = 15s` 判定为崩溃残留可接管，`LOCK_TIMEOUT_MS = 4s` 放弃并抛 `code: "store-busy"`）；文件写走 `atomicWrite`（临时文件 + `rename`），崩溃/断电不会留下半截记忆。**`*Unlocked` 内部函数只能在已持锁的回调里用：在锁内再调 `writeMemory`/`archiveMemory` 等公开函数会自锁死（进程内队列等自己）**——正确写法是 `correctMemoryUnlocked` 内部调 `writeMemoryUnlocked`。
- **并发冲突校验**：`writeMemory` 接受 `expectedUpdatedAt`（调用方据以决策的版本号）。磁盘上的 `updatedAt` 已变时抛 `code: "write-conflict"`（带 `current` 条目），不覆盖别人的新内容。UI 编辑会带上 `expectedUpdatedAt`，Host `update` 把它映射成 `{ ok:false, error:{ code:"stale-write" } }`；`memory_save` 自带冲突重试提示（返回 `saved:false, conflict:true`），提示模型先 `memory_get` 重读再写。
- **扫描范围**：`listMemories`（全库）只服务 UI 列表与统计；写入后的索引重建、注入渲染一律走 `listProjectMemories` / `listProjectMemoriesSync`（只读该项目 + `global` 两个目录），否则任一项目一次写入都会 O(全库) 扫盘，注入更是每步全库扫。
- **相似度（v1.5）**：三层信号合取——字符 bigram Dice（名称权重高）+ TF-IDF 余弦 `semanticSimilarity`（语料为当前库，名字 token 权重 ×2）+ 释义层（`cosine >= 0.30` 且描述 Dice `>= 0.55` → 记 0.74）。`SIMILAR_THRESHOLD = 0.72`（保存提示）、`DUPLICATE_THRESHOLD = 0.82`（review 疑似重复）。阈值是对真实库 2485 对校准的（无关同前缀主题最高 0.712）；**动阈值前必须重跑这个校准**，否则会给每次 memory_save 加噪音提示。

### 6. 标准安装 = dsh bundle（package.json 声明 + 包内 cordis.patch.yml）

本插件是**标准 DSH bundle**：`package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`，用官方 `dsh plugin` 命令安装：

1. `dsh plugin --profile web add <本地路径或包>`：pnpm 把插件装成 profile 的 npm 依赖（本地路径走 `link:` 软链，改代码即生效），并把包名追加到 profile `package.json` 的 `dsh.profile.bundles`。`package.json` 的 `files` 必须包含 `index.js` + `client.js` + `typert.host.js` + **`memory-core.mjs`**（别漏！）+ `cordis.patch.yml`，否则 `npm pack`/发布会丢文件。

   **link: 安装的依赖解析坑（v1.4.1 修复，0.1.7-rc.2 上"加载失败被当成不兼容"的根因）**：`link:` 软链的 realpath 是开发目录（如 `D:\ai-projects\dsh\dsh-memory-manager`），Node 从这里向上找 `node_modules`——**不会**经过 `<DSH_HOME>/profiles/node_modules`（registry 装的包向上解析时恰好命中这个共享依赖目录，所以 registry 安装没此问题）。因此本地开发**必须先 `pnpm install`**，把 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-typert-protocol`（以及动态 import 的 `@deepseek-ai/dsh-tools`）实体化到本目录 `node_modules`，否则 Host 半 import 直接 `Cannot find package`，插件表现为"加载不上/不兼容"。这些包已声明在 `devDependencies`（只影响本地开发，不进发布产物；dsh-deveco 同款模式，借助 pnpm auto-install-peers）。devDep 的 typert-protocol 范围要跟着**本机宿主**走（当前钉 `^0.2.0-rc.1` 解析到 0.2.0-rc.1；prerelease 语义下 `^0.1.0-rc.7` 只会解析到 0.1.0-rc.8，换宿主版本时同步改）。诊断手法：在 `<DSH_HOME>\profiles\web` 目录下 `node --input-type=module -e "await import('@duke-dsh-plugins/dsh-memory-manager')"`，PASS/FAIL 立判。
2. 启动时 DSH 应用包内 `cordis.patch.yml` 的 `- insert:` 行挂载插件（**不要**再在 profile 的 `cordis.patch.yml` 里手工插一行，否则同一 id 重复挂载）：

```yaml
# cordis.patch.yml（随包分发）
- insert:
  - id: memory-manager
    name: '@duke-dsh-plugins/dsh-memory-manager'
```

3. 重启 DSH。**必须重启**，Host 加载、typert 注册、client bundle 注入都在启动时发生。
4. 卸载/切换安装形态的坑（v1.4.2 实测）：`dsh plugin remove` **必须传完整 scoped 名** `@duke-dsh-plugins/dsh-memory-manager`（传裸名 `dsh-memory-manager` 会 `ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS`，因为 profile 依赖存的是 scoped 键）；profile 里已有 `link:` 依赖时，`dsh plugin add <npm 包名>` 会**保留旧 link 声明原样 upsert**（"Already up to date"，不会切到 registry）——要从开发态切到正式态必须**先 scoped remove 再 add**。registry 安装是 pnpm 硬链实体化、包内自带完整 `node_modules`（cordis/typert-protocol/zod 全在里面），与开发目录完全解耦；验证手法：profile 下 `node --input-type=module -e "await import('@duke-dsh-plugins/dsh-memory-manager')"` + `dsh --profile web --dump-config` 无 skipping 行。

### 7. Agent 记忆工具 + 索引注入 + 生命周期（v1.5）

**注入是索引优先的**：`buildMemoryContextSync` 默认（`config.injectBody === false`）每条记忆只注入一行 `- [type] name — description（来源, 日期[, 置顶][, 可能过时]）`，不带正文；`injectBody: true` 恢复旧模式（附加压平后 400 字正文截断）。配置落在 `<DSH_HOME>/memories/config.json`，UI 两个开关分别对应 `autoLoad` / `injectBody`。

**注入排序（v1.5）**：`pinned`（1000 分）> 类型权重（user 40 / feedback 34 / project 26 / reference 16 / other 10）> `useCount`（每次 `memory_get` +2，封顶 20）> 新旧（180 天线性衰减）。每节 `maxItems = 24`、总预算 6000 字符；被裁掉的条目在标题里显示「注入前 N 条」，**不会静默消失**。`status: superseded` / 归档条目**永不注入**。超过类型相关期（`TYPE_TTL_DAYS`：user 3650 / feedback 1095 / project·reference 180 / other 365，可用条目 `ttlDays` 覆盖）的非置顶条目打「可能过时」。来源标签 `manual→人工 / agent→AI / 其它→导入`——**这是让模型折价自己旧结论的关键**，别把 origin 从注入行里删掉。

**Agent 回写回路**：`[Service.init]()` 里用 `ctx.get("tools")` 拿 ToolRuntime，**动态 `import("@deepseek-ai/dsh-tools")`** 拿 `defineTool` 后注册六个模型工具：

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `memory_save` | 保存/更新记忆（同名即更新并留 `.history` 快照；新建时返回 `similar` 相似提示；并发被改时返回 `saved:false, conflict:true` 让模型重读） | name / description / type(enum) / body / project? / pinned? |
| `memory_get` | 按名称读全文（配索引注入使用；读取会 `touchMemory` 累加 `useCount`/`lastUsedAt`） | name / project? |
| `memory_list` | 跨项目搜索（名称/描述过滤，上限 50 条，不含正文；**只列 active**） | query? / project? |
| `memory_forget` | 软遗忘：移入 `.archive/` 并写 `forgotAt/forgotReason` 墓志铭，退出索引但可恢复 | name / project? / reason? |
| `memory_correct` | 取代旧记忆：新条目记 `supersedes`，旧条目转 `status: superseded` + `supersededBy`（不再注入）；同名纠正改为原地写 + `.history` 快照 | replaces / name / description / type / body / project? / pinned? |
| `memory_review` | 记忆体检：列出可能过时 / 长期未读 / 疑似重复（`DUPLICATE_THRESHOLD = 0.82`，语义感知）/ 已被取代的条目 | project? / limit? |

要点：

- **动态 import 是有意的**：`@deepseek-ai/dsh-tools` 解析失败只损失工具，不拖垮整个记忆服务。本机它从 `<DSH_HOME>/profiles/node_modules`（profile 共享依赖目录）解析。
- `ctx.tools.register()` 返回的 disposer 由 fiber 托管，无需手动清理（同 dsh-tool-web）。
- 工具的项目定位：`exec.agent.session.header.cwd` → `projectKeyFromPath`；模型也可显式传 `project`（`"global"` = 全局）。**cwd 拿不到就抛错**，宁可失败也不写错项目。
- 工具指引通过第二个 `systemPrompt.section`（`name: "tool:memory"`，order 100，遵循工具指引 100-199 区间约定）常驻提示词；索引段落本身（order 90）的引导语也指向 `memory_get` / `memory_save` / `memory_correct` / `memory_forget` / `memory_review`。指引里明确要求「旧结论被推翻时用 memory_correct 取代、不要新开一条」，否则会重新长出一堆自相矛盾的自写记忆。
- 工具参数/输出用 dsh-tools 的 schema DSL：string 支持 `enum`，object 必须显式 `additionalProperties`，`required: true` 逐字段标注。
- `setConfig` Remote 只合并且显式传入的布尔字段——`undefined` 会被 JSON 丢弃导致配置悄悄回默认值。

## 开发 / 验证

```bash
pnpm install           # 首次/换机必做：实体化 @deepseek-ai peer 依赖，link: 安装才能被宿主 import（见第 6 节）
npm run check            # 语法检查全部 JS
npm test                 # 独立核心自测（116 项断言）+ typert 双形态 codec 契约测试（390 项检查）
npm run e2e              # 端到端：对本机真实 DSH 安装（当前 0.2.2-rc.1）跑启动闸门/宿主激活/CRUD/真注册表/工具回路/client apply/导航图标槽
dsh plugin --profile web add /path/to/dsh-memory-manager   # 安装/重装到本机 DSH profile
dsh --profile web --dump-config    # stderr 无本包 skipping 行 = 启动闸门放行（重启前先跑这条）
```

改插件后**必须重启 DSH 进程**才生效。验证：
1. 设置 → 侧栏导航出现 **记忆管理**。
2. 新建一条（含中文名）→ 列表出现、磁盘出现 `~/.dsh/memories/projects/<p>/memory/<name>.md` 与索引。
3. 编辑（改名/改类型/改正文）→ 旧文件消失、新文件正确。
4. 删除 → 文件移入 `<project>/.archive/`、列表消失；项目目录只有在「无 live 记忆 + 无归档 + 无历史快照」时才会被整体清理。
5. 从 ZCode 导入 → 统计与磁盘文件一致；重复导入全部跳过。
6. 开新会话 → agent 工具列表有 `memory_save` / `memory_get` / `memory_list` / `memory_forget` / `memory_correct` / `memory_review`；让 agent「记住」一个偏好 → 磁盘出现新记忆且 `origin: agent`，下一轮会话索引注入里能看到它（行尾带 `（AI, 日期）`）。
7. 在记忆管理页删除一条 → 列表消失、`<project>/.archive/` 出现带 `forgotAt` 的墓碑；点「回收站 (n)」→ 恢复回来；再「彻底删除」→ 文件才真的没了。
8. 让 agent 纠正一个已知偏好（"不对，现在是 X"）→ 出现新记忆 `supersedes: <旧名>`，旧文件 `status: superseded` 且下一轮索引不再注入旧条目。
9. 手动编辑一条记忆 → `<project>/.history/` 出现旧版快照（每个名字最多保留 5 份）。

## 发布

打 `v1.0.0` 标签推送到 GitHub，`.github/workflows/release.yml` 会自动构建 `npm pack` 产物并发布为 GitHub Release（需要 `GH_TOKEN` secret，权限 `contents:write`）。

## 常规注意事项

- **不要直接编辑 `~/.dsh/profiles/web/cordis.yml`**（那是生成的文件，patch 覆盖在 `cordis.patch.yml`）。
- `cordis.patch.yml` 顶层是一个 patch 数组：`- insert:` 用于新增行，`- id:` 用于覆盖已有行。
- `client.js` 用 `require("react")`（bundle 的模块表提供），**不要** `import` 或动态插件的 `styles`/`host` 全局。
- 写操作**必须**走 `withWriteLock` + `atomicWrite`；新增变更函数时同时提供 `*Unlocked` 实现与持锁包装，别在锁内调用公开写函数（会自死锁）。
- 删除默认是**软删除**：记忆移入 `<project>/.archive/`（带 `forgotAt`/`forgotReason` 墓碑），UI 可恢复；只有 `remote delete` 与回收站「彻底删除」才真的 `rm` 文件。**不要**把 UI 的删除按钮接回 `delete`，那会绕过回收站。
- 记忆正文与描述中可能出现任意 Markdown / 特殊字符，序列化必须走 `yamlScalar`，不要手拼 YAML。
- `typert.host.js` 的 result schema 是 **strict**：返回结构必须与 schema 完全一致（字段不缺席、类型正确），否则网关校验失败。
- **宿主版本声明**：`package.json` 顶层 `engines.dsh`（当前 `^0.1.0-rc.7 || ^0.2.0-rc.1`，与 typert-protocol peer 同区间；两处必须同步，见第 1 节 0.2.0 闸门段落）。dshmarket 读 `manifest.engines.dsh`（顶层优先，回落 `dsh.engines.dsh`）加上 `dsh*` peerDependencies 的交集来显示「宿主要求」、驱动「适配本机 DSH 版本」过滤和安装/更新阻断；引擎区间是**严格**判定（低于下限或高于上限都算 incompatible，`includePrerelease`）。放宽/收紧支持范围时同步改这里，并用本机 dshmarket 的 `deriveHostCompatibility` 跑一遍确认 0.1.5-rc.3、0.1.7-rc.1 与 0.2.0-rc.1 都判 compatible。
