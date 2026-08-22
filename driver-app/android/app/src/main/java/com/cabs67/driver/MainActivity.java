package com.cabs67.driver;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowManager;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    private static final int PERMISSION_REQ_CODE = 6701;
    private static final int OVERLAY_REQ_CODE = 6702;
    private static final int BG_LOCATION_REQ_CODE = 6703;
    private static final int FULL_SCREEN_REQ_CODE = 6704;
    private static final int BATTERY_OPT_REQ_CODE = 6706;
    private static final int KILL_NOTIFICATION_ID = 6709;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Clear any previous kill warning notification when app is opened
        NotificationManager notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (notificationManager != null) {
            notificationManager.cancel(KILL_NOTIFICATION_ID);
        }

        // Keep Screen On & Wake up over lockscreen flags
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
                            WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD |
                            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON |
                            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            );
        }

        checkAndRequestAppPermissions();
    }

    @Override
    public void onResume() {
        super.onResume();
        NotificationManager notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (notificationManager != null) {
            notificationManager.cancel(KILL_NOTIFICATION_ID);
        }
    }

    private void checkAndRequestAppPermissions() {
        List<String> neededPermissions = new ArrayList<>();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            neededPermissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            neededPermissions.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                neededPermissions.add(Manifest.permission.POST_NOTIFICATIONS);
            }
        }

        // Android 14+ (API 34/35/36) Foreground Location Type Permission
        if (Build.VERSION.SDK_INT >= 34) {
            if (ContextCompat.checkSelfPermission(this, "android.permission.FOREGROUND_SERVICE_LOCATION") != PackageManager.PERMISSION_GRANTED) {
                neededPermissions.add("android.permission.FOREGROUND_SERVICE_LOCATION");
            }
        }

        if (!neededPermissions.isEmpty()) {
            ActivityCompat.requestPermissions(this, neededPermissions.toArray(new String[0]), PERMISSION_REQ_CODE);
        } else {
            checkBackgroundLocationAndProceed();
        }
    }

    private void checkBackgroundLocationAndProceed() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                        this,
                        new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION},
                        BG_LOCATION_REQ_CODE
                );
                return;
            }
        }
        checkOverlayPermissionAndStart();
    }

    private void checkOverlayPermissionAndStart() {
        // 1. Request "Display over other apps" (SYSTEM_ALERT_WINDOW)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!Settings.canDrawOverlays(this)) {
                Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName()));
                startActivityForResult(intent, OVERLAY_REQ_CODE);
                return;
            }
        }

        // 2. Check Android 14+ Full Screen Intent Permission for Private/Sideloaded APKs
        checkFullScreenIntentPermission();
    }

    private void checkFullScreenIntentPermission() {
        if (Build.VERSION.SDK_INT >= 34) { // Android 14+ (API 34+)
            NotificationManager notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (notificationManager != null && !notificationManager.canUseFullScreenIntent()) {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                            Uri.parse("package:" + getPackageName()));
                    startActivityForResult(intent, FULL_SCREEN_REQ_CODE);
                    return;
                } catch (Exception ignored) {}
            }
        }

        checkBatteryOptimizationAndStart();
    }

    private void checkBatteryOptimizationAndStart() {
        // Request Exemption from Battery Optimization to Prevent OS Silent Kills
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                try {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:" + getPackageName()));
                    startActivityForResult(intent, BATTERY_OPT_REQ_CODE);
                    return;
                } catch (Exception ignored) {}
            }
        }

        startBackgroundLocationServiceSafe();
    }

    private void startBackgroundLocationServiceSafe() {
        try {
            Intent serviceIntent = new Intent(this, LocationService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQ_CODE) {
            checkBackgroundLocationAndProceed();
        } else if (requestCode == BG_LOCATION_REQ_CODE) {
            checkOverlayPermissionAndStart();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == OVERLAY_REQ_CODE) {
            checkFullScreenIntentPermission();
        } else if (requestCode == FULL_SCREEN_REQ_CODE) {
            checkBatteryOptimizationAndStart();
        } else if (requestCode == BATTERY_OPT_REQ_CODE) {
            startBackgroundLocationServiceSafe();
        }
    }
}