<p align="center">
  <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" color="#4D6BFE"><rect x="1" y="2.5" width="12" height="9.5" rx="1.2"/><path d="M4 5.5h6M4 7.5h4"/></svg>
</p>

<h3 align="center">DeepSeek Harness 记忆管理插件</h3>

<p align="center">
  <img src="https://img.shields.io/badge/DSH-Plugin-4D6BFE?style=flat" alt="DSH plugin">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Web%20UI-Yes-22C55E?style=flat" alt="Web UI">
</p>

<p align="center"><sub>中文</sub></p>

---

为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web UI 打造的**持久化记忆**插件，移植自 **ZCode 的项目记忆（Memory）**：按项目（工作区）保存结构化记忆，并在**设置**里提供完整的记忆管理页面。

记忆以 ZCode 同款 Markdown 格式落盘（`<DSH_HOME>/memories/projects/<project>/memory/*.md`，含 `MEMORY.md` 索引与 `memory_summary.md` 摘要），并支持**一键从 ZCode 记忆目录导入**，把 ZCode 里积累的用户偏好 / 反馈 / 技术参考直接搬进 DSH。

## 功能

| 功能 | 说明 |
|---|---|
| 🧠 ZCode 记忆移植 | 沿用 ZCode 的记忆文件格式（YAML frontmatter + 正文）、类型体系（user / feedback / reference / project / other）与按项目分目录的存储布局 |
| ⚙️ 设置中的记忆管理 | 设置面板新增 **记忆管理** 页：搜索、项目/类型筛选、按项目分组、新建 / 编辑 / 删除（二次确认）/ 查看正文 |
| 🔄 自动加载到对话 | 每次模型调用自动把「当前项目 + 全局」的记忆**索引**（名称 + 描述）作为系统提示注入给智能体，省上下文；也可切换为附带正文截断的旧模式 |
| 🤖 Agent 记忆工具 | 注册 `memory_save` / `memory_get` / `memory_list` 三个模型工具：agent 可按需读取记忆全文、跨项目搜索，并在发现用户偏好 / 纠正 / 项目约定时**自己回写记忆**（同名即更新，`origin: agent`） |
| 📥 从 ZCode 导入 | 一键扫描 `~/.zcode/cli/memories`（`memory/` + `topics/`），按项目 + 名称去重，不覆盖已有记忆 |
| 🌐 全局 + 项目记忆 | `global` 项目存放跨项目记忆；项目 key 取自工作区路径名，自动清洗为安全片段 |
| 📄 自动索引 | 每次变更自动重写 `MEMORY.md` 索引与 `memory_summary.md` 摘要 |
| 🌗 主题适配 | 全部使用 DSH 设计 token（按钮为官方 DSH Button 组件），明暗主题自动跟随 |

## 安装

### 标准安装（推荐）

本插件是**标准 DSH bundle**：`package.json` 声明 `dsh.bundle.patch`，包内自带 `cordis.patch.yml`，用官方 `dsh plugin` 命令安装：

```bash
# 本地开发：pnpm 软链到本仓库，改代码即生效（无需重新复制）
dsh plugin --profile web add /path/to/dsh-memory-manager

# 正式发布：从 GitHub Release tarball 安装
dsh plugin --profile web add https://github.com/MoonlitDropOfBlood/dsh-memory-manager/releases/download/v1.2.0/dsh-memory-manager-1.2.0.tgz
```

重启 DSH 后，打开 **设置 → 记忆管理** 即可使用。

> `dsh plugin add` 把插件装成 profile 的 npm 依赖并追加到 `dsh.profile.bundles`，启动时 DSH 自动应用包内的 `cordis.patch.yml` 挂载插件。卸载：`dsh plugin --profile web remove dsh-memory-manager`。

## 使用

