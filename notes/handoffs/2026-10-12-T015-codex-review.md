# T015 — Archive adapter review and upload integration (codex)

**Branch:** `codex/T007-upload-pipeline`, integrating `claude/T015-asar-inputs`
**Status:** T015 passes review with the correction below. T007 remains review.

## What changed

- Reviewed Claude's diff, real ASAR fixture, five regression tests, and Obsidian
  findings. Agree with the schema documentation: any observed Electron process
  establishes `appKind: electron`, including renderer/preload-only archives.
- Kept archive inventory evidence on the mapped file and preserved unmapped
  entries as files. Corrected the self-edge filter: drop only edges made into
  self-edges by archive folding, preserving genuine original self relationships.
  Added a regression that preserves an original self import while dropping the
  seven archive-folding links from the tiny real fixture.
- Kept both adapter options during integration: `targetName` and Codex's
  `retainedTimeoutEvidence`. Neither replaces the other.
- Forward the validated original upload filename through the queue runner and
  Docker argument list to the adapter. Names are bounded filenames; no host
  paths enter the adapter. REA's package name still wins when available.
- Cache revision is now `adapter-4`; authorized older results remain readable.
  Existing results are snapshots. A fresh upload receives the new normalization.

## How to verify

- Combined adapter tests: 36 pass. Worker tests: 33 pass (Windows junction
  tests require the real-user test context). Pipeline tests: 9 pass.
- All five workspace typechecks and the production build pass. Real Docker
  checks: 7 pass, including an app without package.json that receives the
  original filename. Real Redis checks: 3 pass, including queue forwarding
  of the original filename and timeout cleanup.

## Coordination

- Read the human's pasted conversation and the shared T009, T013, T014, T015,
  and T016 handoffs. T013 must merge before T016. These other branches have
  only been read in this follow-up, not reviewed or approved. T017 is claimed
  by Claude and is still in progress; Codex is not editing those areas.
- T012 proposal: agree with an optional endpoint `assessment` carrying verdict,
  heuristic and basis. Keep original REA nodes/evidence, treat the assessment
  as a Studio inference, and let users reveal all candidates. An unassessed
  candidate must remain visible. This is agreement on the interface proposal,
  not a claim that endpoint filtering is implemented or reviewed.
- Ask has stand-in API verification only. Live Anthropic behavior, model names,
  API parameters and cost estimates still need independent review. No real key
  or live API call was used by Codex.
- Upload progress UI remains Codex's next UI item. The earlier detailed brief
  is not included in this paste; do not claim it has been implemented.
- Claude should review the latest T007 commits, then merge the combined branch
  using the agreed process. T015 is approved with the self-edge correction.
  No push or deployment was performed.
