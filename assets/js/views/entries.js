// Einträge: Filter, Tagesgruppen, Bearbeiten, Papierkorb – dazu Summen,
// Leistungsnachweis und Export (früher eine eigene Seite "Auswertung").

import { api } from '../api.js';
import { state, loadTree, loadSettings, invalidateTree, flatSubprojects } from '../store.js';
import { t } from '../i18n.js';
import { enhanceCombos } from '../combo.js';
import { loadPref, savePref } from '../prefs.js';
import { bindOnce, confirmDialog, pickSubproject, saveDialog, toast, toastError } from '../ui.js';
import {
    billedMark, calendarHtml, calendarRange, minutesAt, SCALES, scrollToFirstEvent, shiftAnchor,
} from './calendar.js';
import { exportDialog, GROUP_KEYS, groupChips, reportDialog, statsHtml } from './output.js';
import {
    dateTimeToISO, dayLabel, debounce, esc, formatDateTime, hhmm, html, minutesToTime, money, shiftDays,
    startOfMonth, startOfWeek, timeToMinutes, todayISO,
} from '../util.js';

const filters = {
    from: startOfMonth(),
    to: todayISO(),
    client_id: '',
    project_id: '',
    subproject_id: '',
    q: '',
    billed: '',
    trashed: '0',
};

// Zuletzt gewählter Schnellzeitraum ("Dieser Monat" usw.). Solange er gilt,
// merkt sich die Ansicht ihn statt fester Daten – sonst stünde nach einem
// Monatswechsel noch der alte Monat im Filter. Wer die Daten von Hand setzt,
// hebt ihn auf.
let range = null;

let initialized = false;

// Darstellung: Liste, Kalender oder Summen. Im Kalender geben Maßstab und
// Ankertag den Zeitraum vor – die Datumsfelder des Filters werden dann von
// der Navigation gefüllt statt von Hand. Der Ankertag ist immer ein konkreter
// Tag, auch im Monatsraster.
const MODES = ['list', 'calendar', 'stats'];
let mode = 'list';
let scale = 'week';
let anchor = todayISO();
let groupBy = 'client';

// Mehrfachauswahl für Sammelbearbeiten, Leistungsnachweis und Export.
// `selectable` sind die IDs der aktuellen Liste (außerhalb des Papierkorbs) –
// was nach einem Filterwechsel nicht mehr zu sehen ist, fällt aus der
// Auswahl, damit man nichts Unsichtbares mitändert oder mit ausgibt.
// Abgerechnete Einträge lassen sich anhaken (für einen erneuten Nachweis),
// das Sammelbearbeiten überspringt sie.
const selected = new Set();
let selectable = [];

// Zuletzt geladene Einträge und Summen – daraus nennen die Dialoge für
// Leistungsnachweis und Export, worauf sie sich beziehen.
const loaded = new Map();
let lastTotals = null;

/**
 * Gemerkten Zustand übernehmen. Erst beim ersten Aufruf, nicht beim Laden
 * des Moduls: die Einstellungen liegen je Benutzer, und der steht erst nach
 * der Anmeldung fest.
 */
function restore() {
    const view = loadPref('entriesView', {}, { legacyKey: 'vt.entriesView' }) || {};
    mode = MODES.includes(view.mode) ? view.mode : 'list';
    scale = SCALES.includes(view.scale) ? view.scale : 'week';
    // Beim ersten Mal die Gruppierung der früheren Seite "Auswertung" übernehmen.
    const group = view.groupBy ?? loadPref('reports', null)?.filters?.group_by;
    groupBy = GROUP_KEYS.includes(group) ? group : 'client';

    const day = loadPref('entriesAnchor', null, { session: true });
    if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) anchor = day;

    const saved = loadPref('entries', null);
    if (!saved || typeof saved.filters !== 'object') return false;

    for (const key of Object.keys(filters)) {
        if (typeof saved.filters[key] === 'string') filters[key] = saved.filters[key];
    }
    range = RANGES.includes(saved.range) ? saved.range : null;
    if (range) Object.assign(filters, rangeDates(range));
    return true;
}

/** Darstellung und Maßstab überdauern die Sitzung – wie die Sprache. */
function storeView() {
    savePref('entriesView', { mode, scale, groupBy });
    savePref('entriesAnchor', anchor, { session: true });
}

function storeFilters() {
    savePref('entries', { filters, range });
}

/** Kundenzugänge sehen dieselbe Liste, dürfen aber nichts ändern. */
function canEdit() {
    return state.user?.role === 'admin';
}

/**
 * Die Kundenauswahl lohnt nur, wenn es überhaupt mehrere gibt. Ein
 * Kundenzugang sieht ohnehin nur den eigenen.
 */
function showClientFilter() {
    return (state.tree?.clients?.length ?? 0) > 1;
}

