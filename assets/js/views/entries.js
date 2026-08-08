// Einträge: Filter, Tagesgruppen, Bearbeiten, Papierkorb.

import { api } from '../api.js';
import { state, loadTree, invalidateTree, flatSubprojects } from '../store.js';
import { confirmDialog, dialog, pickSubproject, toast, toastError } from '../ui.js';
import {
    dateTimeToISO, dayLabel, debounce, esc, html, money, shiftDays, startOfMonth, todayISO,
} from '../util.js';

const filters = {
    from: startOfMonth(),
    to: todayISO(),
    client_id: '',
    q: '',
    billed: '',
    trashed: '0',
};

/** Kundenzugänge sehen dieselbe Liste, dürfen aber nichts ändern. */
function canEdit() {
    return state.user?.role === 'admin';
}

export const entriesView = {
    title: 'Einträge',

    async render(root) {
        await loadTree();
        root.innerHTML = html`
            <section class="stack">
                <form class="card filters" id="filters">
                    <div class="filters__row">
                        <label class="field field--inline">
                            <span class="field__label">Von</span>
                            <input class="input" type="date" name="from" value="${filters.from}">
                        </label>
                        <label class="field field--inline">
                            <span class="field__label">Bis</span>
                            <input class="input" type="date" name="to" value="${filters.to}">
                        </label>
                        <label class="field field--inline field--grow">
                            <span class="field__label">Kunde</span>
                            <select class="input" name="client_id"><option value="">Alle</option></select>
                        </label>
                    </div>
                    <div class="filters__row">
                        <label class="field field--inline field--grow">
                            <span class="field__label">Suche</span>
                            <input class="input" type="search" name="q" value="${filters.q}"
                                placeholder="Notizen, Kunde, Projekt …">
                        </label>
                        <label class="field field--inline">
                            <span class="field__label">Status</span>
                            <select class="input" name="billed">
                                <option value="">Alle</option>
                                <option value="0">offen</option>
                                <option value="1">abgerechnet</option>
                            </select>
                        </label>
                    </div>
                    <div class="filters__row filters__row--actions">
                        <div class="chips">
                            <button type="button" class="chip" data-range="today">Heute</button>
                            <button type="button" class="chip" data-range="week">Diese Woche</button>
                            <button type="button" class="chip" data-range="month">Dieser Monat</button>
                            <button type="button" class="chip" data-range="lastmonth">Letzter Monat</button>
                            <button type="button" class="chip" data-range="year">Dieses Jahr</button>
                        </div>
                        ${canEdit() ? html`
                            <label class="switch">
                                <input type="checkbox" name="trashed"> <span>Papierkorb</span>
                            </label>
                            <button type="button" class="btn btn--primary" id="new-entry">Eintrag hinzufügen</button>` : ''}
                    </div>
                </form>
                <div id="results"><div class="loading">Lade …</div></div>
            </section>`;

        fillClients(root);
        bind(root);
        await refresh(root);
    },
};

function fillClients(root) {
    const select = root.querySelector('[name=client_id]');
    const clients = state.tree?.clients || [];
    select.innerHTML = '<option value="">Alle</option>' +
        clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    select.value = filters.client_id;
    root.querySelector('[name=billed]').value = filters.billed;
    root.querySelector('[name=trashed]').checked = filters.trashed === '1';
}

