const mongoose = require('mongoose');

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
    enum: ['PERCENTAGE', 'FLAT'], // Percentage (e.g. 10%) ya Flat Amount (e.g. ₹50)
    required: true
  },
  discountValue: {
    type: Number,
    required: true,
    min: 0
  },
  maxDiscountAmount: {
    type: Number, // Percentage case ke liye maximum cap (e.g. Max ₹100 off)
    default: null
  },
  minRechargeAmount: {
    type: Number,
    default: 0 // Minimum kitne ka recharge hona chahiye
  },
  // Dedicated vs Global Target
  targetType: {
    type: String,
    enum: ['ALL', 'SPECIFIC'], // 'ALL' = sabhi drivers, 'SPECIFIC' = selected drivers
    default: 'ALL'
  },
  allowedDrivers: [{
    type: String, // Driver ID ya Driver Phone Number yahan store hoga
    trim: true
  }],
  usageLimitPerDriver: {
    type: Number,
    default: 1 // Ek driver is coupon ko kitni baar use kar sakta hai
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

module.exports = mongoose.model('Coupon', couponSchema);