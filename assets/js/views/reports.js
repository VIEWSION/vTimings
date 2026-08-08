// Auswertung: Gruppierte Summen, Export und Leistungsnachweis.

import { api } from '../api.js';
import { state, loadTree } from '../store.js';
import { bindOnce, toastError } from '../ui.js';
import { decimal, esc, html, money, todayISO } from '../util.js';

const filters = {
    from: `${todayISO().slice(0, 4)}-01-01`,
    to: todayISO(),
    client_id: '',
    project_id: '',
    billed: '',
    group_by: 'client',
};

const GROUPS = [
    ['client', 'Kunde'],
    ['project', 'Projekt'],
    ['subproject', 'Teilprojekt'],
    ['month', 'Monat'],
    ['week', 'Woche'],
    ['day', 'Tag'],
    ['year', 'Jahr'],
];

export const reportsView = {
    title: 'Auswertung',

    async render(root) {
        await loadTree();
        const [{ formats }, { templates }] = await Promise.all([
            api.get('/export/formats'),
            api.get('/report/templates'),
        ]);

        root.innerHTML = html`
            <section class="stack">
                <form class="card filters" id="report-filters">
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
                            <select class="input" name="client_id"></select>
                        </label>
                        <label class="field field--inline field--grow">
                            <span class="field__label">Projekt</span>
                            <select class="input" name="project_id"></select>
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
                    <div class="filters__row">
                        <span class="field__label">Gruppieren nach</span>
                        <div class="chips">
                            ${GROUPS.map(([key, label]) => html`
                                <button type="button" class="chip ${filters.group_by === key ? 'is-active' : ''}"
                                        data-group="${key}">${label}</button>`)}
                        </div>
                    </div>
                </form>

                <div id="stats"><div class="loading">Lade …</div></div>

                <section class="card">
                    <header class="card__head"><h2>Leistungsnachweis</h2></header>
                    <div class="card__body">
                        <div class="filters__row">
                            <label class="field field--inline field--grow">
                                <span class="field__label">Vorlage</span>
                                <select class="input" id="template">
                                    ${templates.map((tpl) => html`<option value="${tpl.key}">${tpl.label}</option>`)}
                                </select>
                            </label>
                            <label class="field field--inline">
                                <span class="field__label">Sprache</span>
                                <select class="input" id="lang">
                                    <option value="">nach Kunde</option>
                                    <option value="de">Deutsch</option>
                                    <option value="en">English</option>
                                </select>
                            </label>
                        </div>
                        <div class="filters__row">
                            <label class="switch"><input type="checkbox" id="opt-costs"> <span>Kosten ausweisen</span></label>
                            <label class="switch"><input type="checkbox" id="opt-group-days"> <span>pro Tag zusammenfassen</span></label>
                            <label class="switch"><input type="checkbox" id="opt-times"> <span>Uhrzeiten zeigen</span></label>
                            <label class="switch"><input type="checkbox" id="opt-notes" checked> <span>Notizen</span></label>
                        </div>
                        <button class="btn btn--primary" id="open-report">Nachweis öffnen</button>
                        <p class="muted">Öffnet die Druckansicht in einem neuen Tab. Dort „Drucken“ und
                            im Druckdialog „Als PDF sichern“.</p>
                    </div>
                </section>

                <section class="card">
                    <header class="card__head"><h2>Export</h2></header>
                    <div class="card__body">
                        <div class="chips">
                            ${formats.map((f) => html`
                                <button class="btn" data-export="${f.key}">${f.label}</button>`)}
                        </div>
                        <p class="muted">Exportiert genau die oben gefilterten Einträge.</p>
                    </div>
                </section>
            </section>`;

        fillSelects(root);
        bind(root);
        await refresh(root);
    },
};

function fillSelects(root) {
    const clients = state.tree?.clients || [];
    const clientSelect = root.querySelector('[name=client_id]');
    clientSelect.innerHTML = '<option value="">Alle</option>' +
        clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    clientSelect.value = filters.client_id;

    fillProjects(root);
    root.querySelector('[name=billed]').value = filters.billed;
}

