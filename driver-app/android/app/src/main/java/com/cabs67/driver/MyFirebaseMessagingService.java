package com.cabs67.driver;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class MyFirebaseMessagingService extends FirebaseMessagingService {

    // Unique channel ID ensuring highest priority settings persist
    private static final String CHANNEL_ID = "67_driver_incoming_call_v4";
    private static final int NOTIFICATION_ID = 6702;

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

        // 3. Acquire short WakeLock to wake CPU & Screen instantly (Ola/Uber Engine)
        acquireScreenWakeLock();

        // 4. Trigger Full-Screen Overlay Alert
        showFullScreenRideAlert(title, body, rideId, driverId, pickup, drop, fare);
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
                wakeLock.acquire(10000); // 10 seconds wake lock
            }
        } catch (Exception ignored) {}
    }

    private void showFullScreenRideAlert(String title, String body, String rideId, String driverId, String pickup, String drop, String fare) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);

        // Android 8.0 (API 26)+ High-Priority Alert Channel
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "67 Urgent Ride Requests",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Critical incoming ride requests overlay channel");
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            channel.enableVibration(true);
            channel.setBypassDnd(true);

            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .build();
            channel.setSound(soundUri, audioAttributes);

            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }

        // Target Activity: IncomingRideActivity (Force Pop over other apps)
        Intent fullScreenIntent = new Intent(this, IncomingRideActivity.class);
        fullScreenIntent.putExtra("rideId", rideId);
        fullScreenIntent.putExtra("driverId", driverId);
        fullScreenIntent.putExtra("pickup", pickup);
        fullScreenIntent.putExtra("drop", drop);
        fullScreenIntent.putExtra("fare", fare);
        fullScreenIntent.putExtra("title", title);
        fullScreenIntent.putExtra("body", body);

        fullScreenIntent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK |
                        Intent.FLAG_ACTIVITY_CLEAR_TOP |
                        Intent.FLAG_ACTIVITY_SINGLE_TOP |
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        );

        int uniqueReqCode = (int) System.currentTimeMillis();
        PendingIntent fullScreenPendingIntent = PendingIntent.getActivity(
                this,
                uniqueReqCode,
                fullScreenIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText("Kiraya: ₹" + fare + " • " + pickup)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setSound(soundUri)
                .setAutoCancel(true)
                .setOngoing(true)
                .setFullScreenIntent(fullScreenPendingIntent, true)
                .setContentIntent(fullScreenPendingIntent);

        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT;

        if (manager != null) {
            manager.notify(NOTIFICATION_ID, notification);
        }

        // Direct Activity Trigger (Works over other running apps when Display over other apps is on)
        try {
            startActivity(fullScreenIntent);
        } catch (Exception ignored) {}
    }
}