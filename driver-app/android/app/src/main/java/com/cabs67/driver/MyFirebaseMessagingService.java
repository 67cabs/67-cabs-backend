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
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class MyFirebaseMessagingService extends FirebaseMessagingService {

    private static final String CHANNEL_ID = "67_driver_urgent_alerts_v3";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        String title = "🚖 Nayi Ride Request!";
        String body = "Nayi ride aayi hai, accept karein.";
        String rideId = "";
        String driverId = "";
        String pickup = "";
        String drop = "";
        String fare = "";

        // Extract Data Payload
        Map<String, String> data = remoteMessage.getData();
        if (data != null && data.size() > 0) {
            if (data.containsKey("title")) title = data.get("title");
            if (data.containsKey("body")) body = data.get("body");
            if (data.containsKey("rideId")) rideId = data.get("rideId");
            if (data.containsKey("driverId")) driverId = data.get("driverId");
            if (data.containsKey("pickup")) pickup = data.get("pickup");
            if (data.containsKey("drop")) drop = data.get("drop");
            if (data.containsKey("fare")) fare = data.get("fare");
        }

        showFullScreenRideAlert(title, body, rideId, driverId, pickup, drop, fare);
    }

    private void showFullScreenRideAlert(String title, String body, String rideId, String driverId, String pickup, String drop, String fare) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);

        // Android 8.0+ Channel Setup with Highest Urgency
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "67 Incoming Ride Alerts",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Urgent full screen alert for new incoming rides");
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

        // Setup Direct Overlay Intent
        Intent fullScreenIntent = new Intent(this, IncomingRideActivity.class);
        fullScreenIntent.putExtra("rideId", rideId);
        fullScreenIntent.putExtra("driverId", driverId);
        fullScreenIntent.putExtra("pickup", pickup);
        fullScreenIntent.putExtra("drop", drop);
        fullScreenIntent.putExtra("fare", fare);
        fullScreenIntent.putExtra("title", title);
        fullScreenIntent.putExtra("body", body);

        fullScreenIntent.setFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK |
                        Intent.FLAG_ACTIVITY_CLEAR_TOP |
                        Intent.FLAG_ACTIVITY_SINGLE_TOP |
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        );

        int uniqueReqCode = (int) System.currentTimeMillis();
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                uniqueReqCode,
                fullScreenIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setSound(soundUri)
                .setAutoCancel(true)
                .setOngoing(true)
                .setFullScreenIntent(pendingIntent, true)
                .setContentIntent(pendingIntent);

        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT;

        if (manager != null) {
            manager.notify(6702, notification);
        }

        // Direct Activity Trigger fallback
        try {
            startActivity(fullScreenIntent);
        } catch (Exception ignored) {}
    }
}