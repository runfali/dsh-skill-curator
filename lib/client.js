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
    const ENUM_OPTIONS = ["off", "on", "verbose"];

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
      { key: "reviewBaseUrl", type: "text" },
      { key: "reviewApiKey", type: "text" },
      { key: "reviewRetryCount", type: "number" },
      { key: "reviewRetryDelayMs", type: "number" },
      { key: "adoptSkills", type: "text" },
      { key: "notifyMode", type: "enum" }
    ];

    const GROUPS = [
      { titleKey: "group.base", keys: ["enabled", "skillNudgeInterval", "notifyMode"] },
      { titleKey: "group.review", keys: ["reviewProvider", "reviewModel", "reviewBaseUrl", "reviewApiKey", "reviewTimeoutMs", "reviewRetryCount", "reviewRetryDelayMs"] },
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
          overridden: this.stored(key),
          invalid: false
        };
      }
      if (staged.cleared) return { stagedText: "", stagedBool: false, overridden: true, invalid: false };
      return {
        stagedText: field.type === "bool" ? undefined : (staged.invalid === true ? staged.raw : String(staged.value)),
        stagedBool: field.type === "bool" ? staged.value === true : undefined,
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

    // ---- 样式（对齐官方 plugin-card 风格与 Mem0 卡片，独立类名前缀）----
    const css = ".SCc_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.SCc_card:hover{border-color:var(--dsw-alias-label-dimmed)}.SCc_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.SCc_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.SCc_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.SCc_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.SCc_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.SCc_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.SCc_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.SCc_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.SCc_chevronOpen{transform:rotate(180deg)}.SCc_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.SCc_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}.SCc_groupTitle{margin:14px 0 2px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}.SCc_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}.SCc_failed{min-width:0;color:var(--dsw-alias-label-error);text-overflow:ellipsis;white-space:nowrap;flex:1;margin:0;font-size:12px;line-height:1.5;overflow:hidden}.SCc_discard,.SCc_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.SCc_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.SCc_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.SCc_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.SCc_discard:disabled,.SCc_save:disabled{opacity:.4;cursor:default}.SCc_discard:focus-visible,.SCc_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.SCc_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.SCc_field+.SCc_field{border-top:1px solid var(--dsw-alias-border-l2)}.SCc_head{align-items:center;gap:8px;display:flex}.SCc_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.SCc_badges{align-items:center;gap:8px;display:inline-flex}.SCc_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.SCc_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}.SCc_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.SCc_reset:disabled{cursor:default}.SCc_reset:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.SCc_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}.SCc_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.SCc_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.SCc_inputInvalid{border:1px solid var(--dsw-alias-label-error);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}.SCc_inputInvalid:focus-visible{outline:2px solid var(--dsw-alias-label-error);outline-offset:1px;border-color:var(--dsw-alias-label-error)}.SCc_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.SCc_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.SCc_check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}.SCc_seg{display:inline-flex;gap:6px}.SCc_segBtn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 12px;font-size:12px;line-height:1.5}.SCc_segBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.SCc_segBtn:disabled{cursor:default;opacity:.5}.SCc_segActive{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform)}.SCc_status{border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0 4px}.SCc_statusTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}.SCc_refresh{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;margin-left:8px;font-size:12px;line-height:1.5}.SCc_statusEmpty{color:var(--dsw-alias-label-tertiary);margin:8px 0 0;font-size:12px;line-height:1.5}.SCc_statusList{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}.SCc_statusOk{color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5}.SCc_statusErr{color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5}@media (prefers-reduced-motion:reduce){.SCc_card,.SCc_header,.SCc_chevron,.SCc_chevronOpen,.SCc_discard,.SCc_save{transition:none}}";
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
      "field.reviewBaseUrl": "评审端点 base_url（OpenAI 兼容；空=不启用）",
      "field.reviewApiKey": "评审端点 api_key（与 base_url 成对）",
      "field.reviewTimeoutMs": "评审超时（毫秒）",
      "field.reviewRetryCount": "评审重试次数",
      "field.reviewRetryDelayMs": "重试退避基数（毫秒）",
      "field.digestTail": "保留全文的消息条数",
      "field.digestMaxChars": "摘要字符上限",
      "field.adoptSkills": "收养的 skill（逗号分隔）",
      "hint.enabled": "关闭后不再自动触发后台评审",
      "hint.skillNudgeInterval": "多少轮真实对话触发一次（默认 3）",
      "hint.notifyMode": "off=静默；on=宿主日志摘要；verbose=含内容预览",
      "hint.reviewProvider": "评审子代理的 provider 覆盖，留空沿用主会话",
      "hint.reviewModel": "评审子代理的模型覆盖，与 Provider 成对使用",
      "hint.reviewBaseUrl": "自定义评审端点（如 http://host:port/v1），填了它与模型后评审走该端点；失败自动回退主模型",
      "hint.reviewApiKey": "自定义评审端点的 API Key（Bearer）；base_url 为空时忽略",
      "hint.reviewTimeoutMs": "评审子代理最长运行时间，超时自动终止（默认 15 分钟）",
      "hint.reviewRetryCount": "最终尝试因连接/端点类原因失败时的额外重试次数，0=不重试（默认 1）",
      "hint.reviewRetryDelayMs": "第 n 次重试的等待 = 基数 × n（默认 5000）",
      "hint.digestTail": "最近 N 条消息全文注入，更早的逐轮压缩",
      "hint.digestMaxChars": "注入评审子代理的摘要文本上限（默认 30000）",
      "hint.adoptSkills": "允许自动维护的非本插件 skill 名，逗号分隔（先自己确认）",
      "unsaved": "有未保存修改",
      "overridden": "已覆盖",
      "reset": "重置",
      "invalid": "存在无效字段，请修正后再保存",
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
      "review.session": "会话",
      "review.fallback": "已回退主模型"
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
      "field.reviewBaseUrl": "Review endpoint base_url (OpenAI-compatible; empty = off)",
      "field.reviewApiKey": "Review endpoint api_key (pairs with base_url)",
      "field.reviewTimeoutMs": "Review timeout (ms)",
      "field.reviewRetryCount": "Review retry count",
      "field.reviewRetryDelayMs": "Retry backoff base (ms)",
      "field.digestTail": "Verbatim tail messages",
      "field.digestMaxChars": "Digest char cap",
      "field.adoptSkills": "Adopted skills (comma separated)",
      "hint.enabled": "Disable automatic background reviews",
      "hint.skillNudgeInterval": "Trigger a review every N real turns (default 3)",
      "hint.notifyMode": "off=quiet; on=host log summary; verbose=with content preview",
      "hint.reviewProvider": "Override review subagent provider; empty follows the main session",
      "hint.reviewModel": "Override review subagent model; pairs with provider",
      "hint.reviewBaseUrl": "Custom review endpoint (e.g. http://host:port/v1); with model set, reviews use it; falls back to the session model on failure",
      "hint.reviewApiKey": "API key (Bearer) for the custom review endpoint; ignored when base_url is empty",
      "hint.reviewTimeoutMs": "Max review subagent runtime before abort (default 15 min)",
      "hint.reviewRetryCount": "Extra retries when the final attempt dies on endpoint/connection failures; 0=off (default 1)",
      "hint.reviewRetryDelayMs": "n-th retry waits base × n ms (default 5000)",
      "hint.digestTail": "Inject the latest N messages verbatim; older turns compressed",
      "hint.digestMaxChars": "Max characters injected into the review subagent (default 30000)",
      "hint.adoptSkills": "Skills this curator may maintain although created elsewhere",
      "unsaved": "Unsaved changes",
      "overridden": "User override",
      "reset": "Reset",
      "invalid": "Some fields are invalid — fix them before saving",
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
      "review.session": "session",
      "review.fallback": "fell back to session model"
    };
    const DICT = { zh, en };

    // ---- 字段行（对齐 Mem0 卡片：纵向 field + head/badge/reset + 控件 + hint）----
    function FieldRow(props) {
      const t = props.t;
      const id = "plugin-config-dsh-skill-curator-" + props.idKey;
      const head = jsxs("div", { className: "SCc_head", children: [
        jsx("label", { className: "SCc_label", htmlFor: id, children: t(props.labelKey) }),
        props.overridden ? jsxs("span", { className: "SCc_badges", children: [
          jsx("span", { className: "SCc_badge", children: t("overridden") }),
          jsx("button", { type: "button", className: "SCc_reset", disabled: props.disabled, onClick: props.onReset, children: t("reset") })
        ] }) : null
      ] });
      if (props.kind === "bool") {
        return jsxs("div", { className: "SCc_field", children: [
          head,
          jsxs("div", { className: "SCc_head", children: [
            jsx("input", { type: "checkbox", className: "SCc_check", id: id, checked: props.checked === true, disabled: props.disabled, onChange: (e) => props.onToggle(e.target.checked) }),
            jsx("p", { className: "SCc_hint", children: t(props.hintKey) })
          ] })
        ] });
      }
      if (props.kind === "enum") {
        const current = props.text || "on";
        return jsxs("div", { className: "SCc_field", children: [
          head,
          jsxs("div", { className: "SCc_head", children: [
            jsx("div", { className: "SCc_seg", children: ENUM_OPTIONS.map((v) => jsx("button", {
              type: "button",
              key: v,
              className: current === v ? "SCc_segActive" : "SCc_segBtn",
              disabled: props.disabled,
              onClick: () => props.onEdit(v),
              children: v
            })) }),
            jsx("p", { className: "SCc_hint", children: t(props.hintKey) })
          ] })
        ] });
      }
      const inputClass = props.invalid ? "SCc_inputInvalid" : "SCc_input";
      return jsxs("div", { className: "SCc_field", children: [
        head,
        jsx("input", {
          className: inputClass,
          id: id,
          type: "text",
          value: props.text || "",
          disabled: props.disabled,
          onInput: (e) => props.onEdit(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") props.onSubmit(); }
        }),
        props.invalid ? jsx("p", { className: "SCc_invalid", children: t("invalid") }) : null,
        jsx("p", { className: "SCc_hint", children: t(props.hintKey) })
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
            // 失败时展示真实原因（error/diagnostic），绝不显示「无需保存」
            const action = r.ok
              ? (r.actions && r.actions.length > 0 ? String(r.actions[0]).slice(0, 120) : t("review.none"))
              : (String(r.error || r.diagnostic || "").slice(0, 120) || t("review.fail"));
            const mark = r.fallback ? " ⚠️" + t("review.fallback") : "";
            return jsx("li", { key: i, className: r.ok ? "SCc_statusOk" : "SCc_statusErr", children: "[" + label + "]" + mark + " " + action + (r.sessionId ? " · " + t("review.session") + " " + String(r.sessionId) : "") });
          }) })
      ] });
    }

    function SkillCuratorCard(props) {
      const t = props.t;
      // slot 框架契约：注册的 hooks 键转成 use<Name> observable hook
      //（hooks: {curator: store} → props.useCurator(selector)），不是 props.hooks.curator
      const state = props.useCurator((snapshot) => snapshot);
      const [open, setOpen] = useState(false);
      const shell = state.shell || {};
      const fields = {};
      for (const f of FIELDS) fields[f.key] = state[f.key] || {};
      const disabled = !shell.writable || shell.saving;
      // 对齐 Mem0 卡：未改动/无效/保存中都禁用保存（初始态按钮置灰）
      const blocked = !shell.dirty || shell.saving || shell.invalid;
      const enabledNow = fields.enabled.stagedBool !== undefined ? fields.enabled.stagedBool === true : (state.enabled ? state.enabled.stagedBool === true : false);
      return jsxs("div", { className: open ? "SCc_card SCc_cardOpen" : "SCc_card", children: [
        jsx("button", { type: "button", className: "SCc_header", onClick: () => setOpen(!open), children: [
          jsxs("span", { className: "SCc_headText", children: [
            jsx("span", { className: "SCc_name", children: t("card.title") }),
            jsx("span", { className: "SCc_description", children: (enabledNow ? t("card.statusOn") : t("card.statusOff")) + " · " + t("card.description") })
          ] }),
          shell.dirty ? jsx("span", { className: "SCc_pending", children: t("unsaved") }) : null,
          jsx("svg", {
            width: "14", height: "14", viewBox: "0 0 14 14", fill: "none", xmlns: "http://www.w3.org/2000/svg",
            className: open ? "SCc_chevron SCc_chevronOpen" : "SCc_chevron",
            children: jsx("path", { d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.58435 9.61756 6.44405 9.46883 6.25 9.29785C6.05595 9.46883 5.81172 9.46883 5.55843 9.29785C5.30273 9.13382 5.38497 9.07248 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.74023 8.24849 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.12709 8.48703 7.20124 8.42195 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z", fill: "currentColor" })
          })
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
                disabled,
                onEdit: (raw) => props.edit(key, raw),
                onToggle: (checked) => props.toggle(key, checked),
                onReset: () => props.resetField(key),
                onSubmit: () => { if (!shell.saving) props.save(); }
              });
            })
          ] })),
          jsxs("div", { className: "SCc_footer", children: [
            shell.failed ? jsx("p", { className: "SCc_failed", role: "status", children: t("saveFailed") }) : null,
            jsx("button", { type: "button", className: "SCc_discard", disabled: !shell.dirty || shell.saving, onClick: props.discard, children: t("discard") }),
            jsx("button", { type: "button", className: "SCc_save", title: shell.invalid ? t("invalid") : undefined, disabled: blocked, onClick: props.save, children: t(shell.saving ? "saving" : "save") })
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