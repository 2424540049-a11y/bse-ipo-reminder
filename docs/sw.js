'use strict';

// All URLs are relative to this app's scope, including GitHub project Pages.
const CACHE = 'bse-calendar-shell-v1';
const SHELL = [
  './', './index.html', './styles.css', './platform.js', './app.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];
const BASE = new URL('./', self.location.href);
const ALLOWED = new Set(SHELL.map(path => new URL(path, BASE).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(
    names.filter(name => name.startsWith('bse-calendar-shell-') && name !== CACHE).map(name => caches.delete(name))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  // Market data deliberately bypasses this cache. The app validates it and marks
  // a failed sync explicitly, retaining a separate timestamped last-good copy.
  if (url.pathname.endsWith('/data/schedule.json')) return;
  const canonical = new URL(url.pathname, url.origin).href;
  if (request.mode !== 'navigate' && !ALLOWED.has(canonical)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (!response.ok) throw new Error('Asset unavailable');
      if (ALLOWED.has(canonical)) await cache.put(canonical, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(canonical) || (request.mode === 'navigate' ? await cache.match(new URL('./index.html', BASE).href) : null);
      if (cached) return cached;
      throw error;
    }
  })());
});