export const entriesView = {
    async render(root) {
        await loadTree();

        if (!initialized) {
            initialized = true;
            // Kundenzugänge interessiert der gesamte Projektverlauf, nicht der
            // laufende Monat – dort stünde meist eine leere Liste.
            if (!restore()) {
                range = canEdit() ? 'month' : 'all';
                Object.assign(filters, rangeDates(range));
            }
        }

        // Der Kalender ist vorerst den Administratoren vorbehalten.
        if (!canEdit()) mode = 'list';

        root.innerHTML = html`
            <section class="stack ${mode === 'calendar' ? 'is-calendar' : ''}" id="entries">
                <form class="card filters" id="filters">
                    <div class="filters__row">
                        <span class="filters__dates">
                            <label class="field field--inline">
                                <span class="field__label">${t('common.from')}</span>
                                <input class="input" type="date" name="from" value="${filters.from}">
                            </label>
                            <label class="field field--inline">
                                <span class="field__label">${t('common.to')}</span>
                                <input class="input" type="date" name="to" value="${filters.to}">
                            </label>
                        </span>
                        ${showClientFilter() ? html`
                            <label class="field field--inline field--grow">
                                <span class="field__label">${t('common.client')}</span>
                                <select class="input" name="client_id" data-combo></select>
                            </label>` : ''}
                        <label class="field field--inline field--grow">
                            <span class="field__label">${t('common.project')}</span>
                            <select class="input" name="project_id" data-combo></select>
                        </label>
                        <label class="field field--inline field--grow">
                            <span class="field__label">${t('common.subproject')}</span>
                            <select class="input" name="subproject_id" data-combo></select>
                        </label>
                    </div>
                    <div class="filters__row">
                        <label class="field field--inline field--grow">
                            <span class="field__label">${t('common.search')}</span>
                            <input class="input" type="search" name="q" value="${filters.q}"
                                placeholder="${t('entries.searchPlaceholder')}">
                        </label>
                        <label class="field field--inline">
                            <span class="field__label">${t('common.status')}</span>
                            <select class="input" name="billed">
                                <option value="">${t('common.all')}</option>
                                <option value="0">${t('common.billedOpen')}</option>
                                <option value="1">${t('common.billedDone')}</option>
                            </select>
                        </label>
                    </div>
                    <div class="filters__row filters__row--actions">
                        ${canEdit() ? html`
                            <div class="seg" title="${t('cal.display')}">
                                <button type="button" class="seg__btn ${mode === 'list' ? 'is-active' : ''}"
                                        data-view="list">${t('cal.viewList')}</button>
                                <button type="button" class="seg__btn ${mode === 'calendar' ? 'is-active' : ''}"
                                        data-view="calendar">${t('cal.viewCalendar')}</button>
                                <button type="button" class="seg__btn ${mode === 'stats' ? 'is-active' : ''}"
                                        data-view="stats">${t('cal.viewStats')}</button>
                            </div>` : ''}
                        <div class="chips">
                            <span class="filters__ranges">
                                <button type="button" class="chip" data-range="today">${t('entries.rangeToday')}</button>
                                <button type="button" class="chip" data-range="week">${t('entries.rangeWeek')}</button>
                                <button type="button" class="chip" data-range="month">${t('entries.rangeMonth')}</button>
                                <button type="button" class="chip" data-range="lastmonth">${t('entries.rangeLastMonth')}</button>
                                <button type="button" class="chip" data-range="year">${t('entries.rangeYear')}</button>
                                <button type="button" class="chip" data-range="all">${t('entries.rangeAll')}</button>
                            </span>
                            <button type="button" class="chip" data-reset>${t('entries.resetFilters')}</button>
                        </div>
                        ${canEdit() ? html`
                            <div class="filters__tools">
                                <label class="switch">
                                    <input type="checkbox" name="trashed"> <span>${t('entries.trash')}</span>
                                </label>
                                <button type="button" class="btn" data-output="report">${t('output.report')}</button>
                                <button type="button" class="btn" data-output="export">${t('output.export')}</button>
                                <button type="button" class="btn btn--primary" id="new-entry">${t('entries.add')}</button>
                            </div>` : ''}
                    </div>
                </form>
                <div class="stack" id="results"><div class="loading">${t('common.loading')}</div></div>
                <div class="batchbar card" id="batchbar" hidden></div>
            </section>`;

        fillFilters(root);
        enhanceCombos(root);
        bind(root);
        if (mode === 'calendar') applyCalendarRange(root);
        await refresh(root);
    },
};

/** Farbe für den Punkt im Auswahlfeld (combo.js); Projekte erben sie schon vom Server. */
function colorAttr(color) {
    return color ? ` data-color="${esc(color)}"` : '';
}

/** Kunden-, Projekt- und Teilprojektauswahl befüllen und aufeinander abstimmen. */
function fillFilters(root) {
    const clients = state.tree?.clients || [];
    const clientSelect = root.querySelector('[name=client_id]');

    if (clientSelect) {
        clientSelect.innerHTML = `<option value="">${esc(t('entries.allClients'))}</option>` +
            clients.map((c) => `<option value="${c.id}"${colorAttr(c.color)}>${esc(c.name)}</option>`).join('');
        clientSelect.value = filters.client_id;
    }

    fillProjects(root);

    root.querySelector('[name=billed]').value = filters.billed;
    // Nur Administratoren haben den Papierkorb-Schalter.
    const trashed = root.querySelector('[name=trashed]');
    if (trashed) trashed.checked = filters.trashed === '1';
}

function fillProjects(root) {
    const clients = state.tree?.clients || [];
    const clientId = Number(filters.client_id) || null;
    const select = root.querySelector('[name=project_id]');

    const projects = clients
        .filter((c) => !clientId || c.id === clientId)
        .flatMap((c) => c.projects.map((p) => ({ ...p, client: c.name })));

    const many = clients.length > 1 && !clientId;
    select.innerHTML = `<option value="">${esc(t('entries.allProjects'))}</option>` + projects
        .map((p) => `<option value="${p.id}"${colorAttr(p.color)}>${esc(many ? `${p.client} | ${p.name}` : p.name)}</option>`)
        .join('');

    // Auswahl nur halten, wenn sie zum aktuellen Kunden noch passt.
    select.value = projects.some((p) => String(p.id) === filters.project_id) ? filters.project_id : '';
    filters.project_id = select.value;

    fillSubprojects(root);
}

