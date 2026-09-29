// Darstellung: automatisch (folgt dem System), hell oder dunkel.
//
// Gespeichert nur im Browser (`vt.theme`), nicht je Benutzer: die Wahl gilt
// schon auf dem Anmeldebildschirm, und index.php setzt sie per Inline-Skript,
// bevor das Stylesheet zeichnet – sonst blitzt beim Laden kurz die falsche
// Farbe auf. Die CSS-Variablen hängen an `html[data-theme]`; ohne das
// Attribut entscheidet `prefers-color-scheme`.

const STORAGE_KEY = 'vt.theme';
export const THEMES = ['auto', 'light', 'dark'];

// Hintergrund der Kopfzeile (--surface) für die Statusleiste mobiler Browser.
const BAR_COLOR = { light: '#ffffff', dark: '#18181d' };

let current = normalize(readStored());

function normalize(value) {
    return THEMES.includes(value) ? value : 'auto';
}

function readStored() {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch {
        return null; // Privater Modus: dann eben automatisch.
    }
}

export function theme() {
    return current;
}

/** Nächste Stufe für den Umschalter: auto → hell → dunkel → auto. */
export function nextTheme() {
    return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
}

export function setTheme(value) {
    current = normalize(value);
    try {
        if (current === 'auto') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, current);
    } catch { /* siehe readStored() */ }
    applyTheme();
    return current;
}

export function applyTheme() {
    const root = document.documentElement;
    if (current === 'auto') delete root.dataset.theme;
    else root.dataset.theme = current;

    // Die beiden theme-color-Angaben in index.php unterscheiden per
    // media-Query. Bei fester Wahl bekommen beide dieselbe Farbe.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
        const scheme = meta.media.includes('dark') ? 'dark' : 'light';
        meta.content = BAR_COLOR[current === 'auto' ? scheme : current];
    }
}

applyTheme();
