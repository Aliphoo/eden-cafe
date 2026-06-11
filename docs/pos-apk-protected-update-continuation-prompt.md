# Prompt: Continue Eden POS APK Protected Update System

Use this prompt when continuing Phase 7 work.

```text
You are continuing Eden POS APK Phase 7 in the real project path only:

- Root website/backend repo: D:\Eden Cafe Website
- POS APK source: D:\Eden Cafe Website\eden-pos-apk

Do not use or copy from C:\Users\ROG\OneDrive\เอกสาร\App POS.
Do not create a new POS project elsewhere.
Do not edit minified dist instead of real source.
Do not deploy production unless the user explicitly approves deployment.
Do not build a rollout APK until versionName/versionCode are confirmed.

Goal:
Make Eden POS APK protected updates and manual APK downloads work with Firebase security so only authorized users can download.

Security architecture:
1. APK files may be uploaded to Spaceship by GitHub Actions.
2. POS APK clients and manual users must never download from a raw Spaceship URL.
3. All downloads must go through Firebase Cloud Functions:
   - checkPosApkUpdate
   - downloadPosApkRelease
   - downloadPosApk
   - reportPosUpdateEvent
4. Cloud Functions must verify Firebase Auth ID token and POS admin permission from admin_users.
5. Firestore release metadata lives in pos_apk_releases.
6. Audit logs live in pos_update_events and pos_devices.
7. Backend must verify SHA256 and size before streaming a Spaceship-hosted APK.
8. POS APK must verify SHA256 again after download before opening Android installer.
9. If raw Spaceship URLs must be blocked, protect the Spaceship release folder with Directory Privacy / Basic Auth and set Firebase Function secrets:
   - POS_APK_ORIGIN_BASIC_USERNAME
   - POS_APK_ORIGIN_BASIC_PASSWORD
10. GitHub FTP upload secrets are separate:
   - SPACESHIP_FTP_SERVER
   - SPACESHIP_FTP_USERNAME
   - SPACESHIP_FTP_PASSWORD
   - SPACESHIP_APK_BASE_URL

Current package identity must not change:
- appId/packageId/applicationId: com.personal.pos
- signing key: do not change

Update decision rule:
- Android update is decided by versionCode only.
- If devices already have versionCode 24, the next real rollout must use versionCode 25 or higher.

Required checks before allowing in-app update:
- no open bill
- no unsynced orders
- loyalty sync is not pending/syncing/local
- network is online
- warn on low battery / not charging if available
- never block POS sales if update check or download fails

Protected manual download:
- Users go to https://www.edencafe.co/pos-apk, or https://www.edencafe.co/pos-apk.html if clean URLs are not enabled on Spaceship.
- Page signs in with Firebase Auth.
- Page calls downloadPosApk with Authorization: Bearer <Firebase ID token>.
- Backend checks POS admin permission before streaming.
- Do not show or distribute storagePath/raw Spaceship URL to normal users.

Firestore rules expectation:
- pos_apk_releases read/create/update only for hasAdminPermission('pos')
- pos_update_events read only for hasAdminPermission('pos'), client write false
- pos_devices read only for hasAdminPermission('pos'), client write false
- report/update writes happen through Cloud Functions using Admin SDK

Implementation checklist:
1. Re-audit D:\Eden Cafe Website\eden-pos-apk exists and has package.json, src, capacitor config, and Android project.
2. Confirm appId/applicationId is com.personal.pos.
3. Confirm current Android versionName/versionCode.
4. Confirm POS Settings/About includes current version, Check for updates, release notes, SHA256, safety blockers, unknown-apps permission path, and installer launch.
5. Confirm native plugin supports getInstalledVersion, downloadApkToPrivateStorage, verifySha256, launchPackageInstaller, canRequestPackageInstalls, openInstallUnknownAppsSettings, and power status.
6. Confirm Cloud Functions enforce auth/permission and do not trust client-provided download URLs.
7. Confirm Admin UI can create/edit pos_apk_releases, channels test/pilot/production, status draft/active/revoked, and device/event status.
8. If using Spaceship origin protection, configure Basic Auth on the Spaceship APK folder and set Firebase origin secrets before deploy.
9. Run verification before any deploy:
   - cd D:\Eden Cafe Website\functions
   - npm.cmd run lint
   - cd D:\Eden Cafe Website\eden-pos-apk
   - npm.cmd run build
   - npx.cmd cap sync android
   - .\android\gradlew.bat -p android :app:assembleRelease
10. Compute APK SHA256 and size, then register release metadata as draft.
11. Deploy only after explicit user approval:
   - firebase deploy --only functions,hosting,firestore:rules
12. Test on one real POS device before marking production active.

Acceptance tests:
- current versionCode 23 sees update to 24 or next selected versionCode.
- current versionCode equal to latest does not see update.
- unauthorized Firebase user cannot check/download.
- authorized POS admin can manually download through https://www.edencafe.co/pos-apk.
- raw Spaceship URL is not used by POS client; if Basic Auth is configured, raw URL is blocked without origin credentials.
- hash mismatch deletes downloaded APK and blocks install.
- pending order/open bill/loyalty pending blocks update.
- download failure does not affect selling.
- Android installer opens through FileProvider.
- unknown-apps permission flow opens Android settings if needed.
- installed event is written to pos_update_events and pos_devices.

Final response must summarize:
1. Architecture chosen
2. Files changed
3. Functions added/changed
4. Admin UI changed
5. POS APK source path
6. Build command used
7. APK output path and SHA256 if built
8. Test evidence
9. Whether MDM/Device Owner is still required for silent update
```
