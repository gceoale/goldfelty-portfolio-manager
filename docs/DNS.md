# Setting up goldfelty.com

Everything here has to happen at your registrar and your host — I can't touch
either. Work down the list.

## 1. The website

The landing page lives in `site/` and deploys to GitHub Pages whenever `main`
changes.

**On GitHub:** Settings → Pages → Source: *GitHub Actions*. Then Settings →
Pages → Custom domain: `goldfelty.com`, and tick *Enforce HTTPS* once the
certificate is issued (that takes a few minutes after DNS resolves).

**At your registrar,** for the apex domain:

| Type | Name | Value |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| AAAA | @ | 2606:50c0:8000::153 |
| AAAA | @ | 2606:50c0:8001::153 |
| AAAA | @ | 2606:50c0:8002::153 |
| AAAA | @ | 2606:50c0:8003::153 |
| CNAME | www | gceoalexyt-ops.github.io |

`site/CNAME` already contains `goldfelty.com`, which is what tells Pages the
domain is yours. Don't delete it.

## 2. The API

`api/` needs to run somewhere — Fly, Railway, Render, a small VPS, anything
that can run a container. Once it has a hostname:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | api | whatever your host gives you |

If your host only gives you an IP, use an A record instead.

The app calls `https://api.goldfelty.com/v1` by default. Until that resolves,
accounts are created locally and the app says so — nothing breaks, people just
don't get a reserved username. Point `GOLDFELTY_API_URL` elsewhere to test
against a staging deployment.

Give the container a persistent volume at `/data`, or accounts disappear on
every restart.

## 3. Email

For `support@goldfelty.com` to work you need an inbox provider — Fastmail,
Google Workspace, Migadu, whatever. They'll give you MX records. Then add SPF
and DMARC yourself:

| Type | Name | Value |
| --- | --- | --- |
| MX | @ | (from your provider, with their priorities) |
| TXT | @ | `v=spf1 include:<your provider> -all` |
| TXT | _dmarc | `v=DMARC1; p=quarantine; rua=mailto:postmaster@goldfelty.com` |

Your provider will also hand you a DKIM record, usually a CNAME or TXT on a
selector like `s1._domainkey`. Add it — without DKIM your mail gets filed as
spam.

Start DMARC at `p=none` if you want to watch the reports for a week before
enforcing.

## 4. Deep links

`https://goldfelty.com/wc?uri=…` works as soon as Pages is live — it's a page
that redirects to `goldfelty://`, so no DNS beyond step 1.

The `goldfelty://` scheme itself is registered by the installer, so it only
works once someone has installed the app.

If you later want links to open the app without the redirect page, that needs
Apple's `apple-app-site-association` and Android's `assetlinks.json` served
from `/.well-known/`. Only worth doing if you ship mobile apps.

## Checking it worked

```sh
dig +short goldfelty.com
dig +short api.goldfelty.com
dig +short MX goldfelty.com
curl -s https://api.goldfelty.com/health
curl -sI https://goldfelty.com | head -1
```

DNS changes take anywhere from a minute to a day to propagate, so if something
looks wrong, wait before assuming it's broken.
