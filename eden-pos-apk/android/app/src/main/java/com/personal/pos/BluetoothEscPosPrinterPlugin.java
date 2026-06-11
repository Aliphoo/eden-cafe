package com.personal.pos;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(
    name = "BluetoothEscPosPrinter",
    permissions = {
        @Permission(
            strings = { Manifest.permission.BLUETOOTH_CONNECT },
            alias = "bluetoothConnect"
        )
    }
)
public class BluetoothEscPosPrinterPlugin extends Plugin {
    public static final String BLUETOOTH_CONNECT = "bluetoothConnect";
    private static final UUID DEFAULT_SPP_UUID =
        UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int BLUETOOTH_CHUNK_SIZE = 384;

    @PluginMethod
    public void listDevices(PluginCall call) {
        BluetoothAdapter adapter = getBluetoothAdapter(call);
        if (adapter == null) return;

        if (!ensureBluetoothPermission(call)) return;

        if (!adapter.isEnabled()) {
            call.reject("Bluetooth is disabled");
            return;
        }

        JSArray devices = new JSArray();
        for (BluetoothDevice device : bondedDevices(adapter)) {
            devices.put(bluetoothDeviceToJson(device));
        }

        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    @PluginMethod
    public void print(PluginCall call) {
        BluetoothAdapter adapter = getBluetoothAdapter(call);
        if (adapter == null) return;

        if (!ensureBluetoothPermission(call)) return;

        if (!adapter.isEnabled()) {
            call.reject("Bluetooth is disabled");
            return;
        }

        String payloadBase64 = stringOption(call, "payloadBase64", "");
        if (payloadBase64.trim().isEmpty()) {
            call.reject("Missing ESC/POS payload");
            return;
        }

        byte[] payload;
        try {
            payload = Base64.decode(payloadBase64, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid ESC/POS payload");
            return;
        }

        BluetoothDevice device = findBluetoothDevice(
            adapter,
            stringOption(call, "address", ""),
            stringOption(call, "name", "")
        );

        if (device == null) {
            call.reject("No paired Bluetooth printer found");
            return;
        }

        UUID uuid = parseUuid(stringOption(call, "uuid", ""));
        try {
            adapter.cancelDiscovery();
        } catch (Exception ignored) {
        }

        try {
            writeToBluetoothDevice(device, uuid, payload);

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("bytes", payload.length);
            result.put("device", bluetoothDeviceToJson(device));
            call.resolve(result);
        } catch (Exception error) {
            call.reject(
                error.getMessage() != null
                    ? error.getMessage()
                    : "Bluetooth printer write failed"
            );
        }
    }

    @PermissionCallback
    private void bluetoothPermissionCallback(PluginCall call) {
        if (!hasBluetoothConnectPermission()) {
            call.reject("Bluetooth permission denied");
            return;
        }

        if ("listDevices".equals(call.getMethodName())) {
            listDevices(call);
        } else {
            print(call);
        }
    }

    private void writeToBluetoothDevice(
        BluetoothDevice device,
        UUID uuid,
        byte[] payload
    ) throws Exception {
        Exception lastError = null;

        try {
            writeWithSocket(device.createRfcommSocketToServiceRecord(uuid), payload);
            return;
        } catch (Exception error) {
            lastError = error;
        }

        try {
            writeWithSocket(device.createInsecureRfcommSocketToServiceRecord(uuid), payload);
            return;
        } catch (Exception error) {
            lastError = error;
        }

        try {
            Method method = device.getClass().getMethod("createRfcommSocket", int.class);
            BluetoothSocket socket = (BluetoothSocket) method.invoke(device, 1);
            writeWithSocket(socket, payload);
            return;
        } catch (Exception error) {
            lastError = error;
        }

        if (lastError != null) throw lastError;
        throw new IOException("Unable to connect Bluetooth printer");
    }

    private void writeWithSocket(BluetoothSocket socket, byte[] payload) throws Exception {
        int written = 0;
        try {
            socket.connect();
            OutputStream outputStream = socket.getOutputStream();
            while (written < payload.length) {
                int chunkLength = Math.min(BLUETOOTH_CHUNK_SIZE, payload.length - written);
                outputStream.write(payload, written, chunkLength);
                outputStream.flush();
                written += chunkLength;
                try {
                    Thread.sleep(35);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw interrupted;
                }
            }
        } finally {
            try {
                socket.close();
            } catch (Exception ignored) {
            }
        }
    }

    private BluetoothDevice findBluetoothDevice(
        BluetoothAdapter adapter,
        String address,
        String name
    ) {
        String wantedAddress = normalize(address);
        String wantedName = normalize(name);
        BluetoothDevice printerLikeFallback = null;
        BluetoothDevice firstFallback = null;

        for (BluetoothDevice device : bondedDevices(adapter)) {
            String deviceAddress = normalize(device.getAddress());
            String deviceName = normalize(safeDeviceName(device));
            if (firstFallback == null) firstFallback = device;

            if (!wantedAddress.isEmpty() && wantedAddress.equalsIgnoreCase(deviceAddress)) {
                return device;
            }

            if (
                !wantedName.isEmpty() &&
                (
                    wantedName.equalsIgnoreCase(deviceName) ||
                    deviceName.toLowerCase().contains(wantedName.toLowerCase()) ||
                    wantedName.toLowerCase().contains(deviceName.toLowerCase())
                )
            ) {
                return device;
            }

            if (printerLikeFallback == null && looksLikePrinter(deviceName)) {
                printerLikeFallback = device;
            }
        }

        if (wantedAddress.isEmpty() && wantedName.isEmpty()) {
            return printerLikeFallback != null ? printerLikeFallback : firstFallback;
        }

        return null;
    }

    private boolean looksLikePrinter(String name) {
        String lower = name.toLowerCase();
        return lower.contains("print") ||
            lower.contains("printer") ||
            lower.contains("pos") ||
            lower.contains("thermal") ||
            lower.contains("xp-") ||
            lower.contains("gprinter") ||
            lower.contains("rongta") ||
            lower.contains("imin") ||
            lower.contains("bt");
    }

    private Set<BluetoothDevice> bondedDevices(BluetoothAdapter adapter) {
        return adapter.getBondedDevices();
    }

    private JSObject bluetoothDeviceToJson(BluetoothDevice device) {
        JSObject item = new JSObject();
        item.put("name", safeDeviceName(device));
        item.put("address", device.getAddress());
        item.put("bondState", device.getBondState());
        item.put(
            "type",
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2
                ? device.getType()
                : 0
        );
        return item;
    }

    private String safeDeviceName(BluetoothDevice device) {
        try {
            String name = device.getName();
            return name == null ? "" : name;
        } catch (SecurityException error) {
            return "";
        }
    }

    private BluetoothAdapter getBluetoothAdapter(PluginCall call) {
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) {
            call.reject("Bluetooth is not available on this device");
            return null;
        }
        return adapter;
    }

    private boolean hasBluetoothConnectPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        return ContextCompat.checkSelfPermission(
            getContext(),
            Manifest.permission.BLUETOOTH_CONNECT
        ) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean ensureBluetoothPermission(PluginCall call) {
        if (hasBluetoothConnectPermission()) return true;
        PermissionState state = getPermissionState(BLUETOOTH_CONNECT);
        if (state == PermissionState.PROMPT || state == PermissionState.PROMPT_WITH_RATIONALE) {
            requestPermissionForAlias(BLUETOOTH_CONNECT, call, "bluetoothPermissionCallback");
        } else {
            call.reject("Bluetooth permission missing. Please allow nearby devices permission for Eden Cafe POS.");
        }
        return false;
    }

    private UUID parseUuid(String value) {
        try {
            String clean = normalize(value);
            return clean.isEmpty() ? DEFAULT_SPP_UUID : UUID.fromString(clean);
        } catch (Exception error) {
            return DEFAULT_SPP_UUID;
        }
    }

    private String stringOption(PluginCall call, String key, String fallback) {
        String value = call.getString(key);
        return value == null ? fallback : value;
    }

    private String normalize(String value) {
        return value == null ? "" : value.trim();
    }
}
