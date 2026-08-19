const dns = require('dns');
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (e) {
  // Fallback to system default DNS
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const { calculateMasterFare } = require('./utils/fareCalculator');

const app = express();
const server = http.createServer(app);

// Socket.io for Real-time Cabs & Alerts (Optimized for HTTPS/Nginx)
const io = new Server(server, {
  cors: { 
    origin: '*', 
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// MongoDB Atlas High-Performance Connection
const MONGO_URI = process.env.MONGO_URI;
if (MONGO_URI) {
  mongoose.connect(MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 15000,
    tls: true,
    tlsAllowInvalidCertificates: true
  })
  .then(() => console.log('🍃 MongoDB Atlas Connected (67-CABS Production)'))
  .catch((err) => {
    console.error('❌ MongoDB Connection Error:', err.message);
    console.warn('⚡ Server running in RAM Cache mode. Real-time rides remain active.');
  });
} else {
  console.warn('⚠️ MONGO_URI not found in .env. Running memory-only mode.');
}

// Trip History Schema
const tripSchema = new mongoose.Schema({
  rideId: { type: String, required: true, unique: true, index: true },
  cabType: { type: String, required: true },
  pickup: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  drop: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  totalFare: { type: Number, required: true },
  driverData: {
    name: String,
    vehicleNo: String,
    phone: String,
    upiId: String
  },
  otp: String,
  status: { 
    type: String, 
    enum: ['SEARCHING', 'ACCEPTED', 'ARRIVED', 'ONGOING', 'COMPLETED', 'CANCELLED'], 
    default: 'SEARCHING' 
  },
  startTime: Date,
  endTime: Date
}, { timestamps: true });

const Trip = mongoose.model('Trip', tripSchema);

// Jaipur Geofencing Boundary Coordinates
const JAIPUR_BBOX = {
  minLat: 26.6500,
  maxLat: 27.1500,
  minLng: 75.6000,
  maxLng: 76.1000
};
const MAX_TRIP_DISTANCE_KM = 80;

function isWithinJaipur(lat, lng) {
  return (
    lat >= JAIPUR_BBOX.minLat &&
    lat <= JAIPUR_BBOX.maxLat &&
    lng >= JAIPUR_BBOX.minLng &&
    lng <= JAIPUR_BBOX.maxLng
  );
}

// Fare Calculation API Route with Validation
app.post('/api/fare/estimate', (req, res) => {
  try {
    const { tripDistanceKm, tripTrafficMins, pickupDistanceKm, pickupTrafficMins, cabType } = req.body;

    if (!tripDistanceKm || !tripTrafficMins) {
      return res.status(400).json({ success: false, message: 'Trip metrics required' });
    }

    if (Number(tripDistanceKm) > MAX_TRIP_DISTANCE_KM) {
      return res.status(400).json({ 
        success: false, 
        message: `Trip distance exceeds maximum Jaipur limit of ${MAX_TRIP_DISTANCE_KM} km.` 
      });
    }

    const fareData = calculateMasterFare({
      tripDistanceKm: Number(tripDistanceKm),
      tripTrafficMins: Number(tripTrafficMins),
      pickupDistanceKm: Number(pickupDistanceKm || 0),
      pickupTrafficMins: Number(pickupTrafficMins || 0),
      cabType: cabType ? cabType.toUpperCase() : 'HATCHBACK'
    });

    return res.status(200).json({ success: true, data: fareData });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Real-Time Socket Storage (Ultra-Low Latency RAM)
let activeDrivers = new Map();
let activeRides = new Map();

io.on('connection', (socket) => {
  console.log(`⚡ Device Connected: ${socket.id}`);

  // 1. Driver Online Registration
  socket.on('driver:register', (driverData) => {
    const normalizedCabType = (driverData.cabType || 'HATCHBACK').toUpperCase();
    activeDrivers.set(socket.id, {
      driverId: driverData.driverId || socket.id,
      name: driverData.name || 'Driver',
      vehicleNo: driverData.vehicleNo || 'RJ 14 TA 6767',
      cabType: normalizedCabType,
      upiId: driverData.upiId || '67cabs@upi',
      socketId: socket.id
    });
    console.log(`🚗 Driver Online: ${driverData.name} (${normalizedCabType}) | Socket: ${socket.id}`);
  });

  // 2. Rider Requests Cab with Geofence Verification
  socket.on('ride:request', async (rideData) => {
    const { pickup, drop, cabType, totalFare } = rideData;
    const requestedCabType = (cabType || 'HATCHBACK').toUpperCase();

    // Backend Geofence Validation
    if (pickup && (!isWithinJaipur(pickup.lat, pickup.lng) || !isWithinJaipur(drop.lat, drop.lng))) {
      return socket.emit('ride:error', { 
        message: 'Pickup ya Drop location Jaipur service boundary ke bahar hai.' 
      });
    }

    const rideId = `RIDE_${Date.now()}`;
    const ridePayload = { 
      ...rideData, 
      cabType: requestedCabType,
      rideId, 
      riderSocketId: socket.id, 
      status: 'SEARCHING' 
    };
    activeRides.set(rideId, ridePayload);

    console.log(`📍 67 Cabs Request: ${rideId} for ${requestedCabType}`);

    // Instant Mongo Atlas Log (SEARCHING state)
    try {
      await Trip.create({
        rideId,
        cabType: requestedCabType,
        pickup,
        drop,
        totalFare: Number(totalFare) || 0,
        status: 'SEARCHING',
        startTime: new Date()
      });
      console.log(`💾 Live Ride ${rideId} persisted in MongoDB (SEARCHING).`);
    } catch (dbErr) {
      console.error(`⚠️ Initial DB Save Error for ${rideId}:`, dbErr.message);
    }

    // Broadcast offer to matching online cabs (or all online if any)
    let dispatchedCount = 0;
    activeDrivers.forEach((driver, driverSocketId) => {
      if (driver.cabType === requestedCabType || requestedCabType === 'ALL') {
        io.to(driverSocketId).emit('ride:new_offer', ridePayload);
        dispatchedCount++;
      }
    });

    console.log(`📡 Offer dispatched to ${dispatchedCount} active driver(s).`);
  });

  // 3. Driver Accepts Ride
  socket.on('ride:accept', async ({ rideId, driverData }) => {
    const ride = activeRides.get(rideId);
    if (!ride || ride.status !== 'SEARCHING') {
      return socket.emit('ride:error', { message: 'Ride already accepted or expired' });
    }

    const registeredDriver = activeDrivers.get(socket.id);
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();

    ride.status = 'ACCEPTED';
    ride.driverSocketId = socket.id;
    ride.driverData = {
      ...driverData,
      upiId: registeredDriver ? registeredDriver.upiId : '67cabs@upi'
    };
    ride.otp = startOtp;
    activeRides.set(rideId, ride);

    console.log(`✅ Ride ${rideId} Accepted. Generated OTP: ${startOtp}`);

    // MongoDB Update to ACCEPTED
    try {
      await Trip.updateOne(
        { rideId }, 
        { 
          status: 'ACCEPTED', 
          driverData: ride.driverData, 
          otp: startOtp 
        }
      );
    } catch (e) {
      console.error('DB Update Error (ACCEPTED):', e.message);
    }

    // Rider ko Driver Details aur OTP bhejo
    io.to(ride.riderSocketId).emit('ride:accepted', {
      rideId,
      driver: ride.driverData,
      otp: startOtp,
      fare: ride.totalFare
    });

    // Driver ko confirmation do
    socket.emit('driver:ride_confirmed', {
      rideId,
      pickup: ride.pickup,
      drop: ride.drop,
      totalFare: ride.totalFare
    });

    // Baaki drivers ki screen se offer hata do
    socket.broadcast.emit('ride:taken', { rideId });
  });

  // 3.1 Driver Arrived at Pickup Point Notification Trigger
  socket.on('driver:arrived', ({ rideId }) => {
    const ride = activeRides.get(rideId);
    if (ride && ride.riderSocketId) {
      ride.status = 'ARRIVED';
      activeRides.set(rideId, ride);
      console.log(`🔔 Driver Arrived at Pickup for Ride: ${rideId}`);
      io.to(ride.riderSocketId).emit('ride:driver_arrived', { 
        message: '🚖 Aapki 67 Cab Pickup Location par pahunch chuki hai!' 
      });
    }
  });

  // 3.2 Live Driver GPS Telemetry Stream (Pickup & Drop Route Sync)
  socket.on('driver:location_update', ({ rideId, lat, lng, phase, heading }) => {
    const ride = activeRides.get(rideId);
    if (ride && ride.riderSocketId) {
      io.to(ride.riderSocketId).emit('driver:location_broadcast', {
        lat,
        lng,
        phase: phase || 'TO_PICKUP',
        heading: heading || 0
      });
    }
  });

  // 4. Driver Verifies OTP to Start Trip
  socket.on('ride:verify_otp', async ({ rideId, enteredOtp }) => {
    const ride = activeRides.get(rideId);

    if (!ride) {
      return socket.emit('ride:error', { message: 'Trip session not found' });
    }

    if (ride.otp === enteredOtp.trim()) {
      ride.status = 'ONGOING';
      ride.startTime = new Date();
      activeRides.set(rideId, ride);

      console.log(`🚀 Trip ${rideId} Started Successfully!`);

      try {
        await Trip.updateOne({ rideId }, { status: 'ONGOING', startTime: ride.startTime });
      } catch (e) {
        console.error('DB Update Error (ONGOING):', e.message);
      }

      io.to(ride.riderSocketId).emit('ride:started', { rideId });
      socket.emit('ride:started_driver_view', { rideId });
    } else {
      socket.emit('ride:otp_invalid', { message: 'Galat OTP! Kripya Rider se pooch kar sahi 4-digit OTP dalein.' });
    }
  });

  // 5. Driver Completes Trip & Triggers Payment Screen
  socket.on('ride:complete', async ({ rideId }) => {
    const ride = activeRides.get(rideId);

    if (ride) {
      ride.status = 'COMPLETED';
      ride.endTime = new Date();

      console.log(`🏁 Trip ${rideId} Completed. Total Fare: ₹${ride.totalFare}`);

      const completionPayload = {
        rideId,
        finalFare: ride.totalFare,
        driverUpiId: ride.driverData?.upiId || '67cabs@upi'
      };

      // Realtime settlement emit to UI
      io.to(ride.riderSocketId).emit('ride:completed', completionPayload);
      socket.emit('ride:completed', completionPayload);

      // Async DB Persistence
      try {
        await Trip.findOneAndUpdate(
          { rideId: ride.rideId },
          {
            cabType: ride.cabType,
            pickup: ride.pickup,
            drop: ride.drop,
            totalFare: ride.totalFare,
            driverData: ride.driverData,
            otp: ride.otp,
            status: 'COMPLETED',
            endTime: ride.endTime
          },
          { upsert: true, new: true }
        );
        console.log(`💾 Trip ${rideId} successfully updated to COMPLETED in MongoDB Atlas.`);
      } catch (dbErr) {
        console.error(`⚠️ MongoDB Log Error for ${rideId}:`, dbErr.message);
      }

      // RAM Cleanup
      activeRides.delete(rideId);
    }
  });

  // Handle Disconnect
  socket.on('disconnect', () => {
    activeDrivers.delete(socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚖 67 Cabs Server live on http://localhost:${PORT}`);
});