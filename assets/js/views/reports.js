// Auswertung: Gruppierte Summen, Export und Leistungsnachweis.

import { api } from '../api.js';
import { state, loadTree } from '../store.js';
import { LANGS, t } from '../i18n.js';
import { loadPref, savePref } from '../prefs.js';
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

const GROUP_KEYS = ['client', 'project', 'subproject', 'month', 'week', 'day', 'year'];

// Optionen des Leistungsnachweises, gemerkt wie die Filter.
const options = { template: '', lang: '', costs: false, group_days: false, times: false, notes: true };

let initialized = false;

/**
 * Gemerkte Filter übernehmen. Ein Bis-Datum, das beim Speichern "heute" war,
 * rückt auf das neue Heute nach – sonst bliebe die Auswertung am Tag des
 * letzten Besuchs stehen.
 */
function restore() {
    const saved = loadPref('reports', null);
    if (!saved) return;

    for (const key of Object.keys(filters)) {
        if (typeof saved.filters?.[key] === 'string') filters[key] = saved.filters[key];
    }
    if (!GROUP_KEYS.includes(filters.group_by)) filters.group_by = 'client';
    if (saved.savedOn && filters.to === saved.savedOn) filters.to = todayISO();

    for (const key of Object.keys(options)) {
        if (typeof saved.options?.[key] === typeof options[key]) options[key] = saved.options[key];
    }
}

function store() {
    savePref('reports', { filters, options, savedOn: todayISO() });
}

/** Beschriftung einer Gruppierung – erst beim Zeichnen, wegen der Sprache. */
function groupLabel(key) {
    return t('reports.group' + key[0].toUpperCase() + key.slice(1));
}

