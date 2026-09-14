/*
 * This worker intentionally stores only an unauthenticated, static shell.
 * Do not add HTML routes, API responses, uploaded images, scan results, or
 * account assets here: those can contain health or account information.
 */
// Bump this deliberately when the public offline notice changes. The worker
// never stores authenticated routes, scan inputs, results, or account assets.
const OFFLINE_CACHE = 'smart-skin-public-shell-v4';
const OFFLINE_PAGE = '/static/offline.html';
const PUBLIC_SHELL_ASSETS = [
  OFFLINE_PAGE,
  '/static/manifest.webmanifest',
  '/static/icons/smart-skin-icon.svg',
];
const PUBLIC_SHELL_ASSET_PATHS = new Set(PUBLIC_SHELL_ASSETS);

function isPublicShellAsset(pathname) {
  return PUBLIC_SHELL_ASSET_PATHS.has(pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE)
      .then((cache) => cache.addAll(PUBLIC_SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('smart-skin-public-shell-') && key !== OFFLINE_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache requests that can contain credentials, health information, or
  // scan results. The offline page is deliberately static and contains no
  // form fields, user data, uploaded images, or analysis results.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Cache only the explicit public-shell allowlist. A generic /static/ rule is
  // unsafe because a future static asset might contain user-specific content.
  if (isPublicShellAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
    return;
  }

  if (request.mode === 'navigate') {
    // Navigation pages are network-only. If an authenticated dashboard or an
    // account page is requested while offline, show the public fallback rather
    // than a stale page containing private information.
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_PAGE)));
  }
});
