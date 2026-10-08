# claude-mods

Function-hook plugins for [Claude Code](https://claude.com/claude-code). Each one installs on its own.

## Install

At a Claude Code prompt, install any of the mods below:

```
/plugin install <mod> --marketplace daviddecorso/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.

## shell-edit-guard

Blocks Bash commands that write files (inline Python/Node scripts, `sed -i`, `perl -pi`, redirects, `tee`) and points the model at Edit/Write instead, so every file change shows up as a reviewable diff. Writes to temp and scratchpad directories are allowed.

Option `extraAllowed`: a regex; Bash commands matching it are never blocked (e.g. `^node scripts/gen-`).

```
/plugin install shell-edit-guard --marketplace daviddecorso/claude-mods
```

## dev-servers

Finds each repo's dev servers (`dev*` package scripts and `wrangler dev`, for Vite, Astro, Next, Wrangler and Expo), gives them fixed ports, and runs them as named services. Adds a `/dev` pane and `dev_list` / `dev_start` / `dev_stop` / `dev_restart` / `dev_logs` tools, so the model reads filtered logs instead of backgrounding servers in Bash.

```
/plugin install dev-servers --marketplace daviddecorso/claude-mods
```

## handoff

Hands a `plans/<slug>.md` plan to agy, the Antigravity CLI (headless with live progress, or copied for `agy -i`), or to Google's Jules (cloud PR), then starts a plan-vs-diff review when the work lands. Ships two skills: `plan-handoff` writes the plan with a recommended implementer, and `plan-diff-review` checks the result against it.

Needs `agy` on `PATH` for agy handoffs, and a Jules API key for Jules handoffs, stored in the macOS Keychain:

```
security add-generic-password -s jules-api -a "$USER" -w
```

(`JULES_API_KEY` in the environment also works.)

```
/plugin install handoff --marketplace daviddecorso/claude-mods
```

## aq

A pane for a per-repo prompt queue kept in `<repo>/.queue/` (shared across worktrees): pick queued prompts, batch them into the prompt box, and queue drafts. Also gives the model an `aq_add` tool to queue follow-ups. Pairs with the `aq` CLI from [zsh-utils](https://github.com/daviddecorso/zsh-utils), which reads and writes the same queue.

```
/plugin install aq --marketplace daviddecorso/claude-mods
```

## Developing

Run a mod from a working copy with `claude --plugin-dir ./<mod>`. Check it with `claude plugin validate ./<mod>` and `claude plugin test ./<mod>`.

Each mod's `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code generates the first time it loads the mod. On a fresh clone, run `claude --plugin-dir ./<mod>` once before type-checking.

## License

MIT
