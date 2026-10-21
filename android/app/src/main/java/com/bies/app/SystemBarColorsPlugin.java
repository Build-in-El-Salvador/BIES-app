package com.bies.app;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.view.Window;

import androidx.annotation.NonNull;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The status bar and gesture bar follow the page under them: the app sends
 * the colours at the top and bottom of the screen (src/components/SystemBarsSync.jsx)
 * and the bars' icons turn light or dark to stay readable. Below WebView 140,
 * Capacitor pads the page instead of drawing it under the bars; the gaps show
 * the window's background, which this paints in the same two colours.
 */
@CapacitorPlugin(name = "SystemBarColors")
public class SystemBarColorsPlugin extends Plugin {

    /** { top, bottom: "#rrggbb", topDark, bottomDark: boolean }. */
    @PluginMethod
    public void set(PluginCall call) {
        final int top;
        final int bottom;
        try {
            top = Color.parseColor(call.getString("top", ""));
            bottom = Color.parseColor(call.getString("bottom", ""));
        } catch (IllegalArgumentException e) {
            call.reject("Colours must be #rrggbb");
            return;
        }
        final boolean topDark = Boolean.TRUE.equals(call.getBoolean("topDark", false));
        final boolean bottomDark = Boolean.TRUE.equals(call.getBoolean("bottomDark", false));

        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            View decor = window.getDecorView();
            if (decor.getBackground() instanceof TwoBands) {
                ((TwoBands) decor.getBackground()).setColors(top, bottom);
            } else {
                decor.setBackground(new TwoBands(top, bottom));
                // A new window background resets the window's padding, which is
                // where Capacitor keeps the page clear of the bars on older
                // WebViews; have it set again.
                ViewCompat.requestApplyInsets(decor);
            }
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
            // "Light" bars have dark icons, for a light background.
            controller.setAppearanceLightStatusBars(!topDark);
            controller.setAppearanceLightNavigationBars(!bottomDark);
            call.resolve();
        });
    }

    /** The top half in one colour, the bottom half in the other. */
    private static final class TwoBands extends Drawable {
        private final Paint top = new Paint();
        private final Paint bottom = new Paint();

        TwoBands(int topColor, int bottomColor) {
            setColors(topColor, bottomColor);
        }

        void setColors(int topColor, int bottomColor) {
            top.setColor(topColor);
            bottom.setColor(bottomColor);
            invalidateSelf();
        }

        @Override
        public void draw(@NonNull Canvas canvas) {
            Rect b = getBounds();
            int middle = b.top + b.height() / 2;
            canvas.drawRect(b.left, b.top, b.right, middle, top);
            canvas.drawRect(b.left, middle, b.right, b.bottom, bottom);
        }

        @Override
        public void setAlpha(int alpha) {}

        @Override
        public void setColorFilter(ColorFilter colorFilter) {}

        @Override
        public int getOpacity() {
            return PixelFormat.OPAQUE;
        }
    }
}
