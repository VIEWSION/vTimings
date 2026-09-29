/**
 * Service Worker.
 *
 * Bewusst zurückhaltend: gecacht wird nur die Programmhülle (HTML, CSS, JS,
 * Icons), damit die App vom Homescreen sofort startet. API-Antworten werden
 * NIE aus dem Cache bedient – eine falsche Zeitangabe wäre schlimmer als
 * eine Fehlermeldung.
 */

const VERSION = 'vtimings-v1';
const BASE = new URL('./', self.location).pathname.replace(/assets\/$/, '');

const SHELL = [
    BASE,
    BASE + 'assets/css/app.css',
    BASE + 'assets/js/app.js',
    BASE + 'assets/js/api.js',
    BASE + 'assets/js/i18n.js',
    BASE + 'assets/js/prefs.js',
    BASE + 'assets/js/store.js',
    BASE + 'assets/js/ui.js',
    BASE + 'assets/js/util.js',
    BASE + 'assets/js/views/timer.js',
    BASE + 'assets/js/views/entries.js',
    BASE + 'assets/js/views/calendar.js',
    BASE + 'assets/js/views/reports.js',
    BASE + 'assets/js/views/master.js',
    BASE + 'assets/js/views/settings.js',
    BASE + 'assets/js/views/users.js',
    BASE + 'assets/js/views/portal.js',
    BASE + 'assets/icons/icon.svg',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(VERSION)
            // Einzelne fehlende Datei darf die Installation nicht kippen.
            .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // Alles Dynamische geht immer ans Netz.
    if (url.pathname.includes('/api/') || url.pathname.endsWith('/report')) return;

    // Programmhülle: Netz zuerst, Cache als Rückfallebene. So sieht man nach
    // einem Deploy sofort die neue Fassung und bleibt offline trotzdem
    // startfähig.
    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(VERSION).then((cache) => cache.put(request, copy));
                }
                return response;
            })
            .catch(() => caches.match(request).then((hit) => hit || caches.match(BASE)))
    );
});
