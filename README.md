# Eden Cafe Website

Static website and Firebase backend configuration for Eden Cafe.

## Main stack
- Static HTML/CSS/JavaScript
- Firebase Authentication
- Cloud Firestore
- Firebase Cloud Functions
- Spaceship/cPanel hosting for uploaded admin images
- cPanel/Apache hosting support via `.htaccess`

## Notes
- Do not commit generated ZIP deploy packages.
- Do not commit `node_modules` or Firebase local cache files.
- Cloud Functions dependencies can be restored with `npm install --prefix functions`.

## Encoding safety
- Save source files as UTF-8.
- Before deploy, run `node scripts/check-encoding.js`.
- For simple text replacements, prefer `node scripts/utf8-replace.js <file> <search> <replace>`.
- Avoid PowerShell text edits without explicit UTF-8, because Thai text can become mojibake.

## Marketing tools
- Public pages load `js/marketing-consent.js` as the single consent and marketing integration layer.
- Configure Google Tag Manager, GA4, Google Ads, and Meta Pixel from Admin > Marketing Tools.
- Third-party marketing scripts are loaded only after the visitor grants analytics or marketing consent.
- Consent is stored in `localStorage` under `eden_cookie_consent_v2`; use `window.EdenMarketing.resetConsent()` in the browser console to test the banner again.