function fillSubprojects(root) {
    const clients = state.tree?.clients || [];
    const projectId = Number(filters.project_id) || null;
    const select = root.querySelector('[name=subproject_id]');

    const projects = clients.flatMap((c) => c.projects);
    const subs = projects
        .filter((p) => !projectId || p.id === projectId)
        .flatMap((p) => p.subprojects.map((s) => ({ ...s, project: p.name })));

    // Ohne gewähltes Projekt wäre die Liste unübersichtlich lang.
    select.disabled = !projectId;
    select.innerHTML = projectId
        ? `<option value="">${esc(t('entries.allSubprojects'))}</option>` +
          subs.map((s) => `<option value="${s.id}"${colorAttr(s.color)}>${esc(s.name)}</option>`).join('')
        : `<option value="">${esc(t('entries.pickProjectFirst'))}</option>`;

    select.value = subs.some((s) => String(s.id) === filters.subproject_id) ? filters.subproject_id : '';
    filters.subproject_id = select.value;
}

function bind(root) {
    const form = root.querySelector('#filters');

    const read = () => {
        const data = new FormData(form);
        filters.from = data.get('from') || '';
        filters.to = data.get('to') || '';
        filters.client_id = data.get('client_id') || '';
        filters.project_id = data.get('project_id') || '';
        filters.subproject_id = data.get('subproject_id') || '';
        filters.q = data.get('q') || '';
        filters.billed = data.get('billed') || '';
        filters.trashed = form.trashed?.checked ? '1' : '0';
    };

    const update = () => {
        read();
        refresh(root);
    };

    form.addEventListener('change', (event) => {
        read();
        if (event.target.name === 'from' || event.target.name === 'to') range = null;
        // Die Auswahl hängt zusammen: ein anderer Kunde ändert die Projekte,
        // ein anderes Projekt die Teilprojekte.
        if (event.target.name === 'client_id') fillProjects(root);
        else if (event.target.name === 'project_id') fillSubprojects(root);
        refresh(root);
    });

    form.querySelector('[name=q]').addEventListener('input', debounce(update, 350));

    form.addEventListener('click', (event) => {
        const view = event.target.closest('[data-view]');
        if (view) return setMode(root, view.dataset.view);

        const output = event.target.closest('[data-output]');
        if (output) return openOutput(output.dataset.output, filterScope());

        if (event.target.closest('[data-reset]')) {
            resetFilters(form);
            fillFilters(root);
            // Im Kalender gibt die Navigation den Zeitraum vor, nicht die
            // zurückgesetzten Datumsfelder.
            if (mode === 'calendar') applyCalendarRange(root);
            return refresh(root);
        }

        const chip = event.target.closest('[data-range]');
        if (!chip) return;
        range = chip.dataset.range;
        const dates = rangeDates(range);
        form.from.value = dates.from;
        form.to.value = dates.to;
        update();
    });

    root.querySelector('#new-entry')?.addEventListener('click', () => editEntry(root, null));

    const results = root.querySelector('#results');

    // Häkchen einzeln oder für einen ganzen Tag.
    bindOnce(results, 'EntriesSelect', 'change', (event) => {
        const one = event.target.closest('[data-select]');
        const day = event.target.closest('[data-select-day]');
        if (!one && !day) return;

        const ids = one
            ? [Number(one.dataset.select)]
            : [...results.querySelectorAll(`[data-day="${day.dataset.selectDay}"] [data-select]:not(:disabled)`)]
                .map((el) => Number(el.dataset.select));
        for (const id of ids) {
            if (event.target.checked) selected.add(id);
            else selected.delete(id);
        }
        syncSelection(root);
    });

    bindOnce(root.querySelector('#batchbar'), 'EntriesBatch', 'click', (event) => {
        const action = event.target.closest('[data-batch]')?.dataset.batch;
        if (action === 'all') {
            for (const id of selectable) selected.add(id);
            syncSelection(root);
        } else if (action === 'clear') {
            selected.clear();
            syncSelection(root);
        } else if (action === 'edit') {
            batchEdit(root);
        } else if (action === 'report' || action === 'export') {
            openOutput(action, selectionScope());
        }
    });

    results.addEventListener('click', async (event) => {
        const edit = event.target.closest('[data-edit]');
        if (edit) return editEntry(root, Number(edit.dataset.edit));

        if (mode === 'calendar' && onCalendarClick(root, event)) return;

        const group = event.target.closest('[data-group]');
        if (group) {
            groupBy = group.dataset.group;
            storeView();
            return refresh(root);
        }

        const del = event.target.closest('[data-delete]');
        if (del) {
            if (!await confirmDialog(t('entries.deleteTitle'), t('entries.deleteText'))) return;
            try {
                await api.delete(`/entries/${del.dataset.delete}`);
                invalidateTree();
                await refresh(root);
            } catch (error) { toastError(error); }
            return;
        }

        const restore = event.target.closest('[data-restore]');
        if (restore) {
            try {
                await api.post(`/entries/${restore.dataset.restore}/restore`);
                await refresh(root);
            } catch (error) { toastError(error); }
        }
    });
}

// -- Darstellung umschalten -------------------------------------------------

/**
 * Zwischen Liste und Kalender wechseln. Der Kalender übernimmt beim
 * Einschalten den zuletzt betrachteten Zeitraum als Ankertag; beim
 * Zurückschalten bleibt der sichtbare Zeitraum in den Datumsfeldern stehen,
 * die Liste zeigt also denselben Ausschnitt.
 */
