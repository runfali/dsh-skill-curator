# dsh-skill-curator

Automatic skill curation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). After every N real conversation turns (default **3**), the plugin fires a background **subagent** that reads a digest of the session and **creates or updates `SKILL.md` files** under the user skills directory (`~/.dsh/skills/<name>/SKILL.md`) — the same self-improvement loop Nous Research's Hermes Agent runs, ported to DSH as a zero-intrusion bundle plugin.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md).

## How it works

```
turn ends ──▶ agent/turn-stopping (scoped listener, counted per agent)
    │ 3 turns reached?  (skillNudgeInterval)
    ▼
async fire-and-forget (never blocks the turn close)
    ▼
session digest built ──▶ latest N messages verbatim + older turns compressed
    ▼
spawn subagent (provider: spawn) with digest + review instructions
    │  toolFilter allow = skill-library-* only (whitelist, hermes-style)
    ▼
subagent reviews and writes ~/.dsh/skills/<name>/SKILL.md
    │  frontmatter is stamped author: dsh-skill-curator (ownership marker)
    ▼
summary logged (host journal) + visible in the settings card status panel
```

![Backstage review subagent in the Tasks panel](docs/screenshot/0-1.png)

*The review subagent runs as a visible task in the Tasks panel — here you see queued/idle `skill review` entries; open the panel to watch a curation as it happens.*

Manual trigger: `/skill-refine [focus]` runs a review of the current session immediately.

## Design decisions (vs Hermes)

| Hermes | dsh-skill-curator |
|---|---|
| turn_finalizer nudge counters (10) | scoped `agent/turn-stopping` counters (3, configurable) |
| fork of AIAgent in a daemon thread | platform subagent (`ctx.subagents.start`) — visible in the UI, fully isolated session |
| replay full conversation (warm prefix cache) | digest injection (tail-verbatim + head compression) — DSH has no cache advantage |
| runtime tool whitelist (memory+skills) | `toolFilter.allow` whitelist + prompt constraint |
| curator ownership markers | frontmatter `author: dsh-skill-curator` + `skill-library-adopt` |
| `/refine` | `/skill-refine` command |

Behavioral parity matrix: [docs/COMPARISON.md](docs/COMPARISON.md).

## Install

```bash
cd /path/to/dsh-skill-curator
dsh plugin --profile web add ./
# restart dsh, then open: Settings → Plugins tab → "Skill Curator" card
```

Skip the restart? The plugin only takes effect on next start (standard bundle plugin; no dsh source changes, ever).

## Settings (Settings → Plugins tab → "Skill Curator" card)

| Settings card (part 1) | Settings card (part 2) |
|:---:|:---:|
| ![Settings card 1/2](docs/screenshot/0-2.png) | ![Settings card 2/2](docs/screenshot/0-3.png) |

- **enabled** — master switch (default on)
- **skillNudgeInterval** — turns between reviews (default 3)
- **notifyMode** — off / on / verbose (segmented buttons)
- **reviewProvider / reviewModel** — optional review subagent model override (empty = follow the session's current model)
- **reviewBaseUrl / reviewApiKey** — optional custom review endpoint (OpenAI-compatible `/chat/completions`). When `reviewBaseUrl` + `reviewModel` are set, the review subagent runs against that endpoint through a dedicated adapter route (provider name = `reviewProvider`, or `skill-curator-review` by default). Settings are read live on every request — no restart needed
- **Review history** persists to `~/.dsh/skill-curator/reviews.json` (last 50 entries) — survives plugin removal/reinstall and restarts
- **Review resilience** — two layers for endpoint/model failures (HTTP/network/auth/rate-limit/model missing/timeout): ① if the custom endpoint fails, the review retries **once** on the session's own model (marked `⚠️已回退主模型` in host log / review log / status panel); ② if the final attempt then dies on an endpoint-class error or a detail-less `killed`, it retries up to `reviewRetryCount` times with `reviewRetryDelayMs` backoff — a model connection blip no longer loses the review. Tool-layer errors are never retried
- **reviewTimeoutMs** — review subagent budget (default 15 min)
- **reviewRetryCount** — extra retries when the final review attempt dies on endpoint/model-layer failures (connection reset, HTTP errors, timeouts) or a detail-less `killed`; `0` disables retrying. Tool-layer errors are never retried. Default 1
- **reviewRetryDelayMs** — backoff base for retries, n-th retry waits `base × n` ms (default 5000)
- **digestTail / digestMaxChars** — digest shape
- **adoptSkills** — comma-separated names of skills the curator may maintain although created elsewhere

## Skill library tools (whitelist)

The review subagent can only call these six (they are also usable by any session):

| Tool | Purpose |
|---|---|
| `skill-library-list` | list skills (name, description, owned?) |
| `skill-library-read` | read one SKILL.md |
| `skill-library-create` | create a class-level umbrella skill (Chinese body, bilingual description) |
| `skill-library-patch` | targeted `oldString→newString` or whole-body replacement (frontmatter preserved) |
| `skill-library-write-file` | support files under `references/` `templates/` `scripts/` |
| `skill-library-adopt` | take ownership of an unowned skill (stamps the author marker) |

Ownership guard: only skills stamped `author: dsh-skill-curator` or listed in `adoptSkills` can be patched; everything else is refused with an explicit "adopt first" message. Paths are boundary-checked; writes are atomic (tmp + rename).

## Requirements

```jsonc
// package.json — machine-readable
"engines": { "node": ">=22" },
"dependencies": {
  "@deepseek-ai/dsh-llm": "^0.1.5-rc.1",
  "@deepseek-ai/dsh-settings": "^0.1.5-rc.1",
  "@deepseek-ai/dsh-subagent": "^0.1.5-rc.1",
  "@deepseek-ai/dsh-tools": "^0.1.5-rc.1",
  "@deepseek-ai/schemastery": "^3.18.2"
},
"dsh": { "engines": { "dsh": ">=0.1.2-alpha.3 <0.2.0 || >=0.1.5-alpha.1 <0.1.6" } }
```

- **Verified host**: `@deepseek-ai/dsh 0.1.5-rc.1` (Node v24).
- **Why the disjunction is load-bearing**: npm semver only satisfies a prerelease from a range group that itself contains a prerelease with the same `[major,minor,patch]` tuple, so the plain `<0.2.0` group does **not** cover `0.1.5-rc.1`. `test/entry.test.mjs` pins this with a 10-row decision table, a counter-proof (reverting to the old single range turns red), and a cross-check against the host's real `semver.satisfies`.
- **No install scripts, no gyp/native deps**: the whole tree is plain ESM; `test/entry.test.mjs` guards this (no `install`/`postinstall`/`prepare`, no `optionalDependencies`, dependency scope limited to `@deepseek-ai/*`).

## Development

```bash
pnpm install                # needs proxy/cache off the default npm cache on some hosts
npm test                    # entry + unit + smoke + client-smoke (all suites)
node test/entry.test.mjs    # entry load, manifest, engines range, key-set parity, dep hygiene
node test/smoke.mjs         # module/tool/whitelist smoke
node test/client-smoke.mjs  # client bundle smoke (real component-tree execution)
```

`docs/EVIDENCE.md` records the isolated-instance install/start/E2E run (disposable `DSH_HOME`, no deployed instance touched); `docs/AUDIT.md` records the audit rounds.

## License

MIT