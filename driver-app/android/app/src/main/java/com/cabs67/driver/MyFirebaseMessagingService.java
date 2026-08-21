package com.cabs67.driver;

import android.content.Intent;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class MyFirebaseMessagingService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        if (remoteMessage.getData().size() > 0) {
            Map<String, String> data = remoteMessage.getData();
            String type = data.get("type");

            if ("NEW_RIDE_REQUEST".equals(type)) {
                Intent intent = new Intent(this, IncomingRideActivity.class);
                intent.putExtra("rideId", data.get("rideId"));
                intent.putExtra("pickup", data.get("pickupLocation"));
                intent.putExtra("drop", data.get("dropLocation"));
                intent.putExtra("fare", data.get("fare"));
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

                startActivity(intent);
            }
        }
    }
}