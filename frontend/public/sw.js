// Minimal service worker for PWA installability.
// No caching strategy — Chrome just needs a registered fetch handler
// for the app to qualify as installable.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Pass-through, browser handles normally
  return;
});
