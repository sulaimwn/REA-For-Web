# T019 — Independent review (codex)

**Branch:** `codex/T019-review`, reviewing `claude/T019-ui-redesign` at `dcd2c19`
**Status:** review passed, including the correction below

## What changed

- Reviewed the full redesign: family glyphs, evidence styles, locally hosted fonts,
  landing explorer, demo selection, embedded URL handling and minimap sizing.
- Fixed a narrow-layout omission: the embedded demo hid its entire details panel
  below 1100px, although its caption offered evidence on selection. It now stacks
  the evidence/Ask panel below a bounded-height graph. The sidebar still hides
  below 720px, where graph selection and the full-screen link remain available.
- Preserved inferred/observed/Studio heuristic labels and the real fixture subset
  notes. No schema, adapter facts, upload limits or API-key behavior changed.

## How to verify

- All six workspace typechecks, all 94 tests and the root production build pass.
  A clean pinned install reports zero npm vulnerabilities.
- Production browser on 3105: tiny live demo loads 28 nodes/58 links; selecting
  its main process opens evidence and neighborhood without modifying the landing
  URL. Minimap visibly contains the three neighborhood nodes.
- Switching to VS Code clears the prior selection and loads 137 nodes/292 links
  with the core-subset warning. Ask opens; no browser console errors.
- The browser's viewport override did not resize this IAB session: it continued
  reporting 1265px after a 390px request, including a fresh tab. The override was
  reset. The responsive correction is source-reviewed; an actual phone-width
  browser check remains useful. Claude's earlier 390px check predates this fix.
- Follow-up on the T007 integration: its IAB tab rendered at 375px content width.
  The configured homepage has no horizontal overflow, selecting the tiny demo's
  main process opens its evidence, and Ask is reachable below the graph. The
  narrow-layout correction is therefore now independently browser-verified.

## Not done / known issues

- Pre-existing graph resize/refit and controlled-node dragging limits remain as
  documented by Claude. No paid Ask request or tour recording was generated.
- T007 will separately adopt these styles and add the upload navigation. Its code
  remains on `codex/T007-upload-pipeline` pending Claude's cross-review.
- T018 deployment prep remains a separate review; no push or deployment here.

## Interface changes or questions for the other agent / human

- Approved for agent merge into main, then run full main checks.
- Claude: review T007 after the redesign integration. Its latest handoff explains
  transfer progress, cache naming and the terminal job-state race regression.
