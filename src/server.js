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

// Middlewares (Increased payload limits for document & photo uploads)
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
  walletBalance: { type: Number, default: 150 },
  bonusFreeRides: { type: Number, default: 3 },
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

// 2. Rider Account Schema (MongoDB Persistence)
const riderSchema = new mongoose.Schema({
  riderId: { type: String, required: true, unique: true, index: true },
  phone: { type: String, required: true, index: true },
  name: { type: String, required: true },
  referralCode: { type: String, default: '' },
  govIdNumber: { type: String, default: '' },
  documents: {
    govIdFront: { type: String, default: '' },
    govIdBack: { type: String, default: '' }
  },
  walletBalance: { type: Number, default: 50 },
  bonusFreeRides: { type: Number, default: 1 },
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

// ---------------- RIDER AUTH & KYC ROUTES (MONGODB SYNC) ----------------

// Fast 5-Sec Rider Signup API
app.post('/api/rider/signup', async (req, res) => {
  try {
    const { name, phone, referralCode } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'Name aur Phone number zaroori hain.' });
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
      return res.json({
        success: true,
        message: 'Welcome back! Logged in successfully.',
        rider: existing
      });
    }

    const riderId = `RDR_${Date.now()}`;
    const newRider = await Rider.create({
      riderId,
      name: name.trim(),
      phone: cleanPhone,
      referralCode: referralCode ? referralCode.trim() : '',
      walletBalance: 50,
      bonusFreeRides: 1,
      isKycDone: false,
      status: 'ACTIVE'
    });

    return res.status(201).json({
      success: true,
      message: 'Rider account successfully created!',
      rider: newRider
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Rider KYC Upload API (ID Verification)
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

// Rider Self-Delete Account API
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
      walletBalance: 150,
      bonusFreeRides: 3,
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
      walletBalance: 150,
      bonusFreeRides: 3,
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
        walletBalance: driver.walletBalance || 150,
        bonusFreeRides: driver.bonusFreeRides || 3,
        status: driver.status,
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

app.get('/api/cabs/nearby-all', async (req, res) => {
  try {
    const driversList = [];
    activeDrivers.forEach((d) => {
      if (d.status === 'APPROVED' && d.location && d.location.lat) {
        driversList.push({
          id: d.driverId,
          name: d.name,
          category: d.cabType,
          vehicleNo: d.vehicleNo,
          lat: d.location.lat,
          lng: d.location.lng
        });
      }
    });

    if (driversList.length === 0) {
      const dbLocations = await DriverLocation.find().sort({ lastActive: -1 }).limit(20);
      dbLocations.forEach((dl) => {
        if (dl.location && dl.location.lat) {
          driversList.push({
            id: dl.driverId,
            name: dl.name,
            category: dl.cabType || 'HATCHBACK',
            vehicleNo: dl.vehicleNo || 'RJ 14 TA 6767',
            lat: dl.location.lat,
            lng: dl.location.lng
          });
        }
      });
    }

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

// Real-Time In-Memory Maps
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
      status: driverData.status || 'APPROVED',
      location: driverData.location || null,
      socketId: socket.id
    });

    if (driverData.location && driverData.location.lat) {
      try {
        await DriverLocation.findOneAndUpdate(
          { driverId },
          {
            name: driverData.name || 'Driver',
            cabType: normalizedCabType,
            vehicleNo: driverData.vehicleNo || 'RJ 14 TA 6767',
            location: { lat: driverData.location.lat, lng: driverData.location.lng },
            lastActive: new Date()
          },
          { upsert: true }
        );
      } catch (e) {}
    }
  });

  // 2. Targeted 1-Click Ride Request
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

    let targetedSocketId = null;
    activeDrivers.forEach((driver, sId) => {
      if (driver.driverId === targetDriverId) {
        targetedSocketId = sId;
      }
    });

    if (targetedSocketId) {
      io.to(targetedSocketId).emit('ride:new_offer', ridePayload);
      console.log(`🎯 Targeted Ride ${rideId} dispatched to Driver: ${targetDriverId}`);
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

    activeDrivers.forEach((driver, driverSocketId) => {
      if (driver.status === 'APPROVED' && (driver.cabType === requestedCabType || requestedCabType === 'ALL')) {
        io.to(driverSocketId).emit('ride:new_offer', ridePayload);
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
    } catch (e) {
      console.error('Cancel Error:', e.message);
    }
  });

  // 3. Driver Accepts Ride
  socket.on('ride:accept', async ({ rideId, driverData }) => {
    const ride = activeRides.get(rideId);
    const registeredDriver = activeDrivers.get(socket.id);

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
            ...driverData,
            driverId: registeredDriver ? registeredDriver.driverId : '',
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
  });

  // 3.2 GPS Telemetry Update
  socket.on('driver:location_update', async ({ rideId, lat, lng, phase, heading }) => {
    const d = activeDrivers.get(socket.id);
    if (d) d.location = { lat, lng };

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

  // 4. Start Trip OTP Verification
  socket.on('ride:verify_otp', async ({ rideId, enteredOtp }) => {
    const trip = await Trip.findOne({ rideId });
    const ride = activeRides.get(rideId);
    const validOtp = trip ? trip.otp : (ride ? ride.otp : null);

    if (!validOtp) return socket.emit('ride:error', { message: 'Trip session not found' });

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

      await Trip.updateOne({ rideId }, { status: 'ONGOING', startTime: now }).catch(() => {});
      io.emit(`ride:started:${rideId}`, { rideId });
      socket.emit('ride:started_driver_view', { rideId });
    } else {
      socket.emit('ride:otp_invalid', { message: 'Galat OTP! Kripya Rider se pooch kar sahi 4-digit OTP dalein.' });
    }
  });

  // 4.1 Rider Generates Early Drop OTP
  socket.on('ride:early_drop_request', async ({ rideId, earlyOtp }) => {
    const strOtp = earlyOtp ? earlyOtp.toString().trim() : '';
    const ride = activeRides.get(rideId);
    if (ride) {
      ride.earlyDropOtp = strOtp;
      activeRides.set(rideId, ride);
    }
    await Trip.updateOne({ rideId }, { earlyDropOtp: strOtp }).catch(() => {});
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
      await Trip.updateOne({ rideId }, { rating: Number(rating) || 5 });
    } catch (err) {}
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
          endTime: new Date() 
        },
        { new: true }
      );
      if (completedTrip?.driverData?.upiId) {
        upiId = completedTrip.driverData.upiId;
      }
    } catch (dbErr) {}

    const completionPayload = {
      rideId,
      finalFare: finalAmount,
      driverUpiId: upiId,
      isEarlyDrop
    };

    if (ride?.riderSocketId) {
      io.to(ride.riderSocketId).emit('ride:completed', completionPayload);
    }
    io.emit(`ride:completed:${rideId}`, completionPayload);
    io.emit('ride:completed', completionPayload);
    socket.emit('ride:completed', completionPayload);

    activeRides.delete(rideId);
  }

  socket.on('disconnect', () => {
    activeDrivers.delete(socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚖 67 Cabs Server live on http://localhost:${PORT}`);
});