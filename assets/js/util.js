// Kleine Helfer. Einzige Abhängigkeit ist die Sprache – Zahlen, Datumsformate
// und Tagesnamen hängen daran.

import { lang, locale, t } from './i18n.js';

/** HTML-Escaping. Jeder Wert aus der API läuft hier durch. */
export function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/**
 * Ergebnis von html`` – trägt bereits fertiges Markup und wird beim
 * Verschachteln nicht noch einmal escaped.
 */
class Html {
    constructor(value) {
        this.__raw = value;
    }

    toString() {
        return this.__raw;
    }
}

function render(value) {
    if (value === null || value === undefined || value === false || value === true) return '';
    if (value instanceof Html) return value.__raw;
    if (Array.isArray(value)) return value.map(render).join('');
    if (typeof value === 'object' && '__raw' in value) return String(value.__raw);
    return esc(value);
}

/** Template-Literal-Tag: interpoliert escaped, ausser bei raw() und html``. */
export function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
        out += render(values[i]) + strings[i + 1];
    }
    return new Html(out);
}

export function raw(string) {
    return new Html(string);
}

export { Html };

// Formatierer je Sprache anlegen und behalten – ein Intl-Objekt pro Aufruf
// wäre in den langen Listen spürbar.
const formatters = new Map();

function formatter(kind, options) {
    const key = `${lang()}:${kind}`;
    if (!formatters.has(key)) {
        formatters.set(key, kind === 'number'
            ? new Intl.NumberFormat(locale(), options)
            : new Intl.DateTimeFormat(locale(), options));
    }
    return formatters.get(key);
}

function number() {
    return formatter('number', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function money(amount, currency = 'EUR') {
    if (amount === null || amount === undefined) return '';
    return `${number().format(amount)} ${currency === 'EUR' ? '€' : currency}`;
}

export function decimal(value) {
    return number().format(value ?? 0);
}

/** Minuten als HH:MM, auch jenseits von 24 Stunden. */
export function hhmm(minutes) {
    const sign = minutes < 0 ? '-' : '';
    const abs = Math.abs(minutes ?? 0);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** "09:15" -> 555 Minuten seit Mitternacht, null bei leerer Eingabe. */
export function timeToMinutes(time) {
    const [hh, mm] = String(time ?? '').split(':').map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return hh * 60 + mm;
}

/** 555 -> "09:15". Werte jenseits eines Tages laufen um Mitternacht um. */
export function minutesToTime(minutes) {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "2026-08-08" als Date in lokaler Zeit – ohne UTC-Umweg über new Date(iso). */
function fromISODate(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(y, m - 1, d);
}

/** "2026-08-08" -> "Heute"/"Today", "Gestern"/"Yesterday" oder "Sa, 08.08.2026". */
export function dayLabel(isoDate) {
    const today = todayISO();
    if (isoDate === today) return t('common.today');
    if (isoDate === shiftDays(today, -1)) return t('common.yesterday');
    return formatDate(isoDate, true);
}

/**
 * Datum in der Sprache des Anwenders. Mit `weekday` zusätzlich der abgekürzte
 * Wochentag – der Punkt der deutschen Abkürzung fällt weg, sonst stünde vor
 * dem Komma ein zweites Satzzeichen ("Sa., 08.08.2026").
 */
export function formatDate(isoDate, weekday = false) {
    const date = fromISODate(isoDate);
    const day = formatter('date', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
    if (!weekday) return day;

    return `${weekdayShort(isoDate)}, ${day}`;
}

/** Abgekürzter Wochentag ohne Abkürzungspunkt, z. B. "Sa" – siehe formatDate(). */
export function weekdayShort(isoDate) {
    return formatter('weekday', { weekday: 'short' }).format(fromISODate(isoDate)).replace(/\.$/, '');
}

/** Tag und Monat ohne Jahr, z. B. "3.8." bzw. "8/3". */
export function dayMonth(isoDate) {
    return formatter('dayMonth', { day: 'numeric', month: 'numeric' }).format(fromISODate(isoDate));
}

/** Überschrift eines Monats, z. B. "August 2026". */
export function monthYear(isoDate) {
    return formatter('monthYear', { month: 'long', year: 'numeric' }).format(fromISODate(isoDate));
}

/** Zeitstempel aus der API ("2026-08-08T09:15:00+02:00") als Datum und Uhrzeit. */
export function formatDateTime(iso) {
    return new Date(iso).toLocaleString(locale());
}

export function todayISO() {
    return toISODate(new Date());
}

export function toISODate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function shiftDays(isoDate, days) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const date = new Date(y, m - 1, d + days);
    return toISODate(date);
}

export function startOfMonth(isoDate = todayISO()) {
    return isoDate.slice(0, 8) + '01';
}

export function endOfMonth(isoDate = todayISO()) {
    const [y, m] = isoDate.split('-').map(Number);
    return toISODate(new Date(y, m, 0)); // Tag 0 des Folgemonats
}

/** Montag der Woche, in der das Datum liegt – die Woche beginnt am Montag. */
export function startOfWeek(isoDate = todayISO()) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return shiftDays(isoDate, -((new Date(y, m - 1, d).getDay() + 6) % 7));
}

/** Alle Kalendertage von `from` bis `to`, beide einschließlich. */
export function dateRange(from, to) {
    const out = [];
    // Die Schranke fängt vertauschte oder unsinnige Grenzen ab.
    for (let date = from; date <= to && out.length < 400; date = shiftDays(date, 1)) {
        out.push(date);
    }
    return out;
}

/** Lokale Zeit als ISO-String mit Offset – so erwartet es die API. */
export function localISO(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
        `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "2026-08-08" + "09:15" -> ISO mit Offset. */
export function dateTimeToISO(isoDate, time) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return localISO(new Date(y, m - 1, d, hh, mm, 0));
}

/** Sekunden als HH:MM:SS für die laufende Uhr. */
export function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
        .map((n) => String(n).padStart(2, '0'))
        .join(':');
}

export function debounce(fn, wait = 250) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

/** Lesbarer Textkontrast zu einer Hintergrundfarbe. */
export function contrastColor(hex) {
    if (!hex) return 'inherit';
    const value = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#16161a' : '#ffffff';
}
