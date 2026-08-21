package com.cabs67.driver;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class MyFirebaseMessagingService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        String title = "🚖 Nayi Ride Request!";
        String body = "Accept karne ke liye tap karein";
        String rideId = "";
        String driverId = "";
        String pickup = "Jaipur Pickup Point";
        String drop = "Jaipur Destination";
        String fare = "0";
        String soundName = "alert_uber"; // Admin default sound

        // 1. Extract pure data payload safely
        Map<String, String> data = remoteMessage.getData();
        if (data != null && !data.isEmpty()) {
            if (data.containsKey("title") && data.get("title") != null) title = data.get("title");
            if (data.containsKey("body") && data.get("body") != null) body = data.get("body");
            if (data.containsKey("rideId") && data.get("rideId") != null) rideId = data.get("rideId");
            if (data.containsKey("driverId") && data.get("driverId") != null) driverId = data.get("driverId");
            if (data.containsKey("pickup") && data.get("pickup") != null) pickup = data.get("pickup");
            if (data.containsKey("drop") && data.get("drop") != null) drop = data.get("drop");
            if (data.containsKey("fare") && data.get("fare") != null) fare = data.get("fare");
            if (data.containsKey("soundName") && data.get("soundName") != null) soundName = data.get("soundName");
        }

        // 2. Fallback check for notification object
        if (remoteMessage.getNotification() != null) {
            if (remoteMessage.getNotification().getTitle() != null) {
                title = remoteMessage.getNotification().getTitle();
            }
            if (remoteMessage.getNotification().getBody() != null) {
                body = remoteMessage.getNotification().getBody();
            }
        }

        // 3. Acquire strong WakeLock
        acquireScreenWakeLock();

        // 4. Trigger Full-Screen Alert / Overlay with Admin Selected Dynamic Tone
        showFullScreenRideAlert(title, body, rideId, driverId, pickup, drop, fare, soundName);
    }

    private void acquireScreenWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock wakeLock = pm.newWakeLock(
                        PowerManager.FULL_WAKE_LOCK |
                                PowerManager.ACQUIRE_CAUSES_WAKEUP |
                                PowerManager.ON_AFTER_RELEASE,
                        "67Cabs:IncomingRideWakeLock"
                );
                wakeLock.acquire(16000); // 16 seconds wake lock
            }
        } catch (Exception ignored) {}
    }

    private void showFullScreenRideAlert(String title, String body, String rideId, String driverId, String pickup, String drop, String fare, String soundName) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        // Dynamic Sound Resource Resolution (res/raw/<soundName>.mp3)
        int soundResId = getResources().getIdentifier(soundName, "raw", getPackageName());
        Uri soundUri;
        if (soundResId != 0) {
            soundUri = Uri.parse("android.resource://" + getPackageName() + "/" + soundResId);
        } else {
            soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        }

        // Dedicated dynamic channel per sound to force Android OS sound updates
        String channelId = "67_alert_ch_" + soundName;
        int notificationId = 6700 + Math.abs(soundName.hashCode() % 100);

        // Android 8.0 (API 26)+ Channel Creation with Forced Heads-up Alert
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    channelId,
                    "67 Urgent Ride Alert (" + soundName + ")",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Critical high priority popup channel for incoming rides");
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            channel.enableVibration(true);
            channel.setBypassDnd(true);
            channel.enableLights(true);
            channel.setLightColor(Color.RED);
            channel.setVibrationPattern(new long[]{0, 500, 200, 500, 200, 500});

            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .build();
            channel.setSound(soundUri, audioAttributes);

            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }

        // Setup Intent for IncomingRideActivity
        Intent fullScreenIntent = new Intent(this, IncomingRideActivity.class);
        fullScreenIntent.putExtra("rideId", rideId);
        fullScreenIntent.putExtra("driverId", driverId);
        fullScreenIntent.putExtra("pickup", pickup);
        fullScreenIntent.putExtra("drop", drop);
        fullScreenIntent.putExtra("fare", fare);
        fullScreenIntent.putExtra("title", title);
        fullScreenIntent.putExtra("body", body);
        fullScreenIntent.putExtra("soundName", soundName);

        // Flags required to break through background and display above active apps
        fullScreenIntent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK |
                        Intent.FLAG_ACTIVITY_CLEAR_TOP |
                        Intent.FLAG_ACTIVITY_SINGLE_TOP |
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        );

        int uniqueReqCode = (int) System.currentTimeMillis();
        int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingIntentFlags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent fullScreenPendingIntent = PendingIntent.getActivity(
                this,
                uniqueReqCode,
                fullScreenIntent,
                pendingIntentFlags
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText("Kiraya: ₹" + fare + " • " + pickup)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setSound(soundUri)
                .setVibrate(new long[]{0, 500, 200, 500})
                .setLights(Color.RED, 1000, 500)
                .setAutoCancel(true)
                .setOngoing(true)
                .setFullScreenIntent(fullScreenPendingIntent, true)
                .setContentIntent(fullScreenPendingIntent);

        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT;

        if (manager != null) {
            manager.notify(notificationId, notification);
        }

        // Direct Activity Trigger when device/overlay permits
        try {
            startActivity(fullScreenIntent);
        } catch (Exception ignored) {}
    }
}