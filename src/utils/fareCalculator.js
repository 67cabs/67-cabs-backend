// 67 Cabs - Master Pricing Engine
const calculateMasterFare = ({
  tripDistanceKm,
  tripTrafficMins,
  pickupDistanceKm = 0,
  pickupTrafficMins = 0,
  cabType = 'HATCHBACK'
}) => {
  // Category Base Rates per KM (Jaipur Intra-City Standard)
  const perKmRates = { HATCHBACK: 16, SEDAN: 20, SUV: 25 };
  const perKmRate = perKmRates[cabType] || 16;
  
  // Dynamic pickup distance rate buffer
  const pickupRatePerKm = 10;
  const trafficRatePer5Min = 10;

  // Minimum base threshold fare per category
  const baseThresholds = { HATCHBACK: 50, SEDAN: 70, SUV: 100 };
  const minBaseFare = baseThresholds[cabType] || 50;

  // 1. Trip Base Fare (Includes Multi-Stop aggregate distance)
  const calculatedBaseFare = Math.round(tripDistanceKm * perKmRate);
  const baseTripFare = Math.max(minBaseFare, calculatedBaseFare);

  // 2. Trip Traffic Delay (Standard SLA: 3 mins per km)
  const tripStandardMins = Math.round(tripDistanceKm * 3);
  let tripDelayMins = 0;
  let tripTrafficCharge = 0;
  if (tripTrafficMins > tripStandardMins) {
    tripDelayMins = tripTrafficMins - tripStandardMins;
    tripTrafficCharge = Math.ceil(tripDelayMins / 5) * trafficRatePer5Min;
  }

  // 3. Pickup Distance Charge (Driver proximity dynamic buffer)
  // Note: Pickup < 150m is treated as 0 km charge
  const pickupBaseFare = Math.round(pickupDistanceKm * pickupRatePerKm);

  // 4. Pickup Traffic Delay
  const pickupStandardMins = Math.round(pickupDistanceKm * 3);
  let pickupDelayMins = 0;
  let pickupTrafficCharge = 0;
  if (pickupTrafficMins > pickupStandardMins) {
    pickupDelayMins = pickupTrafficMins - pickupStandardMins;
    pickupTrafficCharge = Math.ceil(pickupDelayMins / 5) * trafficRatePer5Min;
  }

  // Final Total for Fixed Fare
  const totalFixedFare = baseTripFare + tripTrafficCharge + pickupBaseFare + pickupTrafficCharge;

  return {
    cabType,
    breakdown: {
      trip: {
        distanceKm: tripDistanceKm,
        baseFare: baseTripFare,
        delayMins: tripDelayMins,
        trafficCharge: tripTrafficCharge
      },
      pickup: {
        distanceKm: pickupDistanceKm,
        baseFare: pickupBaseFare,
        delayMins: pickupDelayMins,
        trafficCharge: pickupTrafficCharge
      }
    },
    fixedFare: totalFixedFare,
    dynamicEstimate: {
      minFare: Math.round(baseTripFare + pickupBaseFare),
      maxFare: Math.round(totalFixedFare + 30)
    }
  };
};

module.exports = { calculateMasterFare };