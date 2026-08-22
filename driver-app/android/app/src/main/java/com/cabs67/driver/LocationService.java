package com.cabs67.driver;

import android.annotation.SuppressLint;
import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.json.JSONObject;
import io.socket.client.IO;
import io.socket.client.Socket;

public class LocationService extends Service {

    private static final String CHANNEL_ID = "DriverLocationChannel_v11";
    private static final String ALERT_CHANNEL_ID = "DriverIncomingRideAlertChannel_v11";
    private static final String KILL_CHANNEL_ID = "DriverAppKilledAlertChannel_v11";
    private static final int ALERT_NOTIFICATION_ID = 6705;
    private static final int KILL_NOTIFICATION_ID = 6709;

    private LocationManager locationManager;
    private LocationListener locationListener;
    private Socket mSocket;
    private PowerManager.WakeLock wakeLock;

    private String cachedDriverId = "";
    private String cachedName = "Driver";
    private String cachedVehicleNo = "RJ 14 TA 6767";
    private String cachedCabType = "HATCHBACK";
    private String cachedUpiId = "67cabs@upi";
    private double lastLat = 26.9124;
    private double lastLng = 75.7873;

    private Handler heartbeatHandler;
    private Runnable heartbeatRunnable;

    @Override
    public void onCreate() {
        super.onCreate();
        loadCachedDriverData();
        createNotificationChannels();
        initNativeBackgroundSocket();
        startNativeHeartbeat();
    }

    private void loadCachedDriverData() {
        try {
            SharedPreferences defaultPrefs = getSharedPreferences(getPackageName() + "_preferences", Context.MODE_PRIVATE);
            String driverSessionJson = defaultPrefs.getString("67_driver_session", null);

            if (driverSessionJson == null) {
                SharedPreferences capPrefs = getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
                driverSessionJson = capPrefs.getString("67_driver_session", null);
            }

            if (driverSessionJson == null) {
                SharedPreferences capPrefs2 = getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
                driverSessionJson = capPrefs2.getString("CapacitorStorage.67_driver_session", null);
            }

            if (driverSessionJson != null) {
                JSONObject driver = new JSONObject(driverSessionJson);
                cachedDriverId = driver.optString("driverId", "");
                cachedName = driver.optString("name", "Driver");
                cachedVehicleNo = driver.optString("vehicleNo", "RJ 14 TA 6767");
                cachedCabType = driver.optString("cabType", "HATCHBACK");
                cachedUpiId = driver.optString("upiId", "67cabs@upi");
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        loadCachedDriverData();

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(KILL_NOTIFICATION_ID);
        }

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("67 Cabs Driver Online")
                .setContentText("आपकी लाइव लोकेशन राइडर्स को दिख रही है...")
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(1, notification);
        }

        startLocationUpdates();
        return START_STICKY;
    }

    private void emitDriverHeartbeat() {
        if (mSocket != null && mSocket.connected()) {
            loadCachedDriverData();
            if (!cachedDriverId.isEmpty()) {
                try {
                    JSONObject regData = new JSONObject();
                    regData.put("driverId", cachedDriverId);
                    regData.put("name", cachedName);
                    regData.put("vehicleNo", cachedVehicleNo);
                    regData.put("cabType", cachedCabType);
                    regData.put("upiId", cachedUpiId);
                    regData.put("status", "APPROVED");
                    regData.put("isOnline", true);

                    JSONObject loc = new JSONObject();
                    loc.put("lat", lastLat);
                    loc.put("lng", lastLng);
                    regData.put("location", loc);

                    mSocket.emit("driver:register", regData);
                } catch (Exception ignored) {}
            }
        }
    }

    private void startNativeHeartbeat() {
        heartbeatHandler = new Handler(Looper.getMainLooper());
        heartbeatRunnable = new Runnable() {
            @Override
            public void run() {
                emitDriverHeartbeat();
                heartbeatHandler.postDelayed(this, 3000); // 3-second continuous background pulse
            }
        };
        heartbeatHandler.postDelayed(heartbeatRunnable, 3000);
    }

