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
const webpush = require('web-push');
require('dotenv').config();

const { calculateMasterFare } = require('./utils/fareCalculator');

// ---------------- WEB PUSH VAPID CONFIGURATION ----------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BEj6z8VwcEmB5cjLwMwFLyWMu7CBGP0LyuTyZK_8TihbQYnKxVs4yJZAz0kLUKPDEAcYbArHtfSf5_C1BKHT6b8';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '17eHNw7Rf8YGkYorXkWpre_vAVTAtsZ4oTjGXGmW2hE';

webpush.setVapidDetails(
  'mailto:support@67cabs.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
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

// Phone Sanitizer Helper: Extracts clean 10-digit number
function sanitizePhone(phone) {
  if (!phone) return '';
  let cleaned = phone.toString().replace(/\D/g, '');
  if (cleaned.length > 10) {
    cleaned = cleaned.slice(-10);
  }
  return cleaned;
}

// 1. Driver Account Schema
const driverSchema = new mongoose.Schema({
  driverId: { type: String, required: true, unique: true, index: true },
  phone: { type: String, required: true, index: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, default: '' },
  vehicleNo: { type: String, required: true },
  cabType: { type: String, required: true, default: 'HATCHBACK' },
  upiId: { type: String, default: '67cabs@upi' },
  referralCode: { type: String, default: '' },
  walletBalance: { type: Number, default: 0 },
  bonusFreeRides: { type: Number, default: 0 },
  rating: { type: Number, default: 5.0 },
  totalRatingsCount: { type: Number, default: 1 },
  isFirstTripRewardClaimed: { type: Boolean, default: false },
  documents: {
    selfiePhoto: { type: String, default: '' },
    drivingLicenseFront: { type: String, default: '' },
    drivingLicenseBack: { type: String, default: '' },
    vehicleRc: { type: String, default: '' },
    vehicleFitness: { type: String, default: '' },
    vehiclePermit: { type: String, default: '' },
    permitAuthorization: { type: String, default: '' },
    aadhaarCardFront: { type: String, default: '' },
    aadhaarCardBack: { type: String, default: '' },
    panCard: { type: String, default: '' },
    bankPassbook: { type: String, default: '' },
    additionalDocName: { type: String, default: '' },
    additionalDocImage: { type: String, default: '' }
  },
  status: { 
    type: String, 
    enum: ['PENDING_APPROVAL', 'APPROVED', 'BLOCKED', 'ADDITIONAL_DOC_REQUIRED', 'SUSPENDED', 'NEEDS_KYC'], 
    default: 'PENDING_APPROVAL' 
  },
  isOnline: { type: Boolean, default: false }
}, { timestamps: true });

const Driver = mongoose.model('Driver', driverSchema);

// 2. Rider Account Schema
const riderSchema = new mongoose.Schema({
  riderId: { type: String, required: true, unique: true, index: true },
  phone: { type: String, required: true, index: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  referralCode: { type: String, default: '' },
  govIdNumber: { type: String, default: '' },
  documents: {
    govIdFront: { type: String, default: '' },
    govIdBack: { type: String, default: '' }
  },
  walletBalance: { type: Number, default: 0 },
  bonusFreeRides: { type: Number, default: 0 },
  isFirstTripRewardClaimed: { type: Boolean, default: false },
  isKycDone: { type: Boolean, default: false },
  status: { 
    type: String, 
    enum: ['ACTIVE', 'PENDING_KYC', 'BLOCKED'], 
    default: 'ACTIVE' 
  }
}, { timestamps: true });

const Rider = mongoose.model('Rider', riderSchema);

// 3. Audit Trail Schema
const driverAuditSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  vehicleNo: { type: String, required: true, index: true },
  name: String,
  reason: { type: String, default: 'Policy violation or Admin suspension' },
  suspendedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const DriverAudit = mongoose.model('DriverAudit', driverAuditSchema);

// 4. Trip History Schema (Ratings, Fares & Settlement Persistence in MongoDB)
const tripSchema = new mongoose.Schema({
  rideId: { type: String, required: true, unique: true, index: true },
  cabType: { type: String, required: true },
  pickup: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  drop: {
    lat: { type: Number },
    lng: { type: Number }
  },
  stops: [{
    lat: Number,
    lng: Number,
    text: String
  }],
  totalDistanceKm: { type: Number, default: 0 },
  totalFare: { type: Number, required: true },
  finalFare: { type: Number },
  driverData: {
    driverId: String,
    name: String,
    vehicleNo: String,
    phone: String,
    upiId: String
  },
  riderData: {
    name: String,
    phone: String,
    govIdNumber: String
  },
  otp: String,
  earlyDropOtp: String,
  isEarlyDrop: { type: Boolean, default: false },
  earlyDropReason: String,
  rating: { type: Number, default: 5 },
  status: { 
    type: String, 
    enum: ['SEARCHING', 'ACCEPTED', 'ARRIVED', 'ONGOING', 'COMPLETED', 'CANCELLED'], 
    default: 'SEARCHING' 
  },
  isRiderDismissed: { type: Boolean, default: false },
  isDriverDismissed: { type: Boolean, default: false },
  startTime: Date,
  endTime: Date
}, { timestamps: true });

const Trip = mongoose.model('Trip', tripSchema);

// 5. Driver Live GPS Telemetry Schema
const driverLocationSchema = new mongoose.Schema({
  driverId: { type: String, required: true, unique: true },
  name: String,
  cabType: String,
  vehicleNo: String,
  location: {
    lat: Number,
    lng: Number
  },
  isOnline: { type: Boolean, default: true },
  lastActive: { type: Date, default: Date.now }
});
const DriverLocation = mongoose.model('DriverLocation', driverLocationSchema);

// 6. Dedicated & Public Recharge Coupon Schema
const couponSchema = new mongoose.Schema({
  code: { 
    type: String, 
    required: true, 
    unique: true, 
    uppercase: true, 
    trim: true 
  },
  description: { 
    type: String, 
    default: '' 
  },
  discountType: { 
    type: String, 
    enum: ['PERCENTAGE', 'FLAT'], 
    required: true 
  },
  discountValue: { 
    type: Number, 
    required: true, 
    min: 0 
  },
  maxDiscountAmount: { 
    type: Number, 
    default: null 
  },
  minRechargeAmount: { 
    type: Number, 
    default: 0 
  },
  targetType: { 
    type: String, 
    enum: ['ALL', 'SPECIFIC'], 
    default: 'ALL' 
  },
  allowedDrivers: [{ 
    type: String, 
    trim: true 
  }],
  usageLimitPerDriver: { 
    type: Number, 
    default: 1 
  },
  usedBy: [{
    driverId: { type: String, required: true },
    usedAt: { type: Date, default: Date.now }
  }],
  startDate: { 
    type: Date, 
    default: Date.now 
  },
  expiryDate: { 
    type: Date, 
    required: true 
  },
  isActive: { 
    type: Boolean, 
    default: true 
  }
}, { timestamps: true });

const Coupon = mongoose.model('Coupon', couponSchema);

// 7. Driver Web Push Subscriptions Schema
const driverPushSubscriptionSchema = new mongoose.Schema({
  driverId: { type: String, required: true, index: true },
  subscription: { type: Object, required: true }
}, { timestamps: true });

const DriverPushSubscription = mongoose.model('DriverPushSubscription', driverPushSubscriptionSchema);

// Web Push Sender Helper Function
async function sendDriverPushNotification(driverId, payload) {
  try {
    const subs = await DriverPushSubscription.find({ driverId });
    for (const subDoc of subs) {
      try {
        await webpush.sendNotification(subDoc.subscription, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await DriverPushSubscription.deleteOne({ _id: subDoc._id });
        }
      }
    }
  } catch (err) {
    console.error(`Push dispatch error for Driver ${driverId}:`, err.message);
  }
}

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

// ---------------- STUCK TRIPS RESET & PURGE ROUTE (SUPPORTS GET & POST) ----------------
const handleResetStuckTrips = async (req, res) => {
  try {
    await Trip.updateMany(
      { status: { $in: ['SEARCHING', 'ACCEPTED', 'ARRIVED', 'ONGOING'] } },
      { $set: { status: 'CANCELLED', isRiderDismissed: true, isDriverDismissed: true } }
    );
    activeRides.clear();
    return res.send(`
      <div style="font-family:sans-serif; text-align:center; padding:40px; background:#0f172a; color:#f59e0b; min-height:100vh;">
        <h1 style="font-size:32px;">✅ All Stuck Trips Purged Successfully!</h1>
        <p style="color:#cbd5e1; font-size:16px;">Purane ghost records cancel kar diye gaye hain. Ab Rider aur Driver app fresh state me khulenge.</p>
        <a href="/" style="display:inline-block; margin-top:20px; background:#f59e0b; color:#0f172a; font-weight:bold; padding:12px 24px; border-radius:12px; text-decoration:none;">Open Rider App</a>
      </div>
    `);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};

app.get('/api/admin/reset-stuck-trips', handleResetStuckTrips);
app.post('/api/admin/reset-stuck-trips', handleResetStuckTrips);

// ---------------- WEB PUSH SUBSCRIPTION APIS ----------------
app.post('/api/driver/push-subscription', async (req, res) => {
  try {
    const { driverId, subscription } = req.body;
    if (!driverId || !subscription || !subscription.endpoint) {
      return res.status(400).json({ success: false, message: 'Driver ID and valid subscription payload required.' });
    }

    await DriverPushSubscription.findOneAndUpdate(
      { driverId, 'subscription.endpoint': subscription.endpoint },
      { driverId, subscription },
      { upsert: true, new: true }
    );

    return res.json({ success: true, message: 'Push subscription stored successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- RIDER AUTH & KYC ROUTES ----------------

app.post('/api/rider/signup', async (req, res) => {
  try {
    const { name, phone, password, referralCode } = req.body;
    if (!name || !phone || !password) {
      return res.status(400).json({ success: false, message: 'Name, Phone aur Password zaroori hain.' });
    }

    const cleanPhone = sanitizePhone(phone);
    const existing = await Rider.findOne({
      $or: [
        { phone: cleanPhone },
        { phone: phone.trim() },
        { phone: { $regex: cleanPhone + '$' } }
      ]
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Yeh mobile number pehle se registered hai. Kripya Login karein.' });
    }

    const riderId = `RDR_${Date.now()}`;
    const newRider = await Rider.create({
      riderId,
      name: name.trim(),
      phone: cleanPhone,
      password: password.trim(),
      referralCode: referralCode ? referralCode.trim() : '',
      walletBalance: 0,
      bonusFreeRides: 0,
      isKycDone: false,
      status: 'ACTIVE'
    });

    return res.status(201).json({
      success: true,
      message: 'Rider account successfully created!',
      rider: {
        riderId: newRider.riderId,
        name: newRider.name,
        phone: newRider.phone,
        referralCode: newRider.referralCode,
        govIdNumber: newRider.govIdNumber,
        walletBalance: newRider.walletBalance,
        bonusFreeRides: newRider.bonusFreeRides,
        isKycDone: newRider.isKycDone,
        status: newRider.status
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/rider/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone number aur Password enter karein.' });
    }

    const cleanPhone = sanitizePhone(phone);
    const rider = await Rider.findOne({
      $or: [
        { phone: cleanPhone },
        { phone: phone.trim() },
        { phone: `+91${cleanPhone}` },
        { phone: { $regex: cleanPhone + '$' } }
      ],
      password: password.trim()
    });

    if (!rider) {
      return res.status(401).json({ success: false, message: 'Galat Phone number ya Password!' });
    }

    if (rider.status === 'BLOCKED') {
      return res.status(403).json({ success: false, message: 'Aapka account admin dwara suspend kiya gaya hai.' });
    }

    return res.json({
      success: true,
      message: 'Login successful!',
      rider: {
        riderId: rider.riderId,
        name: rider.name,
        phone: rider.phone,
        referralCode: rider.referralCode,
        govIdNumber: rider.govIdNumber,
        walletBalance: rider.walletBalance || 0,
        bonusFreeRides: rider.bonusFreeRides || 0,
        isKycDone: rider.isKycDone,
        status: rider.status
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/rider/upload-kyc', async (req, res) => {
  try {
    const { phone, govIdNumber, govIdFront, govIdBack } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Rider phone number required.' });
    }

    const cleanPhone = sanitizePhone(phone);
    const updated = await Rider.findOneAndUpdate(
      {
        $or: [
          { phone: cleanPhone },
          { phone: phone.trim() },
          { phone: { $regex: cleanPhone + '$' } }
        ]
      },
      {
        govIdNumber: govIdNumber ? govIdNumber.trim() : '',
        documents: {
          govIdFront: govIdFront || '',
          govIdBack: govIdBack || ''
        },
        isKycDone: true
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Rider record nahi mila.' });
    }

    return res.json({ success: true, message: 'KYC verified and stored successfully!', rider: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/rider/delete-account', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number required' });

    const cleanPhone = sanitizePhone(phone);
    await Rider.deleteOne({
      $or: [
        { phone: cleanPhone },
        { phone: phone.trim() }
      ]
    });

    return res.json({ success: true, message: 'Rider account permanently deleted.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- ACTIVE RIDE & SETTLEMENT RECOVERY APIS ----------------

app.get('/api/driver/active-ride', async (req, res) => {
  try {
    const { driverId } = req.query;
    if (!driverId) return res.status(400).json({ success: false, message: 'Driver ID required' });

    const activeTrip = await Trip.findOne({
      'driverData.driverId': driverId,
      $or: [
        { status: { $in: ['ACCEPTED', 'ARRIVED', 'ONGOING'] } },
        { status: 'COMPLETED', isDriverDismissed: false }
      ]
    }).sort({ updatedAt: -1 });

    if (activeTrip) {
      return res.json({ success: true, hasActiveRide: true, trip: activeTrip });
    }
    return res.json({ success: true, hasActiveRide: false });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/rider/active-ride', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ success: false, message: 'Rider phone required' });

    const clean = sanitizePhone(phone);
    const activeTrip = await Trip.findOne({
      $or: [
        { 'riderData.phone': clean },
        { 'riderData.phone': phone.trim() }
      ],
      $or: [
        { status: { $in: ['ACCEPTED', 'ARRIVED', 'ONGOING'] } },
        { status: 'COMPLETED', isRiderDismissed: false }
      ]
    }).sort({ updatedAt: -1 });

    if (activeTrip) {
      if (activeTrip.driverData?.driverId) {
        const validDriver = await Driver.findOne({ driverId: activeTrip.driverData.driverId, status: 'APPROVED' });
        if (!validDriver) {
          await Trip.updateOne({ _id: activeTrip._id }, { status: 'CANCELLED', isRiderDismissed: true });
          return res.json({ success: true, hasActiveRide: false });
        }
      }
      return res.json({ success: true, hasActiveRide: true, trip: activeTrip });
    }
    return res.json({ success: true, hasActiveRide: false });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/trip/dismiss-settlement', async (req, res) => {
  try {
    const { rideId, role } = req.body;
    if (!rideId) return res.status(400).json({ success: false, message: 'Ride ID required' });

    const updateObj = {};
    if (role === 'rider') updateObj.isRiderDismissed = true;
    if (role === 'driver') updateObj.isDriverDismissed = true;

    await Trip.updateOne({ rideId }, { $set: updateObj });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------- DRIVER AUTH & ONBOARDING ROUTES ----------------

app.post('/api/driver/signup-fast', async (req, res) => {
  try {
    const { name, phone, password, vehicleNo, cabType, referralCode } = req.body;
    if (!name || !phone || !password || !vehicleNo) {
      return res.status(400).json({ success: false, message: 'Name, Phone, Password, aur Vehicle Number zaroori hain.' });
    }

    const cleanPhone = sanitizePhone(phone);
    const cleanVehicle = vehicleNo.trim().toUpperCase();

    const existing = await Driver.findOne({
      $or: [
        { phone: cleanPhone },
        { phone: phone.trim() },
        { phone: { $regex: cleanPhone + '$' } }
      ]
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Yeh mobile number pehle se registered hai.' });
    }

    const driverId = `DRV_${Date.now()}`;
    const newDriver = await Driver.create({
      driverId,
      name: name.trim(),
      phone: cleanPhone,
      password: password.trim(),
      vehicleNo: cleanVehicle,
      cabType: (cabType || 'HATCHBACK').toUpperCase(),
      upiId: '67cabs@upi',
      referralCode: referralCode ? referralCode.trim() : '',
      walletBalance: 0,
      bonusFreeRides: 0,
      documents: {},
      status: 'NEEDS_KYC',
      isOnline: false
    });

    return res.status(201).json({
      success: true,
      message: 'Account registered! Please upload documents.',
      driver: {
        driverId: newDriver.driverId,
        name: newDriver.name,
        phone: newDriver.phone,
        cabType: newDriver.cabType,
        vehicleNo: newDriver.vehicleNo,
        upiId: newDriver.upiId,
        walletBalance: newDriver.walletBalance,
        bonusFreeRides: newDriver.bonusFreeRides,
        status: newDriver.status,
        isOnline: false,
        documents: {}
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/driver/upload-kyc-docs', async (req, res) => {
  try {
    const { driverId, documents } = req.body;
    if (!driverId || !documents) {
      return res.status(400).json({ success: false, message: 'Driver ID and documents required.' });
    }

    const updated = await Driver.findOneAndUpdate(
      { driverId },
      { 
        documents: documents,
        status: 'PENDING_APPROVAL'
      },
      { new: true }
    );

    if (!updated) return res.status(404).json({ success: false, message: 'Driver nahi mila.' });

    return res.json({ success: true, message: 'KYC submitted for admin approval.', driver: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/driver/signup', async (req, res) => {
  try {
    const { name, phone, password, email, vehicleNo, cabType, upiId, referralCode, documents } = req.body;
    if (!name || !phone || !password || !vehicleNo) {
      return res.status(400).json({ success: false, message: 'Name, Phone, Password, aur Vehicle Number zaroori hain.' });
    }

    const cleanPhone = sanitizePhone(phone);
    const cleanVehicle = vehicleNo.trim().toUpperCase();

    const existing = await Driver.findOne({
      $or: [
        { phone: cleanPhone },
        { phone: phone.trim() },
        { phone: { $regex: cleanPhone + '$' } }
      ]
    });

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
      vehicleNo: cleanVehicle,
      cabType: (cabType || 'HATCHBACK').toUpperCase(),
      upiId: upiId ? upiId.trim() : '67cabs@upi',
      referralCode: referralCode ? referralCode.trim() : '',
      walletBalance: 0,
      bonusFreeRides: 0,
      documents: documents || {},
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
        walletBalance: newDriver.walletBalance,
        bonusFreeRides: newDriver.bonusFreeRides,
        status: newDriver.status,
        isOnline: false,
        documents: newDriver.documents
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/driver/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone number aur Password enter karein.' });
    }

    const digitsOnly = phone.toString().replace(/\D/g, '');
    const clean10 = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;
    const rawPhone = phone.trim();

    const driver = await Driver.findOne({
      $or: [
        { phone: clean10 },
        { phone: rawPhone },
        { phone: `0${clean10}` },
        { phone: `+91${clean10}` },
        { phone: { $regex: clean10 + '$' } }
      ],
      password: password.trim()
    });
    
    if (!driver) {
      return res.status(401).json({ success: false, message: 'Galat Phone number ya Password!' });
    }

    if (driver.status === 'SUSPENDED') {
      return res.status(403).json({ success: false, message: 'Aapka account Admin dwara permanently suspend kar diya gaya hai.' });
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
        walletBalance: driver.walletBalance || 0,
        bonusFreeRides: driver.bonusFreeRides || 0,
        status: driver.status,
        isOnline: driver.isOnline || false,
        documents: driver.documents || {}
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/driver/delete-account', async (req, res) => {
  try {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ success: false, message: 'Driver ID required' });

    await Driver.deleteOne({ driverId });
    await DriverLocation.deleteOne({ driverId });

    return res.json({ success: true, message: 'Driver account successfully deleted.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/driver/upload-additional-doc', async (req, res) => {
  try {
    const { driverId, additionalDocImage } = req.body;
    if (!driverId || !additionalDocImage) {
      return res.status(400).json({ success: false, message: 'Driver ID & Document image required.' });
    }

    const updated = await Driver.findOneAndUpdate(
      { driverId },
      { 
        'documents.additionalDocImage': additionalDocImage,
        status: 'PENDING_APPROVAL' 
      },
      { new: true }
    );

    if (!updated) return res.status(404).json({ success: false, message: 'Driver nahi mila.' });

    io.emit(`driver:status:${driverId}`, { status: 'PENDING_APPROVAL' });

    return res.json({ 
      success: true, 
      message: 'Additional document submitted for admin review.',
      driver: updated 
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- ADMIN DASHBOARD ROUTES ----------------

app.get('/api/admin/drivers', async (req, res) => {
  try {
    const drivers = await Driver.find().sort({ createdAt: -1 }).lean();
    const audits = await DriverAudit.find().lean();

    const driversWithAudit = drivers.map(d => {
      const cleanPhone = sanitizePhone(d.phone);
      const pastRecord = audits.find(a => sanitizePhone(a.phone) === cleanPhone || a.vehicleNo === d.vehicleNo);
      return {
        ...d,
        hasPastRecord: !!pastRecord,
        pastRecordDetails: pastRecord || null
      };
    });

    return res.json({ success: true, drivers: driversWithAudit });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/riders', async (req, res) => {
  try {
    const riders = await Rider.find().sort({ createdAt: -1 }).lean();
    return res.json({ success: true, riders });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/rider/status', async (req, res) => {
  try {
    const { phone, status } = req.body;
    if (!phone || !['ACTIVE', 'PENDING_KYC', 'BLOCKED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid rider status payload' });
    }

    const cleanPhone = sanitizePhone(phone);
    const updated = await Rider.findOneAndUpdate(
      {
        $or: [
          { cleanPhone },
          { phone: phone.trim() }
        ]
      },
      { status },
      { new: true }
    );

    if (!updated) return res.status(404).json({ success: false, message: 'Rider nahi mila' });

    return res.json({ success: true, message: `Rider status updated to ${status}`, rider: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/driver/status', async (req, res) => {
  try {
    const { driverId, status } = req.body;
    if (!driverId || !['APPROVED', 'PENDING_APPROVAL', 'BLOCKED', 'ADDITIONAL_DOC_REQUIRED'].includes(status)) {
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

    io.emit(`driver:status:${driverId}`, { 
      status: updated.status,
      docName: updated.documents?.additionalDocName || ''
    });

    return res.json({ success: true, message: `Driver status changed to ${status}`, driver: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/driver/request-doc', async (req, res) => {
  try {
    const { driverId, docName } = req.body;
    if (!driverId || !docName) {
      return res.status(400).json({ success: false, message: 'Driver ID & Document name required.' });
    }

    const updated = await Driver.findOneAndUpdate(
      { driverId },
      { 
        status: 'ADDITIONAL_DOC_REQUIRED',
        'documents.additionalDocName': docName.trim()
      },
      { new: true }
    );

    if (!updated) return res.status(404).json({ success: false, message: 'Driver nahi mila' });

    io.emit(`driver:status:${driverId}`, { 
      status: 'ADDITIONAL_DOC_REQUIRED', 
      docName: docName.trim() 
    });

    return res.json({ success: true, message: `Document '${docName}' requested from Driver.`, driver: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/driver/suspend', async (req, res) => {
  try {
    const { driverId, reason } = req.body;
    const driver = await Driver.findOne({ driverId });
    if (!driver) return res.status(404).json({ success: false, message: 'Driver nahi mila.' });

    await DriverAudit.create({
      phone: sanitizePhone(driver.phone),
      vehicleNo: driver.vehicleNo,
      name: driver.name,
      reason: reason || 'Suspended by admin due to violations'
    });

    await Driver.deleteOne({ driverId });
    await DriverLocation.deleteOne({ driverId });

    io.emit(`driver:status:${driverId}`, { status: 'SUSPENDED' });

    return res.json({ success: true, message: 'Driver suspended & logged into blacklist history.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- COUPON SYSTEM ROUTES ----------------

app.post('/api/admin/coupons', async (req, res) => {
  try {
    const {
      code,
      description,
      discountType,
      discountValue,
      maxDiscountAmount,
      minRechargeAmount,
      targetType,
      allowedDrivers,
      usageLimitPerDriver,
      expiryDate
    } = req.body;

    if (!code || !discountType || !discountValue || !expiryDate) {
      return res.status(400).json({ success: false, message: 'Code, Discount Type, Discount Value aur Expiry Date zaroori hain.' });
    }

    const cleanCode = code.toUpperCase().trim();
    const existing = await Coupon.findOne({ code: cleanCode });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Yeh coupon code pehle se maujood hai.' });
    }

    let driverList = [];
    if (targetType === 'SPECIFIC') {
      if (Array.isArray(allowedDrivers)) {
        driverList = allowedDrivers.map(d => d.trim()).filter(Boolean);
      } else if (typeof allowedDrivers === 'string') {
        driverList = allowedDrivers.split(',').map(d => d.trim()).filter(Boolean);
      }
    }

    const newCoupon = await Coupon.create({
      code: cleanCode,
      description: description ? description.trim() : '',
      discountType,
      discountValue: Number(discountValue),
      maxDiscountAmount: maxDiscountAmount ? Number(maxDiscountAmount) : null,
      minRechargeAmount: Number(minRechargeAmount) || 0,
      targetType: targetType || 'ALL',
      allowedDrivers: driverList,
      usageLimitPerDriver: Number(usageLimitPerDriver) || 1,
      expiryDate: new Date(expiryDate),
      isActive: true
    });

    return res.status(201).json({ 
      success: true, 
      message: 'Coupon successfully create ho gaya!', 
      coupon: newCoupon 
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/coupons', async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    return res.json({ success: true, coupons });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/admin/coupons/:id/toggle', async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon nahi mila.' });

    coupon.isActive = !coupon.isActive;
    await coupon.save();
    return res.json({ success: true, message: `Coupon ${coupon.isActive ? 'Active' : 'Inactive'} kar diya gaya hai.`, isActive: coupon.isActive });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/admin/coupons/:id', async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon nahi mila.' });
    return res.json({ success: true, message: 'Coupon permanently delete ho gaya.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/coupons/driver/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    const now = new Date();

    const coupons = await Coupon.find({
      isActive: true,
      startDate: { $lte: now },
      expiryDate: { $gte: now },
      $or: [
        { targetType: 'ALL' },
        { targetType: 'SPECIFIC', allowedDrivers: driverId }
      ]
    }).select('-usedBy');

    return res.json({ success: true, coupons });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/coupons/apply', async (req, res) => {
  try {
    const { couponCode, driverId, rechargeAmount } = req.body;
    const numAmount = Number(rechargeAmount);

    if (!couponCode || !driverId || !numAmount) {
      return res.status(400).json({ success: false, message: 'Coupon Code, Driver ID aur Recharge Amount zaroori hain.' });
    }

    const coupon = await Coupon.findOne({ 
      code: couponCode.toUpperCase().trim(), 
      isActive: true 
    });

    if (!coupon) {
      return res.status(404).json({ success: false, message: 'Invalid ya Expired coupon code.' });
    }

    const now = new Date();
    if (now < coupon.startDate || now > coupon.expiryDate) {
      return res.status(400).json({ success: false, message: 'Yeh coupon expire ho chuka hai.' });
    }

    if (numAmount < coupon.minRechargeAmount) {
      return res.status(400).json({ 
        success: false, 
        message: `Is coupon ke liye minimum ₹${coupon.minRechargeAmount} ka recharge zaroori hai.` 
      });
    }

    if (coupon.targetType === 'SPECIFIC' && !coupon.allowedDrivers.includes(driverId)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Yeh coupon aapke account ke liye valid nahi hai.' 
      });
    }

    const driverUsageCount = coupon.usedBy.filter(item => item.driverId === driverId).length;
    if (driverUsageCount >= coupon.usageLimitPerDriver) {
      return res.status(400).json({ 
        success: false, 
        message: 'Aap is coupon ka maximum limit pehle hi use kar chuke hain.' 
      });
    }

    let discountAmount = 0;
    if (coupon.discountType === 'FLAT') {
      discountAmount = coupon.discountValue;
    } else if (coupon.discountType === 'PERCENTAGE') {
      discountAmount = (numAmount * coupon.discountValue) / 100;
      if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
        discountAmount = coupon.maxDiscountAmount;
      }
    }

    const finalPayableAmount = Math.max(0, numAmount - discountAmount);

    return res.status(200).json({
      success: true,
      message: 'Coupon successfully apply ho gaya!',
      data: {
        couponCode: coupon.code,
        originalAmount: numAmount,
        discountAmount: Math.round(discountAmount),
        finalAmount: Math.round(finalPayableAmount)
      }
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------- FARE & PROXIMITY RADAR ROUTES ----------------

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

// Real-Time Driver Proximity Radar (Strictly Approved Drivers Only)
app.get('/api/cabs/nearby-all', async (req, res) => {
  try {
    const approvedDrivers = await Driver.find({ status: 'APPROVED' }).lean();
    const approvedDriverMap = new Map();
    approvedDrivers.forEach(d => approvedDriverMap.set(d.driverId, d));

    const driversList = [];
    const addedDriverIds = new Set();

    activeDrivers.forEach((d) => {
      if (approvedDriverMap.has(d.driverId) && d.isOnline !== false && d.location && d.location.lat) {
        const dbDriver = approvedDriverMap.get(d.driverId);
        driversList.push({
          id: d.driverId,
          name: dbDriver.name || d.name,
          category: dbDriver.cabType || d.cabType,
          vehicleNo: dbDriver.vehicleNo || d.vehicleNo,
          lat: d.location.lat,
          lng: d.location.lng
        });
        addedDriverIds.add(d.driverId);
      }
    });

    const dbLocations = await DriverLocation.find({ isOnline: true }).sort({ lastActive: -1 }).limit(30);
    dbLocations.forEach((dl) => {
      if (approvedDriverMap.has(dl.driverId) && !addedDriverIds.has(dl.driverId) && dl.location && dl.location.lat) {
        const dbDriver = approvedDriverMap.get(dl.driverId);
        driversList.push({
          id: dl.driverId,
          name: dbDriver.name || dl.name,
          category: dbDriver.cabType || dl.cabType,
          vehicleNo: dbDriver.vehicleNo || dl.vehicleNo,
          lat: dl.location.lat,
          lng: dl.location.lng
        });
        addedDriverIds.add(dl.driverId);
      }
    });

    return res.json({ success: true, drivers: driversList });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/cabs/nearby', async (req, res) => {
  try {
    const cabType = (req.query.cabType || 'HATCHBACK').toUpperCase();
    let liveDriver = null;
    activeDrivers.forEach((d) => {
      if (d.cabType === cabType && d.isOnline !== false && d.location && d.location.lat) {
        liveDriver = d;
      }
    });

    if (!liveDriver) {
      const dbDriver = await DriverLocation.findOne({ cabType, isOnline: true }).sort({ lastActive: -1 });
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

// Real-Time In-Memory Maps (Keyed by driverId for Zero Lag)
let activeDrivers = new Map();
let driverSocketMap = new Map();
let activeRides = new Map();

io.on('connection', (socket) => {
  console.log(`⚡ Device Connected: ${socket.id}`);

  // 1. Driver Online Registration & Permanent Room Join
  socket.on('driver:register', async (driverData) => {
    const normalizedCabType = (driverData.cabType || 'HATCHBACK').toUpperCase();
    const driverId = driverData.driverId || socket.id;

    socket.join(`driver:${driverId}`);
    driverSocketMap.set(driverId, socket.id);

    const existingEntry = activeDrivers.get(driverId);
    const loc = driverData.location || (existingEntry ? existingEntry.location : null);
    const isOnlineState = driverData.isOnline !== undefined ? driverData.isOnline : true;

    activeDrivers.set(driverId, {
      driverId,
      name: driverData.name,
      vehicleNo: driverData.vehicleNo,
      cabType: normalizedCabType,
      upiId: driverData.upiId || '67cabs@upi',
      status: driverData.status || 'APPROVED',
      isOnline: isOnlineState,
      location: loc,
      socketId: socket.id
    });

    try {
      await Driver.updateOne({ driverId }, { isOnline: isOnlineState });
    } catch (e) {}

    if (loc && loc.lat) {
      try {
        await DriverLocation.findOneAndUpdate(
          { driverId },
          {
            name: driverData.name,
            cabType: normalizedCabType,
            vehicleNo: driverData.vehicleNo,
            location: { lat: loc.lat, lng: loc.lng },
            isOnline: isOnlineState,
            lastActive: new Date()
          },
          { upsert: true }
        );
      } catch (e) {}
    }
  });

  // 1.1 Driver Toggle Online/Offline State
  socket.on('driver:toggle_online', async ({ driverId, isOnline }) => {
    if (!driverId) return;
    const d = activeDrivers.get(driverId);
    if (d) d.isOnline = isOnline;

    try {
      await Driver.updateOne({ driverId }, { isOnline });
      await DriverLocation.updateOne({ driverId }, { isOnline, lastActive: new Date() });
    } catch (e) {}

    console.log(`📡 Driver ${driverId} status updated: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
  });

  // 1.2 Driver Instant Logout Cleanup
  socket.on('driver:logout', async ({ driverId }) => {
    if (!driverId) return;
    activeDrivers.delete(driverId);
    driverSocketMap.delete(driverId);
    socket.leave(`driver:${driverId}`);

    try {
      await Driver.updateOne({ driverId }, { isOnline: false });
      await DriverLocation.deleteOne({ driverId });
    } catch (e) {}

    console.log(`🚪 Driver ${driverId} logged out & purged from active radar.`);
  });

  // 2. Targeted 1-Click Ride Request (Dual Dispatch: Direct Room + Socket Map + Web Push)
  socket.on('ride:request_targeted', async (rideData) => {
    const { rideId, targetDriverId, pickup, stops, cabCategory, totalDistanceKm, totalFare, rider } = rideData;

    const ridePayload = {
      rideId,
      cabType: cabCategory,
      pickup,
      stops: stops || [],
      drop: stops?.[0] || pickup,
      totalDistanceKm: totalDistanceKm || 0,
      totalFare: Number(totalFare) || 0,
      riderData: rider,
      riderSocketId: socket.id,
      status: 'SEARCHING',
      startTime: new Date()
    };
    activeRides.set(rideId, ridePayload);

    try {
      await Trip.create(ridePayload);
    } catch (dbErr) {
      console.warn(`Initial DB Save Warning for ${rideId}:`, dbErr.message);
    }

    let isOnline = activeDrivers.has(targetDriverId) && activeDrivers.get(targetDriverId).isOnline !== false;

    if (!isOnline) {
      const dbCheck = await Driver.findOne({ driverId: targetDriverId, status: 'APPROVED' });
      if (dbCheck) isOnline = true;
    }

    if (isOnline) {
      // 100% Reliable Guaranteed Delivery to Driver's Permanent Room
      io.to(`driver:${targetDriverId}`).emit('ride:new_offer', ridePayload);
      
      const sId = driverSocketMap.get(targetDriverId);
      if (sId) {
        io.to(sId).emit('ride:new_offer', ridePayload);
      }

      // Web Push Notification Trigger
      sendDriverPushNotification(targetDriverId, {
        title: '🚖 Nayi Direct Ride Request!',
        body: `Kiraya: ₹${ridePayload.totalFare} | Pickup location check karein.`,
        data: { rideId: ridePayload.rideId, url: '/driver.html' }
      });

      console.log(`🎯 Targeted Ride ${rideId} dispatched to Driver Room: driver:${targetDriverId}`);
    } else {
      socket.emit('ride:declined_targeted', { rideId });
    }
  });

  socket.on('ride:decline_targeted', ({ rideId }) => {
    const ride = activeRides.get(rideId);
    if (ride && ride.riderSocketId) {
      io.to(ride.riderSocketId).emit('ride:declined_targeted', { rideId });
    }
    io.emit('ride:declined_targeted', { rideId });
    activeRides.delete(rideId);
  });

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
    } catch (dbErr) {}

    activeDrivers.forEach((driver) => {
      if (driver.status === 'APPROVED' && driver.isOnline !== false && (driver.cabType === requestedCabType || requestedCabType === 'ALL')) {
        io.to(`driver:${driver.driverId}`).emit('ride:new_offer', ridePayload);

        // Web Push Notification Trigger to all matching drivers
        sendDriverPushNotification(driver.driverId, {
          title: '🚖 Nayi Ride Request!',
          body: `Category: ${requestedCabType} | Kiraya: ₹${totalFare}`,
          data: { rideId, url: '/driver.html' }
        });
      }
    });
    io.emit('ride:new_offer', ridePayload);
  });

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
    let registeredDriver = null;

    activeDrivers.forEach((d) => {
      if (d.socketId === socket.id || d.driverId === driverData?.driverId) {
        registeredDriver = d;
      }
    });

    if (registeredDriver && registeredDriver.status !== 'APPROVED') {
      return socket.emit('ride:error', { message: 'Aapka account abhi Admin se Approved nahi hai.' });
    }

    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    let finalTotalFare = ride ? ride.totalFare : 0;

    try {
      const updatedTrip = await Trip.findOneAndUpdate(
        { rideId },
        { 
          status: 'ACCEPTED', 
          driverData: {
            driverId: registeredDriver ? registeredDriver.driverId : driverData.driverId,
            name: registeredDriver ? registeredDriver.name : driverData.name,
            vehicleNo: registeredDriver ? registeredDriver.vehicleNo : driverData.vehicleNo,
            phone: driverData?.phone || '',
            upiId: registeredDriver ? registeredDriver.upiId : (driverData?.upiId || '67cabs@upi')
          }, 
          otp: startOtp 
        },
        { new: true }
      );
      if (updatedTrip) finalTotalFare = updatedTrip.totalFare;
    } catch (e) {
      console.error('DB Update Error (ACCEPTED):', e.message);
    }

    if (ride) {
      ride.status = 'ACCEPTED';
      ride.driverSocketId = socket.id;
      ride.driverData = {
        driverId: registeredDriver ? registeredDriver.driverId : driverData.driverId,
        name: registeredDriver ? registeredDriver.name : driverData.name,
        vehicleNo: registeredDriver ? registeredDriver.vehicleNo : driverData.vehicleNo,
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

    socket.emit('driver:ride_confirmed', {
      rideId,
      pickup: ride?.pickup,
      drop: ride?.drop || ride?.stops?.[0],
      totalFare: finalTotalFare
    });

    socket.broadcast.emit('ride:taken', { rideId });
    io.emit('ride:taken', { rideId });
  });

  // 3.1 Driver Arrived
  socket.on('driver:arrived', async ({ rideId }) => {
    const ride = activeRides.get(rideId);
    if (ride) {
      ride.status = 'ARRIVED';
      activeRides.set(rideId, ride);
      if (ride.riderSocketId) {
        io.to(ride.riderSocketId).emit('ride:driver_arrived', { 
          rideId,
          message: '🚖 Driver has arrived at your pickup location!' 
        });
      }
    }
    await Trip.updateOne({ rideId }, { status: 'ARRIVED' }).catch(() => {});
    io.emit(`ride:driver_arrived:${rideId}`, {
      rideId,
      message: '🚖 Driver has arrived at your pickup location!'
    });
    io.emit('ride:driver_arrived', {
      rideId,
      message: '🚖 Driver has arrived at your pickup location!'
    });
  });

  // 3.2 Live Driver GPS Telemetry Stream
  socket.on('driver:location_update', async ({ rideId, lat, lng, phase, heading }) => {
    activeDrivers.forEach((d) => {
      if (d.socketId === socket.id) {
        d.location = { lat, lng };
      }
    });

    const ride = activeRides.get(rideId);
    const telemetryPayload = {
      lat,
      lng,
      phase: phase || (ride ? ride.status : 'TO_PICKUP'),
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
      } catch (e) {}

      io.emit(`ride:started:${rideId}`, { rideId });
      socket.emit('ride:started_driver_view', { rideId });
    } else {
      socket.emit('ride:otp_invalid', { message: 'Galat OTP! Kripya Rider se pooch kar sahi 4-digit OTP dalein.' });
    }
  });

  // 4.1 Rider Initiates Early Drop & Generates OTP
  socket.on('ride:early_drop_request', async ({ rideId, earlyOtp }) => {
    const strOtp = earlyOtp ? earlyOtp.toString().trim() : '';
    const ride = activeRides.get(rideId);
    if (ride) {
      ride.earlyDropOtp = strOtp;
      activeRides.set(rideId, ride);
    }
    try {
      await Trip.updateOne({ rideId }, { earlyDropOtp: strOtp });
    } catch (e) {}
  });

  // 4.2 Driver Ends Trip Early with Rider OTP
  socket.on('ride:early_complete_otp', async ({ rideId, enteredOtp }) => {
    const trip = await Trip.findOne({ rideId });
    const ride = activeRides.get(rideId);
    const validEarlyOtp = trip?.earlyDropOtp || ride?.earlyDropOtp;

    if (!validEarlyOtp || validEarlyOtp !== enteredOtp.trim()) {
      return socket.emit('ride:otp_invalid', { message: 'Invalid Early Drop OTP from Rider.' });
    }

    const fare = trip ? trip.totalFare : (ride ? ride.totalFare : 0);
    completeTripFinal(rideId, fare, false, 'RIDER_REQUESTED_EARLY_DROP');
  });

  // 4.3 Driver Ends Trip Early Due to Emergency/Breakdown
  socket.on('ride:early_complete_emergency', async ({ rideId, reason }) => {
    const ride = activeRides.get(rideId);
    const baseMinFare = 60;
    const reducedFare = ride ? Math.max(baseMinFare, Math.round(ride.totalFare * 0.55)) : baseMinFare;

    completeTripFinal(rideId, reducedFare, true, reason || 'DRIVER_EMERGENCY');
  });

  // 5. Standard Trip Completion
  socket.on('ride:complete', async ({ rideId }) => {
    const trip = await Trip.findOne({ rideId });
    const ride = activeRides.get(rideId);
    const totalFare = trip ? trip.totalFare : (ride ? ride.totalFare : 0);
    completeTripFinal(rideId, totalFare, false, 'STANDARD_DROP');
  });

  // 5.1 Rider Rates Driver Post-Trip
  socket.on('ride:rate_driver', async ({ rideId, rating }) => {
    try {
      const numRating = Math.min(5, Math.max(1, Number(rating) || 5));
      const trip = await Trip.findOneAndUpdate(
        { rideId }, 
        { rating: numRating }, 
        { new: true }
      );

      if (trip && trip.driverData && trip.driverData.driverId) {
        const driver = await Driver.findOne({ driverId: trip.driverData.driverId });
        if (driver) {
          const currentCount = driver.totalRatingsCount || 1;
          const currentAvg = driver.rating || 5.0;
          const newAvg = parseFloat(((currentAvg * currentCount + numRating) / (currentCount + 1)).toFixed(1));
          await Driver.updateOne(
            { driverId: driver.driverId },
            { 
              $set: { rating: newAvg },
              $inc: { totalRatingsCount: 1 }
            }
          );
        }
      }
      console.log(`⭐ Trip ${rideId} rated ${numRating} Stars and saved to MongoDB.`);
    } catch (err) {
      console.error('Rating DB Error:', err.message);
    }
  });

  async function completeTripFinal(rideId, finalAmount, isEarlyDrop, settlementReason) {
    const ride = activeRides.get(rideId);
    let upiId = ride?.driverData?.upiId || '67cabs@upi';

    try {
      const completedTrip = await Trip.findOneAndUpdate(
        { rideId },
        { 
          status: 'COMPLETED', 
          finalFare: finalAmount, 
          isEarlyDrop, 
          earlyDropReason: settlementReason,
          isRiderDismissed: false,
          isDriverDismissed: false,
          endTime: new Date() 
        },
        { new: true }
      );
      if (completedTrip && completedTrip.driverData?.upiId) {
        upiId = completedTrip.driverData.upiId;
      }

      if (completedTrip?.driverData?.driverId) {
        const d = activeDrivers.get(completedTrip.driverData.driverId);
        if (d) d.isOnline = true;
      }

      // ONE-TIME REFERRAL REWARD ENGINE
      if (completedTrip?.riderData?.phone) {
        const riderPhone = sanitizePhone(completedTrip.riderData.phone);
        const riderDoc = await Rider.findOne({ phone: riderPhone });
        if (riderDoc && riderDoc.referralCode && !riderDoc.isFirstTripRewardClaimed) {
          const referrerDriver = await Driver.findOne({ driverId: riderDoc.referralCode.trim() });
          if (referrerDriver) {
            await Driver.updateOne(
              { driverId: referrerDriver.driverId },
              { $inc: { bonusFreeRides: 1 } }
            );
            await Rider.updateOne({ _id: riderDoc._id }, { isFirstTripRewardClaimed: true });
            console.log(`🎁 1-Time Referral Bonus: 1 Free Ride awarded to Driver ${referrerDriver.driverId} for Rider's 1st trip.`);
          }
        }
      }

      if (completedTrip?.driverData?.driverId) {
        const currentDriverDoc = await Driver.findOne({ driverId: completedTrip.driverData.driverId });
        if (currentDriverDoc && currentDriverDoc.referralCode && !currentDriverDoc.isFirstTripRewardClaimed) {
          const referrerDriver = await Driver.findOne({ driverId: currentDriverDoc.referralCode.trim() });
          if (referrerDriver) {
            await Driver.updateOne(
              { driverId: referrerDriver.driverId },
              { $inc: { bonusFreeRides: 1 } }
            );
            await Driver.updateOne({ _id: currentDriverDoc._id }, { isFirstTripRewardClaimed: true });
            console.log(`🎁 1-Time Referral Bonus: 1 Free Ride awarded to Driver ${referrerDriver.driverId} for Driver's 1st trip.`);
          }
        }
      }
    } catch (dbErr) {
      console.error(`MongoDB Log Error for ${rideId}:`, dbErr.message);
    }

    const completionPayload = {
      rideId,
      finalFare: finalAmount,
      driverUpiId: upiId,
      isEarlyDrop
    };

    if (ride && ride.riderSocketId) {
      io.to(ride.riderSocketId).emit('ride:completed', completionPayload);
    }
    io.emit(`ride:completed:${rideId}`, completionPayload);
    io.emit('ride:completed', completionPayload);
    socket.emit('ride:completed', completionPayload);

    activeRides.delete(rideId);
    console.log(`🏁 Trip ${rideId} Finalized. Total Fare: ₹${finalAmount}`);
  }

  // Handle Disconnect (Soft cleanup without killing active driver database entry)
  socket.on('disconnect', () => {
    let disconnectedDriverId = null;
    driverSocketMap.forEach((sId, dId) => {
      if (sId === socket.id) disconnectedDriverId = dId;
    });
    if (disconnectedDriverId) {
      driverSocketMap.delete(disconnectedDriverId);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚖 67 Cabs Server live on http://localhost:${PORT}`);
});