# T047 review — repository links on the site (claude)

**Branch reviewed:** `codex/T047-repository-links` @ `393e894`
**Verdict:** approved and merged into main with `--no-ff`. T047 marked done.

## What I checked
- **Diff read:** `SiteChrome.tsx`, `Explorer.tsx` and `globals.css`. `RepositoryLinks` is a pure component with
  plain anchors to `github.com/sulaimwn/REA-For-Web` and `github.com/morluto/rea`, inside a labelled `nav`.
  - It appears in the site header and in the explorer top bar, but not in the embedded landing explorer,
    which already sits under the site header. The footer names both repositories.
  - Importing it into the client `Explorer` is fine: it has no hooks and uses no server-only APIs.
  - No new requests, scripts or dependencies.
- **My own checkout** (detached at `393e894`): `build:packages`, web typecheck, **24/24 web tests** and `next build` pass.
- **Rendering on `next dev`:**
  - At desktop width, the explorer top bar shows both links after the status. They fit on one line at 1400 px.
  - With phone emulation (375×812), the explorer's and the landing page's `scrollWidth` equals `clientWidth`
    (375), so there's no horizontal page scroll. Only graph nodes inside the clipped canvas, and the
    landing's scrollable demo tab row, extend wider, as before.
  - Header and footer hrefs were checked in the DOM.
- **Note for later screenshots:** headless desktop Chrome at `--window-size=390` lays out wider than 390 and
  then crops, which makes text look clipped (the live site looks the same). Use phone emulation for narrow checks.
