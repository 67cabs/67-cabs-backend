// 67 Cabs - Master Pricing Engine (MongoDB Dynamic Data-Driven)

const DEFAULT_PRICING_CONFIG = {
  HATCHBACK: { perKmRate: 16, minBaseFare: 50 },
  SEDAN: { perKmRate: 20, minBaseFare: 70 },
  SUV: { perKmRate: 25, minBaseFare: 100 },
  rates: {
    pickupRatePerKm: 10,
    trafficRatePer5Min: 10
  }
};

const calculateMasterFare = ({
  tripDistanceKm = 0,
  tripTrafficMins = 0,
  pickupDistanceKm = 0,
  pickupTrafficMins = 0,
  cabType = 'HATCHBACK',
  pricingConfig = null
}) => {
  const category = (cabType || 'HATCHBACK').toUpperCase();

  // 1. Resolve Dynamic Category Rates from MongoDB or Fallback Defaults
  let perKmRate = 16;
  let minBaseFare = 50;
  let pickupRatePerKm = 10;
  let trafficRatePer5Min = 10;

  if (pricingConfig) {
    const catConfig = pricingConfig[category] || pricingConfig['HATCHBACK'];
    if (catConfig) {
      if (catConfig.perKm !== undefined) perKmRate = Number(catConfig.perKm);
      else if (catConfig.perKmRate !== undefined) perKmRate = Number(catConfig.perKmRate);

      if (catConfig.baseFare !== undefined) minBaseFare = Number(catConfig.baseFare);
      else if (catConfig.minBaseFare !== undefined) minBaseFare = Number(catConfig.minBaseFare);
      else if (catConfig.minFare !== undefined) minBaseFare = Number(catConfig.minFare);
    }

    if (pricingConfig.rates) {
      if (pricingConfig.rates.pickupPerKm !== undefined) {
        pickupRatePerKm = Number(pricingConfig.rates.pickupPerKm);
      } else if (pricingConfig.rates.pickupRatePerKm !== undefined) {
        pickupRatePerKm = Number(pricingConfig.rates.pickupRatePerKm);
      }

      if (pricingConfig.rates.trafficRatePer5Min !== undefined) {
        trafficRatePer5Min = Number(pricingConfig.rates.trafficRatePer5Min);
      } else if (pricingConfig.rates.tripTrafficPerMin !== undefined) {
        trafficRatePer5Min = Number(pricingConfig.rates.tripTrafficPerMin) * 5;
      }
    }
  } else {
    // Default Hardcoded Fallbacks
    const perKmRates = { HATCHBACK: 16, SEDAN: 20, SUV: 25 };
    const baseThresholds = { HATCHBACK: 50, SEDAN: 70, SUV: 100 };
    perKmRate = perKmRates[category] || 16;
    minBaseFare = baseThresholds[category] || 50;
    pickupRatePerKm = DEFAULT_PRICING_CONFIG.rates.pickupRatePerKm;
    trafficRatePer5Min = DEFAULT_PRICING_CONFIG.rates.trafficRatePer5Min;
  }

  const numTripDist = Math.max(0, Number(tripDistanceKm) || 0);
  const numTripTraffic = Math.max(0, Number(tripTrafficMins) || 0);
  const numPickupDist = Math.max(0, Number(pickupDistanceKm) || 0);
  const numPickupTraffic = Math.max(0, Number(pickupTrafficMins) || 0);

  // 1. Trip Base Fare (Includes Multi-Stop aggregate distance)
  const calculatedBaseFare = Math.round(numTripDist * perKmRate);
  const baseTripFare = Math.max(minBaseFare, calculatedBaseFare);

  // 2. Trip Traffic Delay (Standard SLA: 3 mins per km)
  const tripStandardMins = Math.round(numTripDist * 3);
  let tripDelayMins = 0;
  let tripTrafficCharge = 0;
  if (numTripTraffic > tripStandardMins) {
    tripDelayMins = numTripTraffic - tripStandardMins;
    tripTrafficCharge = Math.ceil(tripDelayMins / 5) * trafficRatePer5Min;
  }

  // 3. Pickup Distance Charge (Driver proximity dynamic buffer)
  // Note: Pickup < 150m is treated as 0 km charge
  const pickupBaseFare = Math.round(numPickupDist * pickupRatePerKm);

  // 4. Pickup Traffic Delay
  const pickupStandardMins = Math.round(numPickupDist * 3);
  let pickupDelayMins = 0;
  let pickupTrafficCharge = 0;
  if (numPickupTraffic > pickupStandardMins) {
    pickupDelayMins = numPickupTraffic - pickupStandardMins;
    pickupTrafficCharge = Math.ceil(pickupDelayMins / 5) * trafficRatePer5Min;
  }

  // Final Total for Fixed Fare
  const totalFixedFare = baseTripFare + tripTrafficCharge + pickupBaseFare + pickupTrafficCharge;

  return {
    cabType: category,
    breakdown: {
      trip: {
        distanceKm: numTripDist,
        baseFare: baseTripFare,
        delayMins: tripDelayMins,
        trafficCharge: tripTrafficCharge
      },
      pickup: {
        distanceKm: numPickupDist,
        baseFare: pickupBaseFare,
        delayMins: pickupDelayMins,
        trafficCharge: pickupTrafficCharge
      }
    },
    fixedFare: totalFixedFare,
    totalFare: totalFixedFare, // Added alias for seamless backward compatibility
    dynamicEstimate: {
      minFare: Math.round(baseTripFare + pickupBaseFare),
      maxFare: Math.round(totalFixedFare + 30)
    }
  };
};

module.exports = { calculateMasterFare, DEFAULT_PRICING_CONFIG };