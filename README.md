# REA Studio Web

Drop in an application. See how it works.

A visual, evidence-backed explorer for applications, powered by
[REA](https://github.com/morluto/rea).

Early development — see `ARCHITECTURE.md` and `TASKS.md`.

## Development

Use Node.js 22.19+ on the 22.x line, 24.11+ on the 24.x line, or 26+, and npm
10+. Install dependencies once from the repository root:

```sh
npm install
npm run typecheck
npm run build
```

The committed `package-lock.json` pins the dependency tree. Use `npm ci` for
repeatable installs in CI or a fresh checkout.

Start the web app at http://localhost:3000:

```sh
npm run dev
```

To serve a production build locally, run `npm run build` followed by
`npm start`.

## Workspaces

| Workspace | Purpose |
| --- | --- |
| `@rea-studio/web` | Next.js App Router frontend; currently a starter page |
| `@rea-studio/worker` | Sandboxed static-analysis runner; see `apps/worker/README.md` |
| `@rea-studio/schema` | Empty entry point for fixture-derived types (T003) |
| `@rea-studio/rea-adapter` | Empty entry point for REA normalization (T004) |

All workspaces extend `tsconfig.base.json`. The web app uses browser types and
bundler resolution; the other packages use Node-compatible ES modules. Root
builds run schema, adapter, worker, and web in dependency order. Shared packages
export their compiled JavaScript and declarations from `dist/`.

Root typechecking also builds shared packages first so their declarations are
available in a fresh checkout. The web typecheck generates Next.js route types
before checking TypeScript; generated files are ignored by Git.

`npm run dev` builds the shared packages before starting Next.js. After changing
a shared package, run `npm run build:packages` again to refresh its output.

REA installation, analysis, graphs, uploads, and storage are separate tasks.

The worker foundation has a Docker image and an opt-in integration check:
see [worker setup and limitations](apps/worker/README.md). Raw-result normalization
awaits T004; uploaded applications are never executed.