function setMode(root, next) {
    if (next === mode) return;
    mode = next;

    root.querySelector('#entries').classList.toggle('is-calendar', mode === 'calendar');
    for (const button of root.querySelectorAll('[data-view]')) {
        button.classList.toggle('is-active', button.dataset.view === mode);
    }

    if (mode === 'calendar') {
        anchor = startDate();
        applyCalendarRange(root);
    }
    storeView();
    refresh(root);
}

/**
 * Der Tag, auf dem der Kalender aufsetzt: heute, wenn es in den gefilterten
 * Zeitraum fällt – sonst dessen Ende. Ein Sprung auf einen leeren Monat
 * wäre sonst der Regelfall.
 */
function startDate() {
    const today = todayISO();
    const after = filters.from && today < filters.from;
    const before = filters.to && today > filters.to;
    if (!after && !before) return today;
    return after ? filters.from : filters.to;
}

/** Zeitraum des Kalenders in die (dann verborgenen) Datumsfelder schreiben. */
function applyCalendarRange(root) {
    const { from, to } = calendarRange(scale, anchor);
    const form = root.querySelector('#filters');

    // Der Zeitraum folgt jetzt der Kalendernavigation, nicht mehr dem Chip.
    range = null;
    savePref('entriesAnchor', anchor, { session: true });

    filters.from = from;
    filters.to = to;
    form.from.value = from;
    form.to.value = to;
}

/**
 * Klicks im Kalender. Gibt zurück, ob der Klick verarbeitet wurde – der
 * Aufrufer prüft danach noch auf Löschen und Wiederherstellen.
 */
function onCalendarClick(root, event) {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
        const direction = Number(nav.dataset.nav);
        anchor = direction ? shiftAnchor(scale, anchor, direction) : todayISO();
        applyCalendarRange(root);
        refresh(root);
        return true;
    }

    const next = event.target.closest('[data-scale]');
    if (next) {
        scale = next.dataset.scale;
        applyCalendarRange(root);
        storeView();
        refresh(root);
        return true;
    }

    // Tageskopf, Tageszahl im Monat und „+n weitere“ führen in den Tag.
    const open = event.target.closest('[data-open]');
    if (open) {
        scale = 'day';
        anchor = open.dataset.open;
        applyCalendarRange(root);
        storeView();
        refresh(root);
        return true;
    }

    // Freie Fläche: neuer Eintrag an der angeklickten Stelle.
    const slot = event.target.closest('[data-slot]');
    if (slot && canEdit()) {
        const grid = gridMinutes();
        const start = minutesAt(slot, event.clientY, grid);
        editEntry(root, null, start === null
            ? { date: slot.dataset.slot }
            : { date: slot.dataset.slot, start: minutesToTime(start), end: minutesToTime(start + 60) });
        return true;
    }

    return Boolean(slot);
}

function resetFilters(form) {
    // Dieselbe Vorgabe wie beim ersten Aufruf: Kunden sehen alles,
    // Administratoren den laufenden Monat.
    range = canEdit() ? 'month' : 'all';
    Object.assign(filters, {
        ...rangeDates(range),
        client_id: '',
        project_id: '',
        subproject_id: '',
        q: '',
        billed: '',
        trashed: '0',
    });
    form.from.value = filters.from;
    form.to.value = filters.to;
    form.q.value = '';
    form.billed.value = '';
    if (form.trashed) form.trashed.checked = false;
}

const RANGES = ['today', 'week', 'month', 'lastmonth', 'year', 'all'];

/** Von/Bis eines Schnellzeitraums, gerechnet ab heute. */
function rangeDates(key) {
    const today = todayISO();

    // "Gesamt" heißt: keine Datumsgrenzen – der Server liefert dann alles.
    if (key === 'today') return { from: today, to: today };
    if (key === 'week') return { from: startOfWeek(today), to: today };
    if (key === 'month') return { from: startOfMonth(), to: today };
    if (key === 'lastmonth') {
        const [y, m] = today.split('-').map(Number);
        const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
        const last = new Date(prev[0], prev[1], 0).getDate();
        const mm = String(prev[1]).padStart(2, '0');
        return { from: `${prev[0]}-${mm}-01`, to: `${prev[0]}-${mm}-${last}` };
    }
    if (key === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today };
    return { from: '', to: '' };
}

async function refresh(root) {
    const host = root.querySelector('#results');
    host.innerHTML = html`<div class="loading">${t('common.loading')}</div>`;

    storeFilters();
    for (const chip of root.querySelectorAll('[data-range]')) {
        chip.classList.toggle('is-active', chip.dataset.range === range);
    }
    selectable = [];
    loaded.clear();
    lastTotals = null;

    try {
        if (mode === 'stats') return await refreshStats(host);

        const data = await api.get('/entries', {
            ...filters,
            group: 'day',
            // Ein Monatsraster umfasst bis zu sechs Wochen; die Liste zeigt
            // ohnehin nur einen Ausschnitt und meldet den Rest.
            limit: mode === 'calendar' ? 1000 : 500,
        });
        lastTotals = data.totals;
        for (const day of data.days) {
            for (const entry of day.entries) loaded.set(entry.id, entry);
        }

        if (mode === 'calendar') {
            // Ein leerer Kalender ist kein Sonderfall – das leere Raster ist
            // genau das, was man sehen will.
            host.innerHTML = html`
                ${summary(data)}
                ${calendarHtml(data.days, { scale, anchor, editable: canEdit() })}`;
            scrollToFirstEvent(host);
            return;
        }

        if (!data.days.length) {
            host.innerHTML = html`<div class="card"><p class="muted card__body">${t('entries.empty')}</p></div>`;
            return;
        }

        if (canSelect()) selectable = [...loaded.keys()];
        host.innerHTML = html`${summary(data)}${data.days.map(dayGroup)}`;
    } catch (error) {
        toastError(error);
        host.innerHTML = html`<div class="card"><p class="card__body">${t('common.loadFailed')}</p></div>`;
    } finally {
        syncSelection(root);
    }
}

