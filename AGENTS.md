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
├── scripts/install.mjs   # 本地安装脚本：复制到 profile + 写入 patch
├── scripts/self-test.mjs # 独立核心自测：临时 DSH_HOME 上跑 CRUD/索引/导入（不依赖 DSH 进程）
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
- **设置页**注册：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "memory-manager", order: 30, label: () => "记忆管理" }, MemoryManagerPage))`。
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

### 6. 本地安装 = 复制包 + composition patch

`node scripts/install.mjs`：
1. 复制 `package.json` + `index.js` + `client.js` + `typert.host.js` + **`memory-core.mjs`**（别漏！）到 `<DSH_HOME>/profiles/web/node_modules/dsh-memory-manager/`。
2. 在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 用 `- insert:` 新增 `memory-manager` 行（不要用普通 `- id:` 覆盖）。
3. 重启 DSH。**必须重启**，Host 加载、typert 注册、client bundle 注入都在启动时发生。

## 开发 / 验证

```bash
npm run check            # 语法检查全部 JS
npm test                 # 独立核心自测（43 项断言：路径清洗/frontmatter/CRUD/索引/导入/去重/目录清理）
node scripts/install.mjs # 安装到本机 DSH profile
```

改插件后**必须重启 DSH 进程**才生效。验证：
1. 设置 → 侧栏导航出现 **记忆管理**。
2. 新建一条（含中文名）→ 列表出现、磁盘出现 `~/.dsh/memories/projects/<p>/memory/<name>.md` 与索引。
3. 编辑（改名/改类型/改正文）→ 旧文件消失、新文件正确。
4. 删除（二次确认）→ 文件与（空项目）目录被清理。
5. 从 ZCode 导入 → 统计与磁盘文件一致；重复导入全部跳过。

## 发布

打 `v1.0.0` 标签推送到 GitHub，`.github/workflows/release.yml` 会自动构建 `npm pack` 产物并发布为 GitHub Release（需要 `GH_TOKEN` secret，权限 `contents:write`）。

## 常规注意事项

- **不要直接编辑 `~/.dsh/profiles/web/cordis.yml`**（那是生成的文件，patch 覆盖在 `cordis.patch.yml`）。
- `cordis.patch.yml` 顶层是一个 patch 数组：`- insert:` 用于新增行，`- id:` 用于覆盖已有行。
- `client.js` 用 `require("react")`（bundle 的模块表提供），**不要** `import` 或动态插件的 `styles`/`host` 全局。
- 删除是**永久性**的，UI 里已加二次确认。
- 记忆正文与描述中可能出现任意 Markdown / 特殊字符，序列化必须走 `yamlScalar`，不要手拼 YAML。
- `typert.host.js` 的 result schema 是 **strict**：返回结构必须与 schema 完全一致（字段不缺席、类型正确），否则网关校验失败。
