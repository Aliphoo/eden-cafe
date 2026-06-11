# Firebase Default Hosting Minimal Package

Local-only migration package for the Firebase default Hosting domains:

- `https://edencafe-d9095.web.app`
- `https://edencafe-d9095.firebaseapp.com`

This package is intentionally separate from the production Spaceship frontend.
It is not deployed. Deploy only after explicit approval.

## Goal

Reduce duplicate-site confusion on Firebase default Hosting while keeping Firebase
backend services active:

- Firebase Auth
- Firestore
- Cloud Functions
- Firebase reserved Auth helper routes such as `/__/auth/*`

## Current Mode

This package uses noindex-only mode:

- Shows a minimal page that points users to `https://edencafe.co/`.
- Sends `X-Robots-Tag: noindex, nofollow, noarchive`.
- Adds page-level `robots` meta tags.
- Blocks crawlers with `robots.txt`.
- Does not redirect automatically.

## Auth Safety

The `firebase.json` in this package intentionally has:

- No `redirects`
- No `rewrites`
- No `public/__/` folder
- No catch-all route such as `**`
- No catch-all headers that add restrictive CSP to every URL

Do not add wildcard redirects or rewrites. Firebase Auth popup, phone auth, and
email/action helper flows may rely on Firebase reserved paths under `/__/auth/*`.

## Local Verification Only

From this folder, a safe local preview can be run with:

```powershell
firebase.cmd emulators:start --only hosting --project edencafe-d9095
```

Do not run deploy commands unless the production owner explicitly approves the
target and rollback plan.

## Deployment Target If Approved Later

Target:

- Firebase project: `edencafe-d9095`
- Firebase Hosting site: `edencafe-d9095`
- Affected domains: `edencafe-d9095.web.app`, `edencafe-d9095.firebaseapp.com`

Expected result after deploy:

- Firebase default domains show the minimal noindex handoff page.
- `robots.txt` disallows crawling on the default domains.
- Firebase backend services remain unchanged.
- Spaceship production `https://edencafe.co/` remains untouched.

Rollback:

1. Identify the previous live Firebase Hosting release/version.
2. Roll back the `edencafe-d9095` Hosting live channel to that version.
3. Smoke test `/`, `/login`, `/register`, `/__/auth/handler`, and customer flows.
