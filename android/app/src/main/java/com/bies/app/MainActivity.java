package com.bies.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins; Capacitor finds the npm ones by itself.
        registerPlugin(SavedKeyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