function fillProjects(root) {
    const clients = state.tree?.clients || [];
    const select = root.querySelector('[name=project_id]');
    const clientId = Number(root.querySelector('[name=client_id]').value) || null;

    const projects = clients
        .filter((c) => !clientId || c.id === clientId)
        .flatMap((c) => c.projects.map((p) => ({ ...p, client: c.name })));

    select.innerHTML = '<option value="">Alle</option>' + projects
        .map((p) => `<option value="${p.id}">${esc(clientId ? p.name : p.client + ' | ' + p.name)}</option>`)
        .join('');
    select.value = projects.some((p) => String(p.id) === filters.project_id) ? filters.project_id : '';
    filters.project_id = select.value;
}

function bind(root) {
    const form = root.querySelector('#report-filters');

    form.addEventListener('change', (event) => {
        if (event.target.name === 'client_id') {
            filters.client_id = event.target.value;
            fillProjects(root);
        }
        const data = new FormData(form);
        filters.from = data.get('from') || '';
        filters.to = data.get('to') || '';
        filters.client_id = data.get('client_id') || '';
        filters.project_id = data.get('project_id') || '';
        filters.billed = data.get('billed') || '';
        refresh(root);
    });

    form.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-group]');
        if (!chip) return;
        filters.group_by = chip.dataset.group;
        for (const el of form.querySelectorAll('[data-group]')) {
            el.classList.toggle('is-active', el.dataset.group === filters.group_by);
        }
        refresh(root);
    });

    root.querySelector('#open-report').addEventListener('click', () => {
        window.open(api.url('/report', {
            ...queryFilters(),
            template: root.querySelector('#template').value,
            lang: root.querySelector('#lang').value,
            costs: root.querySelector('#opt-costs').checked ? 1 : 0,
            group_days: root.querySelector('#opt-group-days').checked ? 1 : 0,
            times: root.querySelector('#opt-times').checked ? 1 : 0,
            notes: root.querySelector('#opt-notes').checked ? 1 : 0,
        }), '_blank', 'noopener');
    });

    bindOnce(root, 'Reports', 'click', (event) => {
        const button = event.target.closest('[data-export]');
        if (!button) return;
        window.location.href = api.url('/api/export', {
            ...queryFilters(),
            format: button.dataset.export,
        });
    });
}

function queryFilters() {
    return {
        from: filters.from,
        to: filters.to,
        client_id: filters.client_id,
        project_id: filters.project_id,
        billed: filters.billed,
    };
}

async function refresh(root) {
    const host = root.querySelector('#stats');
    host.innerHTML = '<div class="loading">Lade …</div>';

    try {
        const data = await api.get('/stats', { ...queryFilters(), group_by: filters.group_by });

        if (!data.groups.length) {
            host.innerHTML = '<div class="card"><p class="muted card__body">Keine Einträge im gewählten Zeitraum.</p></div>';
            return;
        }

        const max = Math.max(...data.groups.map((g) => g.minutes)) || 1;

        host.innerHTML = html`
            <div class="summary card">
                <span><strong>${data.totals.hhmm}</strong> <span class="muted">Stunden</span></span>
                <span><strong>${money(data.totals.amount)}</strong></span>
                <span class="muted">${data.totals.entries} Einträge · ${data.groups.length} Gruppen</span>
            </div>
            <section class="card">
                <table class="table table--stats">
                    <thead>
                        <tr>
                            <th>${GROUPS.find(([k]) => k === filters.group_by)?.[1] ?? ''}</th>
                            <th class="num">Dauer</th>
                            <th class="num">Stunden</th>
                            <th class="num">Betrag</th>
                            <th class="num">Einträge</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.groups.map((group) => html`
                            <tr>
                                <td>
                                    <span class="statbar" style="--share:${(group.minutes / max) * 100}%;
                                        --bar:${group.color || 'var(--accent)'}"></span>
                                    ${group.label}
                                </td>
                                <td class="num">${group.hhmm}</td>
                                <td class="num">${decimal(group.decimal)}</td>
                                <td class="num">${group.amount !== undefined ? money(group.amount) : ''}</td>
                                <td class="num muted">${group.entries}</td>
                            </tr>`)}
                    </tbody>
                </table>
            </section>`;
    } catch (error) {
        toastError(error);
        host.innerHTML = '<div class="card"><p class="card__body">Konnte nicht geladen werden.</p></div>';
    }
}
