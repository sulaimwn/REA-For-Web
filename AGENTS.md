# AGENTS.md

Shared rules for every coding agent on this repo (Claude Code, Codex, anyone else).
Claude reads this via `CLAUDE.md`. Codex reads it directly.

## What we're building

**REA Studio Web** — a website where you drop in an application and get an
interactive, evidence-backed map of how it works. Analysis is powered by
[REA](https://github.com/morluto/rea) running in a backend worker.

See `ARCHITECTURE.md` for the design. Current local-mode targets: Electron/JS,
.NET programs and website captures. Program files are analyzed statically;
website capture loads the requested page in a fresh browser. The hosted worker
still accepts only Electron/JS artifacts. Android/native providers are separate work.

## Before you start any work

1. `git log --oneline -15` and read the latest files in `notes/handoffs/`.
2. Read `TASKS.md`. Pick an unclaimed task or the one the human assigned you.
3. Claim it in `TASKS.md` (set owner + status `in progress`) and commit that line
   on its own before writing code.

## While working

- Work on your own branch, in your own git worktree. Never edit `main` directly.
  - Branch names: `claude/<task-id>-<slug>` or `codex/<task-id>-<slug>`.
- Stay inside the task's scope. If you need to change a shared interface
  (anything in `packages/schema` or an API shape in `ARCHITECTURE.md`), stop and
  write it up in your handoff note instead of changing it unilaterally.
- **Never invent REA's output format.** Build against real REA JSON in
  `fixtures/`. If no fixture covers what you need, say so — don't guess.
- UI and API code never consume raw REA output. Only `packages/rea-adapter`
  touches REA JSON; everything else uses the `StudioProject` types in
  `packages/schema`.
- Treat every uploaded file as hostile. Never execute an uploaded target.

## When you finish (or stop)

1. Run the checks for what you touched (lint/typecheck/tests once they exist).
2. Update your task's status in `TASKS.md` (`review` or `blocked`).
3. Write a handoff note: `notes/handoffs/YYYY-MM-DD-<task-id>-<agent>.md` using
   `notes/handoffs/_TEMPLATE.md`.
4. Commit everything on your branch.
5. **Merging (agents do it; the human doesn't review merges):**
   - The *other* agent reviews the branch (reads the diff + handoff, reruns checks).
   - After that review passes, either agent merges into `main` in the main
     checkout with `git merge --no-ff`, resolving any `TASKS.md` conflict by keeping
     every task's latest row. Set the task to `done` in the merge.
   - Run the full checks on `main` after merging. If they fail, fix forward right away.
   - Never push. The human pushes from GitHub Desktop.
   - Trivial doc/process-only changes (no code) can be merged without review.

## Conventions

- Language: TypeScript everywhere unless a task says otherwise.
- Package manager: npm workspaces.
- Node: 22.19+ / 24.11+ (REA's requirement).
- Commit messages: `<task-id>: <what changed>` e.g. `T002: add upload endpoint`.
