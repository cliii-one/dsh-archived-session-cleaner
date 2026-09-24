// dsh-archived-session-cleaner client bundle：给已归档的会话在「...」菜单里加一项「彻底删除」。
//
// ## 为什么不用 styles 内置（上一版失败的原因）
//
// 上一版在 apply 里写 `ctx.effect(() => styles.insert(CSS))`，结果插件
// **在前端激活失败**（宿主 boot 检查报 failed，DSH 进不了前端）。
//
// 原因：**静态 profile 插件的客户端半边，工厂只收到 `require` 一个参数**
// —— module-loader 的 materialize 是
//   `exports: registered.factory(this.makeRequire(ownerId, edges))`
// 而 `styles` 是 `evaluateClientHalf`（cordis_run 动态插件路径）的参数，
// **静态插件的作用域里根本没有这个标识符** → 裸引用直接 ReferenceError
// → apply 抛错 → fiber.state = FAILED。
//
// 佐证：dsh-client-ui-workspace 自己**不用** styles 内置，而是把 CSS 编进
// 代码、用 `data-plugin-css` 标记的 <style> 标签幂等注入（本文件同款）。
//
// ## 交互约定
//
// 菜单项只对**已归档**会话渲染（未归档不渲染，不是灰掉——菜单里多一个
// 灰项也是噪音）。删除前必须二次确认，写明会话 id 与将释放的空间。
window.__ModuleLoader__.load({
  id: "dsh-archived-session-cleaner",
  factory: (require) => {
    const React = require("react");
    const ReactDOM = require("react-dom/client");
    const h = React.createElement;

    /** 插件的 slot id，避免与宿主或其他插件撞名。 */
    const SLOT_ID = "archived-session-cleaner";

    /** CSS 标签的幂等键：同键只注入一次，插件热更新也不会叠加。 */
    const CSS_TAG = "dsh-archived-session-cleaner/ui.css";

    /**
     * 样式：全部走宿主主题 token（--dsw-alias-*），明暗主题自动跟随。
     * z-index 2000：宿主前端的浮层上限是 1100，对话框要盖过所有内容。
     */
    const CSS = [
      "/* 菜单项：沿用宿主菜单行的内边距与圆角 */",
      ".asc-menu-item {",
      "  display: flex; align-items: center; gap: 8px; width: 100%;",
      "  padding: 6px 10px; border: none; border-radius: 6px;",
      "  background: transparent; cursor: pointer; text-align: left;",
      "  font-size: 13px; line-height: 1.4;",
      "  color: var(--dsw-alias-label-primary);",
      "  font-family: inherit;",
      "}",
      ".asc-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }",
      ".asc-menu-item:disabled { opacity: .5; cursor: default; }",
      "/* 危险操作：红色文字，与普通菜单项区分开 */",
      ".asc-menu-item--danger { color: var(--dsw-alias-state-error-primary); }",
      ".asc-menu-item__icon { flex: none; display: block; }",
      "/* 确认对话框：遮罩 + 居中卡片（Portal 挂 body 顶层，不受菜单容器约束） */",
      ".asc-overlay {",
      "  /* 100003：对齐宿主 modal 层。2000 会被侧栏等浮层压住（",
      "     documentpreview 的 modal 就在 100003） */",
      "  position: fixed; inset: 0; z-index: 100003;",
      "  display: flex; align-items: center; justify-content: center;",
      "  padding: 16px;",
      "  background: rgba(0, 0, 0, .45);",
      "}",
      ".asc-dialog {",
      "  width: 420px; max-width: 100%;",
      "  padding: 20px 22px; border-radius: 12px;",
      "  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));",
      "  border: 1px solid var(--dsw-alias-border-l2);",
      "  box-shadow: 0 16px 48px rgba(0, 0, 0, .32);",
      "  color: var(--dsw-alias-label-primary);",
      "}",
      ".asc-dialog__title {",
      "  display: flex; align-items: center; gap: 8px;",
      "  font-size: 15px; font-weight: 600; margin-bottom: 10px;",
      "}",
      ".asc-dialog__title svg { color: var(--dsw-alias-state-error-primary); flex: none; }",
      ".asc-dialog__body { font-size: 13px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }",
      ".asc-dialog__body strong {",
      "  color: var(--dsw-alias-label-primary);",
      "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
      "  font-size: 12px; word-break: break-all;",
      "}",
      ".asc-dialog__warn {",
      "  display: flex; align-items: flex-start; gap: 8px;",
      "  margin-top: 12px; padding: 10px 12px; border-radius: 8px; font-size: 12px;",
      "  line-height: 1.6; color: var(--dsw-alias-state-error-primary);",
      "  background: var(--dsw-alias-bg-layer-2);",
      "}",
      ".asc-dialog__error {",
      "  margin-top: 8px; font-size: 12px; color: var(--dsw-alias-state-error-primary);",
      "}",
      ".asc-dialog__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }",
      ".asc-btn {",
      "  padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;",
      "  border: 1px solid var(--dsw-alias-border-l2); background: transparent;",
      "  color: var(--dsw-alias-label-primary); font-family: inherit;",
      "}",
      ".asc-btn:hover { background: var(--dsw-alias-bg-layer-2); }",
      ".asc-btn:disabled { opacity: .5; cursor: default; }",
      "/* 危险按钮用「红边 + 红字」而不是实心红底：主题里没有\"反色文字\"token",
      "   （--dsw-alias-brand-primary 在浅色下是近白色），实心方案必须硬编码",
      "   白字。描边方案全走 token，明暗主题都安全。 */",
      ".asc-btn--danger {",
      "  border-color: var(--dsw-alias-state-error-primary);",
      "  color: var(--dsw-alias-state-error-primary);",
      "}",
      ".asc-btn--danger:hover { background: var(--dsw-alias-bg-layer-2); }",
      ".asc-btn--danger:disabled { opacity: .5; }",
    ].join("\n");

    /**
     * 幂等注入样式（workspace 插件同款：data-plugin-css 标记 + 只插一次）。
     *
     * 不依赖 styles 内置——静态 profile 插件的作用域里没有它（上一版
     * 因此激活失败）。
     */
    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-archived-session-cleaner";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** 垃圾桶图标（内联 SVG，跟随 currentColor）。 */
    function TrashIcon({ size = 14 }) {
      return h("svg", {
        className: "asc-menu-item__icon",
        width: size, height: size, viewBox: "0 0 16 16",
        fill: "none", stroke: "currentColor",
        strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": true,
      },
        h("path", { d: "M2.5 4h11" }),
        h("path", { d: "M6 4V2.6h4V4" }),
        h("path", { d: "M4 4l.7 9.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4" }),
        h("path", { d: "M6.6 6.8v4.4M9.4 6.8v4.4" }),
      );
    }

    /** 把字节数说成人话。 */
    function formatBytes(n) {
      if (typeof n !== "number" || n <= 0) return "无数据";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / 1024 / 1024).toFixed(2) + " MB";
    }

    /**
     * 删除请求的模块级 store。
     *
     * ## 为什么不能用组件状态（上一版踩坑）
     *
     * 宿主的 Menu 把 slot 内容渲染在菜单列表内部，并在 document 上监听
     * pointerdown 做"点外部关闭"。点弹窗里的按钮时事件冒泡到 document →
     * 菜单判定为外部点击而关闭 → 菜单项组件（连同它的 Portal）被卸载 →
     * **弹窗一闪而过**（用户看到的就是"没有居中的对话框显示了"）。
     *
     * 所以把"当前要删除哪个会话"放到模块级状态：菜单项只负责写入请求，
     * 弹窗由**独立的 body 层组件**渲染——它不在菜单子树里，菜单关不关
     * 都不影响它。
     */
    const purgeStore = { listeners: new Set(), current: null };
    function requestPurge(request) {
      purgeStore.current = request;
      for (const fn of purgeStore.listeners) fn(request);
    }
    function clearPurge() {
      purgeStore.current = null;
      for (const fn of purgeStore.listeners) fn(null);
    }
    /** 订阅删除请求（返回退订函数）。 */
    function onRequestPurge(fn) {
      purgeStore.listeners.add(fn);
      fn(purgeStore.current);
      return () => purgeStore.listeners.delete(fn);
    }

    /** 调 Host 的路由（同源，凭 cookie 认证）。 */
    async function callHost(path, init) {
      const res = await fetch(path, {
        credentials: "same-origin",
        headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
        ...init,
      });
      let out;
      try {
        out = await res.json();
      } catch {
        throw new Error("宿主返回了非 JSON 响应（HTTP " + res.status + "）");
      }
      if (!out.ok) throw new Error(out.error || "操作失败");
      return out;
    }

    function ConfirmDialog({ sessionId, bytes, busy, error, onCancel, onConfirm }) {
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape" && !busy) onCancel(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [busy, onCancel]);

      return h("div", {
        className: "asc-overlay",
        // 点遮罩关闭（点卡片内部不关）
        onMouseDown: (e) => { if (e.target === e.currentTarget && !busy) onCancel(); },
      },
        h("div", {
          className: "asc-dialog",
          role: "dialog",
          "aria-modal": true,
          "aria-label": "彻底删除归档会话",
        },
          h("div", { className: "asc-dialog__title" },
            h(TrashIcon, { size: 16 }),
            "彻底删除这个归档会话？",
          ),
          h("div", { className: "asc-dialog__body" },
            "会话 ",
            h("strong", null, String(sessionId).slice(0, 30)),
            sessionId.length > 30 ? "…" : "",
            " 的数据将被删除。",
          ),
          h("div", { className: "asc-dialog__warn" },
            h("span", { style: { flex: "none", marginTop: "1px" } }, "⚠"),
            h("span", null,
              "不可撤销：对话历史与磁盘占用将一并释放（"
              + formatBytes(bytes) + "）。"),
          ),
          error === "" ? null : h("div", { className: "asc-dialog__error" }, error),
          h("div", { className: "asc-dialog__actions" },
            h("button", {
              type: "button", className: "asc-btn",
              disabled: busy, onClick: onCancel,
            }, "取消"),
            h("button", {
              type: "button", className: "asc-btn asc-btn--danger",
              disabled: busy, onClick: onConfirm,
            }, busy ? "删除中…" : "彻底删除"),
          ),
        ),
      );
    }

    /**
     * 会话「...」菜单里的一项：彻底删除（仅归档会话显示）。
     *
     * props 由宿主 ui-workspace 提供：`sessionId` 与 `displayTitle`。
     * 用 `/list` 判断该会话是否已归档——不是归档会话就**不渲染**。
     */
    function PurgeMenuItem({ sessionId, displayTitle }) {
      const [archived, setArchived] = React.useState(null); // null=查询中

      React.useEffect(() => {
        let alive = true;
        callHost("/archived-session-cleaner/list")
          .then((out) => {
            if (!alive) return;
            const hit = (out.sessions || []).find((s) => s.sessionId === sessionId);
            setArchived(hit !== undefined ? hit : false);
          })
          .catch(() => { if (alive) setArchived(false); });
        return () => { alive = false; };
      }, [sessionId]);

      if (archived === null || archived === false) return null;

      return h("button", {
        type: "button",
        className: "asc-menu-item asc-menu-item--danger",
        title: displayTitle ? "彻底删除「" + displayTitle + "」" : "彻底删除该归档会话",
        // 阻止事件到 document：宿主 Menu 在 document 上监听 pointerdown 做
        // 「点外部关闭」，不拦住的话，点本项时菜单会判定为外部点击而关闭，
        // 连带把本组件卸载（确认框状态在组件里时会跟着丢）。
        onPointerDownCapture: (e) => e.stopPropagation(),
        onClick: (e) => {
          e.stopPropagation();
          requestPurge({ sessionId, bytes: archived.bytes || 0 });
        },
      },
        h(TrashIcon, null),
        h("span", null, "彻底删除"),
      );
    }

    /**
     * body 层的删除确认弹窗宿主。
     *
     * 挂载在 apply 里（独立于菜单 slot），订阅 purgeStore——菜单项只负责
     * 写入请求，这里渲染确认框。因为不在菜单子树里，菜单关闭不影响它。
     */
    function PurgeDialogHost() {
      const [request, setRequest] = React.useState(purgeStore.current);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");

      React.useEffect(() => onRequestPurge(setRequest), []);

      if (request === null) return null;

      const close = () => { setBusy(false); setError(""); clearPurge(); };
      const doPurge = async () => {
        setError("");
        setBusy(true);
        try {
          await callHost("/archived-session-cleaner/purge", {
            method: "POST",
            body: JSON.stringify({ sessionId: request.sessionId }),
          });
          close();
        } catch (e) {
          setError(e?.message ?? String(e));
          setBusy(false);
        }
      };

      return h(ConfirmDialog, {
        sessionId: request.sessionId,
        bytes: request.bytes,
        busy,
        error,
        onCancel: close,
        onConfirm: doPurge,
      });
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        // CSS 走自注入标签，不依赖 styles 内置（上一版失败的原因，见文件头）
        ensureStyles();

        // 删除确认弹窗：挂到 body 顶层，独立于菜单 slot 生命周期
        const dialogRoot = ReactDOM.createRoot(
          (() => { const el = document.createElement("div"); document.body.appendChild(el); return el })()
        );
        dialogRoot.render(h(PurgeDialogHost, null));
        ctx.effect(() => () => dialogRoot.unmount());

        // 挂在会话「...」菜单里。order 500 > 宿主的 archive(400)，
        // 排在归档/取消归档之后——删除是更"重"的动作，放最后。
        ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
          name: "sidebar.workspaces.session.menu.item",
          id: SLOT_ID,
          order: 500,
          label: () => "彻底删除归档会话",
        }, PurgeMenuItem));
      },
    };
  },
});
