const CACHE_NAME = '67-driver-cache-v3';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ---------------- BACKGROUND WEB PUSH NOTIFICATION LISTENER ----------------
self.addEventListener('push', (event) => {
  let data = {
    title: '🚖 Nayi Ride Request!',
    body: 'Aapke pass ek nayi ride offer aayi hai.',
    rideId: '',
    driverId: '',
    fare: '0',
    pickup: 'Pickup Point',
    drop: 'Drop Point',
    data: { url: '/driver.html' }
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const rideId = data.rideId || (data.data && data.data.rideId) || '';
  const driverId = data.driverId || (data.data && data.data.driverId) || '';

  const options = {
    body: data.body || `Kiraya: ₹${data.fare} | ${data.pickup} ➔ ${data.drop}`,
    icon: '/manifest.json',
    badge: '/manifest.json',
    vibrate: [500, 200, 500, 200, 500],
    tag: `ride-offer-${rideId || 'general'}`,
    renotify: true,
    requireInteraction: true,
    data: {
      rideId: rideId,
      driverId: driverId,
      url: rideId ? `/driver.html?status=ongoing&id=${rideId}` : (data.data?.url || '/driver.html')
    },
    actions: [
      { action: 'accept_ride', title: '✅ ACCEPT RIDE' },
      { action: 'reject_ride', title: '❌ REJECT' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ---------------- NOTIFICATION TAP & ACTION BUTTON CLICK HANDLER ----------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rideId = event.notification.data?.rideId;
  const driverId = event.notification.data?.driverId;
  const action = event.action;

  // 1. Agar Driver ne 'REJECT' dabaya
  if (action === 'reject_ride') {
    if (rideId) {
      event.waitUntil(
        fetch('/api/ride/decline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rideId })
        }).catch(() => {})
      );
    }
    return;
  }

  // 2. Agar Driver ne 'ACCEPT RIDE' dabaya ya Notification body par click kiya
  const targetUrl = event.notification.data?.url || (rideId ? `/driver.html?status=ongoing&id=${rideId}` : '/driver.html');

  const handleAcceptAndOpen = async () => {
    // Sahi Endpoint (/api/ride/accept-bg) par rideId aur driverId dono bhejein
    if (rideId) {
      try {
        await fetch('/api/ride/accept-bg', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rideId, driverId })
        });
      } catch (err) {
        console.error('Ride accept-bg call failed:', err);
      }
    }

    // Window focus karein ya naya tab open karein
    const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if (client.url.includes('driver.html') && 'focus' in client) {
        client.navigate(targetUrl);
        return client.focus();
      }
    }
    if (clients.openWindow) {
      return clients.openWindow(targetUrl);
    }
  };

  event.waitUntil(handleAcceptAndOpen());
});