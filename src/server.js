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
const fs = require('fs');
const multer = require('multer');
const mongoose = require('mongoose');
require('dotenv').config();

const { calculateMasterFare } = require('./utils/fareCalculator');

// ---------------- WEB PUSH VAPID DISABLED (CHROME PUSH COMPLETELY BYPASSED) ----------------
const app = express();
const server = http.createServer(app);

// Sounds directory setup (Public MP3 Storage Fallback)
const soundDir = path.join(__dirname, '../public/sounds');
if (!fs.existsSync(soundDir)) {
  fs.mkdirSync(soundDir, { recursive: true });
}

// Multer Storage Configuration for Audio Upload
const soundStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, soundDir),
  filename: (req, file, cb) => {
    const cleanName = 'custom_driver_alert.mp3';
    cb(null, cleanName);
  }
});
const uploadSound = multer({ storage: soundStorage });

// Socket.io for Real-time Cabs & Alerts (Optimized for HTTPS/Nginx)
const io = new Server(server, {
  cors: { 
    origin: '*', 
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
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
  .then(async () => {
    console.log('🍃 MongoDB Atlas Connected (67-CABS Production)');
    try {
      // Purge ghost online states on restart
      await Driver.updateMany({}, { $set: { isOnline: false } });
      await DriverLocation.updateMany({}, { $set: { isOnline: false } });
      await refreshFareConfigCache();
      await initDefaultPlans();
    } catch (e) {}
  })
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

// 4. Trip History Schema
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
    upiId: String,
    photo: String
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
  isOnline: { type: Boolean, default: false },
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

// 8. Admin Global App Settings Schema (Ringtone / Sounds)
const settingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
}, { timestamps: true });

const Setting = mongoose.model('Setting', settingSchema);

// 9. Admin Dynamic Fare Rules Schema
const fareConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'global_fare_rules', unique: true },
  HATCHBACK: {
    baseFare: { type: Number, default: 50 },
    perKm: { type: Number, default: 16 },
    minFare: { type: Number, default: 50 }
  },
  SEDAN: {
    baseFare: { type: Number, default: 70 },
    perKm: { type: Number, default: 20 },
    minFare: { type: Number, default: 70 }
  },
  SUV: {
    baseFare: { type: Number, default: 100 },
    perKm: { type: Number, default: 30 },
    minFare: { type: Number, default: 100 }
  },
  rates: {
    pickupPerKm: { type: Number, default: 10 },
    tripTrafficPerMin: { type: Number, default: 2.0 },
    pickupTrafficPerMin: { type: Number, default: 2.0 }
  }
}, { timestamps: true });

const FareConfig = mongoose.model('FareConfig', fareConfigSchema);

// 10. Dynamic Driver Recharge Plans Schema
const rechargePlanSchema = new mongoose.Schema({
  key: { type: String, default: 'global_recharge_plans', unique: true },
  adminUpiId: { type: String, default: '67cabs@upi' },
  plans: [{
    planId: String,
    title: String,
    amount: Number,
    validityDays: Number,
    ridesLimit: Number,
    isPopular: Boolean
  }]
}, { timestamps: true });

const RechargePlan = mongoose.model('RechargePlan', rechargePlanSchema);

// 11. Driver Support Query / Ticket Schema (Driver-to-Admin Contact)
const supportTicketSchema = new mongoose.Schema({
  driverId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, default: '' },
  vehicleNo: { type: String, default: '' },
  message: { type: String, required: true },
  status: { type: String, enum: ['OPEN', 'RESOLVED'], default: 'OPEN' }
}, { timestamps: true });

const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);

async function initDefaultPlans() {
  try {
    const existing = await RechargePlan.findOne({ key: 'global_recharge_plans' });
    if (!existing) {
      await RechargePlan.create({
        key: 'global_recharge_plans',
        adminUpiId: '67cabs@upi',
        plans: [
          { planId: 'p_100', title: '7 Days Pass', amount: 100, validityDays: 7, ridesLimit: 50, isPopular: false },
          { planId: 'p_250', title: '30 Days Pass', amount: 250, validityDays: 30, ridesLimit: 200, isPopular: true },
          { planId: 'p_500', title: 'VIP Unlimited', amount: 500, validityDays: 60, ridesLimit: 9999, isPopular: false }
        ]
      });
    }
  } catch (e) {}
}

// Fast In-Memory Fare Rules Cache
let cachedFareConfig = null;
async function refreshFareConfigCache() {
  try {
    let doc = await FareConfig.findOne({ key: 'global_fare_rules' });
    if (!doc) {
      doc = await FareConfig.create({ key: 'global_fare_rules' });
    }
    cachedFareConfig = doc.toObject();
  } catch (e) {
    cachedFareConfig = null;
  }
}
refreshFareConfigCache();

// Memory Cache for Active Ringtone
let globalActiveSound = 'alert_uber';
(async () => {
  try {
    const soundDoc = await Setting.findOne({ key: 'driver_alert_sound' });
    if (soundDoc && soundDoc.value) {
      globalActiveSound = soundDoc.value;
    }
  } catch (e) {}
})();

