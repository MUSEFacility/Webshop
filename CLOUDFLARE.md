# Cloudflare Migration Runbook — muse.services

This is the step-by-step to deploy the ported Worker to `www.muse.services` while leaving the Fly app at `musevision.it` untouched. Follow top to bottom.

---

## Prerequisites

- [ ] Node.js 18+ installed locally.
- [ ] `muse.services` confirmed registered at united-domains (login OK).
- [ ] Cloudflare account. Free plan is enough.
- [ ] Resend account. Free plan is enough.
- [ ] Access to the existing Fly `.env` (need `INTERNAL_PW`, `ADMIN_PW`, `QUOTE_SIGNING_SECRET`, D1 IDs).

---

## 1. Install Wrangler and log in

```bash
cd Webshop-main
npm install
npx wrangler login
```

The login opens a browser to authorize the CLI against your Cloudflare account.

---

## 2. Wire the D1 binding

Find the existing D1 database ID:

```bash
npx wrangler d1 list
```

Copy the ID of the database currently called `muse` (or whatever name is in the Fly `.env` as `CLOUDFLARE_D1_DATABASE_ID`). Paste it into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`. If the database_name in Cloudflare is not literally `muse`, update that field too.

Verify the schema matches what the code expects:

```bash
npx wrangler d1 execute muse --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

You should see `orders`, `order_items`, `cleaning_quotes`. If not, run:

```bash
npm run migrate:remote
```

---

## 3. Add muse.services to Cloudflare (DNS zone)

Cloudflare dashboard → **Add a site** → `muse.services` → Free plan.

Cloudflare shows you 2 nameserver hostnames (e.g. `leia.ns.cloudflare.com`, `han.ns.cloudflare.com`).

In the **united-domains** control panel:
1. Log in → Domains → `muse.services` → DNS / Nameservers.
2. Change nameservers to the two Cloudflare ones. Save.
3. Wait. (Usually minutes. Worst case a couple of hours.)

Back in Cloudflare, refresh the zone page. When it flips to **Active**, proceed.

---

## 4. Verify muse.services as a sending domain in Resend

Resend dashboard → **Domains** → Add Domain → `muse.services`.

Resend gives you three records (an SPF `TXT`, a DKIM `TXT`, and a DMARC `TXT`).

In Cloudflare (muse.services zone) → DNS → add those records exactly as shown. Proxy = **DNS only (grey cloud)** for all three — SPF/DKIM must resolve directly, not through Cloudflare's proxy.

Back in Resend → refresh until the domain shows **Verified** (usually a few minutes).

Once verified → API Keys → Create → scope: **Sending access**, domain: `muse.services`. Save the key somewhere temporary — you'll paste it into `wrangler secret put` next.

---

## 5. Set secrets on the Worker

From `Webshop-main/`:

```bash
npx wrangler secret put INTERNAL_PW
# paste the value from your Fly .env — same value

npx wrangler secret put ADMIN_PW
# paste from Fly .env — same value

npx wrangler secret put QUOTE_SIGNING_SECRET
# paste from Fly .env — MUST be identical so pending email links still validate

npx wrangler secret put RESEND_API_KEY
# paste the key from step 4
```

Sanity check:

```bash
npx wrangler secret list
```

---

## 6. Deploy to workers.dev (pre-production smoke)

```bash
npm run deploy
```

Wrangler prints a URL like `muse-webshop.<your-subdomain>.workers.dev`. Open it:

- [ ] `/` loads the landing page.
- [ ] `/internal` redirects to `/` (then password gate works through the portal).
- [ ] `/external` redirects to `/`.
- [ ] Enter the internal password → unlocks SPA.
- [ ] Enter the admin password (5 logo clicks) → `/admin` dashboard loads with real D1 data.
- [ ] Place a test order → confirm email arrives, from `shop@muse.services`, DKIM pass.
- [ ] Submit a cleaning quote → receive decision email → click → Accept with a test price → customer gets acceptance email → `wrangler d1 execute muse --remote --command "SELECT status, quoted_price_cents FROM cleaning_quotes ORDER BY created_at DESC LIMIT 1"` shows `accepted`.

