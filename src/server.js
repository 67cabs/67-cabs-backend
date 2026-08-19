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
    maxPoolSize: 20,
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

// Driver Location Schema for Real-time DB GPS Tracking
const driverLocationSchema = new mongoose.Schema({
  driverId: { type: String, required: true, unique: true },
  name: String,
  cabType: String,
  location: {
    lat: Number,
    lng: Number
  },
  lastActive: { type: Date, default: Date.now }
});
const DriverLocation = mongoose.model('DriverLocation', driverLocationSchema);

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

// Direct MongoDB Active Offers Polling Endpoint (Cluster-Safe)
app.get('/api/driver/active-offers', async (req, res) => {
  try {
    const cabType = (req.query.cabType || 'HATCHBACK').toUpperCase();
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    
    const activeOffer = await Trip.findOne({
      cabType,
      status: 'SEARCHING',
      createdAt: { $gte: twoMinutesAgo }
    }).sort({ createdAt: -1 });

    res.json({ success: true, offer: activeOffer });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Real-Time Socket Storage (Ultra-Low Latency RAM)
let activeDrivers = new Map();
let activeRides = new Map();

io.on('connection', (socket) => {
  console.log(`⚡ Device Connected: ${socket.id}`);

  // 1. Driver Online Registration
  socket.on('driver:register', async (driverData) => {
    const normalizedCabType = (driverData.cabType || 'HATCHBACK').toUpperCase();
    const driverId = driverData.driverId || socket.id;

    activeDrivers.set(socket.id, {
      driverId,
      name: driverData.name || 'Driver',
      vehicleNo: driverData.vehicleNo || 'RJ 14 TA 6767',
      cabType: normalizedCabType,
      upiId: driverData.upiId || '67cabs@upi',
      socketId: socket.id
    });
    console.log(`🚗 Driver Online: ${driverData.name} (${normalizedCabType}) | Socket: ${socket.id}`);

    // Update Driver's GPS in MongoDB if available
    if (driverData.location && driverData.location.lat) {
      try {
        await DriverLocation.findOneAndUpdate(
          { driverId },
          {
            name: driverData.name || 'Driver',
            cabType: normalizedCabType,
            location: { lat: driverData.location.lat, lng: driverData.location.lng },
            lastActive: new Date()
          },
          { upsert: true }
        );
      } catch (e) {}
    }
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
      status: 'SEARCHING',
      startTime: new Date()
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

    // Broadcast offer to matching drivers and via global room
    activeDrivers.forEach((driver, driverSocketId) => {
      if (driver.cabType === requestedCabType || requestedCabType === 'ALL') {
        io.to(driverSocketId).emit('ride:new_offer', ridePayload);
      }
    });
    io.emit('ride:new_offer', ridePayload);
  });

  // 3. Driver Accepts Ride
  socket.on('ride:accept', async ({ rideId, driverData }) => {
    const ride = activeRides.get(rideId);
    const registeredDriver = activeDrivers.get(socket.id);
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();

    let finalTotalFare = ride ? ride.totalFare : 0;

    // MongoDB Update to ACCEPTED
    try {
      const updatedTrip = await Trip.findOneAndUpdate(
        { rideId, status: 'SEARCHING' },
        { 
          status: 'ACCEPTED', 
          driverData: {
            ...driverData,
            upiId: registeredDriver ? registeredDriver.upiId : (driverData?.upiId || '67cabs@upi')
          }, 
          otp: startOtp 
        },
        { new: true }
      );
      if (updatedTrip) {
        finalTotalFare = updatedTrip.totalFare;
      }
    } catch (e) {
      console.error('DB Update Error (ACCEPTED):', e.message);
    }

    if (ride) {
      ride.status = 'ACCEPTED';
      ride.driverSocketId = socket.id;
      ride.driverData = {
        ...driverData,
        upiId: registeredDriver ? registeredDriver.upiId : '67cabs@upi'
      };
      ride.otp = startOtp;
      activeRides.set(rideId, ride);

      // Specific Rider Emit
      if (ride.riderSocketId) {
        io.to(ride.riderSocketId).emit('ride:accepted', {
          rideId,
          driver: ride.driverData,
          otp: startOtp,
          fare: finalTotalFare
        });
      }
    }

    // Global Rider Room Broadcast fallback
    io.emit(`ride:accepted:${rideId}`, {
      rideId,
      driver: driverData,
      otp: startOtp,
      fare: finalTotalFare
    });

    console.log(`✅ Ride ${rideId} Accepted. Generated OTP: ${startOtp}`);

    // Driver confirmation
    socket.emit('driver:ride_confirmed', {
      rideId,
      pickup: ride?.pickup,
      drop: ride?.drop,
      totalFare: finalTotalFare
    });

    // Broadcast dismiss to other drivers
    socket.broadcast.emit('ride:taken', { rideId });
    io.emit('ride:taken', { rideId });
  });

  // 3.1 Driver Arrived at Pickup Point Notification Trigger
  socket.on('driver:arrived', async ({ rideId }) => {
    const ride = activeRides.get(rideId);
    if (ride) {
      ride.status = 'ARRIVED';
      activeRides.set(rideId, ride);
      if (ride.riderSocketId) {
        io.to(ride.riderSocketId).emit('ride:driver_arrived', { 
          message: '🚖 Aapki 67 Cab Pickup Location par pahunch chuki hai!' 
        });
      }
    }
    io.emit(`ride:driver_arrived:${rideId}`, {
      message: '🚖 Aapki 67 Cab Pickup Location par pahunch chuki hai!'
    });
    console.log(`🔔 Driver Arrived at Pickup for Ride: ${rideId}`);
  });

  // 3.2 Live Driver GPS Telemetry Stream (Pickup & Drop Route Sync)
  socket.on('driver:location_update', ({ rideId, lat, lng, phase, heading }) => {
    const ride = activeRides.get(rideId);
    const telemetryPayload = {
      lat,
      lng,
      phase: phase || 'TO_PICKUP',
      heading: heading || 0
    };
    if (ride && ride.riderSocketId) {
      io.to(ride.riderSocketId).emit('driver:location_broadcast', telemetryPayload);
    }
    io.emit(`driver:location_broadcast:${rideId}`, telemetryPayload);
  });

  // 4. Driver Verifies OTP to Start Trip
  socket.on('ride:verify_otp', async ({ rideId, enteredOtp }) => {
    const trip = await Trip.findOne({ rideId });
    const ride = activeRides.get(rideId);

    const validOtp = trip ? trip.otp : (ride ? ride.otp : null);

    if (!validOtp) {
      return socket.emit('ride:error', { message: 'Trip session not found' });
    }

    if (validOtp === enteredOtp.trim()) {
      const now = new Date();
      if (ride) {
        ride.status = 'ONGOING';
        ride.startTime = now;
        activeRides.set(rideId, ride);
        if (ride.riderSocketId) {
          io.to(ride.riderSocketId).emit('ride:started', { rideId });
        }
      }

      try {
        await Trip.updateOne({ rideId }, { status: 'ONGOING', startTime: now });
      } catch (e) {
        console.error('DB Update Error (ONGOING):', e.message);
      }

      console.log(`🚀 Trip ${rideId} Started Successfully!`);
      io.emit(`ride:started:${rideId}`, { rideId });
      socket.emit('ride:started_driver_view', { rideId });
    } else {
      socket.emit('ride:otp_invalid', { message: 'Galat OTP! Kripya Rider se pooch kar sahi 4-digit OTP dalein.' });
    }
  });

  // 5. Driver Completes Trip & Triggers Payment Screen
  socket.on('ride:complete', async ({ rideId }) => {
    const ride = activeRides.get(rideId);
    let finalFare = ride ? ride.totalFare : 0;
    let upiId = ride?.driverData?.upiId || '67cabs@upi';

    try {
      const completedTrip = await Trip.findOneAndUpdate(
        { rideId },
        { status: 'COMPLETED', endTime: new Date() },
        { new: true }
      );
      if (completedTrip) {
        finalFare = completedTrip.totalFare;
        upiId = completedTrip.driverData?.upiId || upiId;
      }
      console.log(`💾 Trip ${rideId} successfully updated to COMPLETED in MongoDB Atlas.`);
    } catch (dbErr) {
      console.error(`⚠️ MongoDB Log Error for ${rideId}:`, dbErr.message);
    }

    const completionPayload = {
      rideId,
      finalFare,
      driverUpiId: upiId
    };

    if (ride && ride.riderSocketId) {
      io.to(ride.riderSocketId).emit('ride:completed', completionPayload);
    }
    io.emit(`ride:completed:${rideId}`, completionPayload);
    socket.emit('ride:completed', completionPayload);

    activeRides.delete(rideId);
    console.log(`🏁 Trip ${rideId} Completed. Total Fare: ₹${finalFare}`);
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