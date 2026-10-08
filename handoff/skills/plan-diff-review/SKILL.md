---
name: plan-diff-review
description: Review a diff/PR/branch against the original plan, spec, or task description that produced it — pasted in by the user as context — checking for gaps between what was planned and what was actually built, plus logic, security, and correctness errors. Use this whenever the user hands off review of another agent's or contributor's work and provides (or offers to provide) the original plan, ticket, spec, or instructions alongside a diff to review, e.g. "review this PR against the plan I gave the other agent", "here's the spec, check what my subagent built", "did this implementation miss anything from the brief". Do not use for a plain code-review request with no reference plan/spec — that's a different, blinder review.
---

# Plan-vs-Diff Review

Reviews a diff against the plan/spec/context that was supposed to produce it. The point of this skill is specifically the comparison — an implementation can be locally correct and still fail the task by skipping a requirement, reinterpreting scope, or quietly dropping an edge case the plan called out. A review with the plan in hand catches that; a blind diff review can't.

## Step 1: Get the plan and the diff — don't proceed without both

If the user hasn't pasted the original plan, spec, ticket, or instructions yet, ask for it before reviewing. Reviewing the diff without it collapses this into a generic code review, which defeats the purpose.

If the diff target is ambiguous, ask or infer: current working diff (`git diff` / `git diff --staged`), a PR number, a branch vs. a base, or a specific commit range.

For PRs, don't pull the whole diff at once — list files first, then pull per-file or per-module:
```
gh pr diff <PR> --name-only
gh pr diff <PR> -- <path>
```

## Step 2: Turn the plan into a checklist

Before looking at the diff, extract from the plan a concrete list of:
- Requirements and steps it called for, in order
- Explicit constraints, edge cases, or non-goals it named
- Any file paths, function names, or approach it specified (useful for spotting silent deviations, not for penalizing reasonable ones)

Do this extraction *before* reading the diff closely, so the checklist isn't unconsciously reshaped to match what was actually delivered.

## Step 3: Compare, then verify against real code

Walk the checklist against the diff. For each item, it's satisfied, partially satisfied, deviated (done differently — note whether the deviation is justified or a problem), or missing entirely.

Diff hunks lack surrounding context — before flagging something as wrong or missing, read the actual file to confirm. A function that looks unhandled in the hunk may be handled a few lines outside it; a "missing" step may live in a file the diff didn't touch because it already existed.

Alongside plan coverage, review the diff itself for:
- **Logic errors**: wrong conditionals, off-by-one, incorrect state transitions, unhandled branches
- **Security issues**: injection (SQL/command/XSS), auth/authz gaps, secrets in code, unsafe deserialization, missing input validation at trust boundaries
- **Correctness/other**: race conditions, resource leaks, error handling that swallows failures, tests that don't actually exercise the change

Don't flag style or architectural preferences the plan didn't call for — this review is about fidelity to the plan plus real defects, not taste.

## Step 4: Report

Use the `ReportFindings` tool if available. Otherwise output findings as a plain ranked list with the same fields.

Report most-severe first. Use `category: "gap"` for plan-vs-implementation mismatches (missing, partial, or undocumented deviation) so they're distinguishable from `correctness`, `security`, `logic` findings on actual bugs. For a gap finding, `file` is where the missing piece should have landed (or the plan/spec doc if nothing in the diff is a natural anchor), and `failure_scenario` describes what the plan asked for vs. what exists.

If nothing survived verification, report an empty findings list rather than padding with nitpicks — a clean "matches the plan, no defects found" is a valid and useful result.
