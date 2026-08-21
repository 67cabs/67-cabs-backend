package com.cabs67.driver;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CountDownTimer;
import android.os.Vibrator;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class IncomingRideActivity extends Activity {

    private Ringtone ringtone;
    private Vibrator vibrator;
    private CountDownTimer countDownTimer;
    private String currentRideId = "";
    private String currentDriverId = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Turn Screen ON and Display over Lockscreen / YouTube
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }

        getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
                        WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD |
                        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON |
                        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        );

        setContentView(R.layout.activity_incoming_ride);

        currentRideId = getIntent().getStringExtra("rideId");
        currentDriverId = getIntent().getStringExtra("driverId");
        String pickup = getIntent().getStringExtra("pickup");
        String drop = getIntent().getStringExtra("drop");
        String fare = getIntent().getStringExtra("fare");

        TextView tvPickup = findViewById(R.id.tvPickup);
        TextView tvDrop = findViewById(R.id.tvDrop);
        TextView tvFare = findViewById(R.id.tvFare);
        TextView tvTimer = findViewById(R.id.tvTimer);
        Button btnAccept = findViewById(R.id.btnAccept);
        Button btnDecline = findViewById(R.id.btnDecline);

        if (tvPickup != null) tvPickup.setText(pickup != null ? pickup : "Jaipur Pickup Point");
        if (tvDrop != null) tvDrop.setText(drop != null ? drop : "Drop Destination");
        if (tvFare != null) tvFare.setText("₹" + (fare != null ? fare : "0"));

        // Sound & Vibration Alert
        try {
            Uri alertSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringtone = RingtoneManager.getRingtone(getApplicationContext(), alertSound);
            if (ringtone != null) ringtone.play();
        } catch (Exception e) {}

        try {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null) vibrator.vibrate(new long[]{0, 800, 400, 800}, 0);
        } catch (Exception e) {}

        // 35 Seconds Timeout matching server dispatch window
        countDownTimer = new CountDownTimer(35000, 1000) {
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

    private void openDriverAppDashboard() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
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

                int code = conn.getResponseCode();
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
        } catch (Exception e) {}
        finish();
    }

    @Override
    protected void onDestroy() {
        dismissAlert();
        super.onDestroy();
    }
}