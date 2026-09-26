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
├── memory-core.mjs       # 零依赖记忆核心：frontmatter 解析/序列化、路径清洗、索引生成、ZCode 导入
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

### 2. Host 半：类插件 + Remote 方法

```js
export class MemoryService extends TypertRemoteService {
  static inject = ["workspaceRegistry"];
  constructor(ctx, config) { super(ctx, "memoryManager"); }  // 必须传精确服务键
  [Service.init]() {
    markRemoteMethod(this, "list", "list");
    // ... create / update / delete / get / importZCode
  }
}
```

- 文件 I/O 直接 `import ... from "node:fs/promises"`。正式插件的 Host 半由 loader 用标准 `import()` 加载（见 `cordis-plugin-loader` 的 `EntryTree.import`），拥有完整 Node 权限，和 DSH 核心写 `~/.dsh` 一样，**不需要**走 `ctx.shell` 沙箱。记忆目录在 DSH_HOME 内，用 `node:fs` 最稳。
- Remote 标记用 `markRemoteMethod(instance, method, exportName)` 手动驱动 `Remote()` 装饰器（Node ESM 不支持装饰器语法），在 `[Service.init]()` 中调用。

### 3. Client 半：bundle 格式 + 自挂载 Remote

- `window.__ModuleLoader__.load({ id, factory })` 格式；`exports.inject = ["slots", "remote"]`。
- **必须自挂载** Remote 命名空间：`await ctx.remote.$mount(CLIENT_REMOTE)`（`dsh-api-remotes` 只挂载官方命名空间）；浏览器无 zod，codec 用 passthrough schema。调用走 `ctx.get("remote.memoryManager")`（不要写进 inject）。
- **设置页**注册：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "memory-manager", order: 30, label: () => SETTINGS_LABEL }, MemoryManagerPage))`。
- **设置导航图标**：DSH 0.1.x 的 `settings.section` 只投影 `id/order/label`，设置壳对每个外部 section 统一画通用齿轮（`client-ui-settings-general` 的 `navIcon()`，没有公开图标字段）。client.js 里 `registerSettingsNavIcon(SETTINGS_LABEL)` 用 MutationObserver 给 `[role="dialog"] nav button` 中文本等于 section label 的行打 `data-dsh-memory-manager-settings-nav` 标记，CSS 再隐藏 `>svg:first-child` 齿轮、用 `currentColor` mask 画 brain Lucide 图标（16px，跟随原生 hover/active 颜色）。换图标只需替换 CSS 里 data URI 的 SVG path（Lucide，24×24，stroke-width 2，stroke 用 black——mask 只取 alpha）。
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
- 每次写/删记忆后重写该项目 `MEMORY.md` 索引与 `memory_summary.md`；项目记忆清空后删除整个项目目录。
- `importFromZCode`：**必须跳过** `MEMORY.md` / `memory_summary.md`（它们是索引不是记忆），否则导入统计里会出现"跳过"噪音。
- 复合 id = `<projectKey>/<name>`（两者都已被清洗、不含 `/`），客户端用它做 `get/update/delete`。

### 6. 标准安装 = dsh bundle（package.json 声明 + 包内 cordis.patch.yml）

本插件是**标准 DSH bundle**：`package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`，用官方 `dsh plugin` 命令安装：

1. `dsh plugin --profile web add <本地路径或包>`：pnpm 把插件装成 profile 的 npm 依赖（本地路径走 `link:` 软链，改代码即生效），并把包名追加到 profile `package.json` 的 `dsh.profile.bundles`。`package.json` 的 `files` 必须包含 `index.js` + `client.js` + `typert.host.js` + **`memory-core.mjs`**（别漏！）+ `cordis.patch.yml`，否则 `npm pack`/发布会丢文件。

   **link: 安装的依赖解析坑（v1.4.1 修复，0.1.7-rc.2 上"加载失败被当成不兼容"的根因）**：`link:` 软链的 realpath 是开发目录（如 `D:\ai-projects\dsh\dsh-memory-manager`），Node 从这里向上找 `node_modules`——**不会**经过 `<DSH_HOME>/profiles/node_modules`（registry 装的包向上解析时恰好命中这个共享依赖目录，所以 registry 安装没此问题）。因此本地开发**必须先 `pnpm install`**，把 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-typert-protocol`（以及动态 import 的 `@deepseek-ai/dsh-tools`）实体化到本目录 `node_modules`，否则 Host 半 import 直接 `Cannot find package`，插件表现为"加载不上/不兼容"。这些包已声明在 `devDependencies`（只影响本地开发，不进发布产物；dsh-deveco 同款模式，借助 pnpm auto-install-peers）。devDep 的 typert-protocol 钉 `^0.1.7-rc.1` 以解析到与本机宿主一致的 0.1.7-rc.2（`^0.1.0-rc.7` 在 prerelease 语义下只会解析到 0.1.0-rc.8）。诊断手法：在 `<DSH_HOME>\profiles\web` 目录下 `node --input-type=module -e "await import('@duke-dsh-plugins/dsh-memory-manager')"`，PASS/FAIL 立判。
2. 启动时 DSH 应用包内 `cordis.patch.yml` 的 `- insert:` 行挂载插件（**不要**再在 profile 的 `cordis.patch.yml` 里手工插一行，否则同一 id 重复挂载）：

```yaml
# cordis.patch.yml（随包分发）
- insert:
  - id: memory-manager
    name: '@duke-dsh-plugins/dsh-memory-manager'
```

