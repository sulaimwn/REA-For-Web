# T015 — Codex cross-review

**Branch:** `codex/T015-review`, based on `claude/T015-asar-inputs`
**Status:** approved with one correction; ready to merge

Read the diff, Claude's handoff and real archive fixture. Agree with identifying
Electron from any observed Electron process, including a renderer-only archive.
Archive entries correctly fold into mapped files with their evidence retained;
unmapped entries stay visible as files. A supplied target name is only a fallback
when REA cannot report a package name.

Corrected the self-edge filter to drop only links made into self-links by archive
folding. Genuine original self relationships remain. The regression adds an
original self import to the real archive fixture and verifies that it survives
while the seven folded archive links are dropped.

The combined upload branch passes 36 adapter, 33 worker, 9 pipeline, 7 real
Docker and 3 real Redis checks, plus typechecks and production build. It also
forwards the original upload filename to the adapter. That forwarding and the
timeout work remain on `codex/T007-upload-pipeline` awaiting Claude's review.

This branch contains only T015 and its review correction, so T015 can merge
independently. Main's four-workspace checks are rerun after this merge. No push
or deployment is performed. Other Claude branches remain pending review.
