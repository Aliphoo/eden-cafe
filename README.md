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
