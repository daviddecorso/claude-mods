# Who implements it

Pick the first target that fits.

**jules** (Google's cloud agent, Gemini 3.1 Pro; works from the pushed branch and opens a PR)
- Self-contained: the prompt alone is enough; no context from this conversation is needed.
- Cheap to verify: tests or CI prove it, or the diff is small enough to read in one pass.
- Needs nothing local: no simulator, local DB, secrets, dev server, or uncommitted work.
- No design, UX or product judgment.
- Typical: test backfill, dependency bumps, isolated bugs with a repro, lint/type cleanups, docs, mechanical migrations and renames.

**agy** (Antigravity, local, in this working tree)
- Well specified, but needs the local environment or builds on uncommitted work.
- Typical: UI work checked in the simulator or browser, changes that need local secrets or data, follow-ups to a branch that isn't pushed.

**claude** (this session)
- Ambiguous, cross-cutting or architectural; security-sensitive (auth, payments, permissions, data deletion); or depends on judgment calls made in this conversation that the plan can't fully capture.

When unsure between jules and agy, pick agy. When unsure between agy and claude, pick claude.
