# Guided tours

Pre-generated Ask answers for the demos, written by `scripts/generate-tours.mjs`
(`ANTHROPIC_API_KEY=... npm run tours -w @rea-studio/web`). Each file records the
`projectId` and a fingerprint of the complete normalized project it was generated
for; `build-demo-projects.mjs` removes stale published copies. The app's digest
alone cannot detect adapter or coverage changes.
Commit the generated files. Do not hand-write tours.
