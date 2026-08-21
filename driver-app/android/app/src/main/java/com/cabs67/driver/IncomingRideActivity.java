package com.cabs67.driver;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CountDownTimer;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class IncomingRideActivity extends Activity {

    private Ringtone ringtone;
    private Vibrator vibrator;
    private CountDownTimer countDownTimer;
    private PowerManager.WakeLock screenWakeLock;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;

    private String currentRideId = "";
    private String currentDriverId = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 1. Force Screen ON & Display Over Other Apps / Lockscreen
        wakeAndUnlockScreen();

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_incoming_ride);

        extractIntentData(getIntent());
        setupUI();
        startAlertEffects();
        start15SecondTimer();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        wakeAndUnlockScreen();
        extractIntentData(intent);
        setupUI();
        start15SecondTimer();
    }

    private void wakeAndUnlockScreen() {
        Window window = getWindow();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) {
                km.requestDismissKeyguard(this, null);
            }
        }

        // Window Flags to display on top of YouTube, Games, and Lockscreen
        window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
                        WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD |
                        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON |
                        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON |
                        WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON
        );

        // Hardware Acceleration to prevent UI freezing behind YouTube
        window.setFlags(
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        );

        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                if (screenWakeLock != null && screenWakeLock.isHeld()) {
                    screenWakeLock.release();
                }
                screenWakeLock = pm.newWakeLock(
                        PowerManager.FULL_WAKE_LOCK |
                                PowerManager.ACQUIRE_CAUSES_WAKEUP |
                                PowerManager.ON_AFTER_RELEASE,
                        "67Cabs:IncomingRideOverlayWakeLock"
                );
                screenWakeLock.acquire(16000); // 16 seconds
            }
        } catch (Exception ignored) {}
    }

    private void extractIntentData(Intent intent) {
        if (intent != null) {
            currentRideId = intent.getStringExtra("rideId");
            currentDriverId = intent.getStringExtra("driverId");
        }
    }

    private void setupUI() {
        Intent intent = getIntent();
        String pickup = intent != null ? intent.getStringExtra("pickup") : null;
        String drop = intent != null ? intent.getStringExtra("drop") : null;
        String fare = intent != null ? intent.getStringExtra("fare") : null;

        TextView tvPickup = findViewById(R.id.tvPickup);
        TextView tvDrop = findViewById(R.id.tvDrop);
        TextView tvFare = findViewById(R.id.tvFare);
        Button btnAccept = findViewById(R.id.btnAccept);
        Button btnDecline = findViewById(R.id.btnDecline);

        if (tvPickup != null) tvPickup.setText(pickup != null && !pickup.isEmpty() ? pickup : "Pickup Location");
        if (tvDrop != null) tvDrop.setText(drop != null && !drop.isEmpty() ? drop : "Drop Destination");
        if (tvFare != null) tvFare.setText("₹" + (fare != null && !fare.isEmpty() ? fare : "0"));

        if (btnAccept != null) {
            btnAccept.setOnClickListener(v -> {
                sendRideDecisionToServer(true);
                dismissAlert();
                openDriverAppDashboard();
            });
        }

        if (btnDecline != null) {
            btnDecline.setOnClickListener(v -> {
                sendRideDecisionToServer(false);
                dismissAlert();
            });
        }
    }

    private void startAlertEffects() {
        // Mute YouTube/Background Audio & Focus on Ride Tone
        try {
            audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                            .setAudioAttributes(new AudioAttributes.Builder()
                                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                                    .build())
                            .build();
                    audioManager.requestAudioFocus(audioFocusRequest);
                } else {
                    audioManager.requestAudioFocus(null, AudioManager.STREAM_RING, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
                }
            }
        } catch (Exception ignored) {}

        // Sound Alert
        try {
            Uri alertSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringtone = RingtoneManager.getRingtone(getApplicationContext(), alertSound);
            if (ringtone != null) ringtone.play();
        } catch (Exception ignored) {}

        // Vibration Alert
        try {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(new long[]{0, 800, 400, 800}, 0));
                } else {
                    vibrator.vibrate(new long[]{0, 800, 400, 800}, 0);
                }
            }
        } catch (Exception ignored) {}
    }

    private void start15SecondTimer() {
        TextView tvTimer = findViewById(R.id.tvTimer);
        if (countDownTimer != null) countDownTimer.cancel();

        // 15 SECONDS STRICT AUTO TIMEOUT
        countDownTimer = new CountDownTimer(15000, 1000) {
            @Override
            public void onTick(long millisUntilFinished) {
                if (tvTimer != null) {
                    tvTimer.setText("Time Left: " + (millisUntilFinished / 1000) + "s");
                }
            }

            @Override
            public void onFinish() {
                dismissAlert();
            }
        }.start();
    }

    private void openDriverAppDashboard() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        intent.putExtra("rideId", currentRideId);
        startActivity(intent);
    }

    private void sendRideDecisionToServer(boolean isAccept) {
        new Thread(() -> {
            try {
                String endpoint = isAccept ? "/api/ride/accept-bg" : "/api/ride/decline";
                URL url = new URL("https://137.23.57.23.sslip.io" + endpoint);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setConnectTimeout(6000);
                conn.setReadTimeout(6000);
                conn.setDoOutput(true);

                JSONObject payload = new JSONObject();
                payload.put("rideId", currentRideId != null ? currentRideId : "");
                payload.put("driverId", currentDriverId != null ? currentDriverId : "");

                OutputStream os = conn.getOutputStream();
                os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                os.flush();
                os.close();

                conn.getResponseCode();
                conn.disconnect();
            } catch (Exception e) {
                e.printStackTrace();
            }
        }).start();
    }

    private void dismissAlert() {
        try {
            if (ringtone != null && ringtone.isPlaying()) ringtone.stop();
            if (vibrator != null) vibrator.cancel();
            if (countDownTimer != null) countDownTimer.cancel();
            if (screenWakeLock != null && screenWakeLock.isHeld()) screenWakeLock.release();

            if (audioManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                    audioManager.abandonAudioFocusRequest(audioFocusRequest);
                } else {
                    audioManager.abandonAudioFocus(null);
                }
            }
        } catch (Exception ignored) {}
        finish();
    }

    @Override
    protected void onDestroy() {
        dismissAlert();
        super.onDestroy();
    }
}