/**
 * Summen nach der gewählten Gruppierung – dieselben Filter wie die Liste.
 * Der Papierkorb hat keine Summen: die zählen nur, was auch abgerechnet
 * werden kann.
 */
async function refreshStats(host) {
    if (filters.trashed === '1') {
        host.innerHTML = html`<div class="card"><p class="muted card__body">${t('entries.statsTrash')}</p></div>`;
        return;
    }

    const data = await api.get('/stats', { ...queryFilters(), group_by: groupBy });
    lastTotals = data.totals;
    host.innerHTML = html`
        ${summary(data)}
        <div class="card stats__head">${groupChips(groupBy)}</div>
        ${statsHtml(data, groupBy)}`;
}

/** Ankreuzen nur in der Liste und außerhalb des Papierkorbs. */
function canSelect() {
    return canEdit() && mode === 'list' && filters.trashed !== '1';
}

/**
 * Auswahl mit der sichtbaren Liste abgleichen: Häkchen setzen, Tages-
 * kästchen (ganz, teilweise, gar nicht) nachziehen, Leiste ein-/ausblenden.
 */
function syncSelection(root) {
    const visible = new Set(selectable);
    for (const id of [...selected]) {
        if (!visible.has(id)) selected.delete(id);
    }

    for (const box of root.querySelectorAll('[data-select]')) {
        box.checked = selected.has(Number(box.dataset.select));
        box.closest('.entry')?.classList.toggle('is-selected', box.checked);
    }
    for (const box of root.querySelectorAll('[data-select-day]')) {
        const boxes = [...root.querySelectorAll(`[data-day="${box.dataset.selectDay}"] [data-select]:not(:disabled)`)];
        const count = boxes.filter((el) => el.checked).length;
        box.checked = boxes.length > 0 && count === boxes.length;
        box.indeterminate = count > 0 && count < boxes.length;
    }

    const bar = root.querySelector('#batchbar');
    if (!bar) return;
    bar.hidden = selected.size === 0;
    if (bar.hidden) return;

    bar.innerHTML = html`
        <span class="batchbar__info">
            <strong class="batchbar__count">${t('batch.selected', { count: selected.size })}</strong>
            ${selected.size < selectable.length
                ? html`<button type="button" class="chip" data-batch="all">${t('batch.selectAll')}</button>` : ''}
            <button type="button" class="chip" data-batch="clear">${t('batch.clear')}</button>
        </span>
        <span class="batchbar__actions">
            <button type="button" class="btn" data-batch="report">${t('output.report')}</button>
            <button type="button" class="btn" data-batch="export">${t('output.export')}</button>
            <button type="button" class="btn btn--primary" data-batch="edit">${t('batch.edit')}</button>
        </span>`;
}

// -- Leistungsnachweis und Export -------------------------------------------

/** Filter in der Form, die /stats, /report und /export erwarten. */
function queryFilters() {
    const { trashed, ...rest } = filters;
    return rest;
}

/** Ausgabe über die aktuellen Filter (Knöpfe in der Filterleiste). */
function filterScope() {
    const warnings = [];
    if (filters.q.trim()) warnings.push(t('output.warnSearch', { q: filters.q.trim() }));
    if (!filters.client_id && showClientFilter()) warnings.push(t('output.warnNoClient'));

    return {
        selection: false,
        count: lastTotals?.entries ?? 0,
        hhmm: lastTotals?.hhmm ?? hhmm(0),
        query: queryFilters(),
        warnings,
    };
}

/** Ausgabe über die angehakten Einträge (Knöpfe in der Auswahlleiste). */
function selectionScope() {
    const entries = [...selected].map((id) => loaded.get(id)).filter(Boolean);
    const clients = new Set(entries.map((entry) => entry.client_id));
    const warnings = clients.size > 1 ? [t('output.warnMultiClient', { count: clients.size })] : [];

    return {
        selection: true,
        count: entries.length,
        hhmm: hhmm(entries.reduce((sum, entry) => sum + entry.duration_min, 0)),
        // Nur die IDs, keine Filter: Zeitraum und Kunde des Nachweises ergeben
        // sich dann aus den Einträgen selbst, nicht aus dem breiteren Filter.
        query: { ids: entries.map((entry) => entry.id).join(',') },
        warnings,
    };
}

async function openOutput(kind, scope) {
    try {
        if (kind === 'report') await reportDialog(scope);
        else await exportDialog(scope);
    } catch (error) {
        toastError(error);
    }
}

function summary(data) {
    return html`
        <div class="summary card">
            <span><strong>${data.totals.hhmm}</strong> <span class="muted">${t('common.hours')}</span></span>
            ${data.totals.amount !== undefined
                ? html`<span><strong>${money(data.totals.amount)}</strong></span>` : ''}
            <span class="muted">${data.totals.entries} ${t('common.entries')}</span>
            ${data.total > data.totals.entries
                ? html`<span class="muted">
                    ${t('entries.countOf', { shown: data.totals.entries, total: data.total })}</span>` : ''}
        </div>`;
}

