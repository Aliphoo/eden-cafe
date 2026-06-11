# Eden Cafe Deploy Safety Guard

This project has split production surfaces:

- `https://edencafe.co/` is served from Spaceship / LiteSpeed.
- `https://edencafe-d9095.web.app/` and `https://edencafe-d9095.firebaseapp.com/` are Firebase default Hosting domains.
- Firebase remains the backend for Auth, Firestore, Cloud Functions, and reserved Auth helper paths such as `/__/auth/*`.

The repo root `firebase.json` is dangerous for Hosting because it uses:

```json
{
  "hosting": {
    "public": "."
  }
}
```

That means a root Firebase Hosting deploy can publish a large copy of the repo and overwrite the minimal/noindex default Hosting package.

## Local Guard Script

Run this local guard before any deployment command:

```powershell
node scripts/deploy-safety-guard.mjs --workflow <workflow> --command "<exact command>"
```

Supported workflows:

- `spaceship`
- `firebase-minimal`
- `firebase-backend`

Internal workflow used by the root Hosting predeploy hook:

- `root-hosting-predeploy`

The guard does not deploy anything. It only validates the proposed command and exits nonzero when it sees a dangerous pattern.

The repo root `firebase.json` also has a Hosting `predeploy` hook that calls this guard automatically. If someone forgets the manual guard and tries to deploy Hosting from the repo root, the hook blocks before Firebase publishes files.

## Hard Stop

Never run these from the repo root:

```powershell
firebase.cmd deploy --project edencafe-d9095
firebase.cmd deploy --project edencafe-d9095 --only hosting
firebase.cmd deploy --project edencafe-d9095 --only hosting --config firebase.json
```

These commands can overwrite the Firebase default domains with the full frontend again.

## Allowed Workflow 1: Spaceship Frontend Upload

Purpose:

- Update `https://edencafe.co/` on Spaceship / LiteSpeed.

Rules:

- Do not use Firebase CLI.
- Back up the production document root first.
- Upload exact files only.
- Do not upload broad directories such as `js/`, `Images/`, or `blog/` unless explicitly approved.
- Do not upload `.htaccess` unless the approval says `.htaccess` and includes rollback.
- Do not stage or push git as part of the upload.

Guard example:

```powershell
node scripts/deploy-safety-guard.mjs --workflow spaceship --command "cPanel exact upload from spaceship-production-package manifest"
```

Required checklist before upload:

- Exact source package path is named.
- Exact remote path is named.
- Backup path and timestamp are planned.
- Dirty local files related to the upload are listed.
- Smoke test URLs are listed.
- Rollback path is listed.

## Allowed Workflow 2: Firebase Minimal Hosting Restore

Purpose:

- Restore Firebase default Hosting domains to the minimal noindex handoff page.
- Keep `/__/auth/*` reserved helper routes working.

Rules:

- Run only from `D:\Eden Cafe Website\firebase-default-hosting-minimal`.
- Use only that folder's `firebase.json`.
- Deploy only Hosting.
- Do not deploy Functions/Auth/Firestore.
- Do not use the repo root `firebase.json`.

Backup current live first:

```powershell
firebase.cmd hosting:clone edencafe-d9095:live edencafe-d9095:rollback-before-minimal-restore-YYYYMMDD --project edencafe-d9095
```

Guard example from the minimal folder:

```powershell
Set-Location "D:\Eden Cafe Website\firebase-default-hosting-minimal"
node ..\scripts\deploy-safety-guard.mjs --workflow firebase-minimal --command "firebase.cmd deploy --project edencafe-d9095 --only hosting --config firebase.json --message `"Restore Firebase default domains minimal noindex handoff`""
```

Deploy command after approval:

```powershell
firebase.cmd deploy --project edencafe-d9095 --only hosting --config firebase.json --message "Restore Firebase default domains minimal noindex handoff"
```

Smoke test after deploy:

- `https://edencafe-d9095.web.app/` is minimal and noindex.
- `https://edencafe-d9095.firebaseapp.com/` is minimal and noindex.
- `/robots.txt` returns `200` and `Disallow: /`.
- A missing path returns `404` and noindex.
- `/__/auth/handler` returns `200` and does not redirect.
- `/__/auth/iframe`, `/__/auth/iframe.js`, and `/__/auth/experiments.js` return `200`.
- `https://edencafe.co/login`, `/register`, `/profile`, and `/booking` return `200`.
- Google login, phone OTP, and Recaptcha are tested from `https://edencafe.co/` when credentials/challenges are available.

Rollback if needed:

```powershell
firebase.cmd hosting:clone edencafe-d9095:rollback-before-minimal-restore-YYYYMMDD edencafe-d9095:live --project edencafe-d9095
```

## Allowed Workflow 3: Firebase Functions And Rules

Purpose:

- Deploy Firebase backend code or rules without touching Hosting.

Rules:

- Always include `--only`.
- Never include `hosting` in `--only`.
- Keep project explicit: `--project edencafe-d9095`.
- Review Functions, Firestore rules, and Storage rules separately.
- Do not assume an Auth settings change is part of CLI deploy.

Guard example:

```powershell
node scripts/deploy-safety-guard.mjs --workflow firebase-backend --command "firebase.cmd deploy --project edencafe-d9095 --only functions,firestore:rules"
```

Allowed command examples after approval:

```powershell
firebase.cmd deploy --project edencafe-d9095 --only functions
firebase.cmd deploy --project edencafe-d9095 --only firestore:rules
firebase.cmd deploy --project edencafe-d9095 --only functions,firestore:rules
```

Required checklist before backend/rules deploy:

- Exact backend targets are named.
- `--only` does not include Hosting.
- Functions dependency/build checks are complete.
- Rules diff is reviewed.
- Current production behavior and smoke tests are listed.
- Rollback or mitigation path is listed.

## Universal Pre-Deploy Checklist

Before every deploy or upload, confirm:

- Target surface: Spaceship, Firebase minimal Hosting, or Firebase backend/rules.
- Exact command or exact upload file list.
- Exact source folder/package.
- Exact production target path/site.
- Backup/rollback path.
- Expected blast radius.
- Smoke test checklist.
- Dirty local files related to the action.
- Explicit approval from the owner for that exact action.

If the task does not match one of the allowed workflows, stop and write a new preflight plan before touching production.