export const reportsView = {
    async render(root) {
        if (!initialized) {
            initialized = true;
            restore();
        }
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
                            <span class="field__label">${t('common.from')}</span>
                            <input class="input" type="date" name="from" value="${filters.from}">
                        </label>
                        <label class="field field--inline">
                            <span class="field__label">${t('common.to')}</span>
                            <input class="input" type="date" name="to" value="${filters.to}">
                        </label>
                        <label class="field field--inline field--grow">
                            <span class="field__label">${t('common.client')}</span>
                            <select class="input" name="client_id"></select>
                        </label>
                        <label class="field field--inline field--grow">
                            <span class="field__label">${t('common.project')}</span>
                            <select class="input" name="project_id"></select>
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
                    <div class="filters__row">
                        <span class="field__label">${t('reports.groupBy')}</span>
                        <div class="chips">
                            ${GROUP_KEYS.map((key) => html`
                                <button type="button" class="chip ${filters.group_by === key ? 'is-active' : ''}"
                                        data-group="${key}">${groupLabel(key)}</button>`)}
                        </div>
                    </div>
                </form>

                <div id="stats"><div class="loading">${t('common.loading')}</div></div>

                <section class="card">
                    <header class="card__head"><h2>${t('reports.statement')}</h2></header>
                    <div class="card__body">
                        <div class="filters__row">
                            <label class="field field--inline field--grow">
                                <span class="field__label">${t('reports.template')}</span>
                                <select class="input" id="template">
                                    ${templates.map((tpl) => html`<option value="${tpl.key}">${tpl.label}</option>`)}
                                </select>
                            </label>
                            <label class="field field--inline">
                                <span class="field__label">${t('common.language')}</span>
                                <select class="input" id="lang">
                                    <option value="">${t('reports.langByClient')}</option>
                                    ${LANGS.map((code) => html`<option value="${code}">${t('lang.' + code)}</option>`)}
                                </select>
                            </label>
                        </div>
                        <div class="filters__row">
                            <label class="switch"><input type="checkbox" id="opt-costs" ${options.costs ? 'checked' : ''}> <span>${t('reports.optCosts')}</span></label>
                            <label class="switch"><input type="checkbox" id="opt-group-days" ${options.group_days ? 'checked' : ''}> <span>${t('reports.optGroupDays')}</span></label>
                            <label class="switch"><input type="checkbox" id="opt-times" ${options.times ? 'checked' : ''}> <span>${t('reports.optTimes')}</span></label>
                            <label class="switch"><input type="checkbox" id="opt-notes" ${options.notes ? 'checked' : ''}> <span>${t('common.notes')}</span></label>
                        </div>
                        <button class="btn btn--primary" id="open-report">${t('reports.open')}</button>
                        <p class="muted">${t('reports.openHint')}</p>
                    </div>
                </section>

                <section class="card">
                    <header class="card__head"><h2>${t('reports.export')}</h2></header>
                    <div class="card__body">
                        <div class="chips">
                            ${formats.map((f) => html`
                                <button class="btn" data-export="${f.key}">${f.label}</button>`)}
                        </div>
                        <p class="muted">${t('reports.exportHint')}</p>
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
    clientSelect.innerHTML = `<option value="">${esc(t('common.all'))}</option>` +
        clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    clientSelect.value = filters.client_id;

    fillProjects(root);
    root.querySelector('[name=billed]').value = filters.billed;

    // Nur übernehmen, was es (noch) gibt – sonst bliebe die Auswahl leer.
    const template = root.querySelector('#template');
    if ([...template.options].some((o) => o.value === options.template)) template.value = options.template;
    root.querySelector('#lang').value = options.lang;
}

/** Optionen des Leistungsnachweises aus den Feldern lesen und merken. */
function readOptions(root) {
    options.template = root.querySelector('#template').value;
    options.lang = root.querySelector('#lang').value;
    options.costs = root.querySelector('#opt-costs').checked;
    options.group_days = root.querySelector('#opt-group-days').checked;
    options.times = root.querySelector('#opt-times').checked;
    options.notes = root.querySelector('#opt-notes').checked;
    store();
}

function fillProjects(root) {
    const clients = state.tree?.clients || [];
    const select = root.querySelector('[name=project_id]');
    const clientId = Number(root.querySelector('[name=client_id]').value) || null;

    const projects = clients
        .filter((c) => !clientId || c.id === clientId)
        .flatMap((c) => c.projects.map((p) => ({ ...p, client: c.name })));

    select.innerHTML = `<option value="">${esc(t('common.all'))}</option>` + projects
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

    bindOnce(root, 'ReportOptions', 'change', (event) => {
        if (event.target.closest('#report-filters')) return;
        readOptions(root);
    });

    root.querySelector('#open-report').addEventListener('click', () => {
        readOptions(root);
        window.open(api.url('/report', {
            ...queryFilters(),
            template: options.template,
            lang: options.lang,
            costs: options.costs ? 1 : 0,
            group_days: options.group_days ? 1 : 0,
            times: options.times ? 1 : 0,
            notes: options.notes ? 1 : 0,
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
    store();
    const host = root.querySelector('#stats');
    host.innerHTML = html`<div class="loading">${t('common.loading')}</div>`;

    try {
        const data = await api.get('/stats', { ...queryFilters(), group_by: filters.group_by });

        if (!data.groups.length) {
            host.innerHTML = html`<div class="card"><p class="muted card__body">${t('entries.empty')}</p></div>`;
            return;
        }

        const max = Math.max(...data.groups.map((g) => g.minutes)) || 1;

        host.innerHTML = html`
            <div class="summary card">
                <span><strong>${data.totals.hhmm}</strong> <span class="muted">${t('common.hours')}</span></span>
                <span><strong>${money(data.totals.amount)}</strong></span>
                <span class="muted">
                    ${t('reports.groupsCount', { entries: data.totals.entries, groups: data.groups.length })}
                </span>
            </div>
            <section class="card">
                <table class="table table--stats">
                    <thead>
                        <tr>
                            <th>${groupLabel(filters.group_by)}</th>
                            <th class="num">${t('common.duration')}</th>
                            <th class="num">${t('common.hoursHead')}</th>
                            <th class="num">${t('common.amount')}</th>
                            <th class="num">${t('common.entriesHead')}</th>
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
        host.innerHTML = html`<div class="card"><p class="card__body">${t('common.loadFailed')}</p></div>`;
    }
}
