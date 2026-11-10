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
  id: "@duke-dsh-plugins/dsh-memory-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    // Official DSH design-system atoms (Button etc.) — same pattern as the
    // desktop-plugin bundle. The Button variants are backed by the
    // `--dsw-alias-button-*` token family, so light/dark themes are automatic.
    const ui = require("@deepseek-ai/dsh-client-ui-primitives");

    // ---- CSS (package-owned, mirrors DSH design tokens) --------------------
    const CSS = `
.mm-page{max-width:760px;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.mm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mm-head-title{font-size:16px;font-weight:500;line-height:24px;margin:0;flex:1}
.mm-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.mm-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-height:18px}
.mm-toggle{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.mm-toggle input{accent-color:var(--dsw-alias-brand-primary,#4a7dff);width:15px;height:15px;cursor:pointer;flex:none}
.mm-toggle-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-left:auto;text-align:right}
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
.mm-st-superseded{background:rgba(128,128,128,.16);color:var(--dsw-alias-label-secondary)}
.mm-st-pinned{background:rgba(245,185,66,.18);color:#c98a12}
.mm-origin{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.mm-archive-banner{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mm-archive-banner strong{color:var(--dsw-alias-label-primary);font-weight:600}
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

/* Legacy settings nav icon (DSH <= 0.2.1 only): those hosts project no icon
   for an external settings.section and paint a generic gear as a DIRECT child
   of the nav button. markLegacySettingsNavRow marks our own row on that DOM
   shape only (a direct <svg> child), so the shell's gear is hidden and the
   brain Lucide glyph is drawn as a currentColor mask — it then follows the
   native nav hover/active colors without changing the shell's 16px icon
   rhythm. On DSH >= 0.2.2 the shell owns the glyph inside a span.navIcon
   wrapper and renders it from the settings.section.icon slot, so no row is
   ever marked and this CSS stays inert (marking it would draw the brain NEXT
   to the shell's own glyph — two icons in one row). */
[data-dsh-memory-manager-settings-nav]>svg:first-child{display:none}
[data-dsh-memory-manager-settings-nav]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z'/%3E%3Cpath d='M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z'/%3E%3Cpath d='M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z'/%3E%3Cpath d='M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z'/%3E%3Cpath d='M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4'/%3E%3C/svg%3E") center/contain no-repeat}
`;

    // ---- Settings nav icon --------------------------------------------------
    // DSH >= 0.2.2 ships a dedicated `settings.section.icon` slot: the
    // settings shell wraps every nav row's glyph in `span.navIcon` and asks
    // that slot for the row's own icon, addressed by the section id
    // (`renderSlot('settings.section.icon', {size, active}, {only: row.id,
    // fallback: <shell gear>})`). A registration whose id equals the section
    // id replaces the shell's generic gear; the shell keeps the gear as the
    // fallback when nothing is registered.
    //
    // DSH <= 0.2.1 has no such slot: the shell projects only id/order/label
    // and paints the gear as a DIRECT child of the nav button. That older DOM
    // is handled by the legacy marker + CSS path below, which is gated on the
    // DOM shape so the two paths can never both paint (that would show the
    // brain AND the gear in one row).
    const SETTINGS_LABEL = "记忆管理";
    const SETTINGS_SECTION_ID = "memory-manager";
    const SETTINGS_NAV_MARKER = "data-dsh-memory-manager-settings-nav";

    /**
     * The nav glyph: Lucide "brain" (24x24, stroke 2) — the same glyph the
     * legacy CSS mask drew, so the icon the user sees does not change with
     * the host version. `currentColor` keeps it on the shell's native nav
     * hover/active colors, and `size` follows the shell's 16px icon rhythm.
     * The shell already marks the glyph span `aria-hidden`, so the SVG needs
     * no accessible name of its own.
     * @param {{ size?: number, active?: boolean }} props - owner props from the settings shell.
     * @returns {import("react").ReactElement} the icon element.
     */
    function MemoryNavIcon(props) {
      const p = props || {};
      const size = typeof p.size === "number" && p.size > 0 ? p.size : 16;
      return React.createElement(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        React.createElement("path", { key: "left", d: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" }),
        React.createElement("path", { key: "right", d: "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" }),
        React.createElement("path", { key: "middle", d: "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" }),
      );
    }

    /**
     * True when the nav row still uses the pre-0.2.2 shell shape: the gear is
     * a direct <svg> child of the button. On 0.2.2+ the button's children are
     * `span.navIcon` (glyph) + `span.navLabel`, so no direct svg child exists
     * and the legacy path must stay off.
     * @param {Element} button - one settings nav button.
     * @returns {boolean} whether the legacy gear is present.
     */
    function hasLegacyGear(button) {
      const children = button.children || [];
      for (let i = 0; i < children.length; i++) {
        const tag = children[i].tagName ? String(children[i].tagName).toLowerCase() : "";
        if (tag === "svg") return true;
      }
      return false;
    }

    /**
     * Legacy (DSH <= 0.2.1) settings nav icon: mark this plugin's own nav row
     * so the CSS above replaces the shell's fallback gear. The disposer clears
     * the marker for HMR / plugin disable.
     * @param {string} label - this plugin's localized settings section label.
     * @returns {() => void} disposer that stops observing and clears the marker.
     */
    function markLegacySettingsNavRow(label) {
      let disposed = false;
      const sync = function () {
        if (disposed) return;
        const currentLabel = String(label).trim();
        const buttons = document.querySelectorAll('[role="dialog"] nav button');
        for (let i = 0; i < buttons.length; i++) {
          const button = buttons[i];
          const text = button.textContent ? button.textContent.trim() : "";
          if (currentLabel.length > 0 && text === currentLabel && hasLegacyGear(button)) {
            button.setAttribute(SETTINGS_NAV_MARKER, "");
          } else {
            button.removeAttribute(SETTINGS_NAV_MARKER);
          }
        }
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return function () {
        disposed = true;
        observer.disconnect();
        const marked = document.querySelectorAll("[" + SETTINGS_NAV_MARKER + "]");
        for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(SETTINGS_NAV_MARKER);
      };
    }

    // ---- Client Remote contribution ----------------------------------------
    // The browser-side `remote.memoryManager` service only exists after this
    // module mounts its namespace via ctx.remote.$mount(): dsh-api-remotes'
    // client assembly mounts only the five official namespaces, so a plugin
    // must mount its own. Mirrors the invocations in typert.host.js. zod is
    // not requirable in the browser module loader, so codecs use passthrough
    // schemas. Strict codecs carry BOTH shapes: DSH <= 0.1.5 validates a live
    // schema.parse(), DSH >= 0.1.7 requires a create() factory — each side
    // only checks its own field, so supplying both keeps every host happy.
    const passthrough = () => ({ parse: (v) => v });
    const method = (m, params) => {
      const request = { mode: "strict", typeSymbol: "dsh-memory-manager#MemoryManager" + m + "Request", schema: passthrough(), create: () => passthrough() };
      const result = { mode: "strict", typeSymbol: "dsh-memory-manager#MemoryManager" + m + "Result", schema: passthrough(), create: () => passthrough() };
      return {
        id: "dsh-memory-manager#memoryManager/" + m,
        service: "memoryManager",
        namespace: "memoryManager",
        method: m,
        invocation: { kind: "direct" },
        parameters: (params || []).map((name) => ({
          name,
          wire: name,
          source: "json",
          codec: request,
        })),
        result,
      };
    };
    const CLIENT_REMOTE = {
      package: "dsh-memory-manager",
      descriptors: [
        method("list", ["request"]),
        method("get", ["request"]),
        method("create", ["request"]),
        method("update", ["request"]),
        method("delete", ["request"]),
        method("forget", ["request"]),
        method("restore", ["request"]),
        method("purge", ["request"]),
        method("importZCode", ["request"]),
        method("getConfig", []),
        method("setConfig", ["request"]),
      ],
    };

    async function apply(ctx) {
      // Mount the memoryManager namespace before anything touches it.
      await ctx.remote.$mount(CLIENT_REMOTE);

      const styleTag = document.createElement("style");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => styleTag.remove());

      // Legacy hosts (DSH <= 0.2.1): mark our settings-nav row so the CSS
      // above replaces the shell's fallback gear. On 0.2.2+ the row carries
      // no direct svg child, so nothing is marked and the CSS stays inert —
      // the icon then comes from the `settings.section.icon` slot below.
      ctx.effect(() => markLegacySettingsNavRow(SETTINGS_LABEL));

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

      /** Provenance label: a memory the model wrote itself must not look like a user fact. */
      function originLabel(origin) {
        const value = String(origin || "manual").toLowerCase();
        if (value === "manual" || value === "user") return "人工";
        if (value === "agent" || value === "ai") return "AI";
        return "导入";
      }

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
        const [pinned, setPinned] = React.useState(!!props.initial.pinned);
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
              React.createElement(
                "label", { className: "mm-toggle" },
                React.createElement("input", {
                  type: "checkbox",
                  checked: pinned,
                  onChange: (e) => setPinned(e.target.checked),
                }),
                React.createElement("span", null, "置顶"),
                React.createElement("span", { className: "mm-toggle-hint" }, "注入索引时排在最前，不会被条数上限挤掉")
              ),
              field("内容（Markdown）",
                React.createElement("textarea", {
                  className: "mm-textarea", value: body,
                  onChange: (e) => setBody(e.target.value),
                }))
            ),
            React.createElement(
              "div", { className: "mm-modal-foot" },
              React.createElement(ui.Button, { variant: "ghost", size: "sm", onClick: props.onClose }, "取消"),
              React.createElement(ui.Button, {
                variant: "primary", size: "sm", disabled: props.busy || !name.trim(),
                onClick: () => props.onSave({ name, description, type, project, pinned, body }),
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
                React.createElement("span", null, "项目: " + (item.label || item.project)),
                React.createElement("span", null, "更新于 " + fmtTime(item.updatedAt)),
                React.createElement("span", { className: "mm-origin" }, "来源: " + originLabel(item.origin)),
                item.pinned ? React.createElement("span", { className: "mm-badge mm-st-pinned" }, "置顶") : null,
                item.status && item.status !== "active"
                  ? React.createElement("span", { className: "mm-badge mm-st-superseded" },
                      item.supersededBy ? "已被 " + item.supersededBy + " 取代" : "已被取代")
                  : null,
                item.supersedes ? React.createElement("span", { className: "mm-origin" }, "取代了: " + item.supersedes) : null,
                item.useCount ? React.createElement("span", { className: "mm-origin" }, "读取 " + item.useCount + " 次") : null
              ),
              item.description ? React.createElement("div", { className: "mm-import-line" }, item.description) : null,
              React.createElement("div", { className: "mm-detail-body" }, item.body || "（空）")
            ),
            React.createElement(
              "div", { className: "mm-modal-foot" },
              React.createElement(ui.Button, { variant: "ghost", size: "sm", onClick: props.onEdit }, "编辑"),
              React.createElement(ui.Button, { variant: "primary", size: "sm", onClick: props.onClose }, "关闭")
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
              React.createElement(ui.Button, { variant: "ghost", size: "sm", onClick: props.onClose }, "关闭"),
              !props.result
                ? React.createElement(ui.Button, {
                    variant: "primary", size: "sm", disabled: props.busy,
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
        const [showArchived, setShowArchived] = React.useState(false);
        const [purging, setPurging] = React.useState(null); // "id|file" awaiting purge confirmation
        const [editing, setEditing] = React.useState(null); // { id?, ... } form state
        const [viewing, setViewing] = React.useState(null); // item
        const [importing, setImporting] = React.useState(false); // modal open
        const [importResult, setImportResult] = React.useState(null);
        const [importSource, setImportSource] = React.useState("");
        const [autoLoad, setAutoLoad] = React.useState(true);
        const [autoLoadBusy, setAutoLoadBusy] = React.useState(false);
        const [injectBody, setInjectBody] = React.useState(false);
        const [injectBodyBusy, setInjectBodyBusy] = React.useState(false);

        const loadConfig = React.useCallback(async () => {
          try {
            const res = await remote.getConfig();
            const out = unwrap(res);
            if (out.ok && out.value && out.value.config) {
              setAutoLoad(out.value.config.autoLoad !== false);
              setInjectBody(out.value.config.injectBody === true);
            }
          } catch (e) { /* keep default */ }
        }, []);

        const toggleAutoLoad = React.useCallback(async (next) => {
          setAutoLoadBusy(true);
          try {
            const res = await remote.setConfig({ autoLoad: next });
            const out = unwrap(res);
            if (out.ok && out.value && out.value.config) setAutoLoad(out.value.config.autoLoad !== false);
          } catch (e) { /* keep previous */ }
          finally { setAutoLoadBusy(false); }
        }, []);

        const toggleInjectBody = React.useCallback(async (next) => {
          setInjectBodyBusy(true);
          try {
            const res = await remote.setConfig({ injectBody: next });
            const out = unwrap(res);
            if (out.ok && out.value && out.value.config) setInjectBody(out.value.config.injectBody === true);
          } catch (e) { /* keep previous */ }
          finally { setInjectBodyBusy(false); }
        }, []);

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
        React.useEffect(() => { loadConfig(); }, [loadConfig]);

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

        const archivedFiltered = React.useMemo(() => {
          if (!data) return [];
          const q = query.trim().toLowerCase();
          return (data.archivedItems || []).filter((a) => {
            if (projectFilter !== "all" && a.project !== projectFilter) return false;
            if (q && a.name.toLowerCase().indexOf(q) === -1 && String(a.description || "").toLowerCase().indexOf(q) === -1) return false;
            return true;
          });
        }, [data, query, projectFilter]);

        const grouped = React.useMemo(() => {
          const map = new Map();
          for (const m of filtered) {
            if (!map.has(m.project)) map.set(m.project, []);
            map.get(m.project).push(m);
          }
          const groups = [];
          for (const [key, items] of map) {
            items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            groups.push({ key, label: (items[0] && items[0].label) || (key === (data && data.globalProject) ? "全局" : key), items });
          }
          groups.sort((a, b) => {
            const aGlobal = a.key === (data && data.globalProject) ? 0 : 1;
            const bGlobal = b.key === (data && data.globalProject) ? 0 : 1;
            return aGlobal - bGlobal || (a.key < b.key ? -1 : 1);
          });
          return groups;
        }, [filtered, data]);

        const runRemoteAction = async (action, payload) => {
          setBusy(true);
          setError(null);
          try {
            const res = await remote[action](payload);
            const out = unwrap(res);
            if (!out.ok) {
              setError((out.error && (out.error.message || out.error.code)) || "操作失败");
            } else {
              setConfirming(null);
              setPurging(null);
              await refresh();
            }
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        };

        const runAction = (action, id) => runRemoteAction(action, { id });

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

        /**
         * Load the full memory before opening the edit form. The list payload
         * carries no body, so opening the form straight from a row would save
         * an empty body and silently destroy the content.
         */
        const startEdit = async (id) => {
          setBusy(true);
          setError(null);
          try {
            const res = await remote.get({ id });
            const out = unwrap(res);
            if (out.ok && out.value && out.value.item) {
              const it = out.value.item;
              setEditing({
                id: it.id, name: it.name, description: it.description, type: it.type,
                project: it.project, pinned: Boolean(it.pinned), body: it.body || "",
                updatedAt: it.updatedAt,
              });
            } else {
              setError((out.error && (out.error.message || out.error.code)) || "读取记忆失败");
            }
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
              pinned: fields.pinned === true,
              body: fields.body,
            };
            // Carry the version this edit was based on, so a concurrent edit
            // from another session fails loud instead of being overwritten.
            const baseVersion = editing && editing.updatedAt ? { expectedUpdatedAt: editing.updatedAt } : {};
            const res = editing && editing.id
              ? await remote.update(Object.assign({ id: editing.id }, baseVersion, payload))
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
            { label: "有效记忆", value: String(s.total) },
            { label: "用户", value: String(s.byType.user || 0) },
            { label: "反馈", value: String(s.byType.feedback || 0) },
            { label: "参考", value: String(s.byType.reference || 0) },
            { label: "项目", value: String(s.byType.project || 0) },
            { label: "已被取代", value: String(s.superseded || 0) },
            { label: "回收站", value: String(s.archived || 0) },
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
        } else if (showArchived) {
          if (archivedFiltered.length === 0) {
            body = React.createElement("div", { className: "mm-empty" },
              "回收站是空的。删除记忆时它只会被移到这里，随时可以恢复。");
          } else {
            body = React.createElement(
              "div", { className: "mm-body" },
              React.createElement("div", { className: "mm-archive-banner" },
                "回收站：删除的记忆会保留在这里，可随时恢复；只有「彻底删除」才真正移除文件。"),
              archivedFiltered.map((a) => {
                const purgeKey = a.id + "|" + a.file;
                const isPurgeConfirm = purging === purgeKey;
                return React.createElement(
                  "div", { className: "mm-row", key: purgeKey },
                  React.createElement(
                    "div", { className: "mm-row-main" },
                    React.createElement("div", { className: "mm-row-title" }, a.name),
                    React.createElement("div", { className: "mm-row-desc" }, a.description || "（无描述）"),
                    React.createElement(
                      "div", { className: "mm-row-meta" },
                      React.createElement("span", { className: "mm-badge " + (TYPE_CLASS[a.type] || "mm-t-other") }, TYPE_LABEL[a.type] || a.type),
                      React.createElement("span", null, (a.label || a.project) + " · 归档于 " + fmtTime(a.archivedAt)),
                      a.reason ? React.createElement("span", { className: "mm-origin" }, "原因: " + a.reason) : null
                    )
                  ),
                  React.createElement(
                    "div", { className: "mm-row-actions" },
                    React.createElement("button", {
                      className: "mm-act",
                      disabled: busy,
                      onClick: () => runRemoteAction("restore", { id: a.id, file: a.file }),
                    }, "恢复"),
                    React.createElement("button", {
                      className: "mm-act mm-act-danger",
                      disabled: busy,
                      onClick: () => {
                        if (isPurgeConfirm) runRemoteAction("purge", { id: a.id, file: a.file });
                        else setPurging(purgeKey);
                      },
                    }, isPurgeConfirm ? "确认彻底删除?" : "彻底删除")
                  )
                );
              })
            );
          }
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
                        React.createElement("span", { className: "mm-origin" }, originLabel(m.origin)),
                        m.pinned ? React.createElement("span", { className: "mm-badge mm-st-pinned" }, "置顶") : null,
                        m.status === "superseded"
                          ? React.createElement("span", { className: "mm-badge mm-st-superseded" },
                              m.supersededBy ? "已被 " + m.supersededBy + " 取代" : "已被取代")
                          : null
                      )
                    ),
                    React.createElement(
                      "div", { className: "mm-row-actions" },
                      React.createElement("button", { className: "mm-act", disabled: busy, onClick: () => openView(m.id) }, "查看"),
                      React.createElement("button", {
                        className: "mm-act",
                        disabled: busy,
                        onClick: () => startEdit(m.id),
                      }, "编辑"),
                      React.createElement("button", {
                        className: "mm-act mm-act-danger",
                        disabled: busy,
                        onClick: () => {
                          if (isConfirm) { setConfirming(null); runRemoteAction("forget", { id: m.id, reason: "从设置页移入回收站" }); }
                          else setConfirming(m.id);
                        },
                      }, isConfirm ? "移到回收站?" : "删除")
                    )
                  );
                })
              )
            )
          );
        }

        const head = React.createElement(
          "div", { className: "mm-head" },
          React.createElement("div", { className: "mm-head-title" }, showArchived ? "记忆管理 · 回收站" : "记忆管理"),
          React.createElement(
            "div", { className: "mm-head-actions" },
            React.createElement(ui.Button, { variant: "ghost", size: "sm", onClick: () => refresh(), disabled: busy }, "刷新"),
            React.createElement(ui.Button, {
              variant: "ghost", size: "sm",
              onClick: () => { setShowArchived(!showArchived); setConfirming(null); setPurging(null); },
              disabled: busy,
            }, showArchived ? "返回记忆列表" : "回收站 (" + ((data && data.stats && data.stats.archived) || 0) + ")"),
            showArchived ? null : React.createElement(ui.Button, { variant: "primary", size: "sm", onClick: () => setEditing({}), disabled: busy }, "新建记忆"),
            showArchived ? null : React.createElement(ui.Button, {
              variant: "outline", size: "sm",
              onClick: () => { setImportResult(null); setImportSource(""); setImporting(true); },
              disabled: busy,
            }, "从 ZCode 导入")
          )
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
              setEditing({
                id: v.id, name: v.name, description: v.description, type: v.type,
                project: v.project, pinned: Boolean(v.pinned), body: v.body,
                updatedAt: v.updatedAt,
              });
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
            data
              ? "共 " + data.items.length + " 条记忆 · " + (data.projects.length || 0) + " 个项目" +
                ((data.stats && data.stats.archived) ? " · 回收站 " + data.stats.archived + " 条" : "")
              : ""),
          React.createElement(
            "label", { className: "mm-toggle" },
            React.createElement("input", {
              type: "checkbox",
              checked: autoLoad,
              disabled: autoLoadBusy,
              onChange: (e) => toggleAutoLoad(e.target.checked),
            }),
            React.createElement("span", null, "自动加载记忆到对话上下文"),
            React.createElement("span", { className: "mm-toggle-hint" }, "每次模型调用自动注入「当前项目 + 全局」的记忆索引（名称 + 描述）")
          ),
          React.createElement(
            "label", { className: "mm-toggle" },
            React.createElement("input", {
              type: "checkbox",
              checked: injectBody,
              disabled: injectBodyBusy,
              onChange: (e) => toggleInjectBody(e.target.checked),
            }),
            React.createElement("span", null, "注入记忆正文（不推荐）"),
            React.createElement("span", { className: "mm-toggle-hint" }, "开启后每条记忆附带最多 400 字正文；关闭时仅注入索引，agent 可用 memory_get 工具按需读取全文，更省上下文")
          ),
          statsCards,
          toolbar,
          body,
          modals
        );
      }

      // Settings entry: a full page under the sidebar Settings panel.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: SETTINGS_SECTION_ID, order: 30, label: () => SETTINGS_LABEL },
          MemoryManagerPage,
        ),
      );

      // Settings nav glyph (DSH >= 0.2.2): the shell renders every nav row's
      // icon from this slot, addressed by the section id, and keeps its own
      // gear as the fallback when no registration matches the row id. The
      // registration id MUST equal the section id above, otherwise the row
      // never renders our glyph. On older hosts the slot is not declared, the
      // inject callback never runs, and the legacy CSS path above applies.
      ctx.slots.inject("settings.section.icon", () =>
        ctx.slots.register(
          { name: "settings.section.icon", id: SETTINGS_SECTION_ID, order: 30, label: () => SETTINGS_LABEL },
          MemoryNavIcon,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
