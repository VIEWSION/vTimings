// Stammdaten im Dreispalter: Kunden | Projekte | Teilprojekte.
// Auf schmalen Displays klappt das zu einer Spalte mit Zurück-Navigation um.

import { api } from '../api.js';
import { state, loadTree, invalidateTree } from '../store.js';
import { LANGS, t } from '../i18n.js';
import { loadPref, savePref } from '../prefs.js';
import { bindOnce, confirmDialog, saveDialog, toast, toastError } from '../ui.js';
import { icon } from '../icons.js';
import { decimal, esc, formatDate, html, money, todayISO } from '../util.js';

const sel = { clientId: null, projectId: null, archived: false, q: '' };

// Sortierung der drei Spalten. Betrifft nur die Darstellung – Auswahl und
// Suche arbeiten weiterhin über die IDs, nicht über die Reihenfolge.
let sortBy = 'name';

let initialized = false;

/**
 * Sortierung, Auswahl, Suche und Archiv-Schalter überdauern das Neuladen.
 * Erst beim ersten Aufruf gelesen – die Einstellungen liegen je Benutzer.
 */
function restore() {
    sortBy = loadPref('masterSort', 'name', { legacyKey: 'vt.masterSort' }) === 'activity' ? 'activity' : 'name';

    const saved = loadPref('master', null);
    if (!saved) return;
    sel.clientId = Number.isInteger(saved.clientId) ? saved.clientId : null;
    sel.projectId = Number.isInteger(saved.projectId) ? saved.projectId : null;
    sel.archived = saved.archived === true;
    sel.q = typeof saved.q === 'string' ? saved.q : '';
}

function storeSort() {
    savePref('masterSort', sortBy);
}

/**
 * "Zuletzt aktiv" räumt nicht die Archivierung um: archivierte Einträge
 * stehen weiterhin hinten, wie es die API schon liefert. Innerhalb einer
 * Gruppe kommt zuerst, wer zuletzt gebucht hat; ganz ohne Buchung ans Ende
 * der Gruppe, danach alphabetisch als stabiler Tiebreak.
 */
