package com.personal.pos;

import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

@CapacitorPlugin(name = "EdenPosUpdater")
public class EdenPosUpdaterPlugin extends Plugin {
    private static final String TRUSTED_DOWNLOAD_ENDPOINT =
        "https://asia-southeast1-edencafe-d9095.cloudfunctions.net/downloadPosApkRelease";
    private static final String APK_MIME_TYPE = "application/vnd.android.package-archive";
    private static final int BUFFER_SIZE = 64 * 1024;

    @PluginMethod
    public void getInstalledVersion(PluginCall call) {
        try {
            PackageManager packageManager = getContext().getPackageManager();
            String packageName = getContext().getPackageName();
            PackageInfo info = packageManager.getPackageInfo(packageName, 0);
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;

            JSObject result = new JSObject();
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            result.put("versionCode", versionCode);
            result.put("packageName", packageName);
            result.put("native", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(messageFor(error, "Unable to read installed version"));
        }
    }

    @PluginMethod
    public void downloadApkToPrivateStorage(PluginCall call) {
        String endpoint = call.getString("endpoint", "");
        String idToken = call.getString("idToken", "");
        String expectedSha256 = normalizeSha256(call.getString("sha256", ""));
        Integer versionCode = call.getInt("versionCode", 0);

        if (!TRUSTED_DOWNLOAD_ENDPOINT.equals(endpoint)) {
            call.reject("Untrusted POS APK download endpoint");
            return;
        }
        if (idToken.trim().isEmpty()) {
            call.reject("Missing Firebase ID token");
            return;
        }
        if (expectedSha256.length() != 64) {
            call.reject("Missing expected APK SHA256");
            return;
        }
        if (versionCode == null || versionCode <= 0) {
            call.reject("Missing POS APK versionCode");
            return;
        }

        new Thread(() -> {
            HttpURLConnection connection = null;
            File tempFile = null;

            try {
                JSONObject payload = new JSONObject();
                payload.put("appId", call.getString("appId", "com.personal.pos"));
                payload.put("channel", call.getString("channel", "test"));
                payload.put("deviceId", call.getString("deviceId", ""));
                payload.put("releaseId", call.getString("releaseId", ""));
                payload.put("versionCode", versionCode);

                connection = (HttpURLConnection) new URL(endpoint).openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(120000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Authorization", "Bearer " + idToken);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setRequestProperty("Accept", APK_MIME_TYPE);

                byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body);
                }

                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    throw new Exception("Download denied: HTTP " + status + " " + readResponseText(connection.getErrorStream()));
                }

                File updateDir = updateDirectory();
                tempFile = File.createTempFile("eden-pos-", ".apk.tmp", updateDir);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long totalBytes = 0;

                try (
                    InputStream input = new BufferedInputStream(connection.getInputStream());
                    OutputStream output = new BufferedOutputStream(new FileOutputStream(tempFile))
                ) {
                    byte[] buffer = new byte[BUFFER_SIZE];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        digest.update(buffer, 0, read);
                        output.write(buffer, 0, read);
                        totalBytes += read;
                    }
                }

                String actualSha256 = hexDigest(digest);
                if (!expectedSha256.equals(actualSha256)) {
                    deleteQuietly(tempFile);
                    throw new Exception("APK SHA256 mismatch: " + actualSha256);
                }

                File apkFile = new File(updateDir, "eden-pos-v" + versionCode + ".apk");
                deleteQuietly(apkFile);
                if (!tempFile.renameTo(apkFile)) {
                    copyFile(tempFile, apkFile);
                    deleteQuietly(tempFile);
                }

                JSObject result = new JSObject();
                result.put("filePath", apkFile.getAbsolutePath());
                result.put("sha256", actualSha256);
                result.put("size", totalBytes);
                call.resolve(result);
            } catch (Exception error) {
                deleteQuietly(tempFile);
                call.reject(messageFor(error, "Unable to download POS APK"));
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }).start();
    }

    @PluginMethod
    public void verifySha256(PluginCall call) {
        try {
            File apkFile = safeApkFile(call.getString("filePath", ""));
            String expectedSha256 = normalizeSha256(call.getString("sha256", ""));
            String actualSha256 = sha256File(apkFile);
            boolean ok = expectedSha256.length() == 64 && expectedSha256.equals(actualSha256);
            if (!ok) {
                deleteQuietly(apkFile);
            }

            JSObject result = new JSObject();
            result.put("ok", ok);
            result.put("actualSha256", actualSha256);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(messageFor(error, "Unable to verify POS APK"));
        }
    }

    @PluginMethod
    public void launchPackageInstaller(PluginCall call) {
        try {
            File apkFile = safeApkFile(call.getString("filePath", ""));
            Uri apkUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apkFile
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, APK_MIME_TYPE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            getContext().startActivity(intent);

            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(messageFor(error, "Unable to open Android installer"));
        }
    }

    @PluginMethod
    public void canRequestPackageInstalls(PluginCall call) {
        boolean allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject result = new JSObject();
        result.put("allowed", allowed);
        call.resolve(result);
    }

    @PluginMethod
    public void openInstallUnknownAppsSettings(PluginCall call) {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())
                );
            } else {
                intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(messageFor(error, "Unable to open install settings"));
        }
    }

    @PluginMethod
    public void getPowerStatus(PluginCall call) {
        Intent battery = getContext().registerReceiver(
            null,
            new IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        );
        int level = battery == null ? -1 : battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = battery == null ? -1 : battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        int status = battery == null ? -1 : battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING
            || status == BatteryManager.BATTERY_STATUS_FULL;
        double batteryLevel = scale > 0 && level >= 0 ? (double) level / (double) scale : -1;

        JSObject result = new JSObject();
        result.put("batteryLevel", batteryLevel);
        result.put("isCharging", charging);
        call.resolve(result);
    }

    private File updateDirectory() throws Exception {
        File updateDir = new File(getContext().getCacheDir(), "pos_apk_updates");
        if (!updateDir.exists() && !updateDir.mkdirs()) {
            throw new Exception("Unable to create POS APK update directory");
        }
        return updateDir;
    }

    private File safeApkFile(String filePath) throws Exception {
        if (filePath == null || filePath.trim().isEmpty()) {
            throw new Exception("Missing POS APK file path");
        }

        File updateDir = updateDirectory();
        File apkFile = new File(filePath);
        String canonicalBase = updateDir.getCanonicalPath() + File.separator;
        String canonicalFile = apkFile.getCanonicalPath();
        if (!canonicalFile.startsWith(canonicalBase) || !canonicalFile.endsWith(".apk")) {
            throw new Exception("POS APK file path is outside private update storage");
        }
        if (!apkFile.exists()) {
            throw new Exception("POS APK file is not available");
        }
        return apkFile;
    }

    private String sha256File(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        return hexDigest(digest);
    }

    private static String normalizeSha256(String value) {
        return value == null
            ? ""
            : value.replaceAll("[^a-fA-F0-9]", "").toUpperCase(Locale.US);
    }

    private static String hexDigest(MessageDigest digest) {
        StringBuilder builder = new StringBuilder();
        for (byte item : digest.digest()) {
            builder.append(String.format(Locale.US, "%02X", item));
        }
        return builder.toString();
    }

    private static String readResponseText(InputStream input) {
        if (input == null) return "";

        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = source.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        } catch (Exception ignored) {
            return "";
        }
    }

    private static void copyFile(File source, File target) throws Exception {
        try (
            InputStream input = new BufferedInputStream(new FileInputStream(source));
            OutputStream output = new BufferedOutputStream(new FileOutputStream(target))
        ) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    private static String messageFor(Exception error, String fallback) {
        return error.getMessage() == null || error.getMessage().trim().isEmpty()
            ? fallback
            : error.getMessage();
    }
}
