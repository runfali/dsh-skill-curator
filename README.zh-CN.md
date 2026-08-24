# dsh-skill-curator — 自动技能策展插件

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 开发的自动技能策展 bundle 插件：每 N 轮真实对话（默认 **3**），后台起一个**评审子代理**阅读会话摘要，主动**创建/更新 `~/.dsh/skills/<name>/SKILL.md`**——把 Nous Research Hermes Agent 的「后台评审自我改进」闭环移植到 DSH，零侵入，不改 dsh 源码。

## 工作原理

```
回合结束 ──▶ agent/turn-stopping（scoped 监听，按 agent 计数）
    │ 满 3 轮？（skillNudgeInterval）
    ▼
异步 fire-and-forget（绝不阻塞回合关闭）
    ▼
构建会话摘要 ──▶ 最近 N 条全文 + 更早逐轮压缩
    ▼
起子代理（provider: spawn），注入摘要 + 评审指令
    │  toolFilter allow = 仅 skill-library-*（hermes 式白名单）
    ▼
子代理阅读并写盘 ~/.dsh/skills/<name>/SKILL.md（正文中文、description 双语）
    │  frontmatter 盖 author: dsh-skill-curator（产权标记）
    ▼
摘要写入宿主日志 + 设置卡片「最近评审」面板可见
```

手动触发：`/skill-refine [关注点]` 立即对当前会话发起一次评审。

## 关键设计（对照 hermes）

| hermes | dsh-skill-curator |
|---|---|
| turn_finalizer 计数（10 轮） | scoped `agent/turn-stopping` 计数（默认 3，可配） |
| daemon 线程 fork AIAgent | 平台子代理（ctx.subagents.start）——UI 可见、会话完全隔离 |
| 全量回放会话（吃前缀缓存） | 摘要注入（尾 N 条全文 + 更早压缩）——DSH 无缓存优势 |
| 运行时工具白名单 | toolFilter.allow 白名单 + 提示词约束 |
| curator 产权标记 | frontmatter `author: dsh-skill-curator` + skill-library-adopt |
| /refine | /skill-refine 命令 |

行为对照矩阵详见 [docs/COMPARISON.md](docs/COMPARISON.md)。

## 安装

```bash
cd /path/to/dsh-skill-curator
dsh plugin --profile web add ./
# 重启 dsh，然后在 设置 → 技能策展 里启用
```

标准 bundle 插件，装/卸后重启生效；全程不改 dsh 源码。

## 设置项（设置页 · 技能策展卡片）

- **enabled** 总开关（默认开）
- **skillNudgeInterval** 触发间隔（默认 3 轮）
- **notifyMode** off=静默 / on=宿主日志摘要 / verbose=含内容预览
- **reviewProvider / reviewModel** 评审子代理模型覆盖（留空 = 跟随主会话当前模型）
- **reviewTimeoutMs** 评审预算（默认 15 分钟，超时自动终止）
- **digestTail / digestMaxChars** 摘要形态
- **adoptSkills** 收养清单（逗号分隔）：允许自动维护的非本插件 skill

## 技能库工具（白名单）

评审子代理只能调这六个工具（主会话也可直接用）：

| 工具 | 用途 |
|---|---|
| `skill-library-list` | 列技能（名称/描述/是否托管） |
| `skill-library-read` | 读单个 SKILL.md |
| `skill-library-create` | 新建类级 umbrella 技能（中文正文 + 双语描述） |
| `skill-library-patch` | 定点 `oldString→newString` 或全文替换（保留 frontmatter） |
| `skill-library-write-file` | 写 `references/` `templates/` `scripts/` 支持文件 |
| `skill-library-adopt` | 收养未托管技能（盖 author 章） |

产权守卫：只有 frontmatter 盖 `author: dsh-skill-curator` 章或列入 adoptSkills 的 skill 才能被修改，其余一律拒绝并明确提示「先收养」。路径全部越界校验，写盘原子（tmp + rename）。

## 开发

```bash
pnpm install        # 或把 node_modules 指向 dsh 安装副本（离线测试法，见测试注记）
pnpm test           # node --test 单测套件
node test/smoke.mjs         # 模块/工具/白名单冒烟
node test/client-smoke.mjs  # client bundle 冒烟（真实执行组件树）
```

## License

MIT