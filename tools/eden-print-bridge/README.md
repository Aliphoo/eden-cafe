# Eden Print Bridge

Local bridge for Eden POS thermal receipt printing. It lets the Eden POS APK send ESC/POS bytes to a WiFi/LAN receipt printer over raw TCP, usually port `9100`.

## Start

```powershell
cd "D:\Eden Cafe Website"
node tools\eden-print-bridge\server.js
```

Default URL:

```text
http://127.0.0.1:8787
```

## POS APK setup

1. Open Eden POS APK.
2. In `Printer Control`, choose `WiFi/LAN via Eden Print Bridge`.
3. Set `Bridge URL` to `http://127.0.0.1:8787`.
4. Set the receipt printer IP, for example `192.168.1.50`.
5. Keep port `9100` unless the printer manual says otherwise.
6. Press `Check Bridge`, then `Test Print`.

## Supported paths

- WiFi/LAN ESC/POS printers: supported through this bridge.
- USB / serial cable printers: use the APK printer profile supported by the target device.
- Bluetooth printers: use `Bluetooth BLE` when the printer exposes BLE GATT write service, or the device printer profile if Android exposes it.
- Browser print: use the `Browser Print` profile as a fallback for Windows/macOS printer drivers.

## Security

The bridge listens on `127.0.0.1` by default and accepts requests from local pages, `file://` pages, and local origins. To allow an Eden POS origin during testing, set:

```powershell
$env:EDEN_PRINT_ALLOWED_ORIGINS="https://your-eden-domain.example"
node tools\eden-print-bridge\server.js
```
