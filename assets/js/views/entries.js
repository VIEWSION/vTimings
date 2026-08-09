// Einträge: Filter, Tagesgruppen, Bearbeiten, Papierkorb.

import { api } from '../api.js';
import { state, loadTree, loadSettings, invalidateTree, flatSubprojects } from '../store.js';
import { t } from '../i18n.js';
import { confirmDialog, pickSubproject, saveDialog, toast, toastError } from '../ui.js';
import {
    calendarHtml, calendarRange, minutesAt, SCALES, scrollToFirstEvent, shiftAnchor,
} from './calendar.js';
import {
    dateTimeToISO, dayLabel, debounce, esc, hhmm, html, minutesToTime, money, shiftDays,
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

let initialized = false;

// Darstellung: Liste oder Kalender. Im Kalender geben Maßstab und Ankertag
// den Zeitraum vor – die Datumsfelder des Filters werden dann von der
// Navigation gefüllt statt von Hand. Der Ankertag ist immer ein konkreter
// Tag, auch im Monatsraster.
const VIEW_KEY = 'vt.entriesView';

const stored = readView();
let mode = stored.mode === 'calendar' ? 'calendar' : 'list';
let scale = SCALES.includes(stored.scale) ? stored.scale : 'week';
let anchor = todayISO();

/** Darstellung und Maßstab überdauern die Sitzung – wie die Sprache. */
function readView() {
    try {
        return JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
    } catch {
        return {}; // Privater Modus oder kaputter Eintrag: dann eben Liste.
    }
}

function storeView() {
    try {
        localStorage.setItem(VIEW_KEY, JSON.stringify({ mode, scale }));
    } catch { /* siehe readView() */ }
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
            if (!canEdit()) {
                filters.from = '';
                filters.to = '';
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
                                <select class="input" name="client_id"></select>
                            </label>` : ''}
                        <label class="field field--inline field--grow">
                            <span class="field__label">${t('common.project')}</span>
                            <select class="input" name="project_id"></select>
                        </label>
                        <label class="field field--inline field--grow">
                            <span class="field__label">${t('common.subproject')}</span>
                            <select class="input" name="subproject_id"></select>
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
                                <button type="button" class="btn btn--primary" id="new-entry">${t('entries.add')}</button>
                            </div>` : ''}
                    </div>
                </form>
                <div id="results"><div class="loading">${t('common.loading')}</div></div>
            </section>`;

        fillFilters(root);
        bind(root);
        if (mode === 'calendar') applyCalendarRange(root);
        await refresh(root);
    },
};

/** Kunden-, Projekt- und Teilprojektauswahl befüllen und aufeinander abstimmen. */
function fillFilters(root) {
    const clients = state.tree?.clients || [];
    const clientSelect = root.querySelector('[name=client_id]');

    if (clientSelect) {
        clientSelect.innerHTML = `<option value="">${esc(t('entries.allClients'))}</option>` +
            clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
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
        .map((p) => `<option value="${p.id}">${esc(many ? `${p.client} | ${p.name}` : p.name)}</option>`)
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
          subs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
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

        if (event.target.closest('[data-reset]')) {
            resetFilters(form);
            fillFilters(root);
            // Im Kalender gibt die Navigation den Zeitraum vor, nicht die
            // zurückgesetzten Datumsfelder.
            if (mode === 'calendar') applyCalendarRange(root);
            return refresh(root);
        }

        const range = event.target.closest('[data-range]');
        if (!range) return;
        applyRange(form, range.dataset.range);
        update();
    });

    root.querySelector('#new-entry')?.addEventListener('click', () => editEntry(root, null));

    root.querySelector('#results').addEventListener('click', async (event) => {
        const edit = event.target.closest('[data-edit]');
        if (edit) return editEntry(root, Number(edit.dataset.edit));

        if (mode === 'calendar' && onCalendarClick(root, event)) return;

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
    Object.assign(filters, {
        from: canEdit() ? startOfMonth() : '',
        to: canEdit() ? todayISO() : '',
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

function applyRange(form, range) {
    const today = todayISO();
    const set = (from, to) => { form.from.value = from; form.to.value = to; };

    // "Gesamt" heißt: keine Datumsgrenzen – der Server liefert dann alles.
    if (range === 'all') return set('', '');
    if (range === 'today') return set(today, today);
    if (range === 'week') return set(startOfWeek(today), today);
    if (range === 'month') return set(startOfMonth(), today);
    if (range === 'lastmonth') {
        const [y, m] = today.split('-').map(Number);
        const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
        const last = new Date(prev[0], prev[1], 0).getDate();
        const mm = String(prev[1]).padStart(2, '0');
        return set(`${prev[0]}-${mm}-01`, `${prev[0]}-${mm}-${last}`);
    }
    if (range === 'year') return set(`${today.slice(0, 4)}-01-01`, today);
}

async function refresh(root) {
    const host = root.querySelector('#results');
    host.innerHTML = html`<div class="loading">${t('common.loading')}</div>`;

    try {
        const data = await api.get('/entries', {
            ...filters,
            group: 'day',
            // Ein Monatsraster umfasst bis zu sechs Wochen; die Liste zeigt
            // ohnehin nur einen Ausschnitt und meldet den Rest.
            limit: mode === 'calendar' ? 1000 : 500,
        });

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

        host.innerHTML = html`${summary(data)}${data.days.map(dayGroup)}`;
    } catch (error) {
        toastError(error);
        host.innerHTML = html`<div class="card"><p class="card__body">${t('common.loadFailed')}</p></div>`;
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
    return html`
        <section class="card daygroup">
            <header class="card__head daygroup__head">
                <h3>${dayLabel(day.date)}</h3>
                <span class="badge">${day.hhmm}${day.amount !== undefined ? ` · ${money(day.amount)}` : ''}</span>
            </header>
            <ul class="entrylist">${day.entries.map(row)}</ul>
        </section>`;
}

function row(entry) {
    return html`
        <li class="entry ${entry.billed ? 'entry--billed' : ''}">
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
                ${entry.billed ? html`<span class="tag tag--billed">
                    ${t('entries.invoice', { number: entry.invoice_number || t('common.dash') })}</span>` : ''}
            </span>
            <span class="entry__dur">
                ${entry.hhmm}
                ${entry.amount !== undefined ? html`<span class="muted entry__amount">${money(entry.amount)}</span>` : ''}
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
        </div>`;

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
            };

            if (id) {
                await api.patch(`/entries/${id}`, payload);
            } else {
                const created = await api.post('/entries', payload);
                overlaps = created.overlaps?.length ?? 0;
            }
        },
    });
    if (!saved) return;

    if (overlaps) {
        toast(t('entries.overlapHint', { count: overlaps }), 'info', 6000);
    }
    invalidateTree();
    toast(t('common.saved'), 'ok', 2000);
    await refresh(root);
}
