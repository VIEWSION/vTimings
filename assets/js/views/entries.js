// Einträge: Filter, Tagesgruppen, Bearbeiten, Papierkorb – dazu Summen,
// Leistungsnachweis und Export (früher eine eigene Seite "Auswertung").

import { api } from '../api.js';
import { state, loadTree, loadSettings, invalidateTree, flatSubprojects, byActivity } from '../store.js';
import { t } from '../i18n.js';
import { enhanceCombos } from '../combo.js';
import { icon } from '../icons.js';
import { loadPref, savePref } from '../prefs.js';
import { bindOnce, confirmDialog, pickSubproject, saveDialog, toast, toastError } from '../ui.js';
import {
    billedLabel, billedMark, calendarHtml, calendarRange, minutesAt, SCALES, scrollToFirstEvent, shiftAnchor,
} from './calendar.js';
import { exportDialog, GROUP_KEYS, groupChips, reportDialog, statsHtml } from './output.js';
import {
    count, dateTimeToISO, dayLabel, debounce, decimal, esc, formatDateTime, hhmm, html, minutesToTime, money, shiftDays,
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
    archived: '0', // '1' = Einträge und Auswahlfelder auch für archivierte Kunden/Projekte
};

// Zuletzt gewählter Schnellzeitraum ("Dieser Monat" usw.). Solange er gilt,
// merkt sich die Ansicht ihn statt fester Daten – sonst stünde nach einem
// Monatswechsel noch der alte Monat im Filter. Wer die Daten von Hand setzt,
// hebt ihn auf.
let range = null;

// Jahre mit Einträgen (absteigend) für "ganze Jahre" in der Schnellwahl –
// passend zu den übrigen Filtern (Kunde, Projekt, Suche …), aber unabhängig
// vom Zeitraum. `yearsKey` merkt, für welche Filter sie geladen wurden.
let years = [];
let yearsKey = null;
let yearsRequest = 0;

// Kunden und Projekte mit Einträgen zu den übrigen Filtern (Zeitraum, Status,
// Suche …): nur diese stehen in den Auswahlfeldern. Die Kundenliste hängt
// nicht an der eigenen Kundenauswahl, die Projektliste nur an den gewählten
// Kunden – sonst ließe sich die Auswahl nie wieder erweitern. null = noch
// nicht geladen, dann gilt keine Einschränkung.
let facets = { clients: null, projects: null };
let facetsRequest = 0;

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

// Ausgangspunkt für Umschalt-Klick (Bereich auswählen): der zuletzt einzeln
// an- oder abgehakte Eintrag.
let anchorId = null;

// Die gerade gezeigte Ansicht – für die Tastenkürzel, die am Dokument
// hängen (⌘/Strg+A, Esc) und nicht an einem Element der View.
let activeRoot = null;
let keysBound = false;

// Zuletzt geladene Einträge und Summen – daraus nennen die Dialoge für
// Leistungsnachweis und Export, worauf sie sich beziehen.
const loaded = new Map();
let lastTotals = null;

