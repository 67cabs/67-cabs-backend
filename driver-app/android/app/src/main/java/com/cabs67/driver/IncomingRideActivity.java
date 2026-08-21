package com.cabs67.driver;

import android.app.Activity;
import android.content.Context;
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

public class IncomingRideActivity extends Activity {

    private Ringtone ringtone;
    private Vibrator vibrator;
    private CountDownTimer countDownTimer;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
                            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON |
                            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON |
                            WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            );
        }

        setContentView(R.layout.activity_incoming_ride);

        String rideId = getIntent().getStringExtra("rideId");
        String pickup = getIntent().getStringExtra("pickup");
        String drop = getIntent().getStringExtra("drop");
        String fare = getIntent().getStringExtra("fare");

        TextView tvPickup = findViewById(R.id.tvPickup);
        TextView tvDrop = findViewById(R.id.tvDrop);
        TextView tvFare = findViewById(R.id.tvFare);
        TextView tvTimer = findViewById(R.id.tvTimer);
        Button btnAccept = findViewById(R.id.btnAccept);
        Button btnDecline = findViewById(R.id.btnDecline);

        tvPickup.setText("Pickup: " + (pickup != null ? pickup : "N/A"));
        tvDrop.setText("Drop: " + (drop != null ? drop : "N/A"));
        tvFare.setText("₹" + (fare != null ? fare : "0"));

        Uri alertSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        ringtone = RingtoneManager.getRingtone(getApplicationContext(), alertSound);
        if (ringtone != null) ringtone.play();

        vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (vibrator != null) vibrator.vibrate(new long[]{0, 1000, 1000}, 0);

        countDownTimer = new CountDownTimer(15000, 1000) {
            @Override
            public void onTick(long millisUntilFinished) {
                tvTimer.setText("Accept in: " + (millisUntilFinished / 1000) + "s");
            }

            @Override
            public void onFinish() {
                dismissAlert();
            }
        }.start();

        btnAccept.setOnClickListener(v -> {
            dismissAlert();
            Toast.makeText(this, "Ride Accepted!", Toast.LENGTH_SHORT).show();
        });

        btnDecline.setOnClickListener(v -> {
            dismissAlert();
        });
    }

    private void dismissAlert() {
        if (ringtone != null && ringtone.isPlaying()) ringtone.stop();
        if (vibrator != null) vibrator.cancel();
        if (countDownTimer != null) countDownTimer.cancel();
        finish();
    }
}