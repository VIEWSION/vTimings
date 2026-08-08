// Benutzer- und Token-Verwaltung, eingebettet in die Einstellungen.

import { api } from '../api.js';
import { state, loadTree } from '../store.js';
import { confirmDialog, dialog, saveDialog, toast, toastError } from '../ui.js';
import { esc, html } from '../util.js';

export async function renderUsers(host) {
    host.innerHTML = '<div class="loading">Lade …</div>';

    const [{ users }, { tokens }] = await Promise.all([
        api.get('/users'),
        api.get('/tokens'),
    ]);

    host.innerHTML = html`
        <section class="card">
            <header class="card__head">
                <h2>Zugänge</h2>
                <button class="btn btn--small" data-new-user>Zugang anlegen</button>
            </header>
            <table class="table">
                <thead>
                    <tr><th>Name</th><th>Rolle</th><th>Kunde</th><th>Zuletzt</th><th></th></tr>
                </thead>
                <tbody>
                    ${users.map((user) => html`
                        <tr class="${user.active ? '' : 'is-inactive'}">
                            <td>
                                <strong>${user.name}</strong><br>
                                <span class="muted">${user.email}</span>
                            </td>
                            <td>${user.role === 'admin' ? 'Administrator' : 'Kunde'}
                                ${user.role === 'client' && !user.show_costs
                                    ? html`<br><span class="tag">ohne Kosten</span>` : ''}
                                ${user.project_filter
                                    ? html`<br><span class="tag">${user.project_filter.length} Projekt(e)</span>` : ''}
                            </td>
                            <td>${user.client_name ?? '—'}</td>
                            <td class="muted">${user.last_login_at
                                ? new Date(user.last_login_at).toLocaleDateString('de-DE')
                                : 'nie'}</td>
                            <td class="num">
                                <button class="icon-btn" data-edit-user="${user.id}" title="Bearbeiten">✎</button>
                                ${user.id === state.user?.id
                                    ? ''
                                    : html`<button class="icon-btn" data-delete-user="${user.id}" title="Löschen">🗑</button>`}
                            </td>
                        </tr>`)}
                </tbody>
            </table>
        </section>

        <section class="card">
            <header class="card__head">
                <h2>API-Tokens</h2>
                <button class="btn btn--small" data-new-token>Token erzeugen</button>
            </header>
            <div class="card__body">
                <p class="muted">Für spätere native Clients. Ein Token ersetzt die Anmeldung
                    über den Browser und wird als <code>Authorization: Bearer …</code> geschickt.</p>
            </div>
            ${tokens.length ? html`
                <table class="table">
                    <thead><tr><th>Bezeichnung</th><th>Konto</th><th>Zuletzt benutzt</th><th></th></tr></thead>
                    <tbody>
                        ${tokens.map((token) => html`
                            <tr>
                                <td>${token.label}</td>
                                <td class="muted">${token.email}</td>
                                <td class="muted">${token.last_used_at
                                    ? new Date(token.last_used_at).toLocaleString('de-DE') : 'nie'}</td>
                                <td class="num">
                                    <button class="icon-btn" data-revoke="${token.id}" title="Widerrufen">🗑</button>
                                </td>
                            </tr>`)}
                    </tbody>
                </table>` : ''}
        </section>`;

    bind(host, users);
}

function bind(host, users) {
    host.addEventListener('click', async (event) => {
        if (event.target.closest('[data-new-user]')) return editUser(host, null);

        const edit = event.target.closest('[data-edit-user]');
        if (edit) return editUser(host, users.find((u) => u.id === Number(edit.dataset.editUser)));

        const del = event.target.closest('[data-delete-user]');
        if (del) {
            if (!await confirmDialog('Zugang löschen', 'Der Zugang wird endgültig entfernt.')) return;
            try {
                await api.delete(`/users/${del.dataset.deleteUser}`);
                await renderUsers(host);
            } catch (error) { toastError(error); }
            return;
        }

        if (event.target.closest('[data-new-token]')) return createToken(host);

        const revoke = event.target.closest('[data-revoke]');
        if (revoke) {
            if (!await confirmDialog('Token widerrufen', 'Clients mit diesem Token verlieren sofort den Zugriff.', 'Widerrufen')) return;
            try {
                await api.delete(`/tokens/${revoke.dataset.revoke}`);
                await renderUsers(host);
            } catch (error) { toastError(error); }
        }
    });
}

