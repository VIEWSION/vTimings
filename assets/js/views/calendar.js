// Kalenderdarstellung der Einträge: Tag, Woche, Monat.
//
// Das ist keine eigene Ansicht im Sinne des Routers, sondern die zweite
// Darstellung von „Einträge“. Sie bekommt genau die Tagesgruppen, die
// `entries.js` ohnehin lädt (`/entries?group=day`), hält keinen eigenen
// Zustand und holt nichts nach – Maßstab und Zeitraum kommen von dort.
//
// Vorbild ist der Kalender von macOS: Stundenraster mit nebeneinander
// gelegten Überschneidungen bei Tag und Woche, Zellen mit kurzen Streifen
// beim Monat.

import { t } from '../i18n.js';
import {
    dateRange, dayMonth, endOfMonth, formatDate, formatDateTime, html, monthYear, raw, shiftDays,
    startOfMonth, startOfWeek, toISODate, todayISO, weekdayShort,
} from '../util.js';

export const SCALES = ['day', 'week', 'month'];

/** Beschriftung eines Maßstabs – erst beim Zeichnen, wegen der Sprache. */
function scaleLabel(scale) {
    return t('cal.scale' + scale[0].toUpperCase() + scale.slice(1));
}

// Beschriftet wird ab 01:00; die Marke für 00:00 läge über dem oberen Rand.
const HOURS = Array.from({ length: 23 }, (_, i) => i + 1);

// Mehr Streifen passen nicht in eine Monatszelle; der Rest wird gezählt.
const MONTH_CHIPS = 4;

// -- Zeitraum ---------------------------------------------------------------

/**
 * Der Zeitraum, den ein Maßstab um seinen Ankertag herum zeigt. Der Monat
 * geht bis zum Rand des Rasters, also über volle Wochen – sonst stünden die
 * Wochentage nicht untereinander.
 */
export function calendarRange(scale, anchor) {
    if (scale === 'day') return { from: anchor, to: anchor };

    if (scale === 'week') {
        const from = startOfWeek(anchor);
        return { from, to: shiftDays(from, 6) };
    }

    return {
        from: startOfWeek(startOfMonth(anchor)),
        to: shiftDays(startOfWeek(endOfMonth(anchor)), 6),
    };
}

/**
 * Einen Zeitraum vor oder zurück. Der Anker bleibt immer ein konkreter Tag –
 * auch im Monat. So landet man beim Wechsel auf Tag oder Woche dort, wo man
 * gerade hingeschaut hat, statt am Monatsersten.
 */
export function shiftAnchor(scale, anchor, direction) {
    if (scale === 'day') return shiftDays(anchor, direction);
    if (scale === 'week') return shiftDays(anchor, direction * 7);

    const [year, month, day] = anchor.split('-').map(Number);
    // Der 31. hat im Zielmonat vielleicht keine Entsprechung; sonst liefe
    // der Sprung in den übernächsten Monat.
    const last = new Date(year, month + direction, 0).getDate();
    return toISODate(new Date(year, month - 1 + direction, Math.min(day, last)));
}

function calendarTitle(scale, anchor) {
    if (scale === 'day') return formatDate(anchor, true);
    if (scale === 'month') return monthYear(anchor);

    const { from, to } = calendarRange('week', anchor);
    return `${formatDate(from)} – ${formatDate(to)}`;
}

// -- Einträge in Tagesabschnitte zerlegen -----------------------------------

/**
 * Ein Eintrag über Mitternacht gehört an jedem berührten Tag an seine
 * Stelle im Raster – sonst liefe er unten aus der Spalte heraus. Die
 * Zerlegung folgt den Zeitstempeln, nicht dem `overnight`-Kennzeichen:
 * ein Eintrag darf auch mehr als zwei Tage berühren.
 *
 * Nicht abgedeckt: ein Eintrag, der *vor* dem geladenen Zeitraum beginnt
 * und in ihn hineinragt. Den liefert die API nicht mit, er fehlt also im
 * ersten Tag des Rasters.
 */
