# README screenshots

These are unmodified browser screenshots of the running application, captured
on October 15, 2026. They show a fresh public upload of the repository's
[`tiny-electron`](../../fixtures/sample-apps/tiny-electron) sample, analyzed by
REA 6.5.0: 28 nodes and 61 links. A neighborhood or answer view displays a subset
of those nodes.

- `electron-evidence.jpg`: the save-flow nodes selected by Ask, with
  `window.notesApi`'s evidence inspector open.
- `ask-save-flow.jpg`: an actual Claude Sonnet response, four tool lookups and
  five cited nodes shown in the graph. The answer pane is scrolled to its evidence
  and limitations. It was generated with this prompt:

  > What happens when the renderer calls window.notesApi.save? Trace the bridge,
  > IPC channel and main-process handler. Cite the evidence and keep it under
  > 160 words.

The answer's renderer → bridge → `notes:save` → main-handler chain was checked
against the sample's source and ground truth. An inferred or heuristic link is
not runtime execution evidence. No response was inserted or edited for the image.
No API credentials or private job-access tokens are included in the assets.

The older `.png` screenshots in this directory show earlier demo builds and are
retained for existing references. The root README uses the current `.jpg` pair.
