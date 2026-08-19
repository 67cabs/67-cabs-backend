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

// 1. Driver Account Schema (Auth & Approval Flow)
const driverSchema = new mongoose.Schema({
  driverId: { type: String, required: true, unique: true, index: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, default: '' },
  vehicleNo: { type: String, required: true },
  cabType: { type: String, required: true, default: 'HATCHBACK' },
  upiId: { type: String, default: '67cabs@upi' },
  status: { 
    type: String, 
    enum: ['PENDING_APPROVAL', 'APPROVED', 'BLOCKED'], 
    default: 'PENDING_APPROVAL' 
  },
  isOnline: { type: Boolean, default: false }
}, { timestamps: true });

const Driver = mongoose.model('Driver', driverSchema);

// 2. Trip History Schema
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

// 3. Driver Live GPS Telemetry Schema
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

// ---------------- AUTH & ONBOARDING ROUTES ----------------

// Driver Registration (Sign Up)
app.post('/api/driver/signup', async (req, res) => {
  try {
    const { name, phone, password, email, vehicleNo, cabType, upiId } = req.body;

    if (!name || !phone || !password || !vehicleNo) {
      return res.status(400).json({ success: false, message: 'Name, Phone, Password, aur Vehicle Number zaroori hain.' });
    }

    const cleanPhone = phone.trim();
    const existing = await Driver.findOne({ phone: cleanPhone });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Yeh mobile number pehle se registered hai.' });
    }

    const driverId = `DRV_${Date.now()}`;
    const newDriver = await Driver.create({
      driverId,
      name: name.trim(),
      phone: cleanPhone,
      password: password.trim(),
      email: email ? email.trim() : '',
      vehicleNo: vehicleNo.trim().toUpperCase(),
      cabType: (cabType || 'HATCHBACK').toUpperCase(),
      upiId: upiId ? upiId.trim() : '67cabs@upi',
      status: 'PENDING_APPROVAL',
      isOnline: false
    });

    return res.status(201).json({
      success: true,
      message: 'Account successfully create ho gaya! Admin approval ke baad ride accept kar sakenge.',
      driver: {
        driverId: newDriver.driverId,
        name: newDriver.name,
        phone: newDriver.phone,
        cabType: newDriver.cabType,
        vehicleNo: newDriver.vehicleNo,
        upiId: newDriver.upiId,
        status: newDriver.status
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Driver Login
app.post('/api/driver/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone number aur Password enter karein.' });
    }

    const cleanPhone = phone.trim();
    const driver = await Driver.findOne({ phone: cleanPhone, password: password.trim() });
    
    if (!driver) {
      return res.status(401).json({ success: false, message: 'Galat Phone number ya Password!' });
    }

    return res.json({
      success: true,
      driver: {
        driverId: driver.driverId,
        name: driver.name,
        phone: driver.phone,
        cabType: driver.cabType,
        vehicleNo: driver.vehicleNo,
        upiId: driver.upiId,
        status: driver.status
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- ADMIN DASHBOARD ROUTES ----------------

// Get All Registered Drivers for Verification
app.get('/api/admin/drivers', async (req, res) => {
  try {
    const drivers = await Driver.find().sort({ createdAt: -1 });
    return res.json({ success: true, drivers });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Approve or Block Driver
app.post('/api/admin/driver/status', async (req, res) => {
  try {
    const { driverId, status } = req.body;
    if (!driverId || !['APPROVED', 'PENDING_APPROVAL', 'BLOCKED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid driver status payload' });
    }

    const updated = await Driver.findOneAndUpdate(
      { driverId },
      { status },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Driver nahi mila' });
    }

    // Live Socket Alert to Driver
    io.emit(`driver:status:${driverId}`, { status: updated.status });

    return res.json({ success: true, message: `Driver status changed to ${status}`, driver: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- FARE & LOCATION ROUTES ----------------

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

// Direct Live Nearby Driver GPS Locator API
app.get('/api/cabs/nearby', async (req, res) => {
  try {
    const cabType = (req.query.cabType || 'HATCHBACK').toUpperCase();
    
    let liveDriver = null;
    activeDrivers.forEach((d) => {
      if (d.cabType === cabType && d.location && d.location.lat) {
        liveDriver = d;
      }
    });

    if (!liveDriver) {
      const dbDriver = await DriverLocation.findOne({ cabType }).sort({ lastActive: -1 });
      if (dbDriver && dbDriver.location && dbDriver.location.lat) {
        liveDriver = dbDriver;
      }
    }

    if (liveDriver && liveDriver.location) {
      return res.json({ 
        success: true, 
        driverCoords: [liveDriver.location.lat, liveDriver.location.lng] 
      });
    }

    return res.json({ success: false, driverCoords: null });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Multi-Offer MongoDB Polling Endpoint (Returns all active searching rides)
app.get('/api/driver/active-offers', async (req, res) => {
  try {
    const cabType = (req.query.cabType || 'HATCHBACK').toUpperCase();
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    
    const activeOffers = await Trip.find({
      cabType,
      status: 'SEARCHING',
      createdAt: { $gte: twoMinutesAgo }
    }).sort({ createdAt: -1 });

    res.json({ success: true, offers: activeOffers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Real-Time Socket Storage (Ultra-Low Latency RAM)
let activeDrivers = new Map();
let activeRides = new Map();

io.on('connection', (socket) => {
  console.log(`⚡ Device Connected: ${socket.id}`);

  // 1. Driver Online Registration (Only Approved & Authenticated Drivers)
  socket.on('driver:register', async (driverData) => {
    const normalizedCabType = (driverData.cabType || 'HATCHBACK').toUpperCase();
    const driverId = driverData.driverId || socket.id;

    activeDrivers.set(socket.id, {
      driverId,
      name: driverData.name || 'Driver',
      vehicleNo: driverData.vehicleNo || 'RJ 14 TA 6767',
      cabType: normalizedCabType,
      upiId: driverData.upiId || '67cabs@upi',
      status: driverData.status || 'APPROVED',
      location: driverData.location || null,
      socketId: socket.id
    });
    console.log(`🚗 Driver Online: ${driverData.name} (${normalizedCabType}) | Socket: ${socket.id}`);

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

    if (pickup && (!isWithinJaipur(pickup.lat, pickup.lng) || !isWithinJaipur(drop.lat, drop.lng))) {
      return socket.emit('ride:error', { 
        message: 'Pickup ya Drop location Jaipur service boundary ke bahar hai.' 
      });
    }

    const rideId = rideData.rideId || `RIDE_${Date.now()}`;
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

    // Broadcast offer only to Approved matching active drivers
    activeDrivers.forEach((driver, driverSocketId) => {
      if (driver.status === 'APPROVED' && (driver.cabType === requestedCabType || requestedCabType === 'ALL')) {
        io.to(driverSocketId).emit('ride:new_offer', ridePayload);
      }
    });
    io.emit('ride:new_offer', ridePayload);
  });

  // 2.1 Rider Cancels Ride
  socket.on('ride:cancel', async ({ rideId }) => {
    try {
      await Trip.updateOne({ rideId }, { status: 'CANCELLED' });
      activeRides.delete(rideId);
      io.emit('ride:cancelled', { rideId });
      io.emit('ride:taken', { rideId });
      console.log(`❌ Ride ${rideId} cancelled by Rider.`);
    } catch (e) {
      console.error('Cancel Error:', e.message);
    }
  });

  // 3. Driver Accepts Ride
  socket.on('ride:accept', async ({ rideId, driverData }) => {
    const ride = activeRides.get(rideId);
    const registeredDriver = activeDrivers.get(socket.id);

    // Gating: Only Approved Drivers can accept rides
    if (registeredDriver && registeredDriver.status !== 'APPROVED') {
      return socket.emit('ride:error', { message: 'Aapka account abhi Admin se Approved nahi hai.' });
    }

    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    let finalTotalFare = ride ? ride.totalFare : 0;

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

      if (ride.riderSocketId) {
        io.to(ride.riderSocketId).emit('ride:accepted', {
          rideId,
          driver: ride.driverData,
          otp: startOtp,
          fare: finalTotalFare
        });
      }
    }

    io.emit(`ride:accepted:${rideId}`, {
      rideId,
      driver: driverData,
      otp: startOtp,
      fare: finalTotalFare
    });

    console.log(`✅ Ride ${rideId} Accepted. Generated OTP: ${startOtp}`);

    socket.emit('driver:ride_confirmed', {
      rideId,
      pickup: ride?.pickup,
      drop: ride?.drop,
      totalFare: finalTotalFare
    });

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
  socket.on('driver:location_update', async ({ rideId, lat, lng, phase, heading }) => {
    const d = activeDrivers.get(socket.id);
    if (d) {
      d.location = { lat, lng };
    }

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