function splitEntry(entry) {
    const start = new Date(entry.started_at);
    const end = new Date(entry.ended_at);
    const startDate = toISODate(start);
    const endDate = toISODate(end);
    const endMinute = end.getHours() * 60 + end.getMinutes();

    // Ein Ende genau um Mitternacht schließt den Vortag ab, es beginnt
    // keinen neuen – sonst stünde dort ein Abschnitt ohne Länge.
    const midnight = endMinute === 0 && endDate !== startDate;
    const lastDate = midnight ? shiftDays(endDate, -1) : endDate;
    const lastMinute = midnight ? 1440 : endMinute;

    const out = [];
    let date = startDate;
    let from = start.getHours() * 60 + start.getMinutes();

    // Die Schranken fangen kaputte Zeitstempel ab (Ende vor Beginn).
    for (let guard = 0; guard < 32 && date <= lastDate; guard++) {
        const last = date === lastDate;
        out.push({
            entry,
            date,
            from,
            to: Math.max(last ? lastMinute : 1440, from + 1),
            continued: out.length > 0,
        });
        if (last) break;
        date = shiftDays(date, 1);
        from = 0;
    }
    return out;
}

/** Alle Abschnitte nach Kalendertag, je Tag nach Beginn sortiert. */
function segmentsByDate(days) {
    const map = new Map();

    for (const day of days) {
        for (const entry of day.entries) {
            for (const segment of splitEntry(entry)) {
                if (!map.has(segment.date)) map.set(segment.date, []);
                map.get(segment.date).push(segment);
            }
        }
    }
    for (const list of map.values()) {
        list.sort((a, b) => a.from - b.from || a.to - b.to);
    }
    return map;
}

/**
 * Überschneidende Abschnitte nebeneinander legen: zuerst zusammenhängende
 * Ballungen bilden, dann bekommt jeder Abschnitt darin die erste Spur, die
 * zu seinem Beginn wieder frei ist. Alle Abschnitte einer Ballung teilen
 * sich die Breite – so wie im Kalender von macOS.
 */
function layout(segments) {
    const out = [];
    let cluster = [];
    let clusterEnd = -1;

    const flush = () => {
        if (!cluster.length) return;

        const lanes = [];
        for (const segment of cluster) {
            let lane = lanes.findIndex((end) => end <= segment.from);
            if (lane === -1) lane = lanes.length;
            lanes[lane] = segment.to;
            segment.lane = lane;
        }
        for (const segment of cluster) segment.lanes = lanes.length;

        out.push(...cluster);
        cluster = [];
        clusterEnd = -1;
    };

    for (const segment of segments) {
        if (cluster.length && segment.from >= clusterEnd) flush();
        cluster.push(segment);
        clusterEnd = Math.max(clusterEnd, segment.to);
    }
    flush();

    return out;
}

// -- Zeichnen ---------------------------------------------------------------

/**
 * Der ganze Kalender als Karte, samt Kopfleiste mit Blättern und Maßstab.
 *
 * @param days     Tagesgruppen aus `/entries?group=day`
 * @param editable Nur Administratoren dürfen anfassen und anlegen.
 */
export function calendarHtml(days, { scale, anchor, editable }) {
    const { from, to } = calendarRange(scale, anchor);
    const dates = dateRange(from, to);
    const segments = segmentsByDate(days);
    // Tagessummen kommen aus der API, nicht aus den Abschnitten – ein
    // Eintrag über Mitternacht zählt dort ganz zu seinem Starttag, genau
    // wie in der Liste.
    const totals = new Map(days.map((day) => [day.date, day]));

    return html`
        <section class="card">
            <header class="card__head cal__bar">
                <div class="cal__nav">
                    <button type="button" class="icon-btn" data-nav="-1" title="${t('cal.prev')}">‹</button>
                    <button type="button" class="btn btn--small" data-nav="0">${t('cal.today')}</button>
                    <button type="button" class="icon-btn" data-nav="1" title="${t('cal.next')}">›</button>
                </div>
                <h2 class="cal__title">${calendarTitle(scale, anchor)}</h2>
                <div class="seg">
                    ${SCALES.map((key) => html`
                        <button type="button" class="seg__btn ${key === scale ? 'is-active' : ''}"
                                data-scale="${key}">${scaleLabel(key)}</button>`)}
                </div>
            </header>
            ${scale === 'month'
                ? monthGrid(dates, segments, totals, anchor, editable)
                : timeGrid(dates, segments, totals, scale, editable)}
        </section>`;
}

