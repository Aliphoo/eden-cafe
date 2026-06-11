# Eden POS APK Releases on Spaceship

This flow stores APK files on Spaceship while keeping Eden backend as the
permission gate for both in-app updates and manual downloads.

## Architecture

1. GitHub Actions builds `eden-pos-apk`.
2. The workflow uploads the APK to Spaceship by FTP/FTPS.
3. The workflow prints a release manifest with `sha256`, `size`, and
   `storagePath`.
4. Admin registers the manifest in `pos_apk_releases`.
5. POS APK calls Firebase Cloud Functions:
   - `checkPosApkUpdate`
   - `downloadPosApkRelease`
   - `reportPosUpdateEvent`
6. The Cloud Function checks admin/device permission, fetches the APK from the
   allowlisted Spaceship HTTPS origin, verifies SHA256/size, then sends the APK
   to the POS or manual download page.

The APK client never receives or chooses the Spaceship origin URL.

## GitHub Secrets

Set these repository secrets before running the workflow:

- `SPACESHIP_FTP_SERVER`
- `SPACESHIP_FTP_USERNAME`
- `SPACESHIP_FTP_PASSWORD`
- `SPACESHIP_APK_BASE_URL`

Example:

```text
SPACESHIP_APK_BASE_URL=https://www.edencafe.co/pos-apk/releases
```

This is the origin folder for APK files. The actual APK origin URL will include
the filename, for example:

```text
https://www.edencafe.co/pos-apk/releases/eden-pos-1.24-v25-production.apk
```

Do not send that raw file URL to normal users unless it is protected at the
Spaceship folder level.

The default workflow remote directory is:

```text
pos-apk/releases
```

Adjust it if the Spaceship FTP root is not the web root.

## Firebase Security Gate

The protected download URL is always a Firebase Cloud Function URL, not the
Spaceship file URL.

- In-app update: `downloadPosApkRelease`
- Manual admin download page: `downloadPosApk`
- Permission source: Firebase Auth ID token plus `admin_users` with POS access
- Audit source: `pos_update_events` and `pos_devices`

If the Spaceship folder is public, anyone with the raw Spaceship URL can still
download the file. To make "only authorized users can download" true end to end,
protect the Spaceship APK folder with Directory Privacy / Basic Auth, then set
these Firebase Functions secrets:

```powershell
firebase functions:secrets:set POS_APK_ORIGIN_BASIC_USERNAME
firebase functions:secrets:set POS_APK_ORIGIN_BASIC_PASSWORD
```

`downloadPosApk` and `downloadPosApkRelease` will use those secrets when fetching
the APK from Spaceship, verify SHA256/size, and then stream the file only after
Firebase permission passes.

## Run A Release

1. Open GitHub Actions.
2. Run `POS APK Spaceship Release`.
3. Choose `channel`, `version_name`, and `version_code`.
4. Download the workflow artifact named `pos-apk-release-...`.
5. Open `pos-apk-release-manifest.json`.
6. In Admin > POS APK Updates, create or edit a release:
   - `appId`: `com.personal.pos`
   - `versionName`: from the artifact
   - `versionCode`: from the artifact
   - `channel`: `test`, `pilot`, or `production`
   - `status`: start with `draft`
   - `sha256`: from the artifact
   - `size`: from the artifact
   - `functionAsset`: leave blank
   - `storagePath`: the Spaceship HTTPS URL from the artifact
7. Test on one POS device.
8. Mark the release `active` only after the test device can download, verify,
   and open Android installer.

## Manual Download

The manual download page should live on the Spaceship domain:

```text
https://www.edencafe.co/pos-apk
```

or, if clean URLs are not enabled on Spaceship:

```text
https://www.edencafe.co/pos-apk.html
```

That page should still call `downloadPosApk` with an Eden admin Firebase token.
The function resolves the latest active release and can proxy a Spaceship-hosted
APK.

Do not send users the raw Spaceship URL. If manual download is needed, send them
to `https://www.edencafe.co/pos-apk` and require Firebase sign-in with POS admin
permission. If the raw Spaceship URL must be completely blocked, the Spaceship
folder must be protected with Basic Auth and the two Firebase origin secrets
above must be deployed.

## Allowlist

Firebase Functions currently allow remote APK origins under:

```text
edencafe.co
*.edencafe.co
```

If Spaceship gives a different public hostname, add it to
`POS_APK_REMOTE_ALLOWED_HOST_SUFFIXES` in `functions/index.js` before deploying.

## Version Code Rule

Android updates are decided by `versionCode`, not SHA256. If a device already
has `versionCode 24`, it will not install another `versionCode 24` as an
upgrade. Use a higher versionCode for the next real rollout.
