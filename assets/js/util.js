// Kleine Helfer ohne Abhängigkeiten.

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

const NUMBER = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(amount, currency = 'EUR') {
    if (amount === null || amount === undefined) return '';
    return `${NUMBER.format(amount)} ${currency === 'EUR' ? '€' : currency}`;
}

export function decimal(value) {
    return NUMBER.format(value ?? 0);
}

/** Minuten als HH:MM, auch jenseits von 24 Stunden. */
export function hhmm(minutes) {
    const sign = minutes < 0 ? '-' : '';
    const abs = Math.abs(minutes ?? 0);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/** "2026-08-08" -> "Heute", "Gestern" oder "Sa, 08.08.2026". */
export function dayLabel(isoDate) {
    const today = todayISO();
    if (isoDate === today) return 'Heute';
    if (isoDate === shiftDays(today, -1)) return 'Gestern';

    const [y, m, d] = isoDate.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return `${WEEKDAYS[date.getDay()].slice(0, 2)}, ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
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
