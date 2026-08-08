// Stammdaten im Dreispalter: Kunden | Projekte | Teilprojekte.
// Auf schmalen Displays klappt das zu einer Spalte mit Zurück-Navigation um.

import { api } from '../api.js';
import { state, loadTree, invalidateTree } from '../store.js';
import { bindOnce, confirmDialog, saveDialog, toast, toastError } from '../ui.js';
import { esc, hhmm, html, money } from '../util.js';

const sel = { clientId: null, projectId: null, archived: false, q: '' };

export const masterView = {
    title: 'Stammdaten',

    async render(root) {
        root.innerHTML = '<div class="loading">Lade …</div>';
        await loadTree({ force: true, archived: sel.archived });

        root.innerHTML = html`
            <section class="browser" data-level="clients">
                <header class="browser__bar">
                    <input class="input" type="search" id="master-search" placeholder="Kunde, Projekt, Teilprojekt …"
                        value="${sel.q}">
                    <label class="switch">
                        <input type="checkbox" id="show-archived" ${sel.archived ? 'checked' : ''}>
                        <span>Archivierte</span>
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
    if (!needle) return state.tree?.clients || [];
    return (state.tree?.clients || []).filter((c) =>
        c.name.toLowerCase().includes(needle) ||
        c.projects.some((p) => p.name.toLowerCase().includes(needle) ||
            p.subprojects.some((s) => s.name.toLowerCase().includes(needle))));
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

    root.querySelector('.browser').dataset.level =
        sel.projectId ? 'subprojects' : (sel.clientId ? 'projects' : 'clients');

    drawClients(root, list);
    drawProjects(root);
    drawSubprojects(root);
}

function columnHead(title, backLabel, addLabel, addAttr) {
    return html`
        <header class="column__head">
            ${backLabel ? html`<button class="icon-btn column__back" data-back>‹</button>` : ''}
            <h3>${title}</h3>
            <button class="icon-btn" ${{ __raw: addAttr }} title="${addLabel}">＋</button>
        </header>`;
}

function statLine(node) {
    const stats = node.stats;
    if (!stats || !stats.entries) return '<span class="muted">—</span>';
    return html`<span class="muted">${stats.hhmm}${stats.amount ? ' · ' + money(stats.amount) : ''}</span>`;
}

function drawClients(root, list) {
    root.querySelector('#col-clients').innerHTML = html`
        ${{ __raw: columnHead('Kunden', null, 'Kunde anlegen', 'data-add-client') }}
        <ul class="rows">
            ${list.map((client) => html`
                <li>
                    <button class="row ${client.id === sel.clientId ? 'is-active' : ''} ${client.archived ? 'is-archived' : ''}"
                            data-client="${client.id}">
                        <span class="dot" style="background:${client.color || 'var(--border)'}"></span>
                        <span class="row__main">
                            <strong>${client.name}</strong>
                            ${{ __raw: statLine(client) }}
                        </span>
                        <span class="row__meta">${client.effective_rate} €</span>
                    </button>
                </li>`)}
        </ul>
        ${list.length ? '' : '<p class="muted column__empty">Keine Kunden.</p>'}`;
}

function drawProjects(root) {
    const client = currentClient();
    const host = root.querySelector('#col-projects');

    if (!client) {
        host.innerHTML = '<p class="muted column__empty">Kunde wählen.</p>';
        return;
    }

    host.innerHTML = html`
        ${{ __raw: columnHead(client.name, 'Kunden', 'Projekt anlegen', 'data-add-project') }}
        <div class="column__tools">
            <button class="btn btn--ghost btn--small" data-edit-client="${client.id}">Kunde bearbeiten</button>
            <a class="btn btn--ghost btn--small" href="#/uebersicht?client_id=${client.id}"
               title="So sieht der Kunde sein Portal">Kundenansicht</a>
            <button class="btn btn--ghost btn--small" data-delete-client="${client.id}">Löschen</button>
        </div>
        <ul class="rows">
            ${client.projects.map((project) => html`
                <li>
                    <button class="row ${project.id === sel.projectId ? 'is-active' : ''} ${project.archived ? 'is-archived' : ''}"
                            data-project="${project.id}">
                        <span class="dot" style="background:${project.color || 'var(--border)'}"></span>
                        <span class="row__main">
                            <strong>${project.name}</strong>
                            ${{ __raw: statLine(project) }}
                            ${project.progress ? html`
                                <span class="progress" title="${project.progress.used_hours} von ${project.progress.budget_hours} Stunden">
                                    <span class="progress__bar" style="width:${Math.min(100, project.progress.percent)}%"></span>
                                </span>` : ''}
                        </span>
                        <span class="row__meta">${project.effective_rate} €</span>
                    </button>
                </li>`)}
        </ul>
        ${client.projects.length ? '' : '<p class="muted column__empty">Keine Projekte.</p>'}`;
}

function drawSubprojects(root) {
    const project = currentProject();
    const host = root.querySelector('#col-subprojects');

    if (!project) {
        host.innerHTML = '<p class="muted column__empty">Projekt wählen.</p>';
        return;
    }

    host.innerHTML = html`
        ${{ __raw: columnHead(project.name, 'Projekte', 'Teilprojekt anlegen', 'data-add-subproject') }}
        <div class="column__tools">
            <button class="btn btn--ghost btn--small" data-edit-project="${project.id}">Projekt bearbeiten</button>
            <button class="btn btn--ghost btn--small" data-delete-project="${project.id}">Löschen</button>
        </div>
        ${project.progress ? html`
            <div class="budget">
                <strong>${project.progress.used_hours} h</strong> von ${project.progress.budget_hours} h
                <span class="muted">(${project.progress.remaining_hours} h übrig)</span>
                <span class="progress">
                    <span class="progress__bar ${project.progress.percent > 100 ? 'is-over' : ''}"
                          style="width:${Math.min(100, project.progress.percent)}%"></span>
                </span>
            </div>` : ''}
        <ul class="rows">
            ${project.subprojects.map((sub) => html`
                <li>
                    <span class="row row--static ${sub.archived ? 'is-archived' : ''}">
                        <span class="row__main">
                            <strong>${sub.name}</strong>
                            ${{ __raw: statLine(sub) }}
                        </span>
                        <span class="row__meta">${sub.effective_rate} €</span>
                        <span class="row__actions">
                            <button class="icon-btn" data-edit-subproject="${sub.id}" title="Bearbeiten">✎</button>
                            <button class="icon-btn" data-delete-subproject="${sub.id}" title="Löschen">🗑</button>
                        </span>
                    </span>
                </li>`)}
        </ul>
        ${project.subprojects.length ? '' : '<p class="muted column__empty">Keine Teilprojekte.</p>'}`;
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

        const editC = target('edit-client');
        if (editC) return editClient(root, Number(editC.dataset.editClient));
        const editP = target('edit-project');
        if (editP) return editProject(root, Number(editP.dataset.editProject));
        const editS = target('edit-subproject');
        if (editS) return editSubproject(root, Number(editS.dataset.editSubproject));

        const delC = target('delete-client');
        if (delC) return remove(root, 'clients', Number(delC.dataset.deleteClient), 'Kunde');
        const delP = target('delete-project');
        if (delP) return remove(root, 'projects', Number(delP.dataset.deleteProject), 'Projekt');
        const delS = target('delete-subproject');
        if (delS) return remove(root, 'subprojects', Number(delS.dataset.deleteSubproject), 'Teilprojekt');
    });
}

async function remove(root, resource, id, label) {
    if (!await confirmDialog(`${label} löschen`, `„${label}" wird gelöscht. Vorhandene Zeiten verhindern das.`)) return;
    try {
        await api.delete(`/${resource}/${id}`);
        if (resource === 'clients') sel.clientId = null;
        if (resource === 'projects') sel.projectId = null;
        invalidateTree();
        toast('Gelöscht.', 'ok', 2000);
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
        <label class="field"><span class="field__label">Name</span>
            <input class="input" name="name" value="${client?.name ?? ''}" required></label>
        <div class="filters__row">
            <label class="field field--inline"><span class="field__label">Farbe</span>
                <input class="input" type="color" name="color" value="${client?.color ?? '#2f6df6'}"></label>
            <label class="field field--inline"><span class="field__label">Stundensatz</span>
                <input class="input" type="number" name="rate" step="0.01" min="0"
                    value="${client?.rate ?? ''}" placeholder="Vorgabe"></label>
            <label class="field field--inline"><span class="field__label">Sprache</span>
                <select class="input" name="lang">
                    <option value="de" ${client?.lang === 'en' ? '' : 'selected'}>Deutsch</option>
                    <option value="en" ${client?.lang === 'en' ? 'selected' : ''}>English</option>
                </select></label>
        </div>
        <label class="field"><span class="field__label">Ansprechpartner</span>
            <input class="input" name="contact_name" value="${client?.contact_name ?? ''}"></label>
        <label class="field"><span class="field__label">E-Mail</span>
            <input class="input" type="email" name="contact_email" value="${client?.contact_email ?? ''}"></label>
        <label class="field"><span class="field__label">Anschrift</span>
            <textarea class="input" name="contact_address" rows="3">${client?.contact_address ?? ''}</textarea></label>
        <label class="field"><span class="field__label">Sichtbarkeit im Kundenportal</span>
            <input class="input" type="number" name="visibility_offset_days" step="1" min="0" max="365"
                value="${client?.visibility_offset_days ?? 1}">
            <span class="field__hint">Tage, die Einträge zurückliegen müssen, bevor sie im Kundenportal
                sichtbar werden (nach Kalendertag, nicht rollierend). 0 = keine Einschränkung,
                1 = heutiger Tag noch nicht sichtbar.</span></label>
        <label class="switch"><input type="checkbox" name="archived" ${client?.archived ? 'checked' : ''}>
            <span>archiviert</span></label>`;

    const get = (n) => node.querySelector(`[name=${n}]`);

    await form(root, {
        title: id ? 'Kunde bearbeiten' : 'Kunde anlegen',
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
        <p class="muted">Kunde: ${client.name}</p>
        <label class="field"><span class="field__label">Name</span>
            <input class="input" name="name" value="${project?.name ?? ''}" required></label>
        <div class="filters__row">
            <label class="field field--inline"><span class="field__label">Farbe</span>
                <input class="input" type="color" name="color" value="${project?.own_color ?? client.color ?? '#2f6df6'}"></label>
            <label class="field field--inline"><span class="field__label">Stundensatz</span>
                <input class="input" type="number" name="rate" step="0.01" min="0"
                    value="${project?.rate ?? ''}" placeholder="erbt ${client.effective_rate}"></label>
            <label class="field field--inline"><span class="field__label">Budget (Std.)</span>
                <input class="input" type="number" name="budget_hours" step="0.25" min="0"
                    value="${project?.budget_hours ?? ''}" placeholder="ohne"></label>
        </div>
        <label class="switch"><input type="checkbox" name="archived" ${project?.archived ? 'checked' : ''}>
            <span>archiviert</span></label>`;

    const get = (n) => node.querySelector(`[name=${n}]`);

    await form(root, {
        title: id ? 'Projekt bearbeiten' : 'Projekt anlegen',
        node,
        path: id ? `/projects/${id}` : '/projects',
        creating: !id,
        collect: () => ({
            client_id: client.id,
            name: get('name').value.trim(),
            color: get('color').value,
            rate: get('rate').value === '' ? null : Number(get('rate').value),
            budget_hours: get('budget_hours').value === '' ? null : Number(get('budget_hours').value),
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
        <label class="field"><span class="field__label">Name</span>
            <input class="input" name="name" value="${sub?.name ?? ''}" required></label>
        <label class="field"><span class="field__label">Stundensatz</span>
            <input class="input" type="number" name="rate" step="0.01" min="0"
                value="${sub?.rate ?? ''}" placeholder="erbt ${project.effective_rate}"></label>
        <label class="switch"><input type="checkbox" name="archived" ${sub?.archived ? 'checked' : ''}>
            <span>archiviert</span></label>`;

    const get = (n) => node.querySelector(`[name=${n}]`);

    await form(root, {
        title: id ? 'Teilprojekt bearbeiten' : 'Teilprojekt anlegen',
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
    toast('Gespeichert.', 'ok', 2000);
    await masterView.render(root);
}