// Die Liste lädt seitenweise; `days` sind die bisher geladenen Tagesgruppen,
// `total` die Zahl aller passenden Einträge. Was fehlt, meldet die Liste
// oben und unten und lädt es auf Wunsch nach. `generation` zählt jedes
// Neuladen mit – ein Nachladen für inzwischen geänderte Filter verfällt.
const PAGE = 500;
let days = [];
let total = 0;
let generation = 0;
let loadingMore = null;

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
    range = isRange(saved.range) ? saved.range : null;
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

        // Der Baum wurde oben ohne Archivierte geladen; war der Schalter beim
        // letzten Mal an, fehlen sie sonst in den Auswahlfeldern.
        if (filters.archived === '1') await loadTree({ force: true, archived: true });

        root.innerHTML = html`
            <section class="stack ${mode === 'calendar' ? 'is-calendar' : ''}" id="entries">
                <form class="card filters" id="filters">
                    <div class="filters__row">
                        <span class="filters__dates">
                            <label class="field field--inline">
                                <span class="field__label">${t('entries.range')}</span>
                                <select class="input" name="range">
                                    <option value="">${t('entries.rangeCustom')}</option>
                                    ${RANGES.map((key) => html`<option value="${key}">${rangeLabel(key)}</option>`)}
                                    ${yearsHtml()}
                                </select>
                            </label>
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
                                <select class="input" name="client_id" multiple data-combo
                                    data-placeholder="${t('entries.allClients')}"></select>
                            </label>` : ''}
                        <label class="field field--inline field--grow">
                            <span class="field__label">${t('common.project')}</span>
                            <select class="input" name="project_id" multiple data-combo
                                data-placeholder="${t('entries.allProjects')}"></select>
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
                            <button type="button" class="chip" data-reset>${t('entries.resetFilters')}</button>
                        </div>
                        ${canEdit() ? html`
                            <div class="filters__tools">
                                <label class="switch">
                                    <input type="checkbox" name="trashed"> <span>${t('entries.trash')}</span>
                                </label>
                                <label class="switch">
                                    <input type="checkbox" name="archived"> <span>${t('master.showArchived')}</span>
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

        await loadFacets();
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

/** Farbe und Archiv-Kennzeichnung (combo.js) für eine Option. */
function optionAttrs(item) {
    return colorAttr(item.color) + (item.archived ? ' data-archived="1"' : '');
}

/**
 * Kunden mit Projekten und Teilprojekten für die Auswahlfelder. Archivierte
 * fehlen, solange "Archivierte" nicht angehakt ist – der gemeinsame Baum kann
 * sie enthalten, wenn die Stammdaten sie zuletzt gezeigt haben.
 */
function visibleClients() {
    const showArchived = filters.archived === '1';
    // Was gerade gewählt ist, bleibt in der Liste – auch ohne Einträge zu den
    // übrigen Filtern. Sonst spränge die Auswahl zurück auf "alle", statt eine
    // leere Liste zu zeigen.
    const pickedClients = idList(filters.client_id);
    const pickedProjects = idList(filters.project_id);
    const inFacet = (set, id, picked) => !set || set.has(String(id)) || picked.includes(String(id));

    return (state.tree?.clients || [])
        .filter((c) => (showArchived || !c.archived) && inFacet(facets.clients, c.id, pickedClients))
        .map((c) => ({
            ...c,
            projects: c.projects
                .filter((p) => (showArchived || !p.archived) && inFacet(facets.projects, p.id, pickedProjects))
                .map((p) => ({ ...p, subprojects: showArchived ? p.subprojects : p.subprojects.filter((s) => !s.archived) })),
        }));
}

/** "3,5" -> ['3', '5']; leer = keine Einschränkung. */
function idList(value) {
    return value ? String(value).split(',').filter(Boolean) : [];
}

/**
 * Kunden-, Projekt- und Teilprojektauswahl befüllen und aufeinander
 * abstimmen. Kunden und Projekte stehen nach "zuletzt aktiv" – woran gerade
 * gearbeitet wird, steht oben.
 */
function fillFilters(root) {
    const clients = byActivity(visibleClients());
    const clientSelect = root.querySelector('[name=client_id]');

    if (clientSelect) {
        // Mehrfachauswahl: nichts gewählt = alle (Platzhalter am Feld).
        const chosen = idList(filters.client_id).filter((id) => clients.some((c) => String(c.id) === id));
        filters.client_id = chosen.join(',');
        clientSelect.innerHTML = clients
            .map((c) => `<option value="${c.id}"${optionAttrs(c)}${chosen.includes(String(c.id)) ? ' selected' : ''}>${esc(c.name)}</option>`)
            .join('');
        clientSelect.comboSync?.();
    }

    fillProjects(root);

    root.querySelector('[name=billed]').value = filters.billed;
    // Nur Administratoren haben den Papierkorb-Schalter.
    const trashed = root.querySelector('[name=trashed]');
    if (trashed) trashed.checked = filters.trashed === '1';
    const archived = root.querySelector('[name=archived]');
    if (archived) archived.checked = filters.archived === '1';
}

function fillProjects(root) {
    const clients = visibleClients();
    const clientIds = idList(filters.client_id);
    const select = root.querySelector('[name=project_id]');

    const projects = byActivity(clients
        .filter((c) => !clientIds.length || clientIds.includes(String(c.id)))
        .flatMap((c) => c.projects.map((p) => ({ ...p, client: c.name }))));

    // Der Kundenname davor nur, wenn Projekte verschiedener Kunden im Spiel sind.
    const many = clients.length > 1 && clientIds.length !== 1;

    // Auswahl nur halten, soweit sie zu den gewählten Kunden noch passt.
    const chosen = idList(filters.project_id).filter((id) => projects.some((p) => String(p.id) === id));
    filters.project_id = chosen.join(',');

    select.innerHTML = projects
        .map((p) => `<option value="${p.id}"${optionAttrs(p)}${chosen.includes(String(p.id)) ? ' selected' : ''}>${esc(many ? `${p.client} | ${p.name}` : p.name)}</option>`)
        .join('');
    select.comboSync?.();

    fillSubprojects(root);
}

function fillSubprojects(root) {
    const clients = visibleClients();
    // Teilprojekte gibt es nur, wenn genau ein Projekt gewählt ist.
    const projectIds = idList(filters.project_id);
    const projectId = projectIds.length === 1 ? Number(projectIds[0]) : null;
    const select = root.querySelector('[name=subproject_id]');

    const projects = clients.flatMap((c) => c.projects);
    const subs = projects
        .filter((p) => !projectId || p.id === projectId)
        .flatMap((p) => p.subprojects.map((s) => ({ ...s, project: p.name })));

    // Ohne gewähltes Projekt wäre die Liste unübersichtlich lang.
    select.disabled = !projectId;
    select.innerHTML = projectId
        ? `<option value="">${esc(t('entries.allSubprojects'))}</option>` +
          subs.map((s) => `<option value="${s.id}"${optionAttrs(s)}>${esc(s.name)}</option>`).join('')
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
        filters.client_id = data.getAll('client_id').join(',');
        filters.project_id = data.getAll('project_id').join(',');
        filters.subproject_id = data.get('subproject_id') || '';
        filters.q = data.get('q') || '';
        filters.billed = data.get('billed') || '';
        filters.trashed = form.trashed?.checked ? '1' : '0';
        filters.archived = form.archived?.checked ? '1' : '0';
    };

    const update = () => {
        read();
        refresh(root);
    };

    form.addEventListener('change', async (event) => {
        if (event.target.name === 'range') {
            range = event.target.value || null;
            // "Benutzerdefiniert" lässt die Daten stehen, wie sie sind.
            if (range) {
                const dates = rangeDates(range);
                form.from.value = dates.from;
                form.to.value = dates.to;
            }
        }
        read();
        if (event.target.name === 'archived') {
            // Der Baum wird passend nachgeladen (mit bzw. ohne Archivierte).
            await loadTree({ force: true, archived: filters.archived === '1' });
            fillFilters(root);
            enhanceCombos(root);
            return refresh(root);
        }
        if (event.target.name === 'from' || event.target.name === 'to') range = null;
        // Die Auswahl hängt zusammen: ein anderer Kunde ändert die Projekte,
        // ein anderes Projekt die Teilprojekte.
        if (event.target.name === 'client_id') {
            facets.projects = null; // gilt für die vorige Kundenauswahl
            fillProjects(root);
        }
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
    });

    root.querySelector('#new-entry')?.addEventListener('click', () => editEntry(root, null));

    const results = root.querySelector('#results');

    // Tastatur: Enter auf einem fokussierten Eintrag öffnet ihn.
    bindOnce(results, 'EntriesOpenKey', 'keydown', (event) => {
        if (event.key !== 'Enter' || !event.target.matches('.entry[data-edit]')) return;
        event.preventDefault();
        editEntry(root, Number(event.target.dataset.edit));
    });

    activeRoot = root;
    // Am Fenster in der Capture-Phase: Safari gibt ⌘-Kürzel sonst unter
    // Umständen nicht bis zum <body> weiter. Einmal je Seite, nicht je Aufruf.
    if (!keysBound) {
        keysBound = true;
        window.addEventListener('keydown', onSelectionKey, true);
    }

    // Häkchen einzeln oder für einen ganzen Tag. Klicks mit Umschalt- oder
    // Befehlstaste kommen hier nicht an – die fängt der Klick-Handler unten ab.
    bindOnce(results, 'EntriesSelect', 'change', (event) => {
        if (event.target.matches('[data-select-all]')) {
            if (event.target.checked) for (const id of selectable) selected.add(id);
            else selected.clear();
            return syncSelection(root);
        }

        const one = event.target.closest('[data-select]');
        if (one) {
            const id = Number(one.dataset.select);
            if (one.checked) selected.add(id);
            else selected.delete(id);
            anchorId = id;
            return syncSelection(root);
        }

        const day = event.target.closest('[data-select-day]');
        if (!day) return;
        const ids = [...results.querySelectorAll(`[data-day="${day.dataset.selectDay}"] [data-select]:not(:disabled)`)]
            .map((el) => Number(el.dataset.select));
        for (const id of ids) {
            if (event.target.checked) selected.add(id);
            else selected.delete(id);
        }
        syncSelection(root);
    });

    bindOnce(root.querySelector('#batchbar'), 'EntriesBatch', 'click', (event) => {
        const action = event.target.closest('[data-batch]')?.dataset.batch;
        if (action === 'edit') {
            batchEdit(root);
        } else if (action === 'report' || action === 'export') {
            openOutput(action, selectionScope());
        } else if (['trash', 'restore', 'purge'].includes(action)) {
            batchRemove(root, action);
        } else if (action === 'clear') {
            selected.clear();
            anchorId = null;
            syncSelection(root);
        }
    });

    results.addEventListener('click', async (event) => {
        const more = event.target.closest('[data-more]');
        if (more) return loadMore(root, more.dataset.more === 'all');

        // Wie in Desktop-Programmen, auf Zeile wie Kästchen: ⌘/Strg-Klick
        // hakt an oder ab, Umschalt-Klick gibt dem Bereich bis zum zuletzt
        // angeklickten Eintrag dessen Zustand. Alles in diesem einen Klick –
        // Safari reicht die Tasten beim Klick aufs Label nicht ans Kästchen
        // weiter, auf `change` ist dafür kein Verlass.
        const modified = event.shiftKey || event.metaKey || event.ctrlKey;
        const box = event.target.closest('.entry')?.querySelector('[data-select]');
        if (modified && box && canSelect()) {
            // Kein Öffnen, kein eigenes Umschalten des Kästchens und keine
            // Textmarkierung, die Umschalt-Klick sonst aufzieht.
            event.preventDefault();
            window.getSelection()?.removeAllRanges();

            const id = Number(box.dataset.select);
            if (event.shiftKey && anchorId !== null) selectRange(anchorId, id, selected.has(anchorId));
            else if (selected.has(id)) selected.delete(id);
            else selected.add(id);
            if (!event.shiftKey || anchorId === null) anchorId = id;
            // Erst nach dem Klick: ein abgebrochener Klick setzt das Kästchen
            // hinterher auf den alten Stand zurück.
            setTimeout(() => syncSelection(root));
            return;
        }

        // Häkchen im Eintrag wählen aus, statt zu öffnen; markierter Text
        // (Notiz kopieren) ebenso wenig.
        const edit = event.target.closest('[data-edit]');
        if (edit && !event.target.closest('.check') && !String(window.getSelection())) {
            return editEntry(root, Number(edit.dataset.edit));
        }

        if (mode === 'calendar' && onCalendarClick(root, event)) return;

        const group = event.target.closest('[data-group]');
        if (group) {
            groupBy = group.dataset.group;
            storeView();
            return refresh(root);
        }

        const restore = event.target.closest('[data-restore]');
        if (restore) {
            try {
                await api.post(`/entries/${restore.dataset.restore}/restore`);
                await refresh(root);
            } catch (error) { toastError(error); }
            return;
        }

        const purge = event.target.closest('[data-purge]');
        if (purge) {
            if (!await confirmDialog(t('entries.purgeTitle'), t('entries.purgeText'), t('common.delete'))) return;
            try {
                await api.delete(`/entries/${purge.dataset.purge}/purge`);
                toast(t('common.deleted'), 'ok', 2000);
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
        archived: '0',
    });
    form.from.value = filters.from;
    form.to.value = filters.to;
    form.q.value = '';
    form.billed.value = '';
    if (form.trashed) form.trashed.checked = false;
}

// Reihenfolge = Reihenfolge in der Schnellwahl.
const RANGES = [
    'today', 'week', 'lastweek', 'month', 'lastmonth',
    'quarter', 'lastquarter', 'year', 'lastyear', 'all',
];

const RANGE_KEYS = {
    today: 'rangeToday', week: 'rangeWeek', lastweek: 'rangeLastWeek',
    month: 'rangeMonth', lastmonth: 'rangeLastMonth',
    quarter: 'rangeQuarter', lastquarter: 'rangeLastQuarter',
    year: 'rangeYear', lastyear: 'rangeLastYear', all: 'rangeAll',
};

/** Schnellzeitraum oder ganzes Jahr (`y2024`). */
function isRange(key) {
    return RANGES.includes(key) || (typeof key === 'string' && /^y\d{4}$/.test(key));
}

/**
 * Gruppe "Ganze Jahre". Ein gewähltes Jahr bleibt auch dann in der Liste,
 * wenn es zu den neuen Filtern keine Einträge hat – sonst spränge die
 * Auswahl stillschweigend auf "Benutzerdefiniert".
 */
function yearsHtml() {
    const chosen = /^y(\d{4})$/.exec(range ?? '')?.[1];
    const list = chosen && !years.includes(chosen)
        ? [...years, chosen].sort().reverse()
        : years;
    if (!list.length) return '';
    return html`
        <optgroup label="${t('entries.rangeYears')}">
            ${list.map((year) => html`<option value="y${year}">${year}</option>`)}
        </optgroup>`;
}

const sameSet = (a, b) => a === b || (a && b && a.size === b.size && [...a].every((x) => b.has(x)));

/** Kunden/Projekte mit Einträgen zu den aktuellen Filtern laden. */
async function loadFacets() {
    const { client_id, project_id, subproject_id, ...base } = queryFilters();

    // Bei jedem Aufruf neu fragen, nicht nur bei geänderten Filtern: neue oder
    // verschobene Einträge ändern die Antwort, ohne dass ein Filter wechselt.
    // Nur die jüngste Antwort zählt, falls Filter schnell wechseln.
    const ticket = ++facetsRequest;
    let next = { clients: null, projects: null };
    try {
        const [byClient, byProject] = await Promise.all([
            api.get('/stats', { ...base, group_by: 'client' }),
            api.get('/stats', { ...base, ...(client_id ? { client_id } : {}), group_by: 'project' }),
        ]);
        const keys = (data) => new Set(data.groups.map((g) => String(g.key)));
        next = { clients: keys(byClient), projects: keys(byProject) };
    } catch {
        // Ohne Antwort keine Einschränkung – beim nächsten Mal erneut versuchen.
    }
    if (ticket !== facetsRequest) return false;

    const changed = { clients: !sameSet(facets.clients, next.clients), projects: !sameSet(facets.projects, next.projects) };
    facets = next;
    facets.changed = changed;
    return true;
}

/**
 * Auswahlfelder an die Facetten anpassen. Nur was sich geändert hat, wird neu
 * gezeichnet – ein gerade geöffnetes Feld darf nicht unter der Hand ersetzt
 * werden. Fällt dabei eine Auswahl weg, ändern sich die Einträge: neu laden.
 */
async function syncFacets(root) {
    if (!(await loadFacets())) return;

    const before = `${filters.client_id}|${filters.project_id}|${filters.subproject_id}`;
    if (facets.changed.clients) fillFilters(root);
    else if (facets.changed.projects) fillProjects(root);
    if (before !== `${filters.client_id}|${filters.project_id}|${filters.subproject_id}`) refresh(root);
}

/** Jahre zu den aktuellen Filtern (ohne Zeitraum) laden und eintragen. */
async function syncYears(root) {
    const { from, to, ...rest } = queryFilters();
    const key = JSON.stringify(rest);

    if (key !== yearsKey) {
        yearsKey = key;
        // Nur die jüngste Antwort zählt, falls Filter schnell wechseln.
        const ticket = ++yearsRequest;
        let found = [];
        try {
            const data = await api.get('/stats', { ...rest, group_by: 'year' });
            found = data.groups.map((group) => group.key).filter((y) => /^\d{4}$/.test(y)).sort().reverse();
        } catch {
            yearsKey = null; // beim nächsten Mal erneut versuchen
        }
        if (ticket !== yearsRequest) return;
        years = found;
    }

    const select = root.querySelector('[name=range]');
    if (!select) return;
    select.querySelector('optgroup')?.remove();
    select.insertAdjacentHTML('beforeend', String(yearsHtml()));
    select.value = range ?? '';
}

function rangeLabel(key) {
    return t('entries.' + RANGE_KEYS[key]);
}

/**
 * Von/Bis eines Schnellzeitraums, gerechnet ab heute. Laufende Zeiträume
 * (diese Woche, dieser Monat …) enden heute, abgeschlossene am letzten Tag.
 */
function rangeDates(key) {
    const today = todayISO();
    const [y, m] = today.split('-').map(Number);
    const iso = (year, month, day) =>
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const lastDay = (year, month) => new Date(year, month, 0).getDate();

    const year = /^y(\d{4})$/.exec(key ?? '');
    if (year) return { from: `${year[1]}-01-01`, to: `${year[1]}-12-31` };
    if (key === 'today') return { from: today, to: today };
    if (key === 'week') return { from: startOfWeek(today), to: today };
    if (key === 'lastweek') {
        const monday = shiftDays(startOfWeek(today), -7);
        return { from: monday, to: shiftDays(monday, 6) };
    }
    if (key === 'month') return { from: startOfMonth(), to: today };
    if (key === 'lastmonth') {
        const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
        return { from: iso(py, pm, 1), to: iso(py, pm, lastDay(py, pm)) };
    }
    const qStart = m - ((m - 1) % 3); // erster Monat des Quartals
    if (key === 'quarter') return { from: iso(y, qStart, 1), to: today };
    if (key === 'lastquarter') {
        const [py, pm] = qStart === 1 ? [y - 1, 10] : [y, qStart - 3];
        return { from: iso(py, pm, 1), to: iso(py, pm + 2, lastDay(py, pm + 2)) };
    }
    if (key === 'year') return { from: iso(y, 1, 1), to: today };
    if (key === 'lastyear') return { from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31) };
    // "Gesamt" heißt: keine Datumsgrenzen – der Server liefert dann alles.
    return { from: '', to: '' };
}

async function refresh(root) {
    const host = root.querySelector('#results');
    host.innerHTML = html`<div class="loading">${t('common.loading')}</div>`;

    storeFilters();
    const rangeSelect = root.querySelector('[name=range]');
    if (rangeSelect) rangeSelect.value = range ?? '';
    // Nach dem Bearbeiten ist der Baum verworfen (invalidateTree) – ohne ihn
    // wären die Auswahlfelder leer, bis die Seite neu geladen wird.
    if (!state.tree) {
        await loadTree({ archived: filters.archived === '1' });
        fillFilters(root);
    }
    syncYears(root);
    syncFacets(root);
    selectable = [];
    loaded.clear();
    lastTotals = null;
    days = [];
    total = 0;
    const ticket = ++generation;

    try {
        if (mode === 'stats') return await refreshStats(host);

        const data = await api.get('/entries', {
            ...queryFilters(),
            trashed: filters.trashed,
            group: 'day',
            // Ein Monatsraster umfasst bis zu sechs Wochen; die Liste lädt
            // seitenweise nach (loadMore).
            limit: mode === 'calendar' ? 1000 : PAGE,
        });
        if (ticket !== generation) return;
        lastTotals = data.totals;
        total = data.total;
        days = data.days;
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
        host.innerHTML = html`${summary(data)}${days.map(dayGroup)}${moreHtml()}`;
    } catch (error) {
        if (ticket !== generation) return;
        toastError(error);
        host.innerHTML = html`<div class="card"><p class="card__body">${t('common.loadFailed')}</p></div>`;
    } finally {
        if (ticket === generation) syncSelection(root);
    }
}

/**
 * Nächste Seite der Liste laden – oder mit `all` den ganzen Rest, in
 * Schritten zu 1000 (mehr gibt der Server auf einmal nicht her). Jede
 * Antwort wird sofort angehängt, so sieht man den Fortschritt.
 */
async function loadMore(root, all) {
    const ticket = generation;
    if (loadingMore === ticket) return;
    loadingMore = ticket;

    const host = root.querySelector('#results');
    const pending = host.querySelector('#more');
    for (const button of pending?.querySelectorAll('button') ?? []) button.disabled = true;

    try {
        while (loaded.size < total) {
            pending?.querySelector('[data-more-info]')
                ?.replaceChildren(t('entries.loadingMore', { shown: count(loaded.size), total: count(total) }));

            const data = await api.get('/entries', {
                ...queryFilters(),
                trashed: filters.trashed,
                group: 'day',
                limit: all ? 1000 : PAGE,
                offset: loaded.size,
            });
            if (ticket !== generation) return;
            total = data.total;
            lastTotals = data.totals;
            if (!data.days.length) break;
            appendDays(host, data.days);
            if (!all) break;
        }
    } catch (error) {
        if (ticket === generation) toastError(error);
    } finally {
        if (loadingMore === ticket) loadingMore = null;
        if (ticket === generation) {
            host.querySelector('.summary')?.replaceWith(fragment(summary({ totals: lastTotals })));
            host.querySelector('#more')?.replaceWith(fragment(moreHtml()));
            syncSelection(root);
        }
    }
}

/**
 * Tage einer weiteren Seite anhängen. Die Seitengrenze kann mitten durch
 * einen Tag laufen – dann wächst der zuletzt gezeigte Tag, samt Summe.
 */
function appendDays(host, incoming) {
    const more = host.querySelector('#more');
    let added = '';

    for (const day of incoming) {
        for (const entry of day.entries) loaded.set(entry.id, entry);

        const last = days[days.length - 1];
        if (last && last.date === day.date && !added) {
            last.entries.push(...day.entries);
            last.minutes += day.minutes;
            last.hhmm = hhmm(last.minutes);
            if (last.amount !== undefined) last.amount = Math.round((last.amount + day.amount) * 100) / 100;
            host.querySelector(`[data-day="${last.date}"]`)?.replaceWith(fragment(dayGroup(last)));
        } else {
            days.push(day);
            added += dayGroup(day);
        }
    }

    more?.insertAdjacentHTML('beforebegin', added);
    if (canSelect()) selectable = [...loaded.keys()];
}

/** Markup (auch leer) als einfügbare Knoten. */
function fragment(markup) {
    const template = document.createElement('template');
    template.innerHTML = String(markup);
    return template.content;
}

/** Hinweis am Ende der Liste, solange nicht alle Einträge geladen sind. */
function moreHtml() {
    const rest = total - loaded.size;
    if (mode !== 'list' || rest <= 0) return '';

    return html`
        <div class="card more" id="more">
            <span class="more__info" data-more-info>
                ${t('entries.countOf', { shown: count(loaded.size), total: count(total) })}</span>
            <span class="more__actions">
                <button type="button" class="btn" data-more="page">
                    ${t('entries.loadMore', { count: count(Math.min(PAGE, rest)) })}</button>
                <button type="button" class="btn btn--primary" data-more="all">
                    ${t('entries.loadAll', { count: count(total) })}</button>
            </span>
        </div>`;
}

/**
 * Tastenkürzel der Auswahl: ⌘/Strg+A hakt alle geladenen Einträge an, Esc
 * hebt die Auswahl auf. Nicht in Eingabefeldern (dort bleibt ⌘A "Text
 * markieren") und nicht, solange ein Dialog offen ist.
 */
function onSelectionKey(event) {
    const root = activeRoot;
    if (!root?.isConnected || !canSelect() || document.querySelector('.overlay')) return;
    const target = event.target instanceof Element ? event.target : document.activeElement;
    if (target?.closest?.('input:not([type=checkbox]), textarea, select, [contenteditable]')) return;

    // `code` statt nur `key`: mit gehaltener ⌘-Taste liefert nicht jeder
    // Browser bei jeder Tastaturbelegung "a".
    const keyA = event.code === 'KeyA' || event.key?.toLowerCase() === 'a';
    if ((event.metaKey || event.ctrlKey) && !event.altKey && keyA) {
        if (!selectable.length) return;
        event.preventDefault();
        for (const id of selectable) selected.add(id);
        syncSelection(root);
    } else if (event.key === 'Escape' && selected.size) {
        selected.clear();
        anchorId = null;
        syncSelection(root);
    }
}

/** Einen Bereich der Liste (in Anzeigereihenfolge) an- oder abhaken. */
function selectRange(fromId, toId, on) {
    const a = selectable.indexOf(fromId);
    const b = selectable.indexOf(toId);
    const ids = a < 0 || b < 0 ? [toId] : selectable.slice(Math.min(a, b), Math.max(a, b) + 1);
    for (const id of ids) {
        if (on) selected.add(id);
        else selected.delete(id);
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

/** Ankreuzen nur in der Liste; im Papierkorb für Wiederherstellen/endgültig Löschen. */
function canSelect() {
    return canEdit() && mode === 'list';
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
        // Nur im eigenen Tag suchen – bei Tausenden Tagen zählt das.
        const boxes = [...box.closest('[data-day]').querySelectorAll('[data-select]:not(:disabled)')];
        const count = boxes.filter((el) => el.checked).length;
        box.checked = boxes.length > 0 && count === boxes.length;
        box.indeterminate = count > 0 && count < boxes.length;
    }

    const all = root.querySelector('[data-select-all]');
    if (all) {
        all.checked = selectable.length > 0 && selected.size === selectable.length;
        all.indeterminate = selected.size > 0 && selected.size < selectable.length;
    }

    const bar = root.querySelector('#batchbar');
    if (!bar) return;
    bar.hidden = selected.size === 0;
    if (bar.hidden) return;

    // Summen der Auswahl – dieselben Kennzahlen wie oben für die ganze Liste.
    const picked = [...selected].map((id) => loaded.get(id)).filter(Boolean);
    const minutes = picked.reduce((sum, entry) => sum + entry.duration_min, 0);
    const amount = picked.some((entry) => entry.amount !== undefined)
        ? Math.round(picked.reduce((sum, entry) => sum + (entry.amount ?? 0), 0) * 100) / 100
        : undefined;

    bar.innerHTML = html`
        <button type="button" class="icon-btn" data-batch="clear"
            title="${t('batch.clear')}" aria-label="${t('batch.clear')}">${icon('close')}</button>
        <span class="batchbar__info">
            <strong class="batchbar__count">${selected.size === 1
                ? t('batch.selectedOne')
                : t('batch.selected', { count: count(selected.size) })}</strong>
            <span><strong class="batchbar__num">${hhmm(minutes)}</strong>
                <span class="muted">${t('common.hours')}</span></span>
            ${amount !== undefined ? html`<strong class="batchbar__num">${money(amount)}</strong>` : ''}
        </span>
        <span class="batchbar__actions">
            ${filters.trashed === '1' ? html`
                <button type="button" class="btn" data-batch="restore">${icon('restore', 16)} ${t('common.restore')}</button>
                <button type="button" class="btn btn--danger" data-batch="purge">${icon('trash', 16)} ${t('entries.purge')}</button>` : html`
                <button type="button" class="btn" data-batch="report">${t('output.report')}</button>
                <button type="button" class="btn" data-batch="export">${t('output.export')}</button>
                <button type="button" class="btn" data-batch="trash">${icon('trash', 16)} ${t('batch.trash')}</button>
                <button type="button" class="btn btn--primary" data-batch="edit">${t('batch.edit')}</button>`}
        </span>`;
}

// -- Leistungsnachweis und Export -------------------------------------------

/** Filter in der Form, die /stats, /report und /export erwarten. */
function queryFilters() {
    const { trashed, archived, ...rest } = filters;
    // Archivierte Kunden/Projekte gelten nur für Administratoren als Schalter.
    return canEdit() ? { ...rest, archived: archived === '1' ? '1' : '0' } : rest;
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
    // In der Liste wählt das Kästchen alle sichtbaren Einträge aus bzw. ab –
    // Zustand (ganz, teilweise, gar nicht) zieht syncSelection() nach.
    return html`
        <div class="summary card">
            ${canSelect() && selectable.length ? html`
                <label class="check" title="${t('batch.selectAll')}">
                    <input type="checkbox" data-select-all aria-label="${t('batch.selectAll')}">
                </label>` : ''}
            <span><strong>${data.totals.hhmm}</strong> <span class="muted">${t('common.hours')}</span></span>
            ${data.totals.amount !== undefined
                ? html`<span><strong>${money(data.totals.amount)}</strong></span>` : ''}
            <span class="muted">${count(data.totals.entries)} ${t('common.entries')}</span>
            ${loaded.size < total ? html`
                <span class="summary__partial">
                    ${t('entries.countOf', { shown: count(loaded.size), total: count(total) })}
                    ${mode === 'list' ? html`
                        <button type="button" class="chip" data-more="all">${t('entries.loadAllShort')}</button>` : ''}
                </span>` : ''}
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

    // Ein Klick auf den Eintrag öffnet ihn zum Bearbeiten (Löschen steckt im
    // Dialog). Im Papierkorb nicht – dort gibt es nur Wiederherstellen.
    const open = canEdit() && !entry.deleted_at;

    return html`
        <li class="entry ${entry.billed ? 'entry--billed' : ''} ${entry.archived ? 'entry--archived' : ''} ${check ? 'entry--check' : ''} ${open ? 'entry--open' : ''}"
            ${open ? { __raw: `data-edit="${entry.id}" tabindex="0"` } : ''}>
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
                    ${entry.archived ? html`<span class="row__tag">${t('master.archivedTag')}</span>` : ''}
                </span>
                ${entry.note ? html`<span class="entry__note">${entry.note}</span>` : ''}
            </span>
            <span class="entry__dur">
                ${billedMark(entry, { open: true })}${entry.hhmm}
                ${entry.amount !== undefined ? html`<span class="muted entry__amount">${money(entry.amount)}</span>` : ''}
                ${entry.rate !== undefined ? html`<span class="muted entry__rate">
                    ${t('entries.perHour', { rate: money(entry.rate, entry.currency) })}</span>` : ''}
            </span>
            ${canEdit() && entry.deleted_at ? html`
                <span class="entry__actions">
                    <button class="icon-btn" data-restore="${entry.id}"
                        title="${t('common.restore')}" aria-label="${t('common.restore')}">${icon('restore')}</button>
                    <button class="icon-btn" data-purge="${entry.id}"
                        title="${t('entries.purge')}" aria-label="${t('entries.purge')}">${icon('trash')}</button>
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
                <button type="button" class="icon-btn" data-unpick hidden
                    title="${t('batch.keep')}" aria-label="${t('batch.keep')}">${icon('close')}</button>
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
                <input class="input" type="number" name="rate" step="0.01" min="0">
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

    // Das Satzfeld zeigt in Grau, was gelten würde: bei "behalten" der Satz
    // der Auswahl (oder "unterschiedlich"), bei "aus den Stammdaten" der dort
    // hinterlegte. Eigene Eingabe (kräftig) schaltet auf "festen Satz".
    const picked = ids.map((id) => loaded.get(id)).filter(Boolean);
    const rateText = (values) => {
        const set = new Set(values);
        return set.size === 1 && !set.has(undefined) ? decimal([...set][0]) : `≠ ${t('batch.rateMixed')}`;
    };
    const showRateHint = () => {
        if (rateMode.value === 'fixed') {
            rate.placeholder = '';
            return;
        }
        if (rateMode.value === 'keep') {
            rate.placeholder = rateText(picked.map((entry) => entry.rate));
            return;
        }
        const effective = new Map(flatSubprojects().map((s) => [s.id, s.effective_rate]));
        rate.placeholder = rateText(picked.map((entry) => effective.get(subprojectId ?? entry.subproject_id)));
    };

    pick.addEventListener('click', async () => {
        const chosen = await pickSubproject({ current: subprojectId });
        if (!chosen) return;
        subprojectId = chosen;
        pick.textContent = flatSubprojects().find((s) => s.id === chosen)?.path || t('common.dash');
        unpick.hidden = false;
        showRateHint();
    });
    unpick.addEventListener('click', () => {
        subprojectId = null;
        pick.textContent = t('batch.keep');
        unpick.hidden = true;
        showRateHint();
    });
    rateMode.addEventListener('change', () => {
        if (rateMode.value === 'fixed') rate.focus();
        else rate.value = ''; // ein getippter Satz gilt nur mit "festen Satz setzen"
        showRateHint();
    });
    rate.addEventListener('input', () => {
        // Eigener Satz -> "festen Satz setzen"; leeres Feld -> zurück.
        if (rate.value !== '') rateMode.value = 'fixed';
        else if (rateMode.value === 'fixed') rateMode.value = 'keep';
        showRateHint();
    });
    showRateHint();

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
            if (rateMode.value === 'fixed') {
                if (rate.value === '') throw new Error(t('batch.rateEmpty'));
                payload.rate = Number(rate.value);
            }
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

/** Auswahl in den Papierkorb legen, zurückholen oder endgültig löschen. */
async function batchRemove(root, action) {
    const ids = [...selected];
    if (!ids.length) return;
    const n = count(ids.length);

    // In den Papierkorb und zurück lässt sich rückgängig machen – nur das
    // endgültige Löschen fragt nach.
    if (action === 'purge' && !await confirmDialog(
        t('batch.purgeTitle', { count: n }), t('batch.purgeText', { count: n }), t('entries.purge'),
    )) return;
    if (action === 'trash' && ids.length > 1 && !await confirmDialog(
        t('batch.trashTitle', { count: n }), t('batch.trashText'), t('batch.trash'),
    )) return;

    try {
        const result = await api.post('/entries/batch/remove', { ids, action });
        toast(t('batch.removed.' + action, { count: count(result.done.length) }), 'ok', 3000);
        if (result.skipped.length) {
            toast(t('batch.removeSkipped', { count: result.skipped.length }), 'info', 6000);
        }
    } catch (error) {
        return toastError(error);
    }
    selected.clear();
    anchorId = null;
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
                        tabindex="-1" aria-label="${t('entries.stepUp', { minutes: grid })}">${icon('up', 12)}</button>
                    <button type="button" class="timefield__step" data-step="${name}" data-dir="-1"
                        tabindex="-1" aria-label="${t('entries.stepDown', { minutes: grid })}">${icon('down', 12)}</button>
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
                ${billedLabel(entry)} –
                ${t(entry.budget_id ? 'entries.billedBudgetLocked' : 'entries.billedLocked')}</p>` : ''}
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
                <select class="input" name="billed" ${entry?.budget_id ? 'disabled' : ''}>
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
        remove: id ? () => api.delete(`/entries/${id}`) : null,
        removeConfirm: { title: t('entries.deleteTitle'), text: t('entries.deleteText') },
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
    if (saved === 'removed') {
        invalidateTree();
        toast(t('common.deleted'), 'ok', 2000);
        return refresh(root);
    }

    if (overlaps) {
        toast(t('entries.overlapHint', { count: overlaps }), 'info', 6000);
    }
    invalidateTree();
    toast(t('common.saved'), 'ok', 2000);
    await refresh(root);
}
