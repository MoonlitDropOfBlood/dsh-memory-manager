/**
 * dsh-memory-manager — Client half (web bundle).
 *
 * Rendered by the DSH web shell via `window.__ModuleLoader__.load`. Registers a
 * **记忆管理** page in the Settings panel (`settings.section`, order 30) that:
 *   - lists all memories (grouped by project, newest first) with search,
 *     project and type filters;
 *   - shows per-type stats and project summaries;
 *   - creates / edits / deletes memories (composite id `project/name`);
 *   - views a memory's full body;
 *   - imports an existing ZCode memory directory in one click.
 *
 * Host communication goes through the `memoryManager` Remote namespace
 * (`ctx.remote.memoryManager.{list,get,create,update,delete,importZCode}`),
 * published by the Host half in `index.js`.
 *
 * IMPORTANT: every React component below is defined once at bundle scope so its
 * function identity is stable across parent re-renders. Never create a
 * component type inline inside another render (a new identity each render makes
 * React unmount/remount the subtree and wipes local input state).
 */
window.__ModuleLoader__.load({
  id: "dsh-memory-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // ---- CSS (package-owned, mirrors DSH design tokens) --------------------
    const CSS = `
.mm-page{max-width:760px;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.mm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mm-head-title{font-size:16px;font-weight:500;line-height:24px;margin:0;flex:1}
.mm-btn{box-sizing:border-box;height:28px;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 12px;font-size:12px;line-height:26px;white-space:nowrap}
.mm-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.mm-btn-primary{background:var(--dsw-alias-brand-primary,#4a7dff);border-color:transparent;color:#fff}
.mm-btn-primary:hover{color:#fff;opacity:.9}
.mm-btn[disabled]{opacity:.5;cursor:default}
.mm-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-height:18px}
.mm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.mm-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:10px 14px;display:flex;flex-direction:column;gap:3px}
.mm-card-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.mm-card-value{font-size:18px;font-weight:600;line-height:26px}
.mm-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mm-select{box-sizing:border-box;height:30px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 8px;outline:none;max-width:180px}
.mm-search{flex:1;min-width:160px;box-sizing:border-box;height:30px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;outline:none}
.mm-search:focus{border-color:var(--dsw-alias-brand-primary,#4a7dff)}
.mm-body{display:flex;flex-direction:column;gap:12px}
.mm-group{display:flex;flex-direction:column;gap:4px}
.mm-group-head{display:flex;align-items:baseline;gap:8px;padding:6px 2px 2px;font-weight:500;font-size:12px;color:var(--dsw-alias-label-secondary);}
.mm-group-count{font-size:11px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.mm-row{display:flex;align-items:flex-start;gap:10px;padding:10px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.mm-row-main{flex:1;min-width:0}
.mm-row-title{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mm-row-desc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mm-row-meta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mm-badge{display:inline-flex;align-items:center;height:18px;padding:0 8px;border-radius:999px;font-size:11px;line-height:18px;white-space:nowrap}
.mm-t-user{background:rgba(90,140,255,.14);color:#5b8cff}
.mm-t-feedback{background:rgba(245,185,66,.16);color:#d99a1f}
.mm-t-reference{background:rgba(62,207,142,.15);color:#2fb37d}
.mm-t-project{background:rgba(167,139,250,.15);color:#9b7ff0}
.mm-t-other{background:rgba(128,128,128,.14);color:var(--dsw-alias-label-secondary)}
.mm-row-actions{display:flex;gap:4px;flex:none;align-items:center}
.mm-act{border:none;background:transparent;color:var(--dsw-alias-brand-primary,#4a7dff);font-size:12px;line-height:18px;padding:4px 8px;border-radius:7px;cursor:pointer;white-space:nowrap}
.mm-act:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.mm-act-danger{color:var(--dsw-alias-state-error-primary,#e5484d)}
.mm-act-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.1))}
.mm-empty{text-align:center;padding:36px 16px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.mm-error{padding:8px 14px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.08));color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;line-height:18px}
.mm-loading{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:13px;padding:24px 0}
.mm-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:mm-spin .8s linear infinite;flex:none}
@keyframes mm-spin{to{transform:rotate(360deg)}}
.mm-overlay{position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.4));display:flex;align-items:center;justify-content:center;padding:24px}
.mm-modal{width:min(560px,94vw);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(128,128,128,.2));border-radius:16px;box-shadow:var(--dsw-shadow-lv2,0 12px 40px rgba(0,0,0,.25));overflow:hidden}
.mm-modal-head{display:flex;align-items:center;gap:10px;padding:16px 18px 10px}
.mm-modal-title{font-weight:600;font-size:15px;flex:1;line-height:22px}
.mm-modal-close{border:none;background:transparent;cursor:pointer;font-size:15px;width:26px;height:26px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,inherit);padding:0}
.mm-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,inherit)}
.mm-modal-body{flex:1;overflow-y:auto;padding:6px 18px 18px;display:flex;flex-direction:column;gap:12px}
.mm-field{display:flex;flex-direction:column;gap:5px}
.mm-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mm-input{box-sizing:border-box;width:100%;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;outline:none}
.mm-input:focus{border-color:var(--dsw-alias-brand-primary,#4a7dff)}
.mm-textarea{box-sizing:border-box;width:100%;min-height:180px;resize:vertical;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;outline:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap}
.mm-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4a7dff)}
.mm-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1)}
.mm-detail-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mm-detail-body{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:46vh;overflow-y:auto}
.mm-import-line{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mm-import-num{font-weight:600;color:var(--dsw-alias-label-primary)}
.mm-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
`;

    // ---- Client Remote contribution ----------------------------------------
    // The browser-side `remote.memoryManager` service only exists after this
    // module mounts its namespace via ctx.remote.$mount(): dsh-api-remotes'
    // client assembly mounts only the five official namespaces, so a plugin
    // must mount its own. Mirrors the invocations in typert.host.js. zod is
    // not requirable in the browser module loader, so codecs use passthrough
    // schemas — the runtime contract only requires typeSymbol + schema.parse().
    const passthrough = () => ({ parse: (v) => v });
    const method = (m, params) => ({
      id: "dsh-memory-manager#memoryManager/" + m,
      service: "memoryManager",
      namespace: "memoryManager",
      method: m,
      invocation: { kind: "direct" },
      parameters: (params || []).map((name) => ({
        name,
        wire: name,
        source: "json",
        codec: { mode: "strict", typeSymbol: "dsh-memory-manager#MemoryManager" + m + "Request", schema: passthrough() },
      })),
      result: { mode: "strict", typeSymbol: "dsh-memory-manager#MemoryManager" + m + "Result", schema: passthrough() },
    });
    const CLIENT_REMOTE = {
      package: "dsh-memory-manager",
      descriptors: [
        method("list", ["request"]),
        method("get", ["request"]),
        method("create", ["request"]),
        method("update", ["request"]),
        method("delete", ["request"]),
        method("importZCode", ["request"]),
      ],
    };

    async function apply(ctx) {
      // Mount the memoryManager namespace before anything touches it.
      await ctx.remote.$mount(CLIENT_REMOTE);

      const styleTag = document.createElement("style");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => styleTag.remove());

      // ctx.get() reads the service without the property-accessor inject guard.
      const remote = ctx.get("remote.memoryManager");

      /**
       * Normalize the Remote transport result into `{ ok, value | error }`.
       * Tolerates both envelope shapes seen across DSH plugins: a transport
       * wrapper `{ ok, value }` whose value is the Host method's full
       * `{ ok, value|error }` envelope, or the Host envelope returned directly.
       */
      function unwrap(res) {
        if (!res || res.ok !== true) {
          return { ok: false, error: (res && res.error) || { code: "transport", message: "调用失败" } };
        }
        const v = res.value;
        if (v && typeof v === "object" && typeof v.ok === "boolean") return v;
        return { ok: true, value: v };
      }

      const TYPE_LABEL = { user: "用户", feedback: "反馈", reference: "参考", project: "项目", other: "其他" };
      const TYPE_CLASS = { user: "mm-t-user", feedback: "mm-t-feedback", reference: "mm-t-reference", project: "mm-t-project", other: "mm-t-other" };

      function fmtTime(ts) {
        if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "";
        const diff = Date.now() - ts;
        const min = 60 * 1000, hour = 60 * min, day = 24 * hour, month = 30 * day;
        if (diff < min) return "刚刚";
        if (diff < hour) return Math.floor(diff / min) + " 分钟前";
        if (diff < day) return Math.floor(diff / hour) + " 小时前";
        if (diff < month) return Math.floor(diff / day) + " 天前";
        const d = new Date(ts);
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      }

      // ---- stable modal components -----------------------------------------
      // Defined once per bundle so React reconciliation never remounts them.

      function MemoryFormModal(props) {
        const isEdit = !!props.initial.id;
        const [name, setName] = React.useState(props.initial.name || "");
        const [description, setDescription] = React.useState(props.initial.description || "");
        const [type, setType] = React.useState(props.initial.type || "reference");
        const [project, setProject] = React.useState(props.initial.project || props.data.globalProject || "global");
        const [body, setBody] = React.useState(props.initial.body || "");
        const projectOptions = [];
        if (props.data) {
          for (const p of props.data.projects) projectOptions.push(p.key);
          for (const w of props.data.workspaces || []) if (projectOptions.indexOf(w) === -1) projectOptions.push(w);
          if (projectOptions.indexOf(props.data.globalProject) === -1) projectOptions.unshift(props.data.globalProject);
        }
        const field = (label, child) =>
          React.createElement(
            "div", { className: "mm-field" },
            React.createElement("label", { className: "mm-label" }, label),
            child
          );
        return React.createElement(
          "div", { className: "mm-overlay", onClick: props.onClose },
          React.createElement(
            "div", { className: "mm-modal", onClick: (e) => e.stopPropagation() },
            React.createElement(
              "div", { className: "mm-modal-head" },
              React.createElement("div", { className: "mm-modal-title" }, isEdit ? "编辑记忆" : "新建记忆"),
              React.createElement("button", { className: "mm-modal-close", onClick: props.onClose, "aria-label": "关闭" }, "✕")
            ),
            React.createElement(
              "div", { className: "mm-modal-body" },
              field("名称 *",
                React.createElement("input", {
                  className: "mm-input", value: name, placeholder: "例如 dsh-plugin-client-remote-mount",
                  onChange: (e) => setName(e.target.value),
                })),
              field("类型",
                React.createElement("select", {
                  className: "mm-select", value: type, style: { width: "100%", maxWidth: "100%" },
                  onChange: (e) => setType(e.target.value),
                },
                  (props.data.types || ["user", "feedback", "reference", "project", "other"]).map((t) =>
                    React.createElement("option", { key: t, value: t }, (TYPE_LABEL[t] || t) + " (" + t + ")")
                  )
                )),
              field("项目（global 表示全局记忆）",
                React.createElement("input", {
                  className: "mm-input", value: project, list: "mm-project-list",
                  placeholder: "global",
                  onChange: (e) => setProject(e.target.value),
                })),
              React.createElement("datalist", { id: "mm-project-list" },
                projectOptions.map((p) => React.createElement("option", { key: p, value: p }))
              ),
              field("描述",
                React.createElement("input", {
                  className: "mm-input", value: description,
                  onChange: (e) => setDescription(e.target.value),
                })),
              field("内容（Markdown）",
                React.createElement("textarea", {
                  className: "mm-textarea", value: body,
                  onChange: (e) => setBody(e.target.value),
                }))
            ),
            React.createElement(
              "div", { className: "mm-modal-foot" },
              React.createElement("button", { className: "mm-btn", onClick: props.onClose }, "取消"),
              React.createElement("button", {
                className: "mm-btn mm-btn-primary", disabled: props.busy || !name.trim(),
                onClick: () => props.onSave({ name, description, type, project, body }),
              }, props.busy ? "保存中…" : "保存")
            )
          )
        );
      }

      function MemoryViewModal(props) {
        const item = props.item;
        return React.createElement(
          "div", { className: "mm-overlay", onClick: props.onClose },
          React.createElement(
            "div", { className: "mm-modal", onClick: (e) => e.stopPropagation() },
            React.createElement(
              "div", { className: "mm-modal-head" },
              React.createElement("div", { className: "mm-modal-title" }, item.name),
              React.createElement("button", { className: "mm-modal-close", onClick: props.onClose, "aria-label": "关闭" }, "✕")
            ),
            React.createElement(
              "div", { className: "mm-modal-body" },
              React.createElement(
                "div", { className: "mm-detail-meta" },
                React.createElement("span", { className: "mm-badge " + (TYPE_CLASS[item.type] || "mm-t-other") }, TYPE_LABEL[item.type] || item.type),
                React.createElement("span", null, "项目: " + item.project),
                React.createElement("span", null, "更新于 " + fmtTime(item.updatedAt)),
                item.origin && item.origin !== "manual" ? React.createElement("span", null, "来源: " + item.origin) : null
              ),
              item.description ? React.createElement("div", { className: "mm-import-line" }, item.description) : null,
              React.createElement("div", { className: "mm-detail-body" }, item.body || "（空）")
            ),
            React.createElement(
              "div", { className: "mm-modal-foot" },
              React.createElement("button", { className: "mm-btn", onClick: props.onEdit }, "编辑"),
              React.createElement("button", { className: "mm-btn mm-btn-primary", onClick: props.onClose }, "关闭")
            )
          )
        );
      }

      function MemoryImportModal(props) {
        return React.createElement(
          "div", { className: "mm-overlay", onClick: props.onClose },
          React.createElement(
            "div", { className: "mm-modal", onClick: (e) => e.stopPropagation() },
            React.createElement(
              "div", { className: "mm-modal-head" },
              React.createElement("div", { className: "mm-modal-title" }, "从 ZCode 导入记忆"),
              React.createElement("button", { className: "mm-modal-close", onClick: props.onClose, "aria-label": "关闭" }, "✕")
            ),
            React.createElement(
              "div", { className: "mm-modal-body" },
              React.createElement("div", { className: "mm-import-line" }, "将扫描 ZCode 的记忆目录（默认 ~/.zcode/cli/memories），把各项目的 memory/ 与 topics/ 下的记忆复制到 DSH 记忆库中。同名（同项目）记忆会自动跳过，不会覆盖现有内容。"),
              React.createElement(
                "div", { className: "mm-field" },
                React.createElement("label", { className: "mm-label" }, "ZCode 记忆目录（可选，默认 ~/.zcode/cli/memories）"),
                React.createElement("input", {
                  className: "mm-input", value: props.source,
                  placeholder: "~/.zcode/cli/memories",
                  onChange: (e) => props.onSource(e.target.value),
                })
              ),
              props.result
                ? React.createElement(
                    "div", { className: "mm-field" },
                    React.createElement("div", { className: "mm-import-line" },
                      React.createElement("span", { className: "mm-import-num" }, "导入 " + props.result.imported + " 条"),
                      "，跳过 " + props.result.skipped + " 条（共 " + props.result.total + " 条）。"
                    ),
                    (props.result.projects || []).map((p) =>
                      React.createElement("div", { className: "mm-import-line", key: p.source },
                        "· " + p.source + " → " + p.project + "：导入 " + p.imported + "，跳过 " + p.skipped
                      )
                    )
                  )
                : React.createElement("div", { className: "mm-hint" }, "提示：导入前建议先确认 ZCode 里已有记忆（~/.zcode/cli/memories/projects/*/memory 或 topics）。")
            ),
            React.createElement(
              "div", { className: "mm-modal-foot" },
              React.createElement("button", { className: "mm-btn", onClick: props.onClose }, "关闭"),
              !props.result
                ? React.createElement("button", {
                    className: "mm-btn mm-btn-primary", disabled: props.busy,
                    onClick: props.onRun,
                  }, props.busy ? "导入中…" : "开始导入")
                : null
            )
          )
        );
      }

      function MemoryManagerPage(props) {
        const [data, setData] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [query, setQuery] = React.useState("");
        const [projectFilter, setProjectFilter] = React.useState("all");
        const [typeFilter, setTypeFilter] = React.useState("all");
        const [busy, setBusy] = React.useState(false);
        const [confirming, setConfirming] = React.useState(null);
        const [editing, setEditing] = React.useState(null); // { id?, ... } form state
        const [viewing, setViewing] = React.useState(null); // item
        const [importing, setImporting] = React.useState(false); // modal open
        const [importResult, setImportResult] = React.useState(null);
        const [importSource, setImportSource] = React.useState("");

        const refresh = React.useCallback(async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await remote.list({});
            const out = unwrap(res);
            if (out.ok) {
              setData(out.value);
            } else {
              setError((out.error && (out.error.message || out.error.code)) || "获取记忆失败");
            }
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }, []);

        React.useEffect(() => { refresh(); }, [refresh]);

        const filtered = React.useMemo(() => {
          if (!data) return [];
          const q = query.trim().toLowerCase();
          return data.items.filter((m) => {
            if (projectFilter !== "all" && m.project !== projectFilter) return false;
            if (typeFilter !== "all" && m.type !== typeFilter) return false;
            if (q && m.name.toLowerCase().indexOf(q) === -1 && m.description.toLowerCase().indexOf(q) === -1) return false;
            return true;
          });
        }, [data, query, projectFilter, typeFilter]);

        const grouped = React.useMemo(() => {
          const map = new Map();
          for (const m of filtered) {
            if (!map.has(m.project)) map.set(m.project, []);
            map.get(m.project).push(m);
          }
          const groups = [];
          for (const [key, items] of map) {
            items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            groups.push({ key, label: key === (data && data.globalProject) ? "全局" : key, items });
          }
          groups.sort((a, b) => {
            const aGlobal = a.key === (data && data.globalProject) ? 0 : 1;
            const bGlobal = b.key === (data && data.globalProject) ? 0 : 1;
            return aGlobal - bGlobal || (a.key < b.key ? -1 : 1);
          });
          return groups;
        }, [filtered, data]);

        const runAction = async (action, id) => {
          setBusy(true);
          setError(null);
          try {
            const res = await remote[action]({ id });
            const out = unwrap(res);
            if (!out.ok) {
              setError((out.error && (out.error.message || out.error.code)) || "操作失败");
            } else {
              await refresh();
            }
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        };

        const openView = async (id) => {
          setBusy(true);
          setError(null);
          try {
            const res = await remote.get({ id });
            const out = unwrap(res);
            if (out.ok && out.value && out.value.item) setViewing(out.value.item);
            else setError((out.error && (out.error.message || out.error.code)) || "读取失败");
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        };

        const submitForm = async (fields) => {
          setBusy(true);
          setError(null);
          try {
            const payload = {
              name: fields.name,
              description: fields.description,
              type: fields.type,
              project: fields.project || (data && data.globalProject) || "global",
              body: fields.body,
            };
            const res = editing && editing.id
              ? await remote.update(Object.assign({ id: editing.id }, payload))
              : await remote.create(payload);
            const out = unwrap(res);
            if (!out.ok) {
              setError((out.error && (out.error.message || out.error.code)) || "保存失败");
              return;
            }
            setEditing(null);
            await refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        };

        const runImport = async () => {
          setBusy(true);
          setError(null);
          try {
            const req = importSource && importSource.trim() ? { source: importSource.trim() } : {};
            const res = await remote.importZCode(req);
            const out = unwrap(res);
            if (!out.ok) {
              setError((out.error && (out.error.message || out.error.code)) || "导入失败");
            } else {
              setImportResult(out.value);
              await refresh();
            }
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        };

        // ---- view ----------------------------------------------------------

        const statsCards = data ? (function () {
          const s = data.stats;
          const cards = [
            { label: "记忆总数", value: String(s.total) },
            { label: "用户", value: String(s.byType.user || 0) },
            { label: "反馈", value: String(s.byType.feedback || 0) },
            { label: "参考", value: String(s.byType.reference || 0) },
            { label: "项目", value: String(s.byType.project || 0) },
            { label: "其他", value: String(s.byType.other || 0) },
          ];
          return React.createElement(
            "div", { className: "mm-stats" },
            cards.map((c, i) =>
              React.createElement(
                "div", { key: i, className: "mm-card" },
                React.createElement("div", { className: "mm-card-label" }, c.label),
                React.createElement("div", { className: "mm-card-value" }, c.value)
              )
            )
          );
        })() : null;

        const toolbar = React.createElement(
          "div", { className: "mm-toolbar" },
          React.createElement("input", {
            className: "mm-search",
            type: "text",
            placeholder: "搜索记忆名称或描述…",
            value: query,
            onChange: (e) => { setQuery(e.target.value); setConfirming(null); },
          }),
          React.createElement("select", {
            className: "mm-select",
            value: projectFilter,
            onChange: (e) => setProjectFilter(e.target.value),
          },
            React.createElement("option", { value: "all" }, "全部项目"),
            (data ? data.projects : []).map((p) =>
              React.createElement("option", { key: p.key, value: p.key }, p.label + " (" + p.count + ")")
            )
          ),
          React.createElement("select", {
            className: "mm-select",
            value: typeFilter,
            onChange: (e) => setTypeFilter(e.target.value),
          },
            React.createElement("option", { value: "all" }, "全部类型"),
            (data ? data.types : []).map((t) =>
              React.createElement("option", { key: t, value: t }, TYPE_LABEL[t] || t)
            )
          )
        );

        let body;
        if (error) {
          body = React.createElement("div", { className: "mm-error" }, error);
        } else if (!data) {
          body = React.createElement(
            "div", { className: "mm-loading" },
            React.createElement("span", { className: "mm-spinner", "aria-hidden": true }),
            React.createElement("span", null, "正在加载记忆…")
          );
        } else if (data.items.length === 0) {
          body = React.createElement("div", { className: "mm-empty" }, "还没有记忆。点击右上角「新建记忆」，或「从 ZCode 导入」把 ZCode 的记忆搬过来。");
        } else if (grouped.length === 0) {
          body = React.createElement("div", { className: "mm-empty" }, "没有符合筛选条件的记忆。");
        } else {
          body = React.createElement(
            "div", { className: "mm-body" },
            grouped.map((g) =>
              React.createElement(
                "div", { className: "mm-group", key: g.key },
                React.createElement(
                  "div", { className: "mm-group-head" },
                  React.createElement("span", null, g.label),
                  React.createElement("span", { className: "mm-group-count" }, g.items.length + " 条")
                ),
                g.items.map((m) => {
                  const isConfirm = confirming === m.id;
                  return React.createElement(
                    "div", { className: "mm-row", key: m.id },
                    React.createElement(
                      "div", { className: "mm-row-main" },
                      React.createElement("div", { className: "mm-row-title" }, m.name),
                      React.createElement("div", { className: "mm-row-desc" }, m.description || "（无描述）"),
                      React.createElement(
                        "div", { className: "mm-row-meta" },
                        React.createElement("span", { className: "mm-badge " + (TYPE_CLASS[m.type] || "mm-t-other") }, TYPE_LABEL[m.type] || m.type),
                        React.createElement("span", null, "更新于 " + fmtTime(m.updatedAt)),
                        m.origin && m.origin !== "manual" ? React.createElement("span", null, m.origin) : null
                      )
                    ),
                    React.createElement(
                      "div", { className: "mm-row-actions" },
                      React.createElement("button", { className: "mm-act", disabled: busy, onClick: () => openView(m.id) }, "查看"),
                      React.createElement("button", {
                        className: "mm-act",
                        disabled: busy,
                        onClick: () => setEditing({ id: m.id, name: m.name, description: m.description, type: m.type, project: m.project, body: "" }),
                      }, "编辑"),
                      React.createElement("button", {
                        className: "mm-act mm-act-danger",
                        disabled: busy,
                        onClick: () => {
                          if (isConfirm) { setConfirming(null); runAction("delete", m.id); }
                          else setConfirming(m.id);
                        },
                      }, isConfirm ? "确认删除?" : "删除")
                    )
                  );
                })
              )
            )
          );
        }

        const head = React.createElement(
          "div", { className: "mm-head" },
          React.createElement("div", { className: "mm-head-title" }, "记忆管理"),
          React.createElement("button", { className: "mm-btn", onClick: () => refresh(), disabled: busy }, "刷新"),
          React.createElement("button", {
            className: "mm-btn mm-btn-primary",
            onClick: () => setEditing({}),
            disabled: busy,
          }, "新建记忆"),
          React.createElement("button", {
            className: "mm-btn",
            onClick: () => { setImportResult(null); setImportSource(""); setImporting(true); },
            disabled: busy,
          }, "从 ZCode 导入")
        );

        const modals = [];
        if (editing !== null) {
          modals.push(React.createElement(MemoryFormModal, {
            key: "form",
            initial: editing,
            data: data || { projects: [], workspaces: [], types: [], globalProject: "global" },
            busy,
            onClose: () => setEditing(null),
            onSave: submitForm,
          }));
        }
        if (viewing) {
          modals.push(React.createElement(MemoryViewModal, {
            key: "view",
            item: viewing,
            onClose: () => setViewing(null),
            onEdit: () => {
              const v = viewing;
              setViewing(null);
              setEditing({ id: v.id, name: v.name, description: v.description, type: v.type, project: v.project, body: v.body });
            },
          }));
        }
        if (importing) {
          modals.push(React.createElement(MemoryImportModal, {
            key: "import",
            source: importSource,
            result: importResult,
            busy,
            onSource: setImportSource,
            onClose: () => setImporting(false),
            onRun: runImport,
          }));
        }

        return React.createElement(
          "div", { className: "mm-page" },
          head,
          React.createElement("div", { className: "mm-status" },
            data ? "共 " + data.items.length + " 条记忆 · " + (data.projects.length || 0) + " 个项目" : ""),
          statsCards,
          toolbar,
          body,
          modals
        );
      }

      // Settings entry: a full page under the sidebar Settings panel.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "memory-manager", order: 30, label: () => "记忆管理" },
          MemoryManagerPage,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
