# T008 + T012 + T021 + T022 integration (claude)

**Branch:** `claude/T008-T022-integration` (from `main` @ `ad7316f`)
**Status:** review. One branch containing all four reviewed-separately branches, so they can be reviewed and merged together.

Merged in order: `claude/T012-endpoints`, `claude/T008-recover`, `claude/T021-beyond-electron`, `claude/T022-mcp`.

## Conflicts resolved
- `apps/cli/src/cli.ts`: T021's version (.NET, websites, generalized `runRea`) plus T008's recovery (`--no-recover`, `recoverDropped`, quiet parallel runs). Recovery applies to Electron/JS inputs only.
- `packages/rea-adapter/src/file.ts`: T021's `readReaJson` helpers plus T008's `extractedArtifactRoot`.
- `packages/rea-adapter/src/index.ts`: both `endpointVerdicts` (T012) and `skippedManagedCalls` (T021) in the report; dispatch to .NET/web adapters.
- New interaction: website projects now get T012 endpoint verdicts (`assessEndpoints` in `web.ts`; `endpointNotes` exported from `findings.ts`).
- `fixtures/README.md`, `TASKS.md`: kept both sides.

## Verification
- `npm ci`, `build:packages`, `npm run typecheck`: all 8 workspaces pass.
- `npm test --workspaces`: **152 pass** (web 10, worker 33, cli 12, adapter 67, pipeline 11, ask 14, mcp 5).
- `npm run build`: passes.
