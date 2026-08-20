const CACHE_NAME = '67-driver-cache-v1';

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
    data: { url: '/driver.html' }
  };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/manifest.json',
    badge: '/manifest.json',
    vibrate: [300, 100, 300, 100, 300],
    tag: 'ride-offer-notification',
    renotify: true,
    requireInteraction: true,
    data: data.data || { url: '/driver.html' }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ---------------- NOTIFICATION TAP TO OPEN APP ----------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/driver.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('driver.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});