---
name: plan-handoff
description: Write the agreed plan to plans/ with its recommended implementer (claude, agy or Jules) and print the handoff
allowed-tools: Write, Read, Bash(mkdir:*)
---

Write the plan we just agreed on to `plans/<slug>.md`, where `<slug>` is a short kebab-case name for the work. Create it with the Write tool, even when the plan already exists as a plan-mode file: the handoff mod only notices plans written that way, never a `cp`.

Read `routing.md` in this skill's folder and pick the target.

The file:
- Opens with `Target: <jules|agy|claude> — <one clause why>` on its own line, under the title.
- Then one paragraph describing the end state. No preamble, no restating my request.
- Then the steps in order, each naming the files it touches.
- Every command a step tells the agent to run must exit on its own: no dev servers, watch modes, or e2e suites that start a web server. Check each script against `package.json` before writing it down; a wrong `test` script is how a headless agy run hangs.
- Records decisions we made and why, so the implementing agent doesn't relitigate them.
- Lists anything we explicitly ruled out.
- If some pieces are jules-shaped and the rest aren't, ends with a "Delegable sub-tasks" section: each piece as a standalone prompt that names its files and how to verify it.
- No code blocks longer than a few lines. This is a plan, not a patch.

Then print this line and nothing else:

    handoff plans/<slug>.md
