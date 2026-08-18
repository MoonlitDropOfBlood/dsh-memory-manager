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
| 📥 从 ZCode 导入 | 一键扫描 `~/.zcode/cli/memories`（`memory/` + `topics/`），按项目 + 名称去重，不覆盖已有记忆 |
| 🌐 全局 + 项目记忆 | `global` 项目存放跨项目记忆；项目 key 取自工作区路径名，自动清洗为安全片段 |
| 📄 自动索引 | 每次变更自动重写 `MEMORY.md` 索引与 `memory_summary.md` 摘要 |
| 🌗 主题适配 | 全部使用 DSH 设计 token，明暗主题自动跟随 |

## 安装

### 本地安装

```bash
# 1. 克隆本仓库
git clone git@github.com:MoonlitDropOfBlood/dsh-memory-manager.git
cd dsh-memory-manager

# 2. 安装到本机 DSH profile（复制插件包 + 写入 cordis.patch.yml）
node scripts/install.mjs

# 3. 重启 DSH（命令行：node <dsh bin> web --profile web）
```

重启后，打开 **设置 → 记忆管理** 即可使用。

> 需要插件能在 profile 的 `node_modules` 解析到依赖（`zod`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol`）。若本机 DSH 未提供这些依赖，先在插件目录 `npm install`，再手动把 `node_modules` 一并复制，或把插件作为依赖加入 profile。

### 手动安装（原理）

1. 将插件包放入 `<DSH_HOME>/profiles/web/node_modules/dsh-memory-manager/`。
2. 在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
  - id: memory-manager
    name: 'dsh-memory-manager'
```

3. 重启 DSH。

## 使用

1. 打开 **设置**，侧栏出现 **记忆管理** 页。
2. 列表按项目分组、最新优先；顶部可**搜索**（名称/描述）、按**项目**和**类型**筛选；卡片展示类型徽章与更新时间。
3. **新建记忆**：填写名称（建议短横线 slug，可含中文）、类型、项目（`global` = 全局，或某个项目名，可参考工作区建议）、描述与 Markdown 正文。
4. **编辑 / 查看 / 删除**：每行右侧操作；删除需二次确认（永久，不可恢复）。
5. **从 ZCode 导入**：一键导入 `~/.zcode/cli/memories` 下各项目的记忆，同名自动跳过，结束后展示每个项目的导入/跳过统计。

## 工作原理

```
DSH Web UI
  └─ client.js (window.__ModuleLoader__.load bundle)
       └─ settings.section 注册「记忆管理」页
            └─ ctx.remote.memoryManager.{list|get|create|update|delete|importZCode}
                 └─ index.js (MemoryService, TypertRemoteService)
                      └─ memory-core.mjs（node:fs 直接读写）
                           ├─ <DSH_HOME>/memories/projects/<p>/memory/<name>.md
                           ├─ <DSH_HOME>/memories/projects/<p>/MEMORY.md
                           └─ <DSH_HOME>/memories/projects/<p>/memory_summary.md
```

记忆存储走 `node:fs` 直接落在 `<DSH_HOME>/memories/`（与 DSH 核心写 `~/.dsh` 的方式一致），无需 shell 沙箱。

## 目录结构

```
dsh-memory-manager/
├── index.js            # Host 半：MemoryService（Remote 服务）
├── client.js           # Client 半：设置「记忆管理」页 UI bundle
├── typert.host.js      # Typert Host manifest（Remote 方法描述）
├── memory-core.mjs     # 共享记忆核心（frontmatter / 存储 / 索引 / ZCode 导入），零依赖
├── scripts/install.mjs # 本地安装脚本
├── scripts/self-test.mjs # 独立核心自测（无需 DSH 进程）
├── .github/workflows/  # GitHub Actions 发布
├── AGENTS.md           # 面向 AI agent 的开发指南（含踩坑）
└── LICENSE             # MIT
```

## 开发

```bash
npm run check           # 全文件语法检查
npm test                # 独立核心自测（临时目录 CRUD / 索引 / ZCode 导入）
```

详见 [AGENTS.md](AGENTS.md)——记录了 DSH 正式插件（Host/Client/Typert 三件套）的完整机制和踩坑。

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区插件，并非 DeepSeek 官方产品。记忆格式移植自 ZCode 的项目记忆设计。
