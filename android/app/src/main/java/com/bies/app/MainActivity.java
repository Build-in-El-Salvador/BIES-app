package com.bies.app;

import android.os.Bundle;
import android.view.View;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins; Capacitor finds the npm ones by itself.
        registerPlugin(SavedKeyPlugin.class);
        super.onCreate(savedInstanceState);
        // Android 12+ stretches the whole web view at the top and bottom of a
        // page, the fixed header and bottom bar with it. Pages stop at their
        // ends instead, as in most apps built this way.
        getBridge().getWebView().setOverScrollMode(View.OVER_SCROLL_NEVER);
    }
}
