package com.personal.pos;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;

@CapacitorPlugin(name = "UsbEscPosPrinter")
public class UsbEscPosPrinterPlugin extends Plugin {
    private static final String ACTION_USB_PERMISSION = "com.personal.pos.USB_PRINTER_PERMISSION";
    private static final int USB_TIMEOUT_MS = 5000;
    private static final int USB_CHUNK_SIZE = 512;

    private UsbManager usbManager;
    private boolean receiverRegistered = false;
    private PluginCall pendingCall;
    private byte[] pendingPayload;
    private UsbDevice pendingDevice;
    private int pendingInterfaceNumber = -1;
    private int pendingEndpointNumber = -1;

    private final BroadcastReceiver permissionReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!ACTION_USB_PERMISSION.equals(intent.getAction())) return;

            UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
            PluginCall call = pendingCall;
            byte[] payload = pendingPayload;
            int interfaceNumber = pendingInterfaceNumber;
            int endpointNumber = pendingEndpointNumber;

            clearPendingPrint();

            if (call == null || payload == null || device == null) return;
            if (!granted) {
                call.reject("USB printer permission denied");
                return;
            }

            writeToUsb(call, device, payload, interfaceNumber, endpointNumber);
        }
    };

    @Override
    public void load() {
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        registerPermissionReceiver();
    }

    @PluginMethod
    public void listDevices(PluginCall call) {
        ensureUsbManager();
        JSObject result = new JSObject();
        JSArray devices = new JSArray();

        HashMap<String, UsbDevice> deviceList = usbManager.getDeviceList();
        for (UsbDevice device : deviceList.values()) {
            JSObject item = usbDeviceToJson(device);
            item.put("hasPermission", usbManager.hasPermission(device));
            devices.put(item);
        }

        result.put("devices", devices);
        call.resolve(result);
    }

    @PluginMethod
    public void print(PluginCall call) {
        ensureUsbManager();
        registerPermissionReceiver();

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

        Integer vendorId = parseFlexibleInt(stringOption(call, "vendorId", ""));
        Integer productId = parseFlexibleInt(stringOption(call, "productId", ""));
        String deviceName = stringOption(call, "deviceName", "");
        int interfaceNumber = intOption(call, "interfaceNumber", -1);
        int endpointNumber = intOption(call, "endpointNumber", -1);

        UsbDevice device = findUsbDevice(vendorId, productId, deviceName);
        if (device == null) {
            call.reject(buildNoPrinterFoundMessage(vendorId, productId, deviceName));
            return;
        }

        if (!usbManager.hasPermission(device)) {
            pendingCall = call;
            pendingPayload = payload;
            pendingDevice = device;
            pendingInterfaceNumber = interfaceNumber;
            pendingEndpointNumber = endpointNumber;
            PendingIntent permissionIntent = PendingIntent.getBroadcast(
                getContext(),
                0,
                new Intent(ACTION_USB_PERMISSION).setPackage(getContext().getPackageName()),
                pendingIntentFlags()
            );
            usbManager.requestPermission(device, permissionIntent);
            return;
        }

        writeToUsb(call, device, payload, interfaceNumber, endpointNumber);
    }

    private void writeToUsb(
        PluginCall call,
        UsbDevice device,
        byte[] payload,
        int interfaceNumber,
        int endpointNumber
    ) {
        UsbTarget target = findUsbTarget(device, interfaceNumber, endpointNumber);
        if (target == null) {
            target = findUsbTarget(device, -1, -1);
        }
        if (target == null) {
            call.reject("No writable USB output endpoint found");
            return;
        }

        UsbDeviceConnection connection = usbManager.openDevice(device);
        if (connection == null) {
            call.reject("Unable to open USB printer");
            return;
        }

        boolean claimed = false;
        int writtenTotal = 0;
        try {
            claimed = connection.claimInterface(target.usbInterface, true);
            if (!claimed) {
                call.reject("Unable to claim USB printer interface");
                return;
            }
            try {
                connection.setInterface(target.usbInterface);
            } catch (Exception ignored) {
            }

            while (writtenTotal < payload.length) {
                int endpointPacketSize = Math.max(1, target.endpoint.getMaxPacketSize());
                int chunkLimit = Math.min(USB_CHUNK_SIZE, endpointPacketSize * 8);
                int chunkLength = Math.min(chunkLimit, payload.length - writtenTotal);
                byte[] chunk = new byte[chunkLength];
                System.arraycopy(payload, writtenTotal, chunk, 0, chunkLength);
                int written = connection.bulkTransfer(target.endpoint, chunk, chunkLength, USB_TIMEOUT_MS);
                if (written < 0) {
                    call.reject("USB printer write failed");
                    return;
                }
                if (written == 0) {
                    call.reject("USB printer accepted 0 bytes");
                    return;
                }
                writtenTotal += written;
                try {
                    Thread.sleep(12);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    call.reject("USB printer write interrupted");
                    return;
                }
            }

            if (writtenTotal < payload.length) {
                call.reject("USB printer write incomplete");
                return;
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("bytes", writtenTotal);
            result.put("device", usbDeviceToJson(device));
            result.put("interfaceNumber", target.usbInterface.getId());
            result.put("endpointNumber", target.endpoint.getEndpointNumber());
            result.put("endpointAddress", target.endpoint.getAddress());
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() != null ? error.getMessage() : "USB printer error");
        } finally {
            if (claimed) {
                try {
                    connection.releaseInterface(target.usbInterface);
                } catch (Exception ignored) {
                }
            }
            connection.close();
        }
    }

    private UsbDevice findUsbDevice(Integer vendorId, Integer productId, String deviceName) {
        HashMap<String, UsbDevice> deviceList = usbManager.getDeviceList();
        String wantedDeviceName = deviceName == null ? "" : deviceName.trim();
        boolean hasVendorId = vendorId != null;
        boolean hasProductId = productId != null;
        boolean hasDeviceName = !wantedDeviceName.isEmpty();
        boolean hasStableId = hasVendorId || hasProductId;
        UsbDevice exactNameFallback = null;
        UsbDevice writableFallback = null;
        UsbDevice firstMatchingFallback = null;

        for (UsbDevice device : deviceList.values()) {
            if (hasVendorId && device.getVendorId() != vendorId) {
                continue;
            }
            if (hasProductId && device.getProductId() != productId) {
                continue;
            }
            if (!hasStableId && hasDeviceName && !device.getDeviceName().equals(wantedDeviceName)) {
                continue;
            }

            if (firstMatchingFallback == null) firstMatchingFallback = device;

            boolean nameMatches = hasDeviceName && device.getDeviceName().equals(wantedDeviceName);
            if (nameMatches && exactNameFallback == null) exactNameFallback = device;

            if (findUsbTarget(device, -1, -1) != null) {
                if (nameMatches) return device;
                if (writableFallback == null) writableFallback = device;
            }
        }

        if (hasStableId || hasDeviceName) {
            if (writableFallback != null) return writableFallback;
            if (exactNameFallback != null) return exactNameFallback;
            return firstMatchingFallback;
        }

        for (UsbDevice device : deviceList.values()) {
            if (findUsbTarget(device, -1, -1) != null) return device;
        }

        return null;
    }

    private String buildNoPrinterFoundMessage(
        Integer vendorId,
        Integer productId,
        String deviceName
    ) {
        HashMap<String, UsbDevice> deviceList = usbManager.getDeviceList();
        StringBuilder message = new StringBuilder("No USB ESC/POS printer found");
        String filterSummary = usbFilterSummary(vendorId, productId, deviceName);
        if (!filterSummary.isEmpty()) {
            message.append(" for ").append(filterSummary);
        }

        if (deviceList.isEmpty()) {
            message.append(". Android reports 0 USB devices. Check cable, OTG/USB host mode, printer power, and USB permission.");
            return message.toString();
        }

        message.append(". Android sees ");
        message.append(deviceList.size());
        message.append(" USB device(s): ");

        int index = 0;
        for (UsbDevice device : deviceList.values()) {
            if (index > 0) message.append("; ");
            if (index >= 4) {
                message.append("...");
                break;
            }
            message.append(usbDeviceSummary(device));
            index += 1;
        }

        return message.toString();
    }

    private String usbFilterSummary(Integer vendorId, Integer productId, String deviceName) {
        StringBuilder summary = new StringBuilder();
        if (vendorId != null) {
            summary.append("VID ").append(vendorId);
        }
        if (productId != null) {
            if (summary.length() > 0) summary.append(" / ");
            summary.append("PID ").append(productId);
        }
        if (deviceName != null && !deviceName.trim().isEmpty()) {
            if (summary.length() > 0) summary.append(" / ");
            summary.append(deviceName.trim());
        }
        return summary.toString();
    }

    private String usbDeviceSummary(UsbDevice device) {
        StringBuilder summary = new StringBuilder();
        summary.append("VID ").append(device.getVendorId());
        summary.append(" PID ").append(device.getProductId());
        summary.append(" class ").append(device.getDeviceClass());
        summary.append(" name ").append(device.getDeviceName());
        UsbTarget target = findUsbTarget(device, -1, -1);
        if (target == null) {
            summary.append(" no writable endpoint");
        } else {
            summary.append(" interface ").append(target.usbInterface.getId());
            summary.append(" endpoint ").append(target.endpoint.getEndpointNumber());
        }
        return summary.toString();
    }

    private UsbTarget findUsbTarget(UsbDevice device, int interfaceNumber, int endpointNumber) {
        UsbTarget fallback = null;

        for (int interfaceIndex = 0; interfaceIndex < device.getInterfaceCount(); interfaceIndex++) {
            UsbInterface usbInterface = device.getInterface(interfaceIndex);
            if (interfaceNumber >= 0 && usbInterface.getId() != interfaceNumber) continue;

            for (int endpointIndex = 0; endpointIndex < usbInterface.getEndpointCount(); endpointIndex++) {
                UsbEndpoint endpoint = usbInterface.getEndpoint(endpointIndex);
                boolean isWritableOut =
                    endpoint.getDirection() == UsbConstants.USB_DIR_OUT &&
                    (
                        endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK ||
                        endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_INT
                    );
                if (!isWritableOut) continue;

                boolean endpointMatches =
                    endpointNumber < 0 ||
                    endpoint.getEndpointNumber() == endpointNumber ||
                    endpoint.getAddress() == endpointNumber;
                if (!endpointMatches) continue;

                UsbTarget target = new UsbTarget(usbInterface, endpoint);
                if (usbInterface.getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) {
                    return target;
                }
                if (fallback == null) fallback = target;
            }
        }

        return fallback;
    }

    private JSObject usbDeviceToJson(UsbDevice device) {
        JSObject item = new JSObject();
        item.put("deviceName", device.getDeviceName());
        item.put("vendorId", device.getVendorId());
        item.put("productId", device.getProductId());
        item.put("deviceClass", device.getDeviceClass());
        item.put("manufacturerName", Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP ? device.getManufacturerName() : "");
        item.put("productName", Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP ? device.getProductName() : "");
        JSArray interfaces = new JSArray();
        for (int interfaceIndex = 0; interfaceIndex < device.getInterfaceCount(); interfaceIndex++) {
            UsbInterface usbInterface = device.getInterface(interfaceIndex);
            JSObject interfaceJson = new JSObject();
            interfaceJson.put("id", usbInterface.getId());
            interfaceJson.put("interfaceClass", usbInterface.getInterfaceClass());
            interfaceJson.put("interfaceSubclass", usbInterface.getInterfaceSubclass());
            interfaceJson.put("interfaceProtocol", usbInterface.getInterfaceProtocol());

            JSArray endpoints = new JSArray();
            for (int endpointIndex = 0; endpointIndex < usbInterface.getEndpointCount(); endpointIndex++) {
                UsbEndpoint endpoint = usbInterface.getEndpoint(endpointIndex);
                boolean writable =
                    endpoint.getDirection() == UsbConstants.USB_DIR_OUT &&
                    (
                        endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK ||
                        endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_INT
                    );
                JSObject endpointJson = new JSObject();
                endpointJson.put("endpointNumber", endpoint.getEndpointNumber());
                endpointJson.put("address", endpoint.getAddress());
                endpointJson.put("direction", endpoint.getDirection());
                endpointJson.put("type", endpoint.getType());
                endpointJson.put("maxPacketSize", endpoint.getMaxPacketSize());
                endpointJson.put("writable", writable);
                endpoints.put(endpointJson);
            }
            interfaceJson.put("endpoints", endpoints);
            interfaces.put(interfaceJson);
        }
        item.put("interfaces", interfaces);
        return item;
    }

    private void ensureUsbManager() {
        if (usbManager == null) {
            usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        }
    }

    private void registerPermissionReceiver() {
        if (receiverRegistered) return;
        IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(permissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(permissionReceiver, filter);
        }
        receiverRegistered = true;
    }

    private void clearPendingPrint() {
        pendingCall = null;
        pendingPayload = null;
        pendingDevice = null;
        pendingInterfaceNumber = -1;
        pendingEndpointNumber = -1;
    }

    private int pendingIntentFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        return flags;
    }

    private String stringOption(PluginCall call, String key, String fallback) {
        String value = call.getString(key);
        return value == null ? fallback : value;
    }

    private int intOption(PluginCall call, String key, int fallback) {
        Integer value = parseFlexibleInt(stringOption(call, key, ""));
        return value == null ? fallback : value;
    }

    private Integer parseFlexibleInt(String rawValue) {
        String value = rawValue == null ? "" : rawValue.trim().toLowerCase();
        if (value.isEmpty()) return null;
        try {
            if (value.startsWith("0x")) {
                return Integer.parseInt(value.substring(2), 16);
            }
            return Integer.parseInt(value, 10);
        } catch (NumberFormatException error) {
            return null;
        }
    }

    private static class UsbTarget {
        final UsbInterface usbInterface;
        final UsbEndpoint endpoint;

        UsbTarget(UsbInterface usbInterface, UsbEndpoint endpoint) {
            this.usbInterface = usbInterface;
            this.endpoint = endpoint;
        }
    }
}
