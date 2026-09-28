# dsh-skill-curator

Automatic skill curation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). After every N real conversation turns (default **3**), the plugin fires a background **subagent** that reads a digest of the session and **edits, merges, prunes and creates `SKILL.md` files** under the user skills directory (`~/.dsh/skills/`) — the same self-improvement loop Nous Research's Hermes Agent runs, ported to DSH as a zero-intrusion bundle plugin.

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
subagent reads the library first → subtracts (merge / shorten / delete) before it adds
    │  every write must echo the sha256 it just read (= hard read-before-write)
    ▼
writes ~/.dsh/skills/<name>/SKILL.md (Chinese body; original backed up first)
    ▼
summary logged (host journal) + visible in the settings card status panel
```

Manual trigger: `/skill-refine [focus]` runs a review of the current session immediately.

## Design decisions (vs Hermes)

| Hermes | dsh-skill-curator |
|---|---|
| turn_finalizer nudge counters (10) | scoped `agent/turn-stopping` counters (3, configurable) |
| fork of AIAgent in a daemon thread | platform subagent (`ctx.subagents.start`) — visible in the UI, fully isolated session |
| replay full conversation (warm prefix cache) | digest injection (tail-verbatim + head compression) — DSH has no cache advantage |
| runtime tool whitelist (memory+skills) | `toolFilter.allow` whitelist + prompt constraint |
| edits only curator-created skills | the whole library is editable, guarded by read-before-write + auto-backup + a protected list |
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
- **excludedSkills** — comma-separated names the reviewer must never touch (empty = the whole library is editable)

## Skill library tools (whitelist)

The review subagent can only call these seven (they are also usable by any session):

| Tool | Purpose |
|---|---|
| `skill-library-list` | list skills (name, description, body line count, protected?) |
| `skill-library-read` | read one SKILL.md in full + its **sha256** |
| `skill-library-create` | create a class-level umbrella skill (Chinese body, bilingual description) |
| `skill-library-patch` | targeted `oldString→newString` or whole-body replacement (frontmatter preserved) |
| `skill-library-write-file` | support files under `references/` `templates/` `scripts/` |
| `skill-library-delete` | delete a redundant/merged-away skill (read-first; whole directory backed up) |
| `skill-library-adopt` | stamp an externally authored skill with the author marker (provenance only) |

### Three guardrails

1. **Read before write** — `patch` / `write-file` / `delete` must echo the `expectedSha256` returned by `skill-library-read`. Writing without reading, or writing against a file that changed since the read, is refused. This is the only mechanical defence against rewriting someone's skill from memory.
2. **Backup before write** — every write/delete first copies the original (the whole skill directory on delete) to `~/.dsh/skill-curator/backups/`, keeping the latest 30, so a wrong move is recoverable.
3. **Protected list** — skills in `excludedSkills` are read-only.

Paths are boundary-checked; writes are atomic (tmp + rename). Bodies over 150 lines come back with a "move detail into `references/`" nudge in the tool result (advisory, never blocking).

## How the reviewer writes skills (plain, not bloated)

The review prompt carries a shape contract aimed squarely at "skills only ever grow":

- **Subtract first** — priority slot 0 is "read the candidate skills, then delete duplicates, merge siblings, shorten stale parts". A deleted line counts as a result, usually the better one.
- **Length** — body target ≤150 lines; past 250 the detail must move to `references/`. Standard skeleton: one-line conclusion → when to use → how → pitfalls → boundary.
- **Language** — plain human wording; no background/foreword/summary/disclaimers, no restating common knowledge, every term explained in one clause, one fact stated once.
- **Adding a section is the last resort** — rewrite an existing section before adding a new one.

## Requirements

```jsonc
// package.json — machine-readable
"engines": { "node": "^22.19.0 || >=24.0.0" },
"peerDependencies": {          // the host runtime is the single source of truth; no bundled dsh-* copies
  "@deepseek-ai/dsh-llm":      ">=0.1.2-alpha.3 <0.1.8 || >=0.1.5-alpha.1 <0.1.6 || >=0.1.7-alpha.0 <0.1.8",
  "@deepseek-ai/dsh-settings": "…same…",
  "@deepseek-ai/dsh-subagent": "…same…",
  "@deepseek-ai/dsh-tools":    "…same…",
  "@deepseek-ai/schemastery":  "~3.18.4"     // .volatile() needs 3.18.4+
},
"devDependencies": { …local copies of the four dsh-* packages + schemastery… }  // no @deepseek-ai/dsh umbrella: it drags the whole host tree in
```

- **Verified host**: `@deepseek-ai/dsh 0.1.7-rc.2` (Node v24).
- **Why the disjunction is load-bearing**: npm semver only satisfies a prerelease from a range group that itself contains a prerelease with the same `[major,minor,patch]` tuple, so the plain `<0.2.0` group does **not** cover `0.1.5-rc.1` or `0.1.7-rc.2`. `test/entry.test.mjs` pins this with a 14-row decision table, a counter-proof (reverting to the old single range turns red), and a cross-check against the host's real `semver.satisfies`.
- **0.1.7 settings contract (what this adaptation was about)**: `settings.installSection` was removed from dsh-settings. The namespace **is** the cordis row id, `Config` must be exported from the plugin module, and every live-editable field must be `.volatile()` (the host's `_commitVolatile` rewrites the live reference in place, no fiber restart). The settings card therefore hangs off `configForms.get(ns)` and the `plugins.item` slot.
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