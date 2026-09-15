/*
 * PWA/offline support was retired. This one-time cleanup worker removes the
 * old public shell cache from browsers that previously installed it.
 */
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('smart-skin-public-shell-'))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.registration.unregister())
  );
});