1. 打开 **设置**，侧栏出现 **记忆管理** 页。
2. 列表按项目分组、最新优先；顶部可**搜索**（名称/描述）、按**项目**和**类型**筛选；卡片展示类型徽章与更新时间。
3. **自动加载记忆到对话上下文**：默认开启。每次模型调用，DSH 会把当前会话工作区项目的记忆 + 全局记忆的**索引**（名称 + 描述，不含正文）作为系统提示注入给智能体，agent 对某条感兴趣时自行用 `memory_get` 工具读取全文——比全量注入省一个量级的上下文。需要旧行为（每条附带 400 字正文截断）可在记忆管理页打开「注入记忆正文」。
4. **Agent 回写记忆**：agent 在对话中发现值得长期保留的用户偏好、纠正/反馈、项目约定时，会自己调用 `memory_save` 写入记忆（`origin: agent`），之后每轮索引自动带上它。也可在记忆管理页看到、编辑或删除这些记忆。
5. **新建记忆**：填写名称（建议短横线 slug，可含中文）、类型、项目（`global` = 全局，或某个项目名，可参考工作区建议）、描述与 Markdown 正文。
6. **编辑 / 查看 / 删除**：每行右侧操作；删除需二次确认（永久，不可恢复）。
7. **从 ZCode 导入**：一键导入 `~/.zcode/cli/memories` 下各项目的记忆，同名自动跳过，结束后展示每个项目的导入/跳过统计。

## 工作原理

```
DSH Web UI
  └─ client.js (window.__ModuleLoader__.load bundle)
       └─ settings.section 注册「记忆管理」页
            └─ ctx.remote.memoryManager.{list|get|create|update|delete|importZCode|getConfig|setConfig}
                 └─ index.js (MemoryService, TypertRemoteService)
                      ├─ systemPrompt.section（order 90）→ 每次模型调用注入「记忆索引」段落
                      │    └─ context.agent.session.header.cwd → 项目 key → 项目 + 全局记忆索引（同步渲染，进程内缓存）
                      ├─ ctx.tools.register → memory_save / memory_get / memory_list（agent 回写与按需读取）
                      │    └─ systemPrompt.section（order 100）→ 工具使用指引
                      └─ memory-core.mjs（node:fs 直接读写）
                           ├─ <DSH_HOME>/memories/projects/<p>/memory/<name>.md
                           ├─ <DSH_HOME>/memories/projects/<p>/MEMORY.md
                           ├─ <DSH_HOME>/memories/projects/<p>/memory_summary.md
                           └─ <DSH_HOME>/memories/config.json（autoLoad / injectBody 开关）
```

记忆存储走 `node:fs` 直接落在 `<DSH_HOME>/memories/`（与 DSH 核心写 `~/.dsh` 的方式一致），无需 shell 沙箱。

## 目录结构

```
dsh-memory-manager/
├── index.js            # Host 半：MemoryService（Remote 服务）
├── client.js           # Client 半：设置「记忆管理」页 UI bundle
├── typert.host.js      # Typert Host manifest（Remote 方法描述）
├── memory-core.mjs     # 共享记忆核心（frontmatter / 存储 / 索引 / ZCode 导入），零依赖
├── cordis.patch.yml    # dsh bundle patch（挂载行）
├── scripts/self-test.mjs # 独立核心自测（无需 DSH 进程）
├── .github/workflows/  # GitHub Actions 发布
├── AGENTS.md           # 面向 AI agent 的开发指南（含踩坑）
└── LICENSE             # MIT
```

## 开发

```bash
npm run check           # 全文件语法检查
npm test                # 独立核心自测（临时目录 CRUD / 索引 / ZCode 导入）
dsh plugin --profile web add /path/to/dsh-memory-manager   # 安装/重装到本机 DSH profile
```

详见 [AGENTS.md](AGENTS.md)——记录了 DSH 正式插件（Host/Client/Typert 三件套）的完整机制和踩坑。

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区插件，并非 DeepSeek 官方产品。记忆格式移植自 ZCode 的项目记忆设计。
