package com.cabs67.driver;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import io.socket.client.IO;
import io.socket.client.Socket;

public class LocationService extends Service {

    private static final String CHANNEL_ID = "DriverLocationChannel";
    private static final String ALERT_CHANNEL_ID = "DriverIncomingRideAlertChannel_v4";
    private static final int ALERT_NOTIFICATION_ID = 6705;

    private LocationManager locationManager;
    private LocationListener locationListener;
    private Socket mSocket;
    private PowerManager.WakeLock wakeLock;
    private String cachedDriverId = "";

    @Override
    public void onCreate() {
        super.onCreate();
        loadCachedDriverId();
        createNotificationChannels();
        initNativeBackgroundSocket();
    }

    private void loadCachedDriverId() {
        try {
            SharedPreferences prefs = getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
            String driverSessionJson = prefs.getString("67_driver_session", null);
            if (driverSessionJson != null) {
                JSONObject driver = new JSONObject(driverSessionJson);
                cachedDriverId = driver.optString("driverId", "");
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("67 Cabs Driver Online")
                .setContentText("आपकी लाइव लोकेशन राइडर्स को दिख रही है...")
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();

        startForeground(1, notification);
        startLocationUpdates();

        return START_STICKY;
    }

    private void initNativeBackgroundSocket() {
        try {
            IO.Options opts = new IO.Options();
            opts.transports = new String[]{"websocket", "polling"};
            opts.reconnection = true;
            opts.reconnectionAttempts = 100;
            opts.reconnectionDelay = 1000;

            mSocket = IO.socket("https://137.23.57.23.sslip.io", opts);

            mSocket.on(Socket.EVENT_CONNECT, args -> {
                loadCachedDriverId();
                if (!cachedDriverId.isEmpty()) {
                    try {
                        JSONObject regData = new JSONObject();
                        regData.put("driverId", cachedDriverId);
                        regData.put("status", "APPROVED");
                        regData.put("isOnline", true);
                        mSocket.emit("driver:register", regData);
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                }
            });

            mSocket.on("ride:new_offer", args -> {
                if (args.length > 0 && args[0] instanceof JSONObject) {
                    JSONObject offer = (JSONObject) args[0];
                    launchIncomingRideFullScreen(offer);
                }
            });

            mSocket.connect();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void launchIncomingRideFullScreen(JSONObject offer) {
        try {
            String rideId = offer.optString("rideId", "");
            String fare = offer.optString("totalFare", "0");
            String driverId = offer.optString("targetDriverId", cachedDriverId);
            String pickup = "Jaipur Pickup Point";
            String drop = "Drop Destination";

            if (offer.has("pickupName")) {
                pickup = offer.optString("pickupName");
            } else if (offer.has("pickup")) {
                JSONObject pObj = offer.optJSONObject("pickup");
                if (pObj != null) pickup = pObj.optString("text", "Jaipur Pickup Point");
            }

            if (offer.has("dropName")) {
                drop = offer.optString("dropName");
            } else if (offer.has("stops") && offer.optJSONArray("stops") != null && offer.optJSONArray("stops").length() > 0) {
                JSONObject sObj = offer.optJSONArray("stops").optJSONObject(0);
                if (sObj != null) drop = sObj.optString("text", "Drop Destination");
            }

            // 1. Instant Hardware Screen Wakeup
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                if (wakeLock != null && wakeLock.isHeld()) {
                    wakeLock.release();
                }
                wakeLock = pm.newWakeLock(
                        PowerManager.FULL_WAKE_LOCK |
                                PowerManager.ACQUIRE_CAUSES_WAKEUP |
                                PowerManager.ON_AFTER_RELEASE,
                        "67Cabs:LocationServiceRideWakeLock"
                );
                wakeLock.acquire(15000);
            }

            // 2. Setup Full Screen Intent
            Intent fullScreenIntent = new Intent(this, IncomingRideActivity.class);
            fullScreenIntent.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK |
                            Intent.FLAG_ACTIVITY_CLEAR_TOP |
                            Intent.FLAG_ACTIVITY_SINGLE_TOP |
                            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            );
            fullScreenIntent.putExtra("rideId", rideId);
            fullScreenIntent.putExtra("driverId", driverId);
            fullScreenIntent.putExtra("fare", fare);
            fullScreenIntent.putExtra("pickup", pickup);
            fullScreenIntent.putExtra("drop", drop);

            PendingIntent pendingIntent = PendingIntent.getActivity(
                    this,
                    (int) System.currentTimeMillis(),
                    fullScreenIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
            );

            Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);

            Notification alertNotification = new NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setContentTitle("🚖 NEW RIDE REQUEST!")
                    .setContentText("₹" + fare + " • " + pickup + " ➔ " + drop)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setSound(soundUri)
                    .setFullScreenIntent(pendingIntent, true)
                    .setContentIntent(pendingIntent)
                    .setAutoCancel(true)
                    .setOngoing(true)
                    .build();

            alertNotification.flags |= Notification.FLAG_INSISTENT;

            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.notify(ALERT_NOTIFICATION_ID, alertNotification);
            }

            // Direct Overlay Launch
            try {
                startActivity(fullScreenIntent);
            } catch (Exception ignored) {}

        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @SuppressLint("MissingPermission")
    private void startLocationUpdates() {
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        locationListener = new LocationListener() {
            @Override
            public void onLocationChanged(@NonNull Location location) {
                sendLocationToServer(location.getLatitude(), location.getLongitude());
            }
            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {}
            @Override
            public void onProviderEnabled(@NonNull String provider) {}
            @Override
            public void onProviderDisabled(@NonNull String provider) {}
        };

        try {
            if (locationManager != null) {
                if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 4000, 3, locationListener);
                }
                if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 4000, 3, locationListener);
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void sendLocationToServer(double lat, double lng) {
        new Thread(() -> {
            try {
                URL url = new URL("https://137.23.57.23.sslip.io/api/driver/update-location");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setConnectTimeout(6000);
                conn.setReadTimeout(6000);
                conn.setDoOutput(true);

                JSONObject jsonParam = new JSONObject();
                jsonParam.put("latitude", lat);
                jsonParam.put("longitude", lng);
                if (!cachedDriverId.isEmpty()) {
                    jsonParam.put("driverId", cachedDriverId);
                }

                OutputStream os = conn.getOutputStream();
                os.write(jsonParam.toString().getBytes(StandardCharsets.UTF_8));
                os.flush();
                os.close();

                conn.getResponseCode();
                conn.disconnect();
            } catch (Exception e) {
                e.printStackTrace();
            }
        }).start();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                NotificationChannel trackChannel = new NotificationChannel(
                        CHANNEL_ID,
                        "Driver Location Tracking",
                        NotificationManager.IMPORTANCE_LOW
                );
                manager.createNotificationChannel(trackChannel);

                Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
                NotificationChannel alertChannel = new NotificationChannel(
                        ALERT_CHANNEL_ID,
                        "Driver Incoming Ride Full Screen",
                        NotificationManager.IMPORTANCE_HIGH
                );
                alertChannel.setDescription("Shows full screen incoming ride requests over any open app");
                alertChannel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                alertChannel.enableVibration(true);
                alertChannel.setBypassDnd(true);

                AudioAttributes audioAttributes = new AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .build();
                alertChannel.setSound(soundUri, audioAttributes);

                manager.createNotificationChannel(alertChannel);
            }
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (locationManager != null && locationListener != null) {
            locationManager.removeUpdates(locationListener);
        }
        if (mSocket != null) {
            mSocket.disconnect();
            mSocket.off();
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}