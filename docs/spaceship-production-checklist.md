# Spaceship Production Checklist

Local planning document only. Do not deploy, push, or change DNS from this file.

Production frontend target:

- Host: Spaceship / LiteSpeed / cPanel
- Domain: `https://edencafe.co`
- Likely document root: `public_html`

Firebase remains the backend:

- Firebase Auth
- Firestore
- Cloud Functions
- Visitor counter
- Booking API
- Member auth
- POS loyalty
- Admin tools

## Current Live Findings

- `edencafe.co` resolves to `209.74.68.30` and responds with `LiteSpeed`.
- `www.edencafe.co` is a CNAME to `edencafe.co`.
- Firebase default domains are still serving a mostly duplicated static site.
- Firebase Auth authorized domains include `edencafe.co` and `www.edencafe.co`.
- Cloud Functions CORS allows `https://edencafe.co` and `https://www.edencafe.co`.
- `robots.txt` and `sitemap.xml` currently return 404 on both Spaceship and Firebase default domains.

## Files That Need Spaceship Sync Review

These files were observed as stale or missing on Spaceship compared with local/Firebase default Hosting:

- `admin.html`
- `js/admin.js`
- `js/pos.js`
- `pos-apk.html` currently exists locally/Firebase but `https://edencafe.co/pos-apk` returns 404

Sync these only after confirming the current local changes are approved for production.

## Public HTML Sync Manifest

Use `spaceship-production-drafts/public_html-sync-manifest.txt` as the working manifest.

High-level include list:

- `.htaccess`
- `robots.txt`
- `sitemap.xml`
- Root HTML pages such as `index.html`, `menu.html`, `shop.html`, `booking.html`, `login.html`, `register.html`, `profile.html`, `admin.html`
- English and utility pages such as `en.html`, `menu-en.html`, `shop-en.html`, `booking-en.html`, `checkout-en.html`, `profile-en.html`, `faq.html`, `feelfreepay.html`
- `blog/` and blog HTML files
- `js/`
- `Images/`
- `Hero/`
- `style.css`
- `pos.css`
- `db_bilingual.js`
- `llms.txt`
- `pos-apk.html` only if the business wants POS APK download/admin entry on Spaceship

Never upload these to `public_html`:

- `.git/`
- `.firebase/`
- `.firebaserc`
- `firebase.json`
- `firestore.rules`
- `storage.rules`
- `functions/`
- `scripts/`
- `tools/`
- `docs/`
- `backups/`
- `eden-pos-apk/`
- `node_modules/`
- `*.zip`
- `.env*`
- secret or password files

## Draft Files

Draft artifacts are local only:

- `spaceship-production-drafts/.htaccess`
- `spaceship-production-drafts/robots.txt`
- `spaceship-production-drafts/sitemap.xml`
- `spaceship-production-drafts/public_html-sync-manifest.txt`

Before any Spaceship deploy, copy drafts into a reviewed staging package and
compare them with the current live `public_html` files.

## Spaceship Deploy Approval Requirements

Before uploading anything to Spaceship, approval must specify:

- Exact file list to upload
- Whether `www.edencafe.co` should 301 to `edencafe.co`
- Whether `pos-apk.html` should become public on Spaceship
- Backup location and timestamp
- Smoke test owner
- Rollback owner

## Firebase Default Hosting Approval Requirements

Before deploying `firebase-default-hosting-minimal/`, approval must specify:

- Target project: `edencafe-d9095`
- Target site: `edencafe-d9095`
- Expected default-domain behavior: minimal noindex handoff page, no automatic redirect
- Confirmation that no `redirects` or `rewrites` will be added
- Firebase Auth smoke tests for Google popup, phone auth, and `/__/auth/handler`

## Smoke Test Checklist

Spaceship after sync:

- `https://edencafe.co/` returns 200
- `https://www.edencafe.co/` redirects to canonical host if canonical redirect is approved
- `/menu`, `/shop`, `/booking`, `/faq`, `/blog/` return expected content
- `/login` and `/register` load Firebase Auth scripts
- Google sign-in popup opens
- Phone OTP/Recaptcha starts without domain errors
- Booking availability and create booking call Functions successfully
- `/profile` loads after sign-in
- `/admin` loads the expected current version
- POS loyalty/admin Functions still pass CORS
- `/robots.txt` returns production draft
- `/sitemap.xml` returns production draft

Firebase default Hosting after minimal package deploy:

- `https://edencafe-d9095.web.app/` shows minimal noindex handoff page
- `https://edencafe-d9095.firebaseapp.com/` shows minimal noindex handoff page
- `/robots.txt` disallows all crawling
- Response headers include `X-Robots-Tag: noindex, nofollow, noarchive`
- `/__/auth/handler` is not redirected by project config
- Firebase Auth still works from `https://edencafe.co`

## Rollback Paths

Spaceship rollback:

1. Back up current `public_html` before upload.
2. Upload only the approved file list.
3. If a blocker appears, restore the previous `public_html` backup.
4. Re-test home, login/register, booking, profile, admin, and Functions calls.

Firebase default Hosting rollback:

1. Record the current live Hosting release/version before deploy.
2. Deploy only after approval.
3. If a blocker appears, roll back the `edencafe-d9095` live channel to the previous release/version.
4. Re-test default-domain page, `/__/auth/handler`, and production Auth flows.
