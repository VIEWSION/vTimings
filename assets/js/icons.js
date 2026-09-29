// Symbole der Oberfläche: schlichte Linien im 24er-Raster, 1.5er Strich,
// Farbe über currentColor. Nur der Inhalt des <svg> steht hier, den Rahmen
// setzt icon(). Keine Schriftzeichen (✎, 🗑, ▶ …) in Views – die sehen je
// System anders aus.

import { raw } from './util.js';

const ICONS = {
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4"/><path d="M10 2h4"/>',
    list: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
    folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
    more: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/>',
    chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
    power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
    auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17"/>',
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2"/><path d="M12 19.5v2"/><path d="M2.5 12h2"/><path d="M19.5 12h2"/><path d="m5.3 5.3 1.4 1.4"/><path d="m17.3 17.3 1.4 1.4"/><path d="m5.3 18.7 1.4-1.4"/><path d="m17.3 6.7 1.4-1.4"/>',
    dark: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    check: '<path d="M4.5 12.5l5 5 10-11"/>',
    trash: '<path d="M4 7h16"/><path d="M10 3.5h4"/><path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    restore: '<path d="M4 9h11a5 5 0 0 1 0 10h-4"/><path d="M8 5 4 9l4 4"/>',
    play: '<path d="M8 5.5v13l10-6.5z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    up: '<path d="m7 14 5-5 5 5"/>',
    down: '<path d="m7 10 5 5 5-5"/>',
    back: '<path d="m14 6-6 6 6 6"/>',
    download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
    open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
};

/** SVG-Markup als Html-Instanz – direkt in html`` verwendbar. */
export function icon(name, size = 18) {
    return raw(`<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`);
}