function dayGroup(day) {
    const withBoxes = canSelect();

    return html`
        <section class="card daygroup" data-day="${day.date}">
            <header class="card__head daygroup__head">
                ${withBoxes ? html`
                    <label class="check" title="${t('batch.selectDay')}">
                        <input type="checkbox" data-select-day="${day.date}" aria-label="${t('batch.selectDay')}">
                    </label>` : ''}
                <h3>${dayLabel(day.date)}</h3>
                <span class="badge">${day.hhmm}${day.amount !== undefined ? ` · ${money(day.amount)}` : ''}</span>
            </header>
            <ul class="entrylist entrylist--spaced">${day.entries.map(row)}</ul>
        </section>`;
}

function row(entry) {
    const check = canSelect();

    return html`
        <li class="entry ${entry.billed ? 'entry--billed' : ''} ${check ? 'entry--check' : ''}">
            ${check ? html`
                <label class="check entry__check" title="${t('batch.selectEntry')}">
                    <input type="checkbox" data-select="${entry.id}" aria-label="${t('batch.selectEntry')}">
                </label>` : ''}
            <span class="dot" style="background:${entry.color || 'var(--border)'}"></span>
            <span class="entry__times">
                ${entry.start_time}–${entry.end_time}
                ${entry.overnight ? html`<span class="tag" title="${t('entries.overnight')}">+1</span>` : ''}
            </span>
            <span class="entry__main">
                <span class="entry__path">
                    ${entry.subproject_name}
                    <span class="muted"> · ${entry.client_name} · ${entry.project_name}</span>
                </span>
                ${entry.note ? html`<span class="entry__note">${entry.note}</span>` : ''}
            </span>
            <span class="entry__dur">
                ${billedMark(entry, { open: true })}${entry.hhmm}
                ${entry.amount !== undefined ? html`<span class="muted entry__amount">${money(entry.amount)}</span>` : ''}
                ${entry.rate !== undefined ? html`<span class="muted entry__rate">
                    ${t('entries.perHour', { rate: money(entry.rate, entry.currency) })}</span>` : ''}
            </span>
            ${canEdit() ? html`
                <span class="entry__actions">
                    ${entry.deleted_at
                        ? html`<button class="icon-btn" data-restore="${entry.id}" title="${t('common.restore')}">↩</button>`
                        : html`
                            <button class="icon-btn" data-edit="${entry.id}" title="${t('common.edit')}">✎</button>
                            <button class="icon-btn" data-delete="${entry.id}" title="${t('common.delete')}">🗑</button>`}
                </span>` : ''}
        </li>`;
}

// -- Sammelbearbeiten -------------------------------------------------------

/**
 * Mehrere Einträge auf einmal ändern: verschieben, Stundensatz, abrechenbar,
 * Status. Zeiten, Dauer und Notizen gibt es hier bewusst nicht – die sind je
 * Eintrag verschieden, und der Server nimmt sie in diesem Weg auch nicht an.
 */
