window.__ModuleLoader__.load({
  id: "dsh-skill-curator",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    let jsxRuntime = require("react/jsx-runtime");
    let jsx = jsxRuntime.jsx;
    let jsxs = jsxRuntime.jsxs;
    let useState = react.useState;
    let useEffect = react.useEffect;

    const NS = "skill-curator";

    // ---- 最小快照 store ----
    function createStore(init) {
      let state = init;
      const listeners = new Set();
      return {
        getSnapshot() { return state; },
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
        set(next) { state = next; listeners.forEach((fn) => fn()); }
      };
    }

    // ---- 字段规格 ----
    const FIELDS = [
      { key: "enabled", type: "bool" },
      { key: "skillNudgeInterval", type: "number" },
      { key: "digestTail", type: "number" },
      { key: "digestMaxChars", type: "number" },
      { key: "reviewTimeoutMs", type: "number" },
      { key: "reviewProvider", type: "text" },
      { key: "reviewModel", type: "text" },
      { key: "adoptSkills", type: "text" },
      { key: "notifyMode", type: "enum" }
    ];

    const GROUPS = [
      { titleKey: "group.base", keys: ["enabled", "skillNudgeInterval", "notifyMode"] },
      { titleKey: "group.review", keys: ["reviewProvider", "reviewModel", "reviewTimeoutMs"] },
      { titleKey: "group.digest", keys: ["digestTail", "digestMaxChars"] },
      { titleKey: "group.adopt", keys: ["adoptSkills"] }
    ];

    function parseFieldValue(field, raw) {
      if (field.type === "bool") return typeof raw === "boolean" ? raw : null;
      const text = String(raw == null ? "" : raw).trim();
      if (text === "") return { cleared: true };
      if (field.type === "number") {
        const n = Number(text);
        if (!Number.isFinite(n)) return { invalid: true, raw: text };
        return { value: Math.trunc(n) };
      }
      return { value: text };
    }

    // ---- 表单控制器（staging + plan + revision-fenced scope 写入）----
    function Form(scope) {
      this.scope = scope;
      this.staged = new Map();
      this.listeners = new Set();
      this.saving = false;
      this.failed = false;
      const self = this;
      this.store = createStore(this.projection());
      this.listeners.add(() => { this.store.set(this.projection()); });
    }
    Form.prototype.publish = function () { this.listeners.forEach((fn) => fn()); };
    Form.prototype.snapshotOf = function () { return this.scope.getSnapshot(); };
    Form.prototype.sectionValue = function (key) {
      const v = this.snapshotOf().value;
      return v === undefined || v === null ? undefined : v[key];
    };
    Form.prototype.userLayer = function () { return this.snapshotOf().user; };
    Form.prototype.stored = function (key) {
      const user = this.userLayer();
      return user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, key);
    };
    Form.prototype.spec = function (key) { return FIELDS.find((f) => f.key === key); };
    Form.prototype.field = function (key) {
      const field = this.spec(key);
      const staged = this.staged.get(key);
      if (staged === undefined) {
        const value = this.sectionValue(key);
        const text = value === undefined || value === null ? "" : (Array.isArray(value) ? value.join(", ") : String(value));
        return {
          stagedText: field.type === "bool" ? undefined : text,
          stagedBool: field.type === "bool" ? value === true : undefined,
          stagedEnum: field.type === "enum" ? text : undefined,
          overridden: this.stored(key),
          invalid: false
        };
      }
      if (staged.cleared) return { stagedText: "", stagedBool: false, stagedEnum: "", overridden: true, invalid: false };
      return {
        stagedText: field.type === "bool" ? undefined : (staged.invalid === true ? staged.raw : String(staged.value)),
        stagedBool: field.type === "bool" ? staged.value === true : undefined,
        stagedEnum: field.type === "enum" ? String(staged.value) : undefined,
        overridden: true,
        invalid: staged.invalid === true
      };
    };
    Form.prototype.plan = function () {
      const plan = [];
      this.staged.forEach((staged, key) => {
        if (staged.cleared) {
          if (this.stored(key)) plan.push({ key, run: () => this.scope.unset(key).then(() => !this.stored(key)) });
          return;
        }
        if (staged.invalid) { plan.push({ key, run: undefined }); return; }
        if (key === "adoptSkills") {
          const arrayValue = String(staged.value).split(",").map((s) => s.trim()).filter(Boolean);
          const section = this.sectionValue(key);
          const same = Array.isArray(section) && section.length === arrayValue.length && section.every((v, i) => String(v) === String(arrayValue[i]));
          if (same) return;
          plan.push({ key, run: () => this.scope.set(key, arrayValue).then(() => {
            const user = this.userLayer();
            return user !== undefined && user !== null && Array.isArray(user[key]) && JSON.stringify(user[key]) === JSON.stringify(arrayValue);
          }) });
          return;
        }
        if (this.spec(key).type === "bool") {
          if (this.sectionValue(key) === staged.value) return;
          plan.push({ key, run: () => this.scope.set(key, staged.value).then(() => {
            const user = this.userLayer();
            return user !== undefined && user !== null && user[key] === staged.value;
          }) });
          return;
        }
        const section = this.sectionValue(key);
        if (section === undefined || section === null) {
          if (staged.value === "") return;
        } else if (String(section) === String(staged.value)) return;
        plan.push({ key, run: () => this.scope.set(key, staged.value).then(() => {
          const user = this.userLayer();
          return user !== undefined && user !== null && user[key] === staged.value;
        }) });
      });
      return plan;
    };
    Form.prototype.shell = function () {
      const snapshot = this.snapshotOf();
      const plan = this.plan();
      return {
        available: snapshot.status === "ready",
        writable: snapshot.writable === true,
        dirty: plan.length > 0,
        invalid: plan.some((item) => item.run === undefined),
        saving: this.saving,
        failed: this.failed
      };
    };
    Form.prototype.projection = function () {
      const shell = this.shell();
      const result = { shell };
      FIELDS.forEach((f) => { result[f.key] = this.field(f.key); });
      return result;
    };
    Form.prototype.actions = function () {
      const self = this;
      return {
        edit: (key, raw) => { self.staged.set(key, parseFieldValue(self.spec(key), raw)); self.failed = false; self.publish(); },
        toggle: (key, checked) => { self.staged.set(key, { value: checked === true }); self.failed = false; self.publish(); },
        resetField: (key) => { self.staged.delete(key); self.failed = false; self.publish(); },
        discard: () => { if (self.staged.size === 0 && !self.failed) return; self.staged.clear(); self.failed = false; self.publish(); },
        save: async () => {
          const plan = self.plan();
          const runs = plan.map((item) => item.run).filter((r) => r !== undefined);
          if (plan.length === 0) { self.staged.clear(); self.failed = false; self.publish(); return; }
          if (self.saving || runs.length !== plan.length) return;
          self.saving = true; self.failed = false; self.publish();
          let landed = true;
          for (const run of runs) {
            const okRun = await run();
            if (!okRun) landed = false;
          }
          if (landed) {
            for (const item of plan) self.staged.delete(item.key);
          }
          self.saving = false; self.failed = !landed; self.publish();
        }
      };
    };

    // ---- 样式（官方 plugin-card 风格，独立类名前缀）----
    const css = ".SCc_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.SCc_card:hover{border-color:var(--dsw-alias-label-dimmed)}.SCc_head{width:100%;text-align:left;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex;cursor:pointer;background:0 0;font:inherit;color:inherit}.SCc_headMain{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;display:flex;align-items:center;gap:12px;flex:1}.SCc_headMain:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.SCc_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.SCc_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.SCc_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.SCc_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.SCc_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.SCc_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.SCc_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}.SCc_groupTitle{margin:14px 0 2px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}.SCc_row{align-items:center;gap:12px;padding:12px 0;display:flex}.SCc_row+.SCc_row{border-top:1px solid var(--dsw-alias-border-l2)}.SCc_rowMain{min-width:0;flex:1;flex-direction:column;gap:4px;display:flex}.SCc_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}.SCc_dot{display:inline-block;width:6px;height:6px;border-radius:99px;background:var(--dsw-alias-brand-primary);margin-left:6px}.SCc_ctl{align-items:center;gap:8px;display:flex}.SCc_invalid{color:var(--dsw-alias-label-error);font-size:12px}.SCc_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:220px;box-sizing:border-box}.SCc_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.SCc_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.SCc_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;box-sizing:border-box}.SCc_check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}.SCc_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}.SCc_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.SCc_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}.SCc_failed{min-width:0;color:var(--dsw-alias-label-error);text-overflow:ellipsis;white-space:nowrap;flex:1;margin:0;font-size:12px;line-height:1.5;overflow:hidden}.SCc_discard,.SCc_save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.SCc_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.SCc_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.SCc_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.SCc_discard:disabled,.SCc_save:disabled{opacity:.4;cursor:default}.SCc_status{border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0 4px}.SCc_statusTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}.SCc_refresh{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;margin-left:8px;font-size:12px;line-height:1.5}.SCc_statusEmpty{color:var(--dsw-alias-label-tertiary);margin:8px 0 0;font-size:12px;line-height:1.5}.SCc_statusList{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}.SCc_statusOk{color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5}.SCc_statusErr{color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5}@media (prefers-reduced-motion:reduce){.SCc_card,.SCc_head,.SCc_chevron{transition:none}}";
    const tagId = "dsh-skill-curator/settings.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-skill-curator";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---- 文案 ----
    const zh = {
      "card.title": "技能策展（Skill Curator）",
      "card.description": "每 N 轮对话后台自动评审会话，提炼/更新 ~/.dsh/skills 下的 SKILL.md",
      "card.statusOn": "开启",
      "card.statusOff": "关闭",
      "group.base": "基础",
      "group.review": "评审执行",
      "group.digest": "会话摘要",
      "group.adopt": "收养清单",
      "field.enabled": "自动评审",
      "field.skillNudgeInterval": "触发间隔（轮）",
      "field.notifyMode": "通知模式",
      "field.reviewProvider": "评审 Provider（空=跟随当前）",
      "field.reviewModel": "评审模型（空=跟随当前）",
      "field.reviewTimeoutMs": "评审超时（毫秒）",
      "field.digestTail": "保留全文的消息条数",
      "field.digestMaxChars": "摘要字符上限",
      "field.adoptSkills": "收养的 skill（逗号分隔）",
      "hint.enabled": "关闭后不再自动触发后台评审",
      "hint.skillNudgeInterval": "多少轮真实对话触发一次（默认 3）",
      "hint.notifyMode": "off=静默；on=宿主日志摘要；verbose=含内容预览",
      "hint.reviewProvider": "评审子代理的 provider 覆盖，留空沿用主会话",
      "hint.reviewModel": "评审子代理的模型覆盖，与 Provider 成对使用",
      "hint.reviewTimeoutMs": "评审子代理最长运行时间，超时自动终止（默认 15 分钟）",
      "hint.digestTail": "最近 N 条消息全文注入，更早的逐轮压缩",
      "hint.digestMaxChars": "注入评审子代理的摘要文本上限（默认 30000）",
      "hint.adoptSkills": "允许自动维护的非本插件 skill 名，逗号分隔（先自己确认）",
      "unsaved": "有未保存修改",
      "readOnly": "当前设置只读",
      "save": "保存",
      "saving": "保存中…",
      "discard": "放弃",
      "saveFailed": "保存失败，请重试",
      "status.title": "最近评审",
      "status.empty": "暂无评审记录",
      "status.error": "状态获取失败",
      "status.refresh": "刷新",
      "review.ok": "完成",
      "review.fail": "失败",
      "review.none": "无需保存",
      "review.session": "会话"
    };
    const en = {
      "card.title": "Skill Curator",
      "card.description": "Background review after every N turns; distills and updates SKILL.md under ~/.dsh/skills",
      "card.statusOn": "on",
      "card.statusOff": "off",
      "group.base": "Base",
      "group.review": "Review execution",
      "group.digest": "Session digest",
      "group.adopt": "Adopted skills",
      "field.enabled": "Auto review",
      "field.skillNudgeInterval": "Trigger interval (turns)",
      "field.notifyMode": "Notify mode",
      "field.reviewProvider": "Review provider (empty = follow session)",
      "field.reviewModel": "Review model (empty = follow session)",
      "field.reviewTimeoutMs": "Review timeout (ms)",
      "field.digestTail": "Verbatim tail messages",
      "field.digestMaxChars": "Digest char cap",
      "field.adoptSkills": "Adopted skills (comma separated)",
      "hint.enabled": "Disable automatic background reviews",
      "hint.skillNudgeInterval": "Trigger a review every N real turns (default 3)",
      "hint.notifyMode": "off=quiet; on=host log summary; verbose=with content preview",
      "hint.reviewProvider": "Override review subagent provider; empty follows the main session",
      "hint.reviewModel": "Override review subagent model; pairs with provider",
      "hint.reviewTimeoutMs": "Max review subagent runtime before abort (default 15 min)",
      "hint.digestTail": "Inject the latest N messages verbatim; older turns compressed",
      "hint.digestMaxChars": "Max characters injected into the review subagent (default 30000)",
      "hint.adoptSkills": "Skills this curator may maintain although created elsewhere",
      "unsaved": "Unsaved changes",
      "readOnly": "Settings are read-only",
      "save": "Save",
      "saving": "Saving…",
      "discard": "Discard",
      "saveFailed": "Save failed, retry",
      "status.title": "Recent reviews",
      "status.empty": "No reviews yet",
      "status.error": "Failed to load status",
      "status.refresh": "Refresh",
      "review.ok": "done",
      "review.fail": "failed",
      "review.none": "nothing to save",
      "review.session": "session"
    };
    const DICT = { zh, en };

    // ---- 小组件 ----
    function FieldRow(props) {
      const t = props.t;
      const id = "plugin-config-dsh-skill-curator-" + props.idKey;
      if (props.kind === "bool") {
        return jsxs("div", { className: "SCc_row", children: [
          jsxs("label", { className: "SCc_rowMain", children: [
            jsxs("span", { children: [t(props.labelKey), props.overridden ? jsx("span", { className: "SCc_dot", title: "user override" }) : null] }),
            jsx("span", { className: "SCc_hint", children: t(props.hintKey) })
          ] }),
          jsx("input", { type: "checkbox", className: "SCc_check", id: id, checked: props.checked === true, disabled: props.disabled, onChange: (e) => props.onToggle(e.target.checked) })
        ] });
      }
      if (props.kind === "enum") {
        return jsxs("div", { className: "SCc_row", children: [
          jsxs("label", { className: "SCc_rowMain", children: [
            jsxs("span", { children: [t(props.labelKey), props.overridden ? jsx("span", { className: "SCc_dot", title: "user override" }) : null] }),
            jsx("span", { className: "SCc_hint", children: t(props.hintKey) })
          ] }),
          jsx("select", { className: "SCc_select", id: id, value: props.text || "on", disabled: props.disabled, onChange: (e) => props.onEdit(e.target.value) },
            ["off", "on", "verbose"].map((v) => jsx("option", { key: v, value: v, children: v })))
        ] });
      }
      return jsxs("div", { className: "SCc_row", children: [
        jsxs("label", { className: "SCc_rowMain", children: [
          jsxs("span", { children: [t(props.labelKey), props.overridden ? jsx("span", { className: "SCc_dot", title: "user override" }) : null] }),
          jsx("span", { className: "SCc_hint", children: t(props.hintKey) })
        ] }),
        jsxs("div", { className: "SCc_ctl", children: [
          props.invalid ? jsx("span", { className: "SCc_invalid", children: "✗" }) : null,
          jsx("input", {
            className: "SCc_input",
            id: id,
            type: "text",
            value: props.text || "",
            disabled: props.disabled,
            onInput: (e) => props.onEdit(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") props.onSubmit(); }
          }),
          props.overridden ? jsx("button", { type: "button", className: "SCc_reset", disabled: props.disabled, onClick: props.onReset, children: "↺" }) : null
        ] })
      ] });
    }

    function StatusPanel(props) {
      const t = props.t;
      const [status, setStatus] = useState(null);
      useEffect(() => {
        let alive = true;
        const load = () => {
          fetch("/api/skill-curator/status", { headers: { accept: "application/json" } })
            .then((r) => r.json())
            .then((data) => { if (alive) setStatus(data && data.ok ? data : { error: true }); })
            .catch(() => { if (alive) setStatus({ error: true }); });
        };
        load();
        const timer = setInterval(load, 30000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const reviews = status && !status.error && status.reviews ? status.reviews : [];
      return jsxs("div", { className: "SCc_status", children: [
        jsxs("p", { children: [
          jsx("span", { className: "SCc_statusTitle", children: t("status.title") }),
          jsx("button", { type: "button", className: "SCc_refresh", onClick: () => { fetch("/api/skill-curator/status", { headers: { accept: "application/json" } }).then((r) => r.json()).then((d) => setStatus(d && d.ok ? d : { error: true })).catch(() => setStatus({ error: true })); }, children: t("status.refresh") })
        ] }),
        status && status.error ? jsx("p", { className: "SCc_statusEmpty", children: t("status.error") }) :
          reviews.length === 0 ? jsx("p", { className: "SCc_statusEmpty", children: t("status.empty") }) :
          jsx("ul", { className: "SCc_statusList", children: reviews.map((r, i) => {
            const label = r.ok ? t("review.ok") : t("review.fail");
            const action = r.actions && r.actions.length > 0 ? String(r.actions[0]).slice(0, 120) : t("review.none");
            return jsx("li", { key: i, className: r.ok ? "SCc_statusOk" : "SCc_statusErr", children: "[" + label + "] " + action + (r.sessionId ? " · " + t("review.session") + " " + String(r.sessionId) : "") });
          }) })
      ] });
    }

    function SkillCuratorCard(props) {
      const t = props.t;
      const state = props.hooks.curator.getSnapshot();
      const [open, setOpen] = useState(false);
      const shell = state.shell || {};
      const fields = {};
      for (const f of FIELDS) fields[f.key] = state[f.key] || {};
      const disabled = !shell.writable || shell.saving;
      const blocked = shell.saving;
      const enabledNow = fields.enabled.stagedBool !== undefined ? fields.enabled.stagedBool === true : (state.enabled ? state.enabled.stagedBool === true : false);
      return jsxs("div", { className: "SCc_card", children: [
        jsxs("div", { className: "SCc_head", children: [
          jsx("button", { type: "button", className: "SCc_headMain", onClick: () => setOpen(!open), children: [
            jsxs("span", { className: "SCc_headText", children: [
              jsx("span", { className: "SCc_name", children: t("card.title") }),
              jsx("span", { className: "SCc_description", children: (enabledNow ? t("card.statusOn") : t("card.statusOff")) + " · " + t("card.description") })
            ] }),
            jsx("span", { className: "SCc_chevron", children: open ? "▾" : "▸" })
          ] }),
          shell.dirty ? jsx("span", { className: "SCc_pending", children: t("unsaved") }) : null
        ] }),
        open ? jsxs("div", { className: "SCc_body", children: [
          !shell.writable ? jsx("p", { className: "SCc_readOnly", role: "status", children: t("readOnly") }) : null,
          GROUPS.map((group) => jsxs("div", { key: group.titleKey, children: [
            jsx("p", { className: "SCc_groupTitle", children: t(group.titleKey) }),
            group.keys.map((key) => {
              const spec = FIELDS.find((f) => f.key === key);
              const field = fields[key];
              return jsx(FieldRow, {
                key: key, t: t, idKey: key, kind: spec.type,
                labelKey: "field." + key, hintKey: "hint." + key,
                text: field.stagedText, checked: field.stagedBool,
                overridden: field.overridden, invalid: field.invalid,
                disabled: disabled || shell.invalid,
                onEdit: (raw) => props.edit(key, raw),
                onToggle: (checked) => props.toggle(key, checked),
                onReset: () => props.resetField(key),
                onSubmit: () => { if (!blocked) props.save(); }
              });
            })
          ] })),
          jsxs("div", { className: "SCc_footer", children: [
            shell.failed ? jsx("p", { className: "SCc_failed", role: "status", children: t("saveFailed") }) : null,
            jsx("button", { type: "button", className: "SCc_discard", disabled: !shell.dirty || shell.saving, onClick: props.discard, children: t("discard") }),
            jsx("button", { type: "button", className: "SCc_save", disabled: blocked, onClick: props.save, children: t(shell.saving ? "saving" : "save") })
          ] }),
          jsx(StatusPanel, { t: t })
        ] }) : null
      ] });
    }

    // ---- 插件 apply ----
    const injectServices = ["slots", "locale", "settingsScope"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), "dsh-skill-curator: dictionaries");
      const scope = ctx.settingsScope.bind({ namespace: NS });
      const form = new Form(scope);
      ctx.effect(() => scope.subscribe(() => form.publish()), "dsh-skill-curator: scope-follow");
      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register({
          name: "settings.plugin.item",
          key: NS,
          locale: NS,
          inject: () => ({
            hooks: { curator: form.store },
            ...form.actions()
          })
        }, SkillCuratorCard);
      });
    }

    exports.apply = apply;
    exports.inject = injectServices;
    return module.exports;
  }
});