# Agent Token Optimizer

[![CI](https://github.com/bethvourc/agent-token-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/bethvourc/agent-token-optimizer/actions/workflows/ci.yml)

Agent Token Optimizer is a local, experimental tool that selects focused repository
context before a coding agent starts exploring. It integrates through deterministic
`UserPromptSubmit` hooks, so activation does not depend on the model remembering to call a
tool.

The project is pre-1.0. It does **not** currently claim proven token savings; the paired
evaluation must pass before any savings claim is published.

## How It Works

```text
prompt -> local hook -> task assessment -> bounded context pack -> coding agent
                         |                    |
                         +-- trivial: skip   +-- paths, symbols, summaries, snippets
```

The hook runs locally, reads the active agent workspace, and injects at most 1,200
estimated tokens by default. It does not make network requests or require an API key.

Codex, Claude Code, and Kimi Code are supported. Cursor is not yet in the supported
contract because it does not use the same verified hook path.

## Install From A Local Clone

Prerequisites: Git, Node.js 22.13 or newer, and pnpm 10.33.2.

```sh
git clone https://github.com/bethvourc/agent-token-optimizer.git
cd agent-token-optimizer
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm ato install --hosts codex,claude-code,kimi
pnpm ato doctor --hosts codex,claude-code,kimi
```

The installed command points directly to this checkout. Keep the checkout in place. If you
move it, rerun `pnpm build` and `pnpm ato install` from the new location.

The installer merges one managed hook without replacing existing hooks:

| Host        | Managed file               |
| ----------- | -------------------------- |
| Codex       | `~/.codex/hooks.json`      |
| Claude Code | `~/.claude/settings.json`  |
| Kimi Code   | `~/.kimi-code/config.toml` |

For Codex and Claude Code the hook is merged into the host's JSON configuration. For Kimi
Code the installer manages one clearly marked TOML block and never rewrites content
outside its markers. When `KIMI_CODE_HOME` is set, the Kimi config is read from and
written to `$KIMI_CODE_HOME/config.toml` instead of the default above, matching where Kimi
Code loads it.

Review the generated command before approving hook execution. Codex applies its normal
hook trust review. Host hook behavior is documented by
[OpenAI](https://learn.chatgpt.com/docs/hooks),
[Anthropic](https://code.claude.com/docs/en/hooks), and
[Moonshot AI](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md).

Preview changes without writing:

```sh
pnpm ato install --hosts codex,claude-code,kimi --dry-run --json
```

## Use It

After installation, open Codex, Claude Code, or Kimi Code in any repository and submit a
normal coding task. The host passes that repository's working directory to the local hook;
you do not point the agent at the optimizer checkout.

Useful lifecycle commands:

```sh
pnpm ato doctor --hosts codex,claude-code,kimi
pnpm ato cache status
pnpm ato cache list
pnpm ato cache evict --workspace /path/to/repo
pnpm ato cache clear
pnpm ato cache repair
pnpm ato uninstall --hosts codex,claude-code,kimi
```

`cache list` prints record counts per kind, or record keys for one kind; it never prints
cached values. `cache evict` removes every record derived from one workspace - including
its context packs, rankings, summaries, and token ledgers - in a single transaction, and
leaves records for other workspaces untouched. `cache clear` removes everything, and
`cache repair` recreates the cache database in place.

Uninstall removes only the managed hook group. Every changed host file is backed up before
modification.

To update:

```sh
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm ato install --hosts codex,claude-code,kimi
pnpm ato doctor --hosts codex,claude-code,kimi
```

## Privacy And Security

- No telemetry, remote service, API key, or runtime network request is used.
- Raw prompts, source contents, snippets, and credentials are not persisted.
- The local SQLite cache stores content-free hook evidence, file paths and hashes, and
  sanitized structural analysis needed for warm-cache reuse.
- Cache files, host configuration writes, and backups use owner-only permissions on POSIX
  systems.
- Repository symlink escapes are rejected during discovery.
- The installed hook uses a fixed cache location; repository configuration cannot redirect
  it.

The default cache is `~/.agent-token-optimizer/cache.sqlite`. Disable persistence for a
workspace with optional configuration, remove one workspace's records with
`pnpm ato cache evict --workspace <path>`, or clear the cache with `pnpm ato cache clear`.
See [SECURITY.md](SECURITY.md) for reporting and boundary details.

## Optional And Maintainer Commands

`pnpm ato init` creates optional workspace tuning configuration. `pnpm ato optimize`
builds a context pack manually. The secured MCP server remains an advanced development
surface and is not installed into coding agents by the default workflow.

```sh
pnpm run ci
pnpm eval
pnpm eval:report
pnpm audit:prod
pnpm security:sbom
```

Provider-backed evaluation is opt-in with `pnpm eval:live`; it is not run in public CI and
must use non-personal test credentials. Results must pass the behavioral and activation
gates before supporting a performance claim.

## Contributing

Contributions are welcome through short-lived branches and pull requests. Do not push
directly to `main`. Start with the fork-and-branch workflow in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Repository Guide

- [ARCHITECTURE.md](ARCHITECTURE.md) — runtime flow, packages, and trust boundaries
- [AGENTS.md](AGENTS.md) — concise instructions for coding agents working in this repo
- [ROADMAP.md](ROADMAP.md) — launch scope and evidence-gated future work
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, tests, and pull request expectations
- [SECURITY.md](SECURITY.md) — vulnerability reporting and security invariants
- [CHANGELOG.md](CHANGELOG.md) — user-visible changes

## License

Apache-2.0. See [LICENSE](LICENSE).