async function batchEdit(root) {
    // Abgerechnete Einträge sind gesperrt. Sie dürfen trotzdem in der Auswahl
    // stehen: für einen erneuten Nachweis, oder um sie über den Status
    // "offen" wieder freizugeben.
    const ids = [...selected];
    const billed = ids.filter((id) => loaded.get(id)?.billed).length;
    if (!ids.length) return;

    await loadTree();
    let subprojectId = null;

    const node = document.createElement('div');
    node.innerHTML = html`
        <p class="muted">${t('batch.intro')}</p>
        <p class="outscope__warn" data-billed-hint hidden></p>
        <div class="field">
            <span class="field__label">${t('batch.moveTo')}</span>
            <div class="batch__pick">
                <button type="button" class="input input--button" name="subproject_id" data-pick>${t('batch.keep')}</button>
                <button type="button" class="icon-btn" data-unpick hidden title="${t('batch.keep')}">✕</button>
            </div>
        </div>
        <div class="filters__row">
            <label class="field field--inline field--grow">
                <span class="field__label">${t('common.rate')}</span>
                <select class="input" name="rate_mode">
                    <option value="keep">${t('batch.rateKeep')}</option>
                    <option value="inherit">${t('batch.rateInherit')}</option>
                    <option value="fixed">${t('batch.rateFixed')}</option>
                </select>
            </label>
            <label class="field field--inline">
                <span class="field__label">&nbsp;</span>
                <input class="input" type="number" name="rate" step="0.01" min="0" disabled>
            </label>
        </div>
        <div class="filters__row">
            <label class="field field--inline field--grow">
                <span class="field__label">${t('batch.billable')}</span>
                <select class="input" name="billable">
                    <option value="">${t('batch.keep')}</option>
                    <option value="1">${t('batch.billableYes')}</option>
                    <option value="0">${t('batch.billableNo')}</option>
                </select>
            </label>
            <label class="field field--inline field--grow">
                <span class="field__label">${t('batch.status')}</span>
                <select class="input" name="billed">
                    <option value="">${t('batch.keep')}</option>
                    <option value="0">${t('common.billedOpen')}</option>
                    <option value="1">${t('common.billedDone')}</option>
                </select>
            </label>
        </div>
        <p class="muted" data-lock-hint hidden>${t('batch.billLocks')}</p>`;

    const pick = node.querySelector('[data-pick]');
    const unpick = node.querySelector('[data-unpick]');
    const rateMode = node.querySelector('[name=rate_mode]');
    const rate = node.querySelector('[name=rate]');

    pick.addEventListener('click', async () => {
        const picked = await pickSubproject({ current: subprojectId });
        if (!picked) return;
        subprojectId = picked;
        pick.textContent = flatSubprojects().find((s) => s.id === picked)?.path || t('common.dash');
        unpick.hidden = false;
    });
    unpick.addEventListener('click', () => {
        subprojectId = null;
        pick.textContent = t('batch.keep');
        unpick.hidden = true;
    });
    rateMode.addEventListener('change', () => {
        rate.disabled = rateMode.value !== 'fixed';
        if (!rate.disabled) rate.focus();
    });

    // Was mit den abgerechneten Einträgen der Auswahl passiert, hängt am
    // gewählten Status – der Hinweis zieht mit.
    const status = node.querySelector('[name=billed]');
    const billedHint = node.querySelector('[data-billed-hint]');
    const lockHint = node.querySelector('[data-lock-hint]');
    const showStatusHints = () => {
        billedHint.hidden = billed === 0;
        if (status.value === '0') {
            billedHint.textContent = billed === 1 ? t('batch.billedReopenOne') : t('batch.billedReopen', { count: billed });
        } else {
            billedHint.textContent = billed === 1 ? t('batch.billedSkippedOne') : t('batch.billedSkipped', { count: billed });
        }
        lockHint.hidden = status.value !== '1';
    };
    status.addEventListener('change', showStatusHints);
    showStatusHints();

    const result = await saveDialog({
        title: ids.length === 1 ? t('batch.titleOne') : t('batch.title', { count: ids.length }),
        body: node,
        saveLabel: t('common.apply'),
        save: async () => {
            const payload = { ids };
            if (subprojectId) payload.subproject_id = subprojectId;
            if (rateMode.value !== 'keep') payload.rate_mode = rateMode.value;
            if (rateMode.value === 'fixed') payload.rate = rate.value === '' ? null : Number(rate.value);
            if (node.querySelector('[name=billable]').value !== '') {
                payload.billable = node.querySelector('[name=billable]').value === '1';
            }
            if (status.value !== '') payload.billed = status.value === '1';

            if (Object.keys(payload).length === 1) throw new Error(t('batch.nothing'));
            return api.post('/entries/batch', payload);
        },
    });
    if (!result) return;

    const done = result.updated.length;
    if (done || !result.unchanged?.length) {
        toast(done === 1 ? t('batch.doneOne') : t('batch.done', { count: done }), 'ok', 3000);
    } else {
        toast(t('batch.noChange'), 'info', 3000);
    }
    if (result.skipped.length) {
        toast(t('batch.skipped', { count: result.skipped.length }), 'info', 6000);
    }
    selected.clear();
    invalidateTree();
    await refresh(root);
}

// -- Bearbeiten -------------------------------------------------------------

/**
 * Schrittweite der Zeitfelder: das Raster aus den Einstellungen – dasselbe,
 * nach dem auch gerundet wird. Ohne geladene Einstellung die dortige
 * Voreinstellung von 15 Minuten.
 */
function gridMinutes() {
    const minutes = Number(state.settings?.rounding_minutes);
    return Number.isFinite(minutes) && minutes >= 1 ? Math.min(240, Math.round(minutes)) : 15;
}

/**
 * Ein Zeitfeld mit Schrittschaltern. Der native Schritt (Pfeiltasten im Feld)
 * liegt auf demselben Raster wie die Knöpfe.
 */
function timeField(name, label, value, grid) {
    return html`
        <div class="field field--inline">
            <label class="field__label" for="entry-${name}">${label}</label>
            <div class="timefield">
                <input class="input" type="time" id="entry-${name}" name="${name}"
                    step="${grid * 60}" value="${value}">
                <span class="timefield__steps">
                    <button type="button" class="timefield__step" data-step="${name}" data-dir="1"
                        tabindex="-1" aria-label="${t('entries.stepUp', { minutes: grid })}">▲</button>
                    <button type="button" class="timefield__step" data-step="${name}" data-dir="-1"
                        tabindex="-1" aria-label="${t('entries.stepDown', { minutes: grid })}">▼</button>
                </span>
            </div>
        </div>`;
}

/**
 * Eintrag anlegen oder bearbeiten. `preset` füllt Datum und Uhrzeit vor –
 * so übernimmt ein Klick ins Kalenderraster die dort angeklickte Stelle.
 */
