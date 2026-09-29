// Gemerkte Ansichtseinstellungen: Filter, Darstellung, Auswahl.
//
// Liegt im localStorage des Browsers, getrennt je Benutzer – Administrator
// und Kundenzugang im selben Browser kommen sich so nicht in die Quere.
// `session: true` nimmt stattdessen den sessionStorage: überlebt ein Neuladen,
// aber nicht das Schließen des Tabs. Das passt für Dinge wie den Ankertag im
// Kalender, bei denen man am nächsten Morgen wieder bei „heute“ landen will.
//
// Jeder Zugriff ist abgesichert: im privaten Modus oder bei vollem Speicher
// gibt es eben keine Erinnerung, aber auch keinen Fehler.

import { state } from './store.js';

function storage(session) {
    try {
        return session ? window.sessionStorage : window.localStorage;
    } catch {
        return null;
    }
}

function fullKey(key) {
    return `vt.u${state.user?.id ?? 0}.${key}`;
}

/**
 * Gespeicherten Wert lesen. `legacyKey` übernimmt einmalig einen Wert, der
 * vor der Aufteilung je Benutzer unter einem globalen Schlüssel lag.
 */
export function loadPref(key, fallback = null, { session = false, legacyKey = null } = {}) {
    const store = storage(session);
    if (!store) return fallback;
    try {
        let raw = store.getItem(fullKey(key));
        if (raw === null && legacyKey) {
            raw = store.getItem(legacyKey);
            // Alte Einträge waren teils blanke Zeichenketten statt JSON.
            if (raw !== null && !/^[[{"]/.test(raw)) return raw;
        }
        return raw === null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function savePref(key, value, { session = false } = {}) {
    try {
        storage(session)?.setItem(fullKey(key), JSON.stringify(value));
    } catch { /* siehe oben */ }
}