// Web Push Sender Helper Function - COMPLETELY DISABLED
async function sendDriverPushNotification(driverId, payload) {
  return Promise.resolve();
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

// Real-Time In-Memory Maps (Keyed by driverId for Zero Lag)
let activeDrivers = new Map();
let driverSocketMap = new Map();
let activeRides = new Map();
let rideTimeoutTimers = new Map();

// ---------------- STUCK TRIPS RESET & PURGE ROUTE ----------------
const handleResetStuckTrips = async (req, res) => {
  try {
    await Trip.updateMany(
      { status: { $in: ['SEARCHING', 'ACCEPTED', 'ARRIVED', 'ONGOING'] } },
      { $set: { status: 'CANCELLED', isRiderDismissed: true, isDriverDismissed: true } }
    );
    activeRides.clear();
    rideTimeoutTimers.forEach(timer => clearTimeout(timer));
    rideTimeoutTimers.clear();

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

// ---------------- DRIVER SUPPORT TICKETING APIS (DRIVER TO ADMIN CONTACT) ----------------
app.post('/api/driver/support-ticket', async (req, res) => {
  try {
    const { driverId, name, phone, email, vehicleNo, message } = req.body;
    if (!driverId || !message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
    }

    const ticket = await SupportTicket.create({
      driverId,
      name: name || 'Partner Driver',
      phone: phone || '',
      email: email || '',
      vehicleNo: vehicleNo || '',
      message: message.trim(),
      status: 'OPEN'
    });

    // Real-time broadcast to Admin Dashboard
    io.emit('admin:new_support_ticket', ticket);

    return res.status(201).json({ success: true, message: 'Aapka message admin tak pahuch gaya hai. Ham jald hi aapse contact karenge.', ticket });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/support-tickets', async (req, res) => {
  try {
    const tickets = await SupportTicket.find().sort({ createdAt: -1 }).lean();
    return res.json({ success: true, tickets });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/admin/support-tickets/:id/resolve', async (req, res) => {
  try {
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    ticket.status = ticket.status === 'OPEN' ? 'RESOLVED' : 'OPEN';
    await ticket.save();
    return res.json({ success: true, message: `Ticket status updated to ${ticket.status}`, ticket });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/support-tickets/:id', async (req, res) => {
  try {
    await SupportTicket.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: 'Support ticket deleted.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- ADMIN FARE RULES API ROUTES (MONGODB DRIVEN) ----------------
app.get('/api/admin/fare-rules', async (req, res) => {
  try {
    let doc = await FareConfig.findOne({ key: 'global_fare_rules' });
    if (!doc) {
      doc = await FareConfig.create({ key: 'global_fare_rules' });
    }
    return res.json({ success: true, fareRules: doc });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/fare-rules', async (req, res) => {
  try {
    const { HATCHBACK, SEDAN, SUV, rates } = req.body;
    const updated = await FareConfig.findOneAndUpdate(
      { key: 'global_fare_rules' },
      { HATCHBACK, SEDAN, SUV, rates },
      { new: true, upsert: true }
    );
    cachedFareConfig = updated.toObject();
    console.log('💰 MongoDB Dynamic Fare Rules Updated by Admin!');
    return res.json({ success: true, message: 'Fare rules updated in MongoDB Atlas!', fareRules: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Public API for Rider & Driver Frontends to fetch Live Rates
app.get('/api/fare/public-rates', async (req, res) => {
  try {
    let doc = await FareConfig.findOne({ key: 'global_fare_rules' });
    if (!doc) doc = await FareConfig.create({ key: 'global_fare_rules' });
    return res.json({
      success: true,
      rates: {
        HATCHBACK: doc.HATCHBACK?.perKm || 16,
        SEDAN: doc.SEDAN?.perKm || 20,
        SUV: doc.SUV?.perKm || 30
      }
    });
  } catch (e) {
    return res.json({
      success: true,
      rates: { HATCHBACK: 16, SEDAN: 20, SUV: 25 }
    });
  }
});

// ---------------- DYNAMIC RECHARGE PLANS API ----------------
app.get('/api/driver/recharge-plans', async (req, res) => {
  try {
    let doc = await RechargePlan.findOne({ key: 'global_recharge_plans' });
    if (!doc) {
      await initDefaultPlans();
      doc = await RechargePlan.findOne({ key: 'global_recharge_plans' });
    }
    return res.json({ success: true, data: doc });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/recharge-plans', async (req, res) => {
  try {
    const { adminUpiId, plans } = req.body;
    const updated = await RechargePlan.findOneAndUpdate(
      { key: 'global_recharge_plans' },
      { adminUpiId: adminUpiId ? adminUpiId.trim() : '67cabs@upi', plans: plans || [] },
      { new: true, upsert: true }
    );
    return res.json({ success: true, message: 'Recharge plans updated in MongoDB!', data: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------- ADMIN SOUND & SETTINGS ROUTES ----------------
app.get('/api/admin/settings/sound', async (req, res) => {
  try {
    const doc = await Setting.findOne({ key: 'driver_alert_sound' });
    return res.json({ success: true, soundName: doc ? doc.value : globalActiveSound });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/settings/sound', async (req, res) => {
  try {
    const { soundName } = req.body;
    if (!soundName) return res.status(400).json({ success: false, message: 'Sound name is required.' });

    globalActiveSound = soundName.trim();
    await Setting.findOneAndUpdate(
      { key: 'driver_alert_sound' },
      { value: globalActiveSound },
      { upsert: true, new: true }
    );

    await Setting.deleteOne({ key: 'driver_alert_sound_base64' });

    console.log(`🔔 Global driver alert sound updated in MongoDB: ${globalActiveSound}`);
    return res.json({ success: true, message: 'Alert tone updated successfully.', soundName: globalActiveSound });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/upload-custom-sound', uploadSound.single('audioFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Audio file upload failed.' });
    }

    const fileBuffer = fs.readFileSync(req.file.path);
    const base64Audio = `data:${req.file.mimetype || 'audio/mp3'};base64,${fileBuffer.toString('base64')}`;

    await Setting.findOneAndUpdate(
      { key: 'driver_alert_sound_base64' },
      { value: base64Audio },
      { upsert: true, new: true }
    );

    const soundUrl = `/sounds/${req.file.filename}?v=${Date.now()}`;
    globalActiveSound = soundUrl;

    await Setting.findOneAndUpdate(
      { key: 'driver_alert_sound' },
      { value: soundUrl },
      { upsert: true, new: true }
    );

    console.log(`🍃 Custom audio song successfully stored in MongoDB Atlas!`);
    return res.json({ success: true, message: 'Custom song uploaded & stored in MongoDB!', soundUrl });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/driver/alert-sound', async (req, res) => {
  try {
    const doc = await Setting.findOne({ key: 'driver_alert_sound_base64' });
    if (doc && doc.value) {
      return res.json({ success: true, audioData: doc.value, isCustom: true });
    }
    const standardDoc = await Setting.findOne({ key: 'driver_alert_sound' });
    return res.json({ 
      success: true, 
      audioData: null, 
      soundName: standardDoc ? standardDoc.value : globalActiveSound,
      isCustom: false 
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------- ANDROID BACKGROUND GPS REST API ROUTE ----------------
app.post('/api/driver/update-location', async (req, res) => {
  try {
    const { latitude, longitude, driverId, rideId } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({ success: false, message: 'Coordinates required' });
    }

    const lat = Number(latitude);
    const lng = Number(longitude);

    if (driverId && activeDrivers.has(driverId)) {
      const d = activeDrivers.get(driverId);
      d.location = { lat, lng };
      d.isOnline = true;
      activeDrivers.set(driverId, d);
    }

    if (driverId) {
      await DriverLocation.findOneAndUpdate(
        { driverId },
        { 
          location: { lat, lng },
          isOnline: true,
          lastActive: new Date()
        },
        { upsert: true }
      );
    }

    if (rideId) {
      const telemetryPayload = {
        lat,
        lng,
        heading: 0
      };
      io.emit(`driver:location_broadcast:${rideId}`, telemetryPayload);
    }

    return res.status(200).json({ success: true, message: 'Location updated successfully.' });
  } catch (err) {
    console.error('Android GPS update error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- WEB PUSH SUBSCRIPTION APIS (SILENCED) ----------------
app.post('/api/driver/push-subscription', async (req, res) => {
  return res.json({ success: true, message: 'Browser Web Push is disabled in favor of Native Android Engine.' });
});

// ---------------- BACKGROUND ACTION HANDLERS FOR PUSH NOTIFICATIONS ----------------
app.post('/api/ride/accept-bg', async (req, res) => {
  try {
    const { rideId } = req.body;
    let { driverId } = req.body;

    if (!rideId) {
      return res.status(400).json({ success: false, message: 'Ride ID required.' });
    }

    if (rideTimeoutTimers.has(rideId)) {
      clearTimeout(rideTimeoutTimers.get(rideId));
      rideTimeoutTimers.delete(rideId);
    }

    let trip = await Trip.findOne({ rideId });
    const memoryRide = activeRides.get(rideId);

    if (!driverId) {
      driverId = memoryRide?.targetDriverId || trip?.driverData?.driverId;
    }

    let driver = null;
    if (driverId) {
      driver = await Driver.findOne({ driverId });
    }

    const resolvedDriverId = driver?.driverId || driverId || 'DRV_DEFAULT';
    const driverPayload = {
      driverId: resolvedDriverId,
      name: driver?.name || memoryRide?.driverData?.name || '67 Partner Driver',
      vehicleNo: driver?.vehicleNo || memoryRide?.driverData?.vehicleNo || 'RJ 14 TA 6767',
      phone: driver?.phone || memoryRide?.driverData?.phone || '',
      upiId: driver?.upiId || '67cabs@upi',
      photo: driver?.documents?.selfiePhoto || memoryRide?.driverData?.photo || ''
    };

    const startOtp = trip?.otp || Math.floor(1000 + Math.random() * 9000).toString();
    const finalFare = trip ? trip.totalFare : (memoryRide ? memoryRide.totalFare : 0);
    const resolvedRiderPhone = trip?.riderData?.phone || memoryRide?.riderData?.phone || '';

    const updatedTrip = await Trip.findOneAndUpdate(
      { rideId },
      {
        $set: {
          status: 'ACCEPTED',
          driverData: driverPayload,
          otp: startOtp
        }
      },
      { new: true, upsert: true }
    );

    if (memoryRide) {
      memoryRide.status = 'ACCEPTED';
      memoryRide.driverData = driverPayload;
      memoryRide.otp = startOtp;
      activeRides.set(rideId, memoryRide);

      if (memoryRide.riderSocketId) {
        io.to(memoryRide.riderSocketId).emit('ride:accepted', {
          rideId,
          driver: driverPayload,
          otp: startOtp,
          fare: finalFare,
          driverPhone: driverPayload.phone
        });
      }
    }

    io.emit(`ride:accepted:${rideId}`, {
      rideId,
      driver: driverPayload,
      otp: startOtp,
      fare: finalFare,
      driverPhone: driverPayload.phone
    });
    io.emit('ride:accepted', {
      rideId,
      driver: driverPayload,
      otp: startOtp,
      fare: finalFare,
      driverPhone: driverPayload.phone
    });
    io.emit('ride:taken', { rideId });

    if (driverId) {
      io.to(`driver:${driverId}`).emit('driver:ride_confirmed', {
        rideId,
        pickup: updatedTrip.pickup,
        drop: updatedTrip.drop || updatedTrip.stops?.[0],
        totalFare: finalFare,
        riderName: updatedTrip.riderData?.name || 'Rider',
        riderPhone: resolvedRiderPhone
      });
    }

    return res.json({ success: true, trip: updatedTrip });
  } catch (err) {
    console.error('Accept-bg error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ride/decline', async (req, res) => {
  try {
    const { rideId } = req.body;
    if (!rideId) return res.status(400).json({ success: false, message: 'Ride ID required.' });

    if (rideTimeoutTimers.has(rideId)) {
      clearTimeout(rideTimeoutTimers.get(rideId));
      rideTimeoutTimers.delete(rideId);
    }

    const ride = activeRides.get(rideId);
    if (ride && ride.riderSocketId) {
      io.to(ride.riderSocketId).emit('ride:declined_targeted', { 
        rideId, 
        message: 'Driver is currently unavailable.' 
      });
    } else {
      io.emit(`ride:declined_targeted:${rideId}`, { 
        rideId, 
        message: 'Driver is currently unavailable.' 
      });
    }
    
    activeRides.delete(rideId);
    await Trip.updateOne({ rideId }, { status: 'CANCELLED' }).catch(() => {});

    return res.json({ success: true, message: 'Ride declined.' });
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
          { cleanPhone },
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
        { cleanPhone },
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

// ---------------- DRIVER AUTH, ONBOARDING & DOCUMENTS ROUTES ----------------
app.get('/api/driver/documents/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    const driver = await Driver.findOne({ driverId }).select('documents status name vehicleNo cabType');
    if (!driver) return res.status(404).json({ success: false, message: 'Driver nahi mila.' });
    return res.json({ success: true, documents: driver.documents || {}, status: driver.status, driver });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/driver/update-documents', async (req, res) => {
  try {
    const { driverId, documents } = req.body;
    if (!driverId || !documents) {
      return res.status(400).json({ success: false, message: 'Driver ID and documents required.' });
    }

    const driver = await Driver.findOne({ driverId });
    if (!driver) return res.status(404).json({ success: false, message: 'Driver nahi mila.' });

    const mergedDocs = { ...driver.documents.toObject(), ...documents };
    driver.documents = mergedDocs;
    driver.status = 'PENDING_APPROVAL';
    driver.isOnline = false;
    await driver.save();

    await DriverLocation.updateOne({ driverId }, { isOnline: false });
    activeDrivers.delete(driverId);

    io.emit(`driver:status:${driverId}`, { status: 'PENDING_APPROVAL' });
    io.to(COMMON_CAB_ROOM).emit('drivers:updated', Array.from(activeDrivers.values()));

    return res.json({ success: true, message: 'Documents submitted for Admin re-verification!', driver });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/driver/signup-fast', async (req, res) => {
  try {
    const { name, phone, password, vehicleNo, cabType, referralCode, documents } = req.body;
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
      documents: documents || {},
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
        documents: newDriver.documents
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
app.post('/api/fare/estimate', async (req, res) => {
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
      cabType: cabType ? cabType.toUpperCase() : 'HATCHBACK',
      pricingConfig: cachedFareConfig
    });

    return res.status(200).json({ success: true, data: fareData });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/cabs/nearby-all', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const driversList = [];

    activeDrivers.forEach((d, driverId) => {
      const isSocketConnected = driverSocketMap.has(driverId);
      if (isSocketConnected && d.isOnline === true && d.status === 'APPROVED' && d.location && d.location.lat && d.location.lng) {
        driversList.push({
          id: d.driverId,
          name: d.name,
          category: (d.cabType || 'HATCHBACK').toUpperCase(),
          lat: d.location.lat,
          lng: d.location.lng
        });
      }
    });

    return res.json({ success: true, drivers: driversList });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/cabs/nearby', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const cabType = (req.query.cabType || 'HATCHBACK').toUpperCase();
    let liveDriver = null;
    activeDrivers.forEach((d, driverId) => {
      const isSocketConnected = driverSocketMap.has(driverId);
      if (isSocketConnected && d.cabType === cabType && d.isOnline === true && d.status === 'APPROVED' && d.location && d.location.lat) {
        liveDriver = d;
      }
    });

    if (liveDriver && liveDriver.location) {
      return res.json({ 
        success: true, 
        driverCoords: [liveDriver.location.lat, liveDriver.location.lng] 
      });
    }

    return res.json({ success: false, driverCoords: null });
  } catch (e) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Common Global Communication Room for Rider and Driver Synchronization
const COMMON_CAB_ROOM = 'global_live_cabs_room';

io.on('connection', (socket) => {
  console.log(`⚡ Device Connected: ${socket.id}`);
  socket.join(COMMON_CAB_ROOM);

  // 1. Driver Online Registration & Permanent Room Join
  socket.on('driver:register', async (driverData) => {
    const normalizedCabType = (driverData.cabType || 'HATCHBACK').toUpperCase();
    const driverId = driverData.driverId || socket.id;

    socket.join(`driver:${driverId}`);
    socket.join(COMMON_CAB_ROOM);
    driverSocketMap.set(driverId, socket.id);

    const isOnlineState = driverData.isOnline === true;
    const existingEntry = activeDrivers.get(driverId);
    const loc = driverData.location || (existingEntry ? existingEntry.location : null);

    if (isOnlineState) {
      activeDrivers.set(driverId, {
        driverId,
        name: driverData.name,
        vehicleNo: driverData.vehicleNo,
        phone: driverData.phone || '',
        cabType: normalizedCabType,
        upiId: driverData.upiId || '67cabs@upi',
        status: driverData.status || 'APPROVED',
        isOnline: true,
        location: loc,
        socketId: socket.id
      });
    } else {
      activeDrivers.delete(driverId);
    }

    try {
      await Driver.updateOne({ driverId }, { isOnline: isOnlineState });
      if (loc && loc.lat) {
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
      }
    } catch (e) {}

    // Broadcast driver availability immediately to all active riders
    io.to(COMMON_CAB_ROOM).emit('drivers:updated', Array.from(activeDrivers.values()));
  });

  socket.on('driver:ping_alive', async ({ driverId }) => {
    if (!driverId) return;
    if (activeDrivers.has(driverId)) {
      const d = activeDrivers.get(driverId);
      d.isOnline = true;
      d.socketId = socket.id;
      activeDrivers.set(driverId, d);
    }
    driverSocketMap.set(driverId, socket.id);
    socket.join(`driver:${driverId}`);
    socket.join(COMMON_CAB_ROOM);
  });

  socket.on('driver:toggle_online', async ({ driverId, isOnline }) => {
    if (!driverId) return;
    
    if (isOnline) {
      const d = activeDrivers.get(driverId);
      if (d) {
        d.isOnline = true;
        d.socketId = socket.id;
      }
      socket.join(`driver:${driverId}`);
      socket.join(COMMON_CAB_ROOM);
      driverSocketMap.set(driverId, socket.id);
    } else {
      activeDrivers.delete(driverId);
    }

    try {
      await Driver.updateOne({ driverId }, { isOnline: !!isOnline });
      await DriverLocation.updateOne({ driverId }, { isOnline: !!isOnline, lastActive: new Date() });
    } catch (e) {}

    console.log(`📡 Driver ${driverId} status updated: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
    io.to(COMMON_CAB_ROOM).emit('drivers:updated', Array.from(activeDrivers.values()));
  });

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
    io.to(COMMON_CAB_ROOM).emit('drivers:updated', Array.from(activeDrivers.values()));
  });

  // 2. Targeted 1-Click Ride Request
  socket.on('ride:request_targeted', async (rideData) => {
    const { rideId, targetDriverId, pickup, stops, cabCategory, totalDistanceKm, totalFare, rider, pickupName, dropName, drop } = rideData;

    const ridePayload = {
      rideId,
      cabType: cabCategory,
      pickup,
      pickupName: pickupName || (pickup ? pickup.text : 'Jaipur Pickup Point'),
      stops: stops || [],
      drop: drop || stops?.[0] || pickup,
      dropName: dropName || (drop ? drop.text : 'Drop Destination'),
      totalDistanceKm: totalDistanceKm || 0,
      totalFare: Number(totalFare) || 0,
      riderData: rider,
      riderSocketId: socket.id,
      targetDriverId: targetDriverId ? targetDriverId.trim() : '',
      status: 'SEARCHING',
      soundName: globalActiveSound,
      startTime: new Date()
    };
    activeRides.set(rideId, ridePayload);

    try {
      await Trip.create(ridePayload);
    } catch (dbErr) {}

    const isMemoryOnline = activeDrivers.has(targetDriverId) && activeDrivers.get(targetDriverId).isOnline === true;
    const dbDriver = await Driver.findOne({ driverId: targetDriverId, status: 'APPROVED' });

    if (isMemoryOnline || dbDriver) {
      // 1. Room-level broadcast
      io.to(`driver:${targetDriverId}`).emit('ride:new_offer', ridePayload);
      
      // 2. Direct Socket ID target
      const sId = driverSocketMap.get(targetDriverId);
      if (sId) {
        io.to(sId).emit('ride:new_offer', ridePayload);
      }

      // 3. Global Common Room fallback
      io.to(COMMON_CAB_ROOM).emit(`ride:offer_for_${targetDriverId}`, ridePayload);
      io.to(COMMON_CAB_ROOM).emit('ride:new_offer', ridePayload);
      io.emit('ride:new_offer', ridePayload);
      io.emit(`ride:offer_for_${targetDriverId}`, ridePayload);
      io.emit(`ride:new_offer:${targetDriverId}`, ridePayload);

      console.log(`🎯 Targeted Ride ${rideId} dispatched to Driver: ${targetDriverId} with sound: ${globalActiveSound}`);

      if (rideTimeoutTimers.has(rideId)) {
        clearTimeout(rideTimeoutTimers.get(rideId));
      }

      const timer = setTimeout(async () => {
        const currentRide = activeRides.get(rideId);
        if (currentRide && currentRide.status === 'SEARCHING') {
          console.log(`⏱️ Targeted Ride ${rideId} timed out after 15 seconds.`);
          if (currentRide.riderSocketId) {
            io.to(currentRide.riderSocketId).emit('ride:declined_targeted', { 
              rideId, 
              message: 'Driver did not respond within 15 seconds.' 
            });
          }
          io.emit(`ride:declined_targeted:${rideId}`, {
            rideId,
            message: 'Driver did not respond within 15 seconds.'
          });
          activeRides.delete(rideId);
          rideTimeoutTimers.delete(rideId);
          await Trip.updateOne({ rideId }, { status: 'CANCELLED' }).catch(() => {});
        }
      }, 15000);

      rideTimeoutTimers.set(rideId, timer);

    } else {
      socket.emit('ride:declined_targeted', { rideId, message: 'Driver is currently offline.' });
      activeRides.delete(rideId);
    }
  });

  socket.on('ride:decline_targeted', ({ rideId }) => {
    if (rideTimeoutTimers.has(rideId)) {
      clearTimeout(rideTimeoutTimers.get(rideId));
      rideTimeoutTimers.delete(rideId);
    }

    const ride = activeRides.get(rideId);
    if (ride && ride.riderSocketId) {
      io.to(ride.riderSocketId).emit('ride:declined_targeted', { 
        rideId, 
        message: 'Driver declined the ride request.' 
      });
    }
    io.emit(`ride:declined_targeted:${rideId}`, { 
      rideId, 
      message: 'Driver declined the ride request.' 
    });
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
      soundName: globalActiveSound,
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
      if (driver.status === 'APPROVED' && driver.isOnline === true && (driver.cabType === requestedCabType || requestedCabType === 'ALL')) {
        io.to(`driver:${driver.driverId}`).emit('ride:new_offer', ridePayload);
      }
    });
    io.to(COMMON_CAB_ROOM).emit('ride:new_offer', ridePayload);
    io.emit('ride:new_offer', ridePayload);

    if (rideTimeoutTimers.has(rideId)) {
      clearTimeout(rideTimeoutTimers.get(rideId));
    }

    const bTimer = setTimeout(async () => {
      const currentRide = activeRides.get(rideId);
      if (currentRide && currentRide.status === 'SEARCHING') {
        if (currentRide.riderSocketId) {
          io.to(currentRide.riderSocketId).emit('ride:declined_targeted', { 
            rideId,
            message: 'No nearby driver accepted the ride in 15 seconds.' 
          });
        }
        io.emit(`ride:declined_targeted:${rideId}`, { 
          rideId,
          message: 'No nearby driver accepted the ride in 15 seconds.' 
        });
        activeRides.delete(rideId);
        rideTimeoutTimers.delete(rideId);
        await Trip.updateOne({ rideId }, { status: 'CANCELLED' }).catch(() => {});
      }
    }, 15000);

    rideTimeoutTimers.set(rideId, bTimer);
  });

  socket.on('ride:cancel', async ({ rideId }) => {
    try {
      if (rideTimeoutTimers.has(rideId)) {
        clearTimeout(rideTimeoutTimers.get(rideId));
        rideTimeoutTimers.delete(rideId);
      }

      const existingTrip = await Trip.findOne({ rideId });
      await Trip.updateOne(
        { rideId }, 
        { $set: { status: 'CANCELLED', isRiderDismissed: true, isDriverDismissed: true } }
      );
      
      const memoryRide = activeRides.get(rideId);
      const assignedDriverId = existingTrip?.driverData?.driverId || memoryRide?.targetDriverId || memoryRide?.driverData?.driverId;
      
      activeRides.delete(rideId);
      
      if (assignedDriverId) {
        if (activeDrivers.has(assignedDriverId)) {
          const d = activeDrivers.get(assignedDriverId);
          d.isOnline = true;
          activeDrivers.set(assignedDriverId, d);
        }
        await Driver.updateOne({ driverId: assignedDriverId }, { isOnline: true }).catch(() => {});
        await DriverLocation.updateOne({ driverId: assignedDriverId }, { isOnline: true, lastActive: new Date() }).catch(() => {});
        io.to(`driver:${assignedDriverId}`).emit('ride:cancelled', { rideId });
      }

      io.to(COMMON_CAB_ROOM).emit('ride:cancelled', { rideId });
      io.emit('ride:cancelled', { rideId });
      io.emit('ride:taken', { rideId });
    } catch (e) {
      console.error('Cancel ride error:', e);
    }
  });

  // Rider Rejection for Driver or Cab Mismatch
  socket.on('ride:rider_rejected_driver', async ({ rideId, reason }) => {
    try {
      if (rideTimeoutTimers.has(rideId)) {
        clearTimeout(rideTimeoutTimers.get(rideId));
        rideTimeoutTimers.delete(rideId);
      }

      const trip = await Trip.findOneAndUpdate(
        { rideId }, 
        { 
          $set: { 
            status: 'CANCELLED', 
            earlyDropReason: reason || 'RIDER_REPORTED_MISMATCH',
            isRiderDismissed: true, 
            isDriverDismissed: true 
          } 
        },
        { new: true }
      );

      const driverId = trip?.driverData?.driverId;
      activeRides.delete(rideId);

      if (driverId) {
        io.to(`driver:${driverId}`).emit('ride:cancelled_by_rider_mismatch', {
          rideId,
          message: '⚠️ Rider cancelled: Driver face or Vehicle plate mismatched.'
        });
      }

      io.emit(`ride:cancelled:${rideId}`, { rideId, message: 'Trip cancelled due to mismatch.' });
      io.to(COMMON_CAB_ROOM).emit('ride:cancelled', { rideId });
    } catch (e) {
      console.error('Error on rider rejected driver:', e);
    }
  });

  // 3. Driver Accepts Ride
  socket.on('ride:accept', async ({ rideId, driverData }) => {
    if (rideTimeoutTimers.has(rideId)) {
      clearTimeout(rideTimeoutTimers.get(rideId));
      rideTimeoutTimers.delete(rideId);
    }

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

    let dbDriver = null;
    const targetDrvId = registeredDriver ? registeredDriver.driverId : (driverData?.driverId || 'DRV_DEFAULT');
    if (targetDrvId) {
      dbDriver = await Driver.findOne({ driverId: targetDrvId });
    }

    const resolvedDriverPhone = registeredDriver?.phone || driverData?.phone || dbDriver?.phone || '';
    const resolvedDriverPhoto = dbDriver?.documents?.selfiePhoto || driverData?.photo || '';

    const assignedDriverData = {
      driverId: targetDrvId,
      name: registeredDriver ? registeredDriver.name : (driverData?.name || dbDriver?.name || 'Partner Driver'),
      vehicleNo: registeredDriver ? registeredDriver.vehicleNo : (driverData?.vehicleNo || dbDriver?.vehicleNo || 'RJ 14 TA 6767'),
      phone: resolvedDriverPhone,
      upiId: registeredDriver ? registeredDriver.upiId : (driverData?.upiId || dbDriver?.upiId || '67cabs@upi'),
      photo: resolvedDriverPhoto
    };

    let tripDoc = null;
    try {
      tripDoc = await Trip.findOneAndUpdate(
        { rideId }, 
        { 
          $set: { 
            status: 'ACCEPTED', 
            driverData: assignedDriverData, 
            otp: startOtp 
          } 
        },
        { new: true, upsert: true }
      );
      if (tripDoc) finalTotalFare = tripDoc.totalFare;
    } catch (e) {}

    const resolvedRiderPhone = ride?.riderData?.phone || tripDoc?.riderData?.phone || '';
    const resolvedRiderName = ride?.riderData?.name || tripDoc?.riderData?.name || 'Rider';

    if (ride) {
      ride.status = 'ACCEPTED';
      ride.driverSocketId = socket.id;
      ride.driverData = assignedDriverData;
      ride.otp = startOtp;
      activeRides.set(rideId, ride);

      if (ride.riderSocketId) {
        io.to(ride.riderSocketId).emit('ride:accepted', {
          rideId,
          driver: assignedDriverData,
          otp: startOtp,
          fare: finalTotalFare,
          driverPhone: resolvedDriverPhone
        });
      }
    }

    io.emit(`ride:accepted:${rideId}`, {
      rideId,
      driver: assignedDriverData,
      otp: startOtp,
      fare: finalTotalFare,
      driverPhone: resolvedDriverPhone
    });
    io.to(COMMON_CAB_ROOM).emit('ride:accepted', {
      rideId,
      driver: assignedDriverData,
      otp: startOtp,
      fare: finalTotalFare,
      driverPhone: resolvedDriverPhone
    });

    socket.emit('driver:ride_confirmed', {
      rideId,
      pickup: ride?.pickup,
      drop: ride?.drop || ride?.stops?.[0],
      totalFare: finalTotalFare,
      riderName: resolvedRiderName,
      riderPhone: resolvedRiderPhone
    });

    socket.broadcast.emit('ride:taken', { rideId });
    io.emit('ride:taken', { rideId });
  });

  socket.on('driver:arrived', async ({ rideId }) => {
    const ride = activeRides.get(rideId);
    let driverData = ride?.driverData;

    if (!driverData) {
      const trip = await Trip.findOne({ rideId });
      driverData = trip?.driverData;
    }

    if (ride) {
      ride.status = 'ARRIVED';
      activeRides.set(rideId, ride);
      if (ride.riderSocketId) {
        io.to(ride.riderSocketId).emit('ride:driver_arrived', { 
          rideId, 
          driver: driverData,
          message: '🚖 Driver has arrived at your pickup location!' 
        });
      }
    }
    await Trip.updateOne({ rideId }, { status: 'ARRIVED' }).catch(() => {});
    io.emit(`ride:driver_arrived:${rideId}`, {
      rideId,
      driver: driverData,
      message: '🚖 Driver has arrived at your pickup location!'
    });
    io.emit('ride:driver_arrived', {
      rideId,
      driver: driverData,
      message: '🚖 Driver has arrived at your pickup location!'
    });
  });

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

  socket.on('ride:early_complete_emergency', async ({ rideId, reason }) => {
    const ride = activeRides.get(rideId);
    const baseMinFare = 60;
    const reducedFare = ride ? Math.max(baseMinFare, Math.round(ride.totalFare * 0.55)) : baseMinFare;

    completeTripFinal(rideId, reducedFare, true, reason || 'DRIVER_EMERGENCY');
  });

  socket.on('ride:complete', async ({ rideId }) => {
    const trip = await Trip.findOne({ rideId });
    const ride = activeRides.get(rideId);
    const totalFare = trip ? trip.totalFare : (ride ? ride.totalFare : 0);
    completeTripFinal(rideId, totalFare, false, 'STANDARD_DROP');
  });

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
    } catch (err) {}
  });

  async function completeTripFinal(rideId, finalAmount, isEarlyDrop, settlementReason) {
    const ride = activeRides.get(rideId);
    let upiId = ride?.driverData?.upiId || '67cabs@upi';

    try {
      const completedTrip = await Trip.findOneAndUpdate(
        { rideId }, 
        { 
          $set: { 
            status: 'COMPLETED', 
            finalFare: finalAmount, 
            isEarlyDrop, 
            earlyDropReason: settlementReason, 
            isRiderDismissed: false, 
            isDriverDismissed: false, 
            endTime: new Date() 
          } 
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
          }
        }
      }
    } catch (dbErr) {}

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
  }

  socket.on('disconnect', async () => {
    let disconnectedDriverId = null;
    driverSocketMap.forEach((sId, dId) => {
      if (sId === socket.id) disconnectedDriverId = dId;
    });

    if (disconnectedDriverId) {
      // 5-second grace period for quick reconnects/app tab switching
      setTimeout(async () => {
        const currentSocketId = driverSocketMap.get(disconnectedDriverId);
        if (currentSocketId === socket.id) {
          driverSocketMap.delete(disconnectedDriverId);
          activeDrivers.delete(disconnectedDriverId);

          try {
            await Driver.updateOne({ driverId: disconnectedDriverId }, { isOnline: false });
            await DriverLocation.updateOne({ driverId: disconnectedDriverId }, { isOnline: false });
          } catch (e) {}

          console.log(`📡 Driver ${disconnectedDriverId} disconnected and purged from radar.`);
          io.to(COMMON_CAB_ROOM).emit('drivers:updated', Array.from(activeDrivers.values()));
        }
      }, 5000);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚖 67 Cabs Server live on http://localhost:${PORT}`);
});