async function editEntry(root, id, preset = null) {
    let entry = null;
    if (id) {
        try {
            entry = (await api.get(`/entries/${id}`)).entry;
        } catch (error) { return toastError(error); }
    }

    await loadTree();
    // Das Raster steht in den Einstellungen; einmal je Sitzung reicht.
    if (!state.settings?.rounding_minutes) await loadSettings();
    const grid = gridMinutes();
    let subprojectId = entry?.subproject_id ?? flatSubprojects()[0]?.id ?? null;
    let subprojectLabel = entry?.path ?? flatSubprojects()[0]?.path ?? t('common.dash');

    const node = document.createElement('div');
    node.innerHTML = html`
        ${entry?.billed ? html`
            <p class="outscope__warn" data-billed-note>
                ${t('entries.billedAt', { date: formatDateTime(entry.billed_at) })} –
                ${t('entries.billedLocked')}</p>` : ''}
        <fieldset class="entryform__fields" data-fields>
        <div class="field">
            <span class="field__label">${t('common.subproject')}</span>
            <button type="button" class="input input--button" data-pick>${subprojectLabel}</button>
        </div>
        <div class="filters__row">
            <label class="field field--inline">
                <span class="field__label">${t('common.date')}</span>
                <input class="input" type="date" name="date"
                    value="${entry?.date ?? preset?.date ?? todayISO()}">
            </label>
            ${timeField('start', t('common.from'), entry?.start_time ?? preset?.start ?? '09:00', grid)}
            ${timeField('end', t('common.to'), entry?.end_time ?? preset?.end ?? '10:00', grid)}
            <div class="field field--inline">
                <span class="field__label">${t('common.duration')}</span>
                <output class="timesum" data-duration></output>
            </div>
        </div>
        <label class="field">
            <span class="field__label">${t('common.notes')}</span>
            <textarea class="input" name="note" rows="6">${entry?.note ?? ''}</textarea>
        </label>
        <div class="filters__row">
            <label class="field field--inline">
                <span class="field__label">${t('common.rate')}</span>
                <input class="input" type="number" name="rate" step="0.01" min="0"
                    value="${entry?.rate ?? ''}" placeholder="${t('entries.rateInherits')}">
            </label>
            <label class="switch">
                <input type="checkbox" name="billable" ${entry ? (entry.billable ? 'checked' : '') : 'checked'}>
                <span>${t('entries.billable')}</span>
            </label>
            <label class="switch">
                <input type="checkbox" name="round" ${entry ? '' : 'checked'}>
                <span>${t('entries.round')}</span>
            </label>
        </div>
        </fieldset>
        <div class="filters__row">
            <label class="field field--inline">
                <span class="field__label">${t('batch.status')}</span>
                <select class="input" name="billed">
                    <option value="0" ${entry?.billed ? '' : 'selected'}>${t('common.billedOpen')}</option>
                    <option value="1" ${entry?.billed ? 'selected' : ''}>${t('common.billedDone')}</option>
                </select>
            </label>
        </div>`;

    // Abgerechnet heißt gesperrt: die Felder werden erst frei, wenn der
    // Status wieder auf "offen" steht – so ist sichtbar, warum sich nichts
    // ändern lässt, und das Wiederöffnen passiert im selben Dialog.
    const status = node.querySelector('[name=billed]');
    const fields = node.querySelector('[data-fields]');
    const lockFields = () => { fields.disabled = Boolean(entry?.billed) && status.value === '1'; };
    status.addEventListener('change', lockFields);
    lockFields();

    node.querySelector('[data-pick]').addEventListener('click', async () => {
        const picked = await pickSubproject({ current: subprojectId });
        if (!picked) return;
        subprojectId = picked;
        const sub = flatSubprojects().find((s) => s.id === picked);
        node.querySelector('[data-pick]').textContent = sub?.path || t('common.dash');
    });

    const get = (name) => node.querySelector(`[name=${name}]`);

    /**
     * Nächster bzw. vorheriger Rasterpunkt. Eine Zeit neben dem Raster
     * (etwa aus einem gestoppten Timer) rastet damit beim ersten Klick ein,
     * statt den Versatz mitzuschleppen.
     */
    function stepTime(name, direction) {
        const input = get(name);
        const current = timeToMinutes(input.value);
        if (current === null) return;

        input.value = minutesToTime(direction > 0
            ? (Math.floor(current / grid) + 1) * grid
            : (Math.ceil(current / grid) - 1) * grid);
        showDuration();
    }

    /** Gesamtzeit hinter den Feldern – dieselbe Mitternachtsregel wie beim Speichern. */
    function showDuration() {
        const out = node.querySelector('[data-duration]');
        const start = timeToMinutes(get('start').value);
        const end = timeToMinutes(get('end').value);

        if (start === null || end === null) {
            out.innerHTML = html`<span class="muted">${t('common.dash')}</span>`;
            return;
        }

        const overnight = end < start;
        out.innerHTML = html`
            ${hhmm(overnight ? end + 1440 - start : end - start)}
            ${overnight ? html`<span class="tag" title="${t('entries.overnight')}">+1</span>` : ''}`;
    }

    node.addEventListener('click', (event) => {
        const step = event.target.closest('[data-step]');
        if (step) stepTime(step.dataset.step, Number(step.dataset.dir));
    });
    node.addEventListener('input', (event) => {
        if (event.target.name === 'start' || event.target.name === 'end') showDuration();
    });
    showDuration();

    let overlaps = 0;

    const saved = await saveDialog({
        title: id ? t('entries.editTitle') : t('entries.add'),
        body: node,
        save: async () => {
            // Bleibt abgerechnet: es gibt nichts zu speichern.
            if (entry?.billed && status.value === '1') return 'unchanged';

            const date = get('date').value;
            // Endzeit vor Startzeit heißt: über Mitternacht hinaus.
            const endDate = get('end').value < get('start').value ? shiftDays(date, 1) : date;

            const payload = {
                subproject_id: subprojectId,
                started_at: dateTimeToISO(date, get('start').value),
                ended_at: dateTimeToISO(endDate, get('end').value),
                note: get('note').value,
                billable: get('billable').checked,
                round: get('round').checked,
                rate: get('rate').value === '' ? null : Number(get('rate').value),
                billed: status.value === '1',
            };

            if (id) {
                await api.patch(`/entries/${id}`, payload);
            } else {
                const created = await api.post('/entries', payload);
                overlaps = created.overlaps?.length ?? 0;
            }
        },
    });
    if (!saved || saved === 'unchanged') return;

    if (overlaps) {
        toast(t('entries.overlapHint', { count: overlaps }), 'info', 6000);
    }
    invalidateTree();
    toast(t('common.saved'), 'ok', 2000);
    await refresh(root);
}