function bind(root) {
    const form = root.querySelector('#filters');
    const update = () => {
        const data = new FormData(form);
        filters.from = data.get('from') || '';
        filters.to = data.get('to') || '';
        filters.client_id = data.get('client_id') || '';
        filters.q = data.get('q') || '';
        filters.billed = data.get('billed') || '';
        filters.trashed = form.trashed?.checked ? '1' : '0';
        refresh(root);
    };

    form.addEventListener('change', update);
    form.querySelector('[name=q]').addEventListener('input', debounce(update, 350));

    form.addEventListener('click', (event) => {
        const range = event.target.closest('[data-range]');
        if (!range) return;
        applyRange(form, range.dataset.range);
        update();
    });

    root.querySelector('#new-entry')?.addEventListener('click', () => editEntry(root, null));

    root.querySelector('#results').addEventListener('click', async (event) => {
        const edit = event.target.closest('[data-edit]');
        if (edit) return editEntry(root, Number(edit.dataset.edit));

        const del = event.target.closest('[data-delete]');
        if (del) {
            if (!await confirmDialog('Eintrag löschen', 'Der Eintrag wandert in den Papierkorb.')) return;
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

function applyRange(form, range) {
    const today = todayISO();
    const set = (from, to) => { form.from.value = from; form.to.value = to; };

    if (range === 'today') return set(today, today);
    if (range === 'week') {
        const date = new Date();
        const offset = (date.getDay() + 6) % 7; // Montag als Wochenstart
        return set(shiftDays(today, -offset), today);
    }
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
    host.innerHTML = '<div class="loading">Lade …</div>';

    try {
        const data = await api.get('/entries', {
            ...filters,
            group: 'day',
            limit: 500,
        });

        if (!data.days.length) {
            host.innerHTML = '<div class="card"><p class="muted card__body">Keine Einträge im gewählten Zeitraum.</p></div>';
            return;
        }

        host.innerHTML = html`
            <div class="summary card">
                <span><strong>${data.totals.hhmm}</strong> <span class="muted">Stunden</span></span>
                ${data.totals.amount !== undefined
                    ? html`<span><strong>${money(data.totals.amount)}</strong></span>` : ''}
                <span class="muted">${data.totals.entries} Einträge</span>
                ${data.total > data.totals.entries
                    ? html`<span class="muted">(zeigt ${data.totals.entries} von ${data.total})</span>` : ''}
            </div>
            ${data.days.map(dayGroup)}`;
    } catch (error) {
        toastError(error);
        host.innerHTML = '<div class="card"><p class="card__body">Konnte nicht geladen werden.</p></div>';
    }
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
                ${entry.overnight ? html`<span class="tag" title="über Mitternacht">+1</span>` : ''}
            </span>
            <span class="entry__main">
                <span class="entry__path">
                    ${entry.subproject_name}
                    <span class="muted"> · ${entry.client_name} · ${entry.project_name}</span>
                </span>
                ${entry.note ? html`<span class="entry__note">${entry.note}</span>` : ''}
                ${entry.billed ? html`<span class="tag tag--billed">Rechnung ${entry.invoice_number || '—'}</span>` : ''}
            </span>
            <span class="entry__dur">
                ${entry.hhmm}
                ${entry.amount !== undefined ? html`<span class="muted entry__amount">${money(entry.amount)}</span>` : ''}
            </span>
            ${canEdit() ? html`
                <span class="entry__actions">
                    ${entry.deleted_at
                        ? html`<button class="icon-btn" data-restore="${entry.id}" title="Wiederherstellen">↩</button>`
                        : html`
                            <button class="icon-btn" data-edit="${entry.id}" title="Bearbeiten">✎</button>
                            <button class="icon-btn" data-delete="${entry.id}" title="Löschen">🗑</button>`}
                </span>` : ''}
        </li>`;
}

// -- Bearbeiten -------------------------------------------------------------

async function editEntry(root, id) {
    let entry = null;
    if (id) {
        try {
            entry = (await api.get(`/entries/${id}`)).entry;
        } catch (error) { return toastError(error); }
    }

    await loadTree();
    let subprojectId = entry?.subproject_id ?? flatSubprojects()[0]?.id ?? null;
    let subprojectLabel = entry?.path ?? flatSubprojects()[0]?.path ?? '—';

    const node = document.createElement('div');
    node.innerHTML = html`
        <div class="field">
            <span class="field__label">Teilprojekt</span>
            <button type="button" class="input input--button" data-pick>${subprojectLabel}</button>
        </div>
        <div class="filters__row">
            <label class="field field--inline">
                <span class="field__label">Datum</span>
                <input class="input" type="date" name="date" value="${entry?.date ?? todayISO()}">
            </label>
            <label class="field field--inline">
                <span class="field__label">Von</span>
                <input class="input" type="time" name="start" step="60" value="${entry?.start_time ?? '09:00'}">
            </label>
            <label class="field field--inline">
                <span class="field__label">Bis</span>
                <input class="input" type="time" name="end" step="60" value="${entry?.end_time ?? '10:00'}">
            </label>
        </div>
        <label class="field">
            <span class="field__label">Notizen</span>
            <textarea class="input" name="note" rows="6">${entry?.note ?? ''}</textarea>
        </label>
        <div class="filters__row">
            <label class="field field--inline">
                <span class="field__label">Stundensatz</span>
                <input class="input" type="number" name="rate" step="0.01" min="0"
                    value="${entry?.rate ?? ''}" placeholder="erbt">
            </label>
            <label class="switch">
                <input type="checkbox" name="billable" ${entry ? (entry.billable ? 'checked' : '') : 'checked'}>
                <span>abrechenbar</span>
            </label>
            <label class="switch">
                <input type="checkbox" name="round" ${entry ? '' : 'checked'}>
                <span>auf Raster runden</span>
            </label>
        </div>`;

    node.querySelector('[data-pick]').addEventListener('click', async () => {
        const picked = await pickSubproject({ current: subprojectId });
        if (!picked) return;
        subprojectId = picked;
        const sub = flatSubprojects().find((s) => s.id === picked);
        node.querySelector('[data-pick]').textContent = sub?.path || '—';
    });

    const result = await dialog({
        title: id ? 'Eintrag bearbeiten' : 'Eintrag hinzufügen',
        body: node,
        buttons: [
            { label: 'Abbrechen', value: null },
            { label: 'Speichern', value: 'save', kind: 'primary' },
        ],
    });
    if (result !== 'save') return;

    const get = (name) => node.querySelector(`[name=${name}]`);
    const date = get('date').value;
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

    try {
        if (id) {
            await api.patch(`/entries/${id}`, payload);
        } else {
            const created = await api.post('/entries', payload);
            if (created.overlaps?.length) {
                toast(`Hinweis: überschneidet sich mit ${created.overlaps.length} anderen Eintrag/Einträgen.`, 'info', 6000);
            }
        }
        invalidateTree();
        toast('Gespeichert.', 'ok', 2000);
        await refresh(root);
    } catch (error) {
        toastError(error);
    }
}