async function editUser(host, user) {
    await loadTree({ force: true });
    const clients = state.tree?.clients || [];

    const node = document.createElement('div');
    node.innerHTML = html`
        <label class="field"><span class="field__label">Name</span>
            <input class="input" name="name" value="${user?.name ?? ''}"></label>
        <label class="field"><span class="field__label">E-Mail</span>
            <input class="input" type="email" name="email" value="${user?.email ?? ''}"></label>
        <label class="field">
            <span class="field__label">Passwort${user ? ' (leer lassen = unverändert)' : ''}</span>
            <input class="input" type="password" name="password" autocomplete="new-password"
                minlength="10" placeholder="mindestens 10 Zeichen">
            <span class="field__hint">Mindestens 10 Zeichen.</span></label>
        <label class="field"><span class="field__label">Rolle</span>
            <select class="input" name="role">
                <option value="client" ${user?.role === 'admin' ? '' : 'selected'}>Kunde (nur lesen)</option>
                <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Administrator</option>
            </select></label>
        <div data-client-fields>
            <label class="field"><span class="field__label">Kunde</span>
                <select class="input" name="client_id">
                    ${clients.map((c) => html`
                        <option value="${c.id}" ${user?.client_id === c.id ? 'selected' : ''}>${c.name}</option>`)}
                </select></label>
            <label class="field">
                <span class="field__label">Sichtbare Projekte</span>
                <select class="input" name="project_filter" multiple size="6"></select>
                <span class="field__hint">Nichts ausgewählt = alle Projekte des Kunden.</span>
            </label>
            <label class="switch">
                <input type="checkbox" name="show_costs" ${user ? (user.show_costs ? 'checked' : '') : 'checked'}>
                <span>Stundensätze und Beträge zeigen</span></label>
        </div>
        <label class="switch">
            <input type="checkbox" name="active" ${user ? (user.active ? 'checked' : '') : 'checked'}>
            <span>aktiv</span></label>`;

    const roleSelect = node.querySelector('[name=role]');
    const clientSelect = node.querySelector('[name=client_id]');
    const projectSelect = node.querySelector('[name=project_filter]');
    const clientFields = node.querySelector('[data-client-fields]');

    function fillProjects() {
        const client = clients.find((c) => c.id === Number(clientSelect.value));
        projectSelect.innerHTML = (client?.projects || [])
            .map((p) => `<option value="${p.id}"${
                user?.project_filter?.includes(p.id) ? ' selected' : ''}>${esc(p.name)}</option>`)
            .join('');
    }
    function toggleRole() {
        clientFields.hidden = roleSelect.value === 'admin';
    }

    roleSelect.addEventListener('change', toggleRole);
    clientSelect.addEventListener('change', fillProjects);
    fillProjects();
    toggleRole();

    const saved = await saveDialog({
        title: user ? 'Zugang bearbeiten' : 'Zugang anlegen',
        body: node,
        save: async () => {
            const get = (name) => node.querySelector(`[name=${name}]`);
            const payload = {
                name: get('name').value.trim(),
                email: get('email').value.trim(),
                role: get('role').value,
                active: get('active').checked,
            };
            if (get('password').value) payload.password = get('password').value;
            if (payload.role === 'client') {
                payload.client_id = Number(get('client_id').value);
                payload.project_filter = [...projectSelect.selectedOptions].map((o) => Number(o.value));
                payload.show_costs = get('show_costs').checked;
            }

            if (user) await api.patch(`/users/${user.id}`, payload);
            else await api.post('/users', payload);
        },
    });
    if (!saved) return;

    toast('Gespeichert.', 'ok', 2000);
    await renderUsers(host);
}

async function createToken(host) {
    const node = document.createElement('div');
    node.innerHTML = html`
        <label class="field"><span class="field__label">Bezeichnung</span>
            <input class="input" name="label" placeholder="z. B. MacBook, iPhone"></label>
        <label class="field"><span class="field__label">Gültig für (Tage, leer = unbegrenzt)</span>
            <input class="input" type="number" name="expires_days" min="1" max="3650"></label>`;

    const data = await saveDialog({
        title: 'API-Token erzeugen',
        body: node,
        saveLabel: 'Erzeugen',
        save: () => api.post('/tokens', {
            label: node.querySelector('[name=label]').value.trim() || 'Token',
            expires_days: node.querySelector('[name=expires_days]').value || undefined,
        }),
    });
    if (!data) return;

    await dialog({
        title: 'Token erzeugt',
        body: html`
            <p>${data.hint}</p>
            <pre><code>${data.token}</code></pre>`,
        buttons: [{ label: 'Verstanden', value: 'ok', kind: 'primary' }],
    });

    await renderUsers(host);
}
