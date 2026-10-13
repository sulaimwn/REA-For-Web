# Deploying reaforweb.com on Cloudflare

The website runs on **Cloudflare Workers** via the official
[OpenNext adapter](https://opennext.js.org/cloudflare). GitHub Actions builds it on
Linux and deploys it on every push to `main` (`.github/workflows/deploy-cloudflare.yml`).
Building locally on Windows isn't supported by OpenNext, so let CI do it.

For the separate Docker analysis site and the optional `REA_UPLOAD_ORIGIN`
navigation setting, see [hosted uploads](hosted-uploads.md). Keep R2/Redis/Docker
credentials on that service, not the Cloudflare frontend.

**What goes live:** the demos, the explorer, `/open` (local mode) and Ask (bring
your own key). **Not yet:** uploading apps to the site. That needs the analysis
worker hosted somewhere (Cloudflare Containers or a small server); it's a separate step.

## One-time setup (about 15 minutes, all in your browser)

### 1. Start with the free address (a domain is optional)
No purchased domain is needed for the first deployment. The worker uses
`https://reaforweb.<your-subdomain>.workers.dev`. If you want a domain later:
- **Buying it:** Cloudflare dashboard → **Domain Registration → Register Domains** → search `reaforweb.com`.
- **Already own it elsewhere:** dashboard → **Add a domain** → follow the steps to point
  its nameservers at Cloudflare.

### 2. Turn on Workers
Dashboard → **Workers & Pages**. Open it once; the first time it asks you to pick a
free `*.workers.dev` subdomain. Pick anything (e.g. your username).

### 3. Create an API token and find your account ID
- **Token:** top-right profile icon → **My Profile → API Tokens → Create Token** →
  use the **"Edit Cloudflare Workers"** template → under *Account Resources* choose your
  account. For the `workers.dev` deployment, no custom zone is needed. If you later
  add a custom domain, scope *Zone Resources* to that domain → **Create Token**. Copy it
  (it's shown once). Treat it like a password.
- **Account ID:** **Workers & Pages** overview → right sidebar → **Account ID** → copy.

### 4. Give GitHub the two values
GitHub → your repo **sulaimwn/REA-For-Web** → **Settings → Secrets and variables →
Actions → New repository secret**. Add both:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 3 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from step 3 |

### 5. Deploy
Push from GitHub Desktop. In GitHub → **Actions → "Deploy website to Cloudflare"**,
the run should go green in a few minutes. The site is then live at
`https://reaforweb.<your-subdomain>.workers.dev`.

(Before step 4 the workflow still runs, but only builds. It shows a note saying deploy was skipped.)

### 6. Point reaforweb.com at it
Ask Claude or Codex to "enable the custom domain in wrangler.jsonc". That uncomments the
`routes` block in `apps/web/wrangler.jsonc`. Push, and after the next deploy
`https://reaforweb.com` serves the site. Cloudflare creates the DNS record and certificate.

## Costs
The site is static pages plus small JSON files, which fits comfortably in Cloudflare's free
Workers plan for a new project. Check Cloudflare's current pricing page before relying on
exact limits.

**Ask questions:**
- **Free tier (T030):** by default, visitors ask without a key. The site answers with an open
  model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on your account's free Workers AI
  allowance: 10,000 neurons a day, roughly 30–60 questions.
  - On the Workers Free plan, requests past the allowance fail instead of being billed. Visitors
    then see "Today's free questions are used up" and can use their own Claude key.
  - Each visitor is also limited to 12 model calls a minute and 120 a day, best effort per
    Cloudflare location.
  - **If you upgrade to Workers Paid,** usage past the allowance is billed ($0.011 per 1,000
    neurons). Set a spending alert, or remove the `ai` binding from `wrangler.jsonc` to turn the
    free tier off.
  - If a deploy fails with an authorization error about Workers AI, edit the API token from step 3
    and add **Account → Workers AI → Read**.
- **With their own key:** visitors' Claude questions are billed to their own Anthropic key, not to you.

## For maintainers
- Config: `apps/web/wrangler.jsonc`, `apps/web/open-next.config.ts`, `apps/web/public/_headers`.
- Scripts (Linux/macOS/WSL): `npm run build:packages`, then `npm run cf:build -w @rea-studio/web`
  (`cf:preview` runs it locally in Cloudflare's runtime; `cf:deploy` deploys with your
  `CLOUDFLARE_API_TOKEN`).
- `cf:preview` uses the `offline` wrangler environment. It has no Workers AI binding, which would
  need a Cloudflare login even locally, so the free Ask tier answers 503 there. `next dev`
  behaves the same way.
- Pinned: Next.js `16.3.8`, `@opennextjs/cloudflare@1.20.10`, `wrangler@4.148.0`.
  Next.js `16.4.0` currently fails in the adapter runtime
  ([upstream issue #1448](https://github.com/opennextjs/opennextjs-cloudflare/issues/1448)).
