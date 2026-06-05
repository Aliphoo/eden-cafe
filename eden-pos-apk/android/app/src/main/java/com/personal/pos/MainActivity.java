package com.personal.pos;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CustomerDisplayPlugin.class);
        registerPlugin(UsbEscPosPrinterPlugin.class);
        registerPlugin(BluetoothEscPosPrinterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