function sortRows(list) {
    if (sortBy !== 'activity') return list;
    return [...list].sort((a, b) => {
        if (a.archived !== b.archived) return a.archived ? 1 : -1;
        const at = a.stats?.last_at ? Date.parse(a.stats.last_at) : -Infinity;
        const bt = b.stats?.last_at ? Date.parse(b.stats.last_at) : -Infinity;
        if (at !== bt) return bt - at;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

export const masterView = {
    async render(root) {
        if (!initialized) {
            initialized = true;
            restore();
        }
        root.innerHTML = html`<div class="loading">${t('common.loading')}</div>`;
        await loadTree({ force: true, archived: sel.archived });

        root.innerHTML = html`
            <section class="browser" data-level="clients">
                <header class="browser__bar">
                    <input class="input" type="search" id="master-search"
                        placeholder="${t('master.searchPlaceholder')}" value="${sel.q}">
                    <div class="seg" title="${t('master.sortBy')}">
                        <button type="button" class="seg__btn ${sortBy === 'name' ? 'is-active' : ''}"
                                data-sort="name">${t('master.sortName')}</button>
                        <button type="button" class="seg__btn ${sortBy === 'activity' ? 'is-active' : ''}"
                                data-sort="activity">${t('master.sortActivity')}</button>
                    </div>
                    <label class="switch">
                        <input type="checkbox" id="show-archived" ${sel.archived ? 'checked' : ''}>
                        <span>${t('master.showArchived')}</span>
                    </label>
                </header>
                <div class="columns">
                    <div class="column" id="col-clients"></div>
                    <div class="column" id="col-projects"></div>
                    <div class="column" id="col-subprojects"></div>
                </div>
            </section>`;

        draw(root);
        bind(root);
    },
};

// -- Darstellung ------------------------------------------------------------

function clients() {
    const needle = sel.q.trim().toLowerCase();
    const list = needle
        ? (state.tree?.clients || []).filter((c) =>
            c.name.toLowerCase().includes(needle) ||
            c.projects.some((p) => p.name.toLowerCase().includes(needle) ||
                p.subprojects.some((s) => s.name.toLowerCase().includes(needle))))
        : (state.tree?.clients || []);
    return sortRows(list);
}

function currentClient() {
    return clients().find((c) => c.id === sel.clientId) || null;
}

function currentProject() {
    return currentClient()?.projects.find((p) => p.id === sel.projectId) || null;
}

function draw(root) {
    const list = clients();
    if (sel.clientId && !list.some((c) => c.id === sel.clientId)) sel.clientId = null;
    if (sel.projectId && !currentProject()) sel.projectId = null;
    savePref('master', sel);

    root.querySelector('.browser').dataset.level =
        sel.projectId ? 'subprojects' : (sel.clientId ? 'projects' : 'clients');

    drawClients(root, list);
    drawProjects(root);
    drawSubprojects(root);
}

function columnHead(title, backLabel, addLabel, addAttr) {
    return html`
        <header class="column__head">
            ${backLabel ? html`<button class="icon-btn column__back" data-back aria-label="${backLabel}" title="${backLabel}">${icon('back', 20)}</button>` : ''}
            <h3>${title}</h3>
            <button class="icon-btn" ${{ __raw: addAttr }} title="${addLabel}" aria-label="${addLabel}">${icon('plus')}</button>
        </header>`;
}

function statLine(node) {
    const stats = node.stats;
    if (!stats || !stats.entries) return html`<span class="muted">${t('common.dash')}</span>`;
    return html`<span class="muted">${stats.hhmm}${stats.amount ? ' · ' + money(stats.amount) : ''}</span>`;
}

function drawClients(root, list) {
    root.querySelector('#col-clients').innerHTML = html`
        ${{ __raw: columnHead(t('master.clients'), null, t('master.addClient'), 'data-add-client') }}
        <ul class="rows">
            ${list.map((client) => html`
                <li>
                    <button class="row ${client.id === sel.clientId ? 'is-active' : ''} ${client.archived ? 'is-archived' : ''}"
                            data-client="${client.id}">
                        <span class="dot" style="background:${client.color || 'var(--border)'}"></span>
                        <span class="row__main">
                            <strong>${client.name}</strong>
                            ${{ __raw: statLine(client) }}
                            ${progressBar(client.budget)}
                        </span>
                        <span class="row__meta">${client.effective_rate} €</span>
                    </button>
                </li>`)}
        </ul>
        ${list.length ? '' : html`<p class="muted column__empty">${t('master.noClients')}</p>`}`;
}

function drawProjects(root) {
    const client = currentClient();
    const host = root.querySelector('#col-projects');

    if (!client) {
        host.innerHTML = html`<p class="muted column__empty">${t('master.pickClient')}</p>`;
        return;
    }

    host.innerHTML = html`
        ${{ __raw: columnHead(client.name, t('master.clients'), t('master.addProject'), 'data-add-project') }}
        <div class="column__tools">
            <button class="btn btn--ghost btn--small" data-edit-client="${client.id}">${t('master.editClient')}</button>
            <a class="btn btn--ghost btn--small" href="#/uebersicht?client_id=${client.id}"
               title="${t('master.clientViewHint')}">${t('master.clientView')}</a>
            <button class="btn btn--ghost btn--small" data-add-budget="client"
                    title="${t('budget.addClientHint')}">${icon('plus', 14)} ${t('budget.package')}</button>
            <button class="btn btn--ghost btn--small" data-delete-client="${client.id}">${t('common.delete')}</button>
        </div>
        ${budgetSection(client.budget)}
        <ul class="rows">
            ${sortRows(client.projects).map((project) => html`
                <li>
                    <button class="row ${project.id === sel.projectId ? 'is-active' : ''} ${project.archived ? 'is-archived' : ''}"
                            data-project="${project.id}">
                        <span class="dot" style="background:${project.color || 'var(--border)'}"></span>
                        <span class="row__main">
                            <strong>${project.name}</strong>
                            ${{ __raw: statLine(project) }}
                            ${progressBar(project.budget)}
                        </span>
                        <span class="row__meta">${project.effective_rate} €</span>
                    </button>
                </li>`)}
        </ul>
        ${client.projects.length ? '' : html`<p class="muted column__empty">${t('master.noProjects')}</p>`}`;
}

function drawSubprojects(root) {
    const project = currentProject();
    const host = root.querySelector('#col-subprojects');

    if (!project) {
        host.innerHTML = html`<p class="muted column__empty">${t('master.pickProject')}</p>`;
        return;
    }

    host.innerHTML = html`
        ${{ __raw: columnHead(project.name, t('master.projects'), t('master.addSubproject'), 'data-add-subproject') }}
        <div class="column__tools">
            <button class="btn btn--ghost btn--small" data-edit-project="${project.id}">${t('master.editProject')}</button>
            <button class="btn btn--ghost btn--small" data-add-budget="project"
                    title="${t('budget.addProjectHint')}">${icon('plus', 14)} ${t('budget.package')}</button>
            <button class="btn btn--ghost btn--small" data-delete-project="${project.id}">${t('common.delete')}</button>
        </div>
        ${budgetSection(project.budget)}
        <ul class="rows">
            ${sortRows(project.subprojects).map((sub) => html`
                <li>
                    <span class="row row--static ${sub.archived ? 'is-archived' : ''}">
                        <span class="row__main">
                            <strong>${sub.name}</strong>
                            ${{ __raw: statLine(sub) }}
                        </span>
                        <span class="row__meta">${sub.effective_rate} €</span>
                        <span class="row__actions">
                            <button class="icon-btn" data-edit-subproject="${sub.id}" title="${t('common.edit')}" aria-label="${t('common.edit')}">${icon('edit')}</button>
                            <button class="icon-btn" data-delete-subproject="${sub.id}" title="${t('common.delete')}" aria-label="${t('common.delete')}">${icon('trash')}</button>
                        </span>
                    </span>
                </li>`)}
        </ul>
        ${project.subprojects.length ? '' : html`<p class="muted column__empty">${t('master.noSubprojects')}</p>`}`;
}

// -- Stundenkontingente -----------------------------------------------------

/** Balken des laufenden Pakets für Kunden- und Projektzeilen. */
function progressBar(pool) {
    if (!pool) return '';
    const p = pool.progress;
    return html`
        <span class="progress" title="${t('budget.currentTitle', {
            used: decimal(p.used_hours), hours: decimal(p.budget_hours) })}">
            <span class="progress__bar ${p.percent > 100 ? 'is-over' : ''}"
                  style="width:${Math.min(100, p.percent)}%"></span>
        </span>`;
}

function balanceLine(pool) {
    return pool.balance_hours < 0
        ? html`<span class="is-over">${t('budget.overdrawn', { hours: decimal(-pool.balance_hours) })}</span>`
        : html`<span class="muted">${t('budget.balance', { hours: decimal(pool.balance_hours) })}</span>`;
}

/**
 * Kontingent mit seinen Paketen. Laufende und vorrätige Pakete stehen offen
 * in zeitlicher Reihenfolge, aufgebrauchte und abgelaufene zusammengeklappt
 * darunter (jüngstes zuerst).
 */
function budgetSection(pool) {
    if (!pool) return '';

    const finished = (pkg) => pkg.status === 'used' || pkg.status === 'expired';
    const live = pool.packages.filter((pkg) => !finished(pkg));
    const done = pool.packages.filter(finished).reverse();

    return html`
        <section class="budget">
            <div class="budget__head">
                <strong>${t(pool.project_id ? 'budget.title' : 'budget.titleClient')}</strong>
                ${balanceLine(pool)}
            </div>
            ${progressBar(pool)}
            ${pool.balance_hours < 0 ? html`
                <p class="budget__hint muted">${t('budget.overdrawnHint')}</p>` : ''}
            ${pool.project_id ? '' : html`
                <p class="budget__hint muted">${t('budget.clientScope')}</p>`}
            ${live.length ? html`<ul class="budget__list">${live.map(packageRow)}</ul>` : ''}
            ${done.length ? html`
                <details class="budget__done">
                    <summary class="muted">${t('budget.finished', { count: done.length })}</summary>
                    <ul class="budget__list">${done.map(packageRow)}</ul>
                </details>` : ''}
        </section>`;
}

function packageRow(pkg) {
    const period = pkg.expires_on
        ? t('budget.period', { from: formatDate(pkg.starts_on), to: formatDate(pkg.expires_on) })
        : t('budget.since', { from: formatDate(pkg.starts_on) });

    return html`
        <li>
            <button type="button" class="budget__pkg is-${pkg.status}" data-edit-budget="${pkg.id}"
                    title="${t('budget.edit')}">
                <span class="budget__pkg-main">
                    <strong>${decimal(pkg.hours)} h</strong>
                    <span class="muted">${period}</span>
                    ${pkg.note ? html`<span class="muted budget__note">${pkg.note}</span>` : ''}
                </span>
                <span class="budget__pkg-meta">
                    <span>${t('budget.usedOf', { used: decimal(pkg.used_hours), hours: decimal(pkg.hours) })}</span>
                    <span class="budget__status">${t('budget.status.' + pkg.status)}${pkg.expired_hours
                        ? ' · ' + t('budget.lapsed', { hours: decimal(pkg.expired_hours) }) : ''}</span>
                </span>
            </button>
        </li>`;
}

// -- Verhalten --------------------------------------------------------------

function bind(root) {
    root.querySelector('#master-search').addEventListener('input', (event) => {
        sel.q = event.target.value;
        draw(root);
    });

    root.querySelector('#show-archived').addEventListener('change', async (event) => {
        sel.archived = event.target.checked;
        await masterView.render(root);
    });

    root.querySelector('.browser__bar .seg').addEventListener('click', (event) => {
        const button = event.target.closest('[data-sort]');
        if (!button || button.dataset.sort === sortBy) return;

        sortBy = button.dataset.sort;
        storeSort();
        for (const el of root.querySelectorAll('[data-sort]')) {
            el.classList.toggle('is-active', el.dataset.sort === sortBy);
        }
        draw(root);
    });

    // Die Ansicht baut sich nach jedem Speichern neu auf, der Wirt bleibt.
    bindOnce(root, 'Master', 'click', async (event) => {
        const target = (attr) => event.target.closest(`[data-${attr}]`);

        if (target('back')) {
            if (sel.projectId) sel.projectId = null;
            else sel.clientId = null;
            return draw(root);
        }

        const client = target('client');
        if (client) {
            sel.clientId = Number(client.dataset.client);
            sel.projectId = null;
            return draw(root);
        }

        const project = target('project');
        if (project) {
            sel.projectId = Number(project.dataset.project);
            return draw(root);
        }

        if (target('add-client')) return editClient(root, null);
        if (target('add-project')) return editProject(root, null);
        if (target('add-subproject')) return editSubproject(root, null);

        const addB = target('add-budget');
        if (addB) return editBudget(root, null, addB.dataset.addBudget);
        const editB = target('edit-budget');
        if (editB) return editBudget(root, Number(editB.dataset.editBudget));

        const editC = target('edit-client');
        if (editC) return editClient(root, Number(editC.dataset.editClient));
        const editP = target('edit-project');
        if (editP) return editProject(root, Number(editP.dataset.editProject));
        const editS = target('edit-subproject');
        if (editS) return editSubproject(root, Number(editS.dataset.editSubproject));

        const delC = target('delete-client');
        if (delC) return remove(root, 'clients', Number(delC.dataset.deleteClient), t('common.client'));
        const delP = target('delete-project');
        if (delP) return remove(root, 'projects', Number(delP.dataset.deleteProject), t('common.project'));
        const delS = target('delete-subproject');
        if (delS) return remove(root, 'subprojects', Number(delS.dataset.deleteSubproject), t('common.subproject'));
    });
}

async function remove(root, resource, id, label) {
    if (!await confirmDialog(t('master.deleteTitle', { label }), t('master.deleteText', { label }))) return;
    try {
        await api.delete(`/${resource}/${id}`);
        if (resource === 'clients') sel.clientId = null;
        if (resource === 'projects') sel.projectId = null;
        invalidateTree();
        toast(t('common.deleted'), 'ok', 2000);
        await masterView.render(root);
    } catch (error) {
        toastError(error);
    }
}

// -- Formulare --------------------------------------------------------------

async function editClient(root, id) {
    const client = id ? currentClient() : null;

    const node = document.createElement('div');
    node.innerHTML = html`
        <label class="field"><span class="field__label">${t('common.name')}</span>
            <input class="input" name="name" value="${client?.name ?? ''}" required></label>
        <div class="filters__row">
            <label class="field field--inline"><span class="field__label">${t('common.color')}</span>
                <input class="input" type="color" name="color" value="${client?.color ?? '#2f6df6'}"></label>
            <label class="field field--inline"><span class="field__label">${t('common.rate')}</span>
                <input class="input" type="number" name="rate" step="0.01" min="0"
                    value="${client?.rate ?? ''}" placeholder="${t('master.rateDefault')}"></label>
            <label class="field field--inline"><span class="field__label">${t('common.language')}</span>
                <select class="input" name="lang">
                    ${LANGS.map((code) => html`
                        <option value="${code}" ${(client?.lang ?? 'de') === code ? 'selected' : ''}>
                            ${t('lang.' + code)}</option>`)}
                </select></label>
        </div>
        <label class="field"><span class="field__label">${t('master.contactName')}</span>
            <input class="input" name="contact_name" value="${client?.contact_name ?? ''}"></label>
        <label class="field"><span class="field__label">${t('common.email')}</span>
            <input class="input" type="email" name="contact_email" value="${client?.contact_email ?? ''}"></label>
        <label class="field"><span class="field__label">${t('master.address')}</span>
            <textarea class="input" name="contact_address" rows="3">${client?.contact_address ?? ''}</textarea></label>
        <label class="field"><span class="field__label">${t('master.visibility')}</span>
            <input class="input" type="number" name="visibility_offset_days" step="1" min="0" max="365"
                value="${client?.visibility_offset_days ?? 1}">
            <span class="field__hint">${t('master.visibilityHint')}</span></label>
        <label class="switch"><input type="checkbox" name="archived" ${client?.archived ? 'checked' : ''}>
            <span>${t('common.archivedLabel')}</span></label>`;

    const get = (n) => node.querySelector(`[name=${n}]`);

    await form(root, {
        title: id ? t('master.editClient') : t('master.addClient'),
        node,
        path: id ? `/clients/${id}` : '/clients',
        creating: !id,
        collect: () => ({
            name: get('name').value.trim(),
            color: get('color').value,
            rate: get('rate').value === '' ? null : Number(get('rate').value),
            lang: get('lang').value,
            contact_name: get('contact_name').value,
            contact_email: get('contact_email').value,
            contact_address: get('contact_address').value,
            visibility_offset_days: Number(get('visibility_offset_days').value || 0),
            archived: get('archived').checked,
        }),
    });
}

async function editProject(root, id) {
    const client = currentClient();
    const project = id ? currentProject() : null;
    if (!client) return;

    const node = document.createElement('div');
    node.innerHTML = html`
        <p class="muted">${t('common.client')}: ${client.name}</p>
        <label class="field"><span class="field__label">${t('common.name')}</span>
            <input class="input" name="name" value="${project?.name ?? ''}" required></label>
        <div class="filters__row">
            <label class="field field--inline"><span class="field__label">${t('common.color')}</span>
                <input class="input" type="color" name="color" value="${project?.own_color ?? client.color ?? '#2f6df6'}"></label>
            <label class="field field--inline"><span class="field__label">${t('common.rate')}</span>
                <input class="input" type="number" name="rate" step="0.01" min="0"
                    value="${project?.rate ?? ''}"
                    placeholder="${t('master.rateInherits', { rate: client.effective_rate })}"></label>
        </div>
        <label class="switch"><input type="checkbox" name="archived" ${project?.archived ? 'checked' : ''}>
            <span>${t('common.archivedLabel')}</span></label>`;

    const get = (n) => node.querySelector(`[name=${n}]`);

    await form(root, {
        title: id ? t('master.editProject') : t('master.addProject'),
        node,
        path: id ? `/projects/${id}` : '/projects',
        creating: !id,
        collect: () => ({
            client_id: client.id,
            name: get('name').value.trim(),
            color: get('color').value,
            rate: get('rate').value === '' ? null : Number(get('rate').value),
            archived: get('archived').checked,
        }),
    });
}

async function editSubproject(root, id) {
    const project = currentProject();
    if (!project) return;
    const sub = id ? project.subprojects.find((s) => s.id === id) : null;

    const node = document.createElement('div');
    node.innerHTML = html`
        <p class="muted">${currentClient()?.name} · ${project.name}</p>
        <label class="field"><span class="field__label">${t('common.name')}</span>
            <input class="input" name="name" value="${sub?.name ?? ''}" required></label>
        <label class="field"><span class="field__label">${t('common.rate')}</span>
            <input class="input" type="number" name="rate" step="0.01" min="0"
                value="${sub?.rate ?? ''}"
                placeholder="${t('master.rateInherits', { rate: project.effective_rate })}"></label>
        <label class="switch"><input type="checkbox" name="archived" ${sub?.archived ? 'checked' : ''}>
            <span>${t('common.archivedLabel')}</span></label>`;

    const get = (n) => node.querySelector(`[name=${n}]`);

    await form(root, {
        title: id ? t('master.editSubproject') : t('master.addSubproject'),
        node,
        path: id ? `/subprojects/${id}` : '/subprojects',
        creating: !id,
        collect: () => ({
            project_id: project.id,
            name: get('name').value.trim(),
            rate: get('rate').value === '' ? null : Number(get('rate').value),
            archived: get('archived').checked,
        }),
    });
}

/**
 * Stundenpaket anlegen oder bearbeiten.
 *
 * @param level 'client' (Kundenkontingent) oder 'project' – nur beim Anlegen;
 *              ein bestehendes Paket bringt seine Zuordnung mit.
 */
async function editBudget(root, id, level = 'project') {
    const client = currentClient();
    if (!client) return;

    let pkg = null;
    if (id) {
        const pools = [client.budget, ...client.projects.map((p) => p.budget)].filter(Boolean);
        pkg = pools.flatMap((pool) => pool.packages).find((p) => p.id === id) ?? null;
        if (!pkg) return;
        level = pkg.project_id ? 'project' : 'client';
    }
    const project = level === 'project'
        ? (pkg ? client.projects.find((p) => p.id === pkg.project_id) : currentProject())
        : null;
    if (level === 'project' && !project) return;

    const node = document.createElement('div');
    node.innerHTML = html`
        <p class="muted">${project ? `${client.name} · ${project.name}` : `${client.name} · ${t('budget.allProjects')}`}</p>
        <div class="filters__row">
            <label class="field field--inline"><span class="field__label">${t('budget.hours')}</span>
                <input class="input" type="number" name="hours" step="0.25" min="0.25"
                    value="${pkg?.hours ?? ''}" required></label>
            <label class="field field--inline"><span class="field__label">${t('budget.price')}</span>
                <input class="input" type="number" name="price" step="0.01" min="0"
                    value="${pkg?.price ?? ''}" placeholder="${t('budget.optional')}"></label>
        </div>
        <div class="filters__row">
            <label class="field field--inline"><span class="field__label">${t('budget.startsOn')}</span>
                <input class="input" type="date" name="starts_on" value="${pkg?.starts_on ?? todayISO()}" required></label>
            <label class="field field--inline"><span class="field__label">${t('budget.expiresOn')}</span>
                <input class="input" type="date" name="expires_on" value="${pkg?.expires_on ?? ''}"></label>
        </div>
        <p class="field__hint">${t('budget.formHint')}</p>
        <label class="field"><span class="field__label">${t('common.note')}</span>
            <input class="input" name="note" value="${pkg?.note ?? ''}" placeholder="${t('budget.notePlaceholder')}"></label>`;

    const get = (n) => node.querySelector(`[name=${n}]`);

    const saved = await saveDialog({
        title: id ? t('budget.edit') : t(level === 'client' ? 'budget.addClient' : 'budget.addProject'),
        body: node,
        save: async () => {
            const payload = {
                client_id: client.id,
                project_id: project?.id ?? null,
                hours: get('hours').value === '' ? null : Number(get('hours').value),
                price: get('price').value === '' ? null : Number(get('price').value),
                starts_on: get('starts_on').value,
                expires_on: get('expires_on').value || null,
                note: get('note').value,
            };
            if (id) await api.patch(`/budgets/${id}`, payload);
            else await api.post('/budgets', payload);
        },
        remove: id ? () => api.delete(`/budgets/${id}`) : null,
        removeConfirm: { title: t('budget.deleteTitle'), text: t('budget.deleteText') },
    });
    if (!saved) return;

    invalidateTree();
    toast(t(saved === 'removed' ? 'common.deleted' : 'common.saved'), 'ok', 2000);
    await masterView.render(root);
}

/**
 * Formular anzeigen und speichern. Bleibt bei einem Fehler offen, damit
 * die Eingaben nicht verloren gehen.
 *
 * @param collect Liefert die zu sendenden Daten – erst beim Speichern
 *                aufgerufen, also immer mit dem aktuellen Formularstand.
 */
async function form(root, { title, node, path, creating, collect }) {
    const saved = await saveDialog({
        title,
        body: node,
        save: async () => {
            const payload = collect();
            if (creating) await api.post(path, payload);
            else await api.patch(path, payload);
        },
    });
    if (!saved) return;

    invalidateTree();
    toast(t('common.saved'), 'ok', 2000);
    await masterView.render(root);
}