3. 重启 DSH。**必须重启**，Host 加载、typert 注册、client bundle 注入都在启动时发生。
4. 卸载：`dsh plugin --profile web remove dsh-memory-manager`（自动从 bundles 列表移除）。

### 7. Agent 记忆工具 + 索引注入（v1.1）

**注入是索引优先的**：`buildMemoryContextSync` 默认（`config.injectBody === false`）每条记忆只注入一行 `- [type] name — description（更新于 …）`，不带正文；`injectBody: true` 恢复旧模式（附加压平后 400 字正文截断）。配置落在 `<DSH_HOME>/memories/config.json`，UI 两个开关分别对应 `autoLoad` / `injectBody`。

**Agent 回写回路**：`[Service.init]()` 里用 `ctx.get("tools")` 拿 ToolRuntime，**动态 `import("@deepseek-ai/dsh-tools")`** 拿 `defineTool` 后注册三个模型工具：

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `memory_save` | 保存/更新记忆（同名即更新，新建 `origin: "agent"`） | name / description / type(enum) / body / project? |
| `memory_get` | 按名称读全文（配索引注入使用） | name / project? |
| `memory_list` | 跨项目搜索（名称/描述过滤，上限 50 条，不含正文） | query? / project? |

要点：

- **动态 import 是有意的**：`@deepseek-ai/dsh-tools` 解析失败只损失工具，不拖垮整个记忆服务。本机它从 `<DSH_HOME>/profiles/node_modules`（profile 共享依赖目录）解析。
- `ctx.tools.register()` 返回的 disposer 由 fiber 托管，无需手动清理（同 dsh-tool-web）。
- 工具的项目定位：`exec.agent.session.header.cwd` → `projectKeyFromPath`；模型也可显式传 `project`（`"global"` = 全局）。**cwd 拿不到就抛错**，宁可失败也不写错项目。
- 工具指引通过第二个 `systemPrompt.section`（`name: "tool:memory"`，order 100，遵循工具指引 100-199 区间约定）常驻提示词；索引段落本身（order 90）的引导语也指向 `memory_get` / `memory_save`。
- 工具参数/输出用 dsh-tools 的 schema DSL：string 支持 `enum`，object 必须显式 `additionalProperties`，`required: true` 逐字段标注。
- `setConfig` Remote 只合并且显式传入的布尔字段——`undefined` 会被 JSON 丢弃导致配置悄悄回默认值。

## 开发 / 验证

```bash
pnpm install           # 首次/换机必做：实体化 @deepseek-ai peer 依赖，link: 安装才能被宿主 import（见第 6 节）
npm run check            # 语法检查全部 JS
npm test                 # 独立核心自测（68 项断言）+ typert 双形态 codec 契约测试（281 项检查）
dsh plugin --profile web add /path/to/dsh-memory-manager   # 安装/重装到本机 DSH profile
```

改插件后**必须重启 DSH 进程**才生效。验证：
1. 设置 → 侧栏导航出现 **记忆管理**。
2. 新建一条（含中文名）→ 列表出现、磁盘出现 `~/.dsh/memories/projects/<p>/memory/<name>.md` 与索引。
3. 编辑（改名/改类型/改正文）→ 旧文件消失、新文件正确。
4. 删除（二次确认）→ 文件与（空项目）目录被清理。
5. 从 ZCode 导入 → 统计与磁盘文件一致；重复导入全部跳过。
6. 开新会话 → agent 工具列表有 `memory_save` / `memory_get` / `memory_list`；让 agent「记住」一个偏好 → 磁盘出现新记忆且 `origin: agent`，下一轮会话索引注入里能看到它。

## 发布

打 `v1.0.0` 标签推送到 GitHub，`.github/workflows/release.yml` 会自动构建 `npm pack` 产物并发布为 GitHub Release（需要 `GH_TOKEN` secret，权限 `contents:write`）。

## 常规注意事项

- **不要直接编辑 `~/.dsh/profiles/web/cordis.yml`**（那是生成的文件，patch 覆盖在 `cordis.patch.yml`）。
- `cordis.patch.yml` 顶层是一个 patch 数组：`- insert:` 用于新增行，`- id:` 用于覆盖已有行。
- `client.js` 用 `require("react")`（bundle 的模块表提供），**不要** `import` 或动态插件的 `styles`/`host` 全局。
- 删除是**永久性**的，UI 里已加二次确认。
- 记忆正文与描述中可能出现任意 Markdown / 特殊字符，序列化必须走 `yamlScalar`，不要手拼 YAML。
- `typert.host.js` 的 result schema 是 **strict**：返回结构必须与 schema 完全一致（字段不缺席、类型正确），否则网关校验失败。
- **宿主版本声明**：`package.json` 顶层 `engines.dsh`（当前 `^0.1.0-rc.7`，与 typert-protocol peer 同区间）。dshmarket 读 `manifest.engines.dsh`（顶层优先，回落 `dsh.engines.dsh`）加上 `dsh*` peerDependencies 的交集来显示「宿主要求」、驱动「适配本机 DSH 版本」过滤和安装/更新阻断；引擎区间是**严格**判定（低于下限或高于上限都算 incompatible，`includePrerelease`）。放宽/收紧支持范围时同步改这里，并用本机 dshmarket 的 `deriveHostCompatibility` 跑一遍确认 0.1.5-rc.3 与 0.1.7-rc.1 都判 compatible。
