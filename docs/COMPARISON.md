# COMPARISON — hermes background review vs dsh-skill-curator

观测基线：hermes-agent v0.20.2（本机 /usr/local/lib/hermes-agent），dsh 0.1.1-rc.2。观察日期 2026-08-24。

## 行为对照矩阵

| 维度 | hermes | dsh-skill-curator | 备注 |
|---|---|---|---|
| 触发时机 | 每轮 turn 后计数：memory 按 `_turns_since_memory ≥ 10`，skill 按工具迭代 `_iters_since_skill ≥ 10` | `agent/turn-stopping` scoped 监听，按真实会话计数 `≥ skillNudgeInterval`（默认 3） | DSH 无 memory nudge（记忆走 soul-md / 外部 mem0 插件），只做 skill 通道 |
| 执行形态 | fork 一个 AIAgent 进 daemon 线程（`bg-review`），继承运行时与缓存系统提示词 | `ctx.subagents.start('spawn')` 平台子代理，独立 session | DSH 子代理 UI 可见运行；会话隔离天然成立 |
| 会话输入 | 同模型全量回放（吃前缀缓存）；路由 aux 模型时改用 digest（尾 24 条 + 更早压缩） | 一律 digest 注入：尾 N 条全文 + 更早逐轮压缩（USER:/ASSISTANT: 行，截断护栏，字符上限） | DSH 无提示词缓存优势，digest 是唯一形态 |
| 工具白名单 | `set_thread_tool_whitelist` 运行时拒绝非 memory/skill 工具 | `toolFilter: { allow: [skill-library-*] }`：子代理 prompt 不可见 + 执行层拒绝 | 语义一致；DSH 的 allow 是子代理创建窗口 scoped restrict |
| 写盘通道 | memory 工具 + `skill_manage`（SKILL.md / references / templates / scripts） | `skill-library-create/patch/write-file` 六个专用工具 | frontmatter 由服务端校验盖章 |
| 产权模型 | curator-managed 标记（`skills/.usage.json` `created_by: agent`）；pinned/bundled/hub/user-owned 禁改；`hermes curator adopt` | frontmatter `author: dsh-skill-curator` 章 + `adoptSkills` 设置；未托管 skill 只读并提示先 adopt | 都用「无用户在场者不可动用户资产」原则 |
| 评审提示词 | `_SKILL_REVIEW_PROMPT`：主动基调、四档优先级（更新本会话加载 > 更新 umbrella > 加支持文件 > 新建类级）、负面清单（环境故障/否定断言/一次性叙事/未验证方法） | 移植改写为 DSH 语境 + 中文正文条款 + 白名单硬约束 | 语义与 guardrail 全保留 |
| 手动触发 | `/refine [focus]` | `/skill-refine [focus]`（commands 注册，绕过计数直接评审） | |
| 模型路由 | `auxiliary.background_review.{provider,model}` 覆盖 + digest 切换 | 设置 `reviewProvider/reviewModel` 覆盖（agentOptions），超出预算超时 | |
| 结果回显 | `💾 Self-improvement review: …` 经 background_review_callback | 宿主日志 `💾 Skill review: …` + 设置卡「最近评审」面板（GET /api/skill-curator/status） | 都不往父会话注入事件（防污染） |
| 失败兜底 | 全 try/catch + 记账 attribut | 全异常兜底 + reviewLog 记录 + 互斥锁防并发 | 评审失败绝不影响主线 |
| 成本控制 | max_iterations=16、cache 复用 | 摘要字符上限（默认 30K）+ 超时预算（默认 15 分钟） | DSH 子代理迭代预算由平台管理 |
| 模型覆盖 | `auxiliary.background_review.{provider,model}`（已注册路由）+ aux 路由时 digest 化 | reviewProvider/reviewModel（已注册路由直传 agentOptions）；**reviewBaseUrl/reviewApiKey**（自定义 OpenAI 兼容端点 → 插件注册专用 adapter 路由，凭据每请求现读设置，热改免重注册） | DSH AgentOptions 无端点字段，自定义端点必须走 llm.registerAdapter |
| 失败回退 | 无（aux 失败即失败） | 自定义端点/模型无法工作（HTTP/网络/鉴权/限流/模型缺失/超时 killed）→ 自动**去掉模型覆盖以主会话模型重跑一次**；非端点失败不重试；回退标记进日志/评审记录/状态面板 | 发哥要求：自定义模型挂了不能让评审跟着挂 |

## 平台约束与实现注记

1. **turn-stopping 运行时载荷无 agent 字段**（d.ts 声明有、实现没有——契约漂移）。插件用 `agent/created`（实测带 agent）闭包注册 `agent.ctx` 级 scoped 子监听，这也是「子代理自我触发」的隔离手段：子代理 session header `origin === 'subagent'` 被直接排除。
2. **回显零延迟约束**：评审绝不在 `assemble`/`pre-step` 等回显路径上等待；`turn-stopping`（serial）里只做计数与异步调度，`Promise.resolve().then(...)` 微任务延后执行评审，handler 本身返回 undefined。
3. **不注入父会话**：评审子代理是独立 session；摘要只走日志与状态接口。与 dsh-mem0-plugins 的「注入需 createUserMessage + 会污染会话」教训一致。
4. **工具全局可见但语义受限**：skill-library-* 对任何会话可见（主会话也可手动用），但只写插件自有/收养的技能，路径越界拒绝。子代理侧由 toolFilter 完全白名单化。
5. **离线测试法**：`node_modules/@deepseek-ai` symlink 指向 dsh 安装副本（gitignore），可真实加载 schemastery/dsh-tools/dsh-subagent/dsh-settings 跑编译与单元测试；client bundle 用 vm 沙箱 + 组件树真实执行验证装配缺陷。