If anything breaks: `npx wrangler tail` shows live logs.

---

## 7. Attach the custom domain

Option A — dashboard:
1. Cloudflare → Workers & Pages → `muse-webshop` → **Settings** → **Custom Domains** → Add → `www.muse.services` → Add Domain.
2. Cloudflare auto-issues the cert (~1–5 min).

Option B — wrangler.toml: uncomment the `[[routes]]` block and `npm run deploy`.

**Apex redirect** (muse.services → www.muse.services):
1. Cloudflare → `muse.services` zone → **Rules** → **Redirect Rules** → Create.
2. Name: `apex-to-www`.
3. When incoming request matches: `Hostname equals muse.services`.
4. Then: Static redirect, 301, target URL expression: `concat("https://www.muse.services", http.request.uri.path)`, preserve query string: yes.
5. Save & deploy.

Verify:
```bash
curl -sI https://www.muse.services/ | head -1   # HTTP/2 200
curl -sI https://muse.services/      | head -3   # 301 → https://www.muse.services/
```

---

## 8. Stabilize (24–72h)

Do real-life orders through `www.muse.services`. Keep Fly at `musevision.it` running as a safety net — it's still the one customers currently use if they come via old links.

Watch:
- Cloudflare → Workers → `muse-webshop` → **Logs** / **Metrics**.
- Resend → **Logs** (sends, deliveries, bounces).
- Cloudflare → `muse.services` zone → Analytics.

Anything red → `wrangler rollback` (redeploys the previous version) or fix and redeploy.

---

## 9. Redirect musevision.it → www.muse.services (cutover)

Only once step 8 is stable for your comfort:

**Option A — quickest**: add one middleware at the top of the old `server.js` on Fly:

```js
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(301, `https://www.muse.services${req.originalUrl}`);
  }
  return res.redirect(308, `https://www.muse.services${req.originalUrl}`); // preserves POST
});
```

Deploy. Fly is now a dumb redirect.

**Option B — cleanest**: move `musevision.it` NS to Cloudflare as well, set up a Bulk Redirect the same way as step 7's apex redirect, then destroy Fly.

---

## 10. Decommission Fly

```bash
flyctl apps destroy muse-webshop
```

Then in this repo:
- Delete `fly.toml`, `Dockerfile`, `server.js`, `db.js`, `scripts/migrate.js` (replaced by `wrangler d1 execute`), `package-lock.json` (regenerate with new deps).
- Remove `node_modules/` and re-`npm install`.

---

## Rollback matrix

| Step you completed | How to undo |
|---|---|
| 1–2 (install, binding) | No external effect; just discard the wrangler.toml change. |
| 3 (NS moved) | In united-domains, change NS back to their defaults. |
| 4 (Resend DNS) | Remove the DKIM/SPF/DMARC records. |
| 5 (secrets) | `wrangler secret delete <NAME>`. |
| 6 (deploy to workers.dev) | `wrangler delete` or just ignore the URL. |
| 7 (custom domain attached) | Remove the Custom Domain in the dashboard, delete the redirect rule. |
| 8+ (Fly redirect, destroy Fly) | Non-trivial — that's why steps 9–10 wait for stabilization. |

---

## Troubleshooting

- **`Error 1016: Origin DNS error`** when hitting `www.muse.services`: the Custom Domain hasn't finished issuing the cert yet. Wait a few minutes.
- **Resend returns 403 `domain_not_verified`**: wait for Resend to complete DNS verification; `MAIL_FROM` must be on that exact verified domain.
- **`D1_ERROR: no such table`**: the database ID in `wrangler.toml` points at the wrong D1 database, or migrations haven't been applied to this one. Check `wrangler d1 list`.
- **Decision email link returns `Link non valido o scaduto`**: `QUOTE_SIGNING_SECRET` on the Worker differs from the Fly secret. Must be byte-identical.
- **`Service not found: ASSETS`** or static assets return 404: the `[assets]` block in `wrangler.toml` isn't pointing at the right directory, or you deployed with an older Wrangler (need ≥3.85).
