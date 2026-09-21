# Setting up goldfelty.com

All of this happens at your registrar and in the Cloudflare dashboard — I can't
reach either from here. Work down the list.

The plan: Cloudflare runs DNS for the zone, the API is a Worker on
`api.goldfelty.com`, and the site stays on GitHub Pages at the apex.

## 1. Point the domain at Cloudflare

Add `goldfelty.com` in the Cloudflare dashboard, then change the nameservers at
your registrar to the two Cloudflare gives you. Propagation is usually minutes
but can take a day.

This has to happen first. The Worker's custom domain only works on a zone
Cloudflare controls.

## 2. The website

The landing page is in `site/` and deploys to GitHub Pages whenever `main`
changes.

**On GitHub:** Settings → Pages → Source: *GitHub Actions*. Then set the custom
domain to `goldfelty.com` and tick *Enforce HTTPS* once the certificate issues.

**In Cloudflare DNS:**

| Type | Name | Value | Proxy |
| --- | --- | --- | --- |
| A | @ | 185.199.108.153 | DNS only |
| A | @ | 185.199.109.153 | DNS only |
| A | @ | 185.199.110.153 | DNS only |
| A | @ | 185.199.111.153 | DNS only |
| CNAME | www | gceoalexyt-ops.github.io | DNS only |

Leave the proxy **off** (grey cloud) until GitHub has issued its certificate.
Pages validates over plain DNS, and proxying breaks that. Turn it on afterwards
if you want Cloudflare in front.

`site/CNAME` contains `goldfelty.com` — that's what tells Pages the domain is
yours. Don't delete it.

## 3. The API

```sh
cd api
npm install
npm run db:create      # prints a database_id
# paste that id into wrangler.toml
npm run db:migrate
npm run deploy
```

`wrangler.toml` declares `api.goldfelty.com` as a custom domain, so Cloudflare
creates the DNS record itself — there's nothing to add by hand. If the zone
isn't on Cloudflare yet this step fails; go back to step 1.

The desktop app calls `https://api.goldfelty.com/v1`. Until that resolves,
accounts are created locally and the app says so. Nothing breaks; people just
don't get a reserved username. Set `GOLDFELTY_API_URL` to test against a
staging deployment.

## 4. Email

`support@goldfelty.com` needs an inbox provider — Fastmail, Google Workspace,
Migadu. They'll give you MX records and a DKIM record. Add those, then SPF and
DMARC yourself:

| Type | Name | Value |
| --- | --- | --- |
| MX | @ | from your provider, with their priorities |
| TXT | @ | `v=spf1 include:<your provider> -all` |
| TXT | _dmarc | `v=DMARC1; p=quarantine; rua=mailto:postmaster@goldfelty.com` |

MX records are never proxied. DKIM usually arrives as a CNAME on a selector
like `s1._domainkey` — add it, because without DKIM your mail gets filed as
spam.

Start DMARC at `p=none` if you want to read the reports for a week before
enforcing.

## 5. Deep links

`https://goldfelty.com/wc?uri=…` works as soon as Pages is live. It's a page
that redirects to `goldfelty://`, so it needs nothing beyond step 2.

The `goldfelty://` scheme is registered by the installer, so it only works once
someone has the app.

## Checking it worked

```sh
dig +short NS goldfelty.com
dig +short goldfelty.com
dig +short api.goldfelty.com
dig +short MX goldfelty.com
curl -s https://api.goldfelty.com/health
curl -sI https://goldfelty.com | head -1
```

`/health` should return `{"ok":true}`. If DNS looks wrong, give it time before
assuming something is broken.