/** Tag und Woche: Stundenraster mit den Einträgen als Blöcken. */
function timeGrid(dates, segments, totals, scale, editable) {
    const today = todayISO();

    return html`
        <div class="cal cal--${scale}">
            <div class="cal__body" data-calbody>
                <div class="cal__canvas">
                    ${scale === 'day' ? '' : html`
                        <div class="cal__corner"></div>
                        <div class="cal__days">
                            ${dates.map((date) => html`
                                <div class="cal__dayhead ${date === today ? 'is-today' : ''}">
                                    <button type="button" class="cal__daylink" data-open="${date}">
                                        <span class="cal__dayname">${weekdayShort(date)} ${dayMonth(date)}</span>
                                        ${totals.get(date)
                                            ? html`<span class="cal__daysum">${totals.get(date).hhmm}</span>`
                                            : ''}
                                    </button>
                                </div>`)}
                        </div>`}
                    <div class="cal__hours">
                        ${HOURS.map((hour) => html`
                            <span class="cal__hour" style="top:${(hour / 24) * 100}%">
                                ${String(hour).padStart(2, '0')}:00</span>`)}
                    </div>
                    <div class="cal__cols">
                        ${dates.map((date) => html`
                            <div class="cal__col ${date === today ? 'is-today' : ''}" data-slot="${date}">
                                ${date === today ? nowLine() : ''}
                                ${layout(segments.get(date) || []).map((s) => eventBlock(s, editable))}
                            </div>`)}
                    </div>
                </div>
            </div>
        </div>`;
}

function nowLine() {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    return html`<span class="cal__now" style="top:${(minutes / 1440) * 100}%" title="${t('cal.now')}"></span>`;
}

/**
 * Wie viel in einen Block passt, hängt an seiner Höhe: unter 45 Minuten
 * bleibt eine Zeile, darüber kommen Kunde und Projekt dazu, ab knapp zwei
 * Stunden auch die Notiz. Was nicht passt, wegzulassen ist ruhiger als es
 * halb abzuschneiden – vollständig steht ohnehin alles im Tooltip.
 */
function eventBlock(segment, editable) {
    const entry = segment.entry;
    const width = 100 / segment.lanes;
    const minutes = segment.to - segment.from;

    return html`
        <button type="button"
                class="cal__event ${entry.billed ? 'is-billed' : ''} ${entry.deleted_at ? 'is-deleted' : ''}
                       ${minutes < 45 ? 'is-short' : ''}"
                style="top:${(segment.from / 1440) * 100}%; height:${(minutes / 1440) * 100}%;
                       left:${segment.lane * width}%; width:calc(${width}% - 2px);
                       --c:${entry.color || 'var(--accent)'}"
                title="${eventTitle(entry)}"
                ${openAttr(entry, editable)}>
            <span class="cal__time">${billedMark(entry)}${entry.start_time}–${entry.end_time}</span>
            <span class="cal__name">${entry.subproject_name}</span>
            ${minutes >= 75
                ? html`<span class="cal__sub">${entry.client_name} · ${entry.project_name}</span>` : ''}
            ${minutes >= 105 && entry.note ? html`<span class="cal__note">${entry.note}</span>` : ''}
        </button>`;
}

/**
 * Anfassbar ist ein Eintrag nur für Administratoren – und nicht im
 * Papierkorb: dort schlüge das Speichern im Bearbeiten-Dialog fehl.
 * Wiederhergestellt wird weiterhin in der Liste.
 */
function openAttr(entry, editable) {
    return editable && !entry.deleted_at
        ? { __raw: `data-edit="${entry.id}"` }
        : { __raw: 'disabled' };
}

function eventTitle(entry) {
    const head = `${entry.start_time}–${entry.end_time} · ${entry.hhmm} · ${entry.path}`;
    const lines = [head];
    if (entry.billed) lines.push(billedLabel(entry));
    if (entry.note) lines.push(entry.note);
    return lines.join('\n');
}

/** "abgerechnet am …" – mit Rechnungsnummer bzw. Stundenpaket, sofern vorhanden. */
export function billedLabel(entry) {
    const label = t('entries.billedAt', { date: formatDateTime(entry.billed_at) });
    if (entry.invoice_number) return `${label} · ${t('entries.invoice', { number: entry.invoice_number })}`;
    if (entry.budget_id) return `${label} · ${t('entries.budget', { name: budgetName(entry) })}`;
    return label;
}

/** Bezeichnung des Stundenpakets eines Eintrags: Notiz, sonst Beginn. */
export function budgetName(entry) {
    return entry.budget_note || t('budget.packageFrom', { date: formatDate(entry.budget_starts_on) });
}