    private void initNativeBackgroundSocket() {
        try {
            IO.Options opts = new IO.Options();
            opts.transports = new String[]{"websocket", "polling"};
            opts.reconnection = true;
            opts.reconnectionAttempts = 1000;
            opts.reconnectionDelay = 1000;

            mSocket = IO.socket("https://137.23.57.23.sslip.io", opts);

            mSocket.on(Socket.EVENT_CONNECT, args -> {
                emitDriverHeartbeat();
                bindTargetedOfferListeners();
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

    private void bindTargetedOfferListeners() {
        if (!cachedDriverId.isEmpty() && mSocket != null) {
            mSocket.off("ride:offer_for_" + cachedDriverId);
            mSocket.on("ride:offer_for_" + cachedDriverId, args -> {
                if (args.length > 0 && args[0] instanceof JSONObject) {
                    launchIncomingRideFullScreen((JSONObject) args[0]);
                }
            });

            mSocket.off("ride:new_offer:" + cachedDriverId);
            mSocket.on("ride:new_offer:" + cachedDriverId, args -> {
                if (args.length > 0 && args[0] instanceof JSONObject) {
                    launchIncomingRideFullScreen((JSONObject) args[0]);
                }
            });
        }
    }

    // DIRECT APP FORWARD ENGINE: Pushes MainActivity directly ahead of YouTube / Active App
    private void launchIncomingRideFullScreen(JSONObject offer) {
        try {
            String rideId = offer.optString("rideId", "");
            String fare = offer.optString("totalFare", "0");
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

            // 1. Hardware Screen Force Wakeup
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                if (wakeLock != null && wakeLock.isHeld()) {
                    wakeLock.release();
                }
                wakeLock = pm.newWakeLock(
                        PowerManager.FULL_WAKE_LOCK |
                                PowerManager.ACQUIRE_CAUSES_WAKEUP |
                                PowerManager.ON_AFTER_RELEASE,
                        "67Cabs:DirectAppWakeLock"
                );
                wakeLock.acquire(15000);
            }

            // 2. Direct Intent to bring MainActivity (Driver App) to Front
            Intent openMainAppIntent = new Intent(this, MainActivity.class);
            openMainAppIntent.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK |
                            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT |
                            Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED |
                            Intent.FLAG_ACTIVITY_SINGLE_TOP
            );
            openMainAppIntent.putExtra("directIncomingRideId", rideId);

            // 3. Native App Task Reorder (Bypasses YouTube and pulls Main App to screen)
            try {
                ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
                if (am != null) {
                    List<ActivityManager.AppTask> tasks = am.getAppTasks();
                    if (tasks != null && !tasks.isEmpty()) {
                        tasks.get(0).moveToFront();
                    }
                }
            } catch (Exception ignored) {}

            // 4. Launch Main App directly
            startActivity(openMainAppIntent);

            // 5. Full-Screen Call Style Banner with Sound
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    this,
                    (int) System.currentTimeMillis(),
                    openMainAppIntent,
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
                    .build();

            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.notify(ALERT_NOTIFICATION_ID, alertNotification);
            }

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
                lastLat = location.getLatitude();
                lastLng = location.getLongitude();
                sendLocationToServer(lastLat, lastLng);
                emitDriverHeartbeat();
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
                    locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 3000, 2, locationListener);
                }
                if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 3000, 2, locationListener);
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
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
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
            } catch (Exception ignored) {}
        }).start();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
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
                        "Driver Direct App Launch",
                        NotificationManager.IMPORTANCE_HIGH
                );
                alertChannel.setDescription("Brings Driver App directly to screen when ride arrives");
                alertChannel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                alertChannel.enableVibration(true);
                alertChannel.setBypassDnd(true);

                AudioAttributes audioAttributes = new AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .build();
                alertChannel.setSound(soundUri, audioAttributes);

                manager.createNotificationChannel(alertChannel);

                NotificationChannel killChannel = new NotificationChannel(
                        KILL_CHANNEL_ID,
                        "Driver Background Warning Alert",
                        NotificationManager.IMPORTANCE_HIGH
                );
                killChannel.setDescription("Warns driver when OS kills the app in background");
                killChannel.enableVibration(true);
                manager.createNotificationChannel(killChannel);
            }
        }
    }

    private void showAppKilledNotification() {
        try {
            Intent openIntent = new Intent(this, MainActivity.class);
            openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

            PendingIntent pIntent = PendingIntent.getActivity(
                    this,
                    (int) System.currentTimeMillis(),
                    openIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
            );

            Notification killNotif = new NotificationCompat.Builder(this, KILL_CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setContentTitle("⚠️ 67 Partner: App Background me Inactive ho gayi!")
                    .setContentText("Android ne app ko sleep kar diya hai. Nayi rides pane ke liye turant app kholein!")
                    .setStyle(new NotificationCompat.BigTextStyle()
                            .bigText("Android ne battery bachat ke liye aapki location band kar di hai. Rides lene ke liye abhi tap karke app wapas kholein."))
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentIntent(pIntent)
                    .setAutoCancel(true)
                    .build();

            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.notify(KILL_NOTIFICATION_ID, killNotif);
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        showAppKilledNotification();
        if (mSocket != null && mSocket.connected() && !cachedDriverId.isEmpty()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("driverId", cachedDriverId);
                obj.put("isOnline", false);
                mSocket.emit("driver:toggle_online", obj);
            } catch (Exception ignored) {}
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        showAppKilledNotification();
        if (heartbeatHandler != null && heartbeatRunnable != null) {
            heartbeatHandler.removeCallbacks(heartbeatRunnable);
        }
        if (locationManager != null && locationListener != null) {
            locationManager.removeUpdates(locationListener);
        }
        if (mSocket != null) {
            if (mSocket.connected() && !cachedDriverId.isEmpty()) {
                try {
                    JSONObject obj = new JSONObject();
                    obj.put("driverId", cachedDriverId);
                    obj.put("isOnline", false);
                    mSocket.emit("driver:toggle_online", obj);
                } catch (Exception ignored) {}
            }
            mSocket.disconnect();
            mSocket.off();
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}