/**
 * Status als kleines Symbol: Häkchen = abgerechnet. Mit `open: true` bekommt
 * ein offener Eintrag einen dezenten leeren Kreis gleicher Größe – so hat
 * jede Zeile der Liste ein Symbol und das Layout bleibt in den Proportionen
 * gleich. Der Kalender zeigt nur das Häkchen, dort ist der Platz knapp.
 */
export function billedMark(entry, { open = false } = {}) {
    if (!entry.billed) {
        return open ? html`<span class="billed-mark billed-mark--open" role="img"
                title="${t('entries.statusOpen')}" aria-label="${t('entries.statusOpen')}"></span>` : '';
    }
    return html`<span class="billed-mark" title="${billedLabel(entry)}" role="img"
            aria-label="${billedLabel(entry)}">${raw('<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>')}</span>`;
}

/** Monat: eine Zelle je Kalendertag, darin die Einträge als kurze Streifen. */
function monthGrid(dates, segments, totals, anchor, editable) {
    const month = anchor.slice(0, 7);
    const today = todayISO();

    return html`
        <div class="cal cal--month">
            <div class="cal__monthscroll">
                <div class="cal__weekhead">
                    ${dates.slice(0, 7).map((date) => html`<span>${weekdayShort(date)}</span>`)}
                </div>
                <div class="cal__grid">
                    ${dates.map((date) => monthCell(date, segments.get(date) || [], {
                        outside: date.slice(0, 7) !== month,
                        today: date === today,
                        total: totals.get(date),
                        editable,
                    }))}
                </div>
            </div>
        </div>`;
}

function monthCell(date, segments, { outside, today, total, editable }) {
    const shown = segments.slice(0, MONTH_CHIPS);
    const rest = segments.length - shown.length;

    return html`
        <div class="cal__cell ${outside ? 'is-outside' : ''} ${today ? 'is-today' : ''}" data-slot="${date}">
            <header class="cal__cellhead">
                <button type="button" class="cal__daynum" data-open="${date}">${Number(date.slice(8))}</button>
                ${total ? html`<span class="cal__daysum">${total.hhmm}</span>` : ''}
            </header>
            <ul class="cal__chips">
                ${shown.map((segment) => chip(segment, editable))}
                ${rest > 0 ? html`
                    <li><button type="button" class="cal__more" data-open="${date}">
                        ${t('cal.more', { count: rest })}</button></li>` : ''}
            </ul>
        </div>`;
}

function chip(segment, editable) {
    const entry = segment.entry;

    return html`
        <li>
            <button type="button"
                    class="cal__chip ${entry.billed ? 'is-billed' : ''} ${entry.deleted_at ? 'is-deleted' : ''}"
                    style="--c:${entry.color || 'var(--accent)'}"
                    title="${eventTitle(entry)}"
                    ${openAttr(entry, editable)}>
                <span class="cal__chiptime">${billedMark(entry)}${segment.continued ? '00:00' : entry.start_time}</span>
                <span class="cal__chipname">${entry.subproject_name}</span>
            </button>
        </li>`;
}

// -- Verhalten --------------------------------------------------------------

/**
 * Das Raster zeigt volle 24 Stunden; sichtbar soll aber der Teil sein, in
 * dem etwas steht. Ohne Einträge beginnt der Blick bei 07:00.
 */
export function scrollToFirstEvent(host) {
    const body = host.querySelector('[data-calbody]');
    if (!body) return;

    // Die Tagesleiste steht mit im Scrollbereich und zählt bei der Rechnung
    // nicht zum Raster.
    const head = host.querySelector('.cal__days')?.offsetHeight ?? 0;
    const events = host.querySelectorAll('.cal__event');

    if (!events.length) {
        body.scrollTop = ((body.scrollHeight - head) * 7) / 24;
        return;
    }

    const top = Math.min(...[...events].map((el) => el.getBoundingClientRect().top));
    body.scrollTop += top - body.getBoundingClientRect().top - head - 8;
}

/**
 * Die Uhrzeit, auf die in einer Tagesspalte geklickt wurde – auf das
 * übergebene Raster abgerundet. Für Zellen ohne Zeitachse (Monat) gibt es
 * nichts zu rechnen, dann kommt null zurück.
 */
export function minutesAt(column, clientY, grid) {
    if (!column.closest('.cal__cols')) return null;

    const rect = column.getBoundingClientRect();
    const minutes = ((clientY - rect.top) / rect.height) * 1440;
    return Math.max(0, Math.min(1440 - grid, Math.floor(minutes / grid) * grid));
}
