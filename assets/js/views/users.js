// Benutzer- und Token-Verwaltung, eingebettet in die Einstellungen.

import { api } from '../api.js';
import { state, loadTree } from '../store.js';
import { t } from '../i18n.js';
import { confirmDialog, dialog, saveDialog, toast, toastError } from '../ui.js';
import { esc, formatDateTime, html } from '../util.js';

/** Vom Server erzwungene Mindestlänge – siehe UserRepo::MIN_PASSWORD. */
const MIN_PASSWORD = 10;

export async function renderUsers(host) {
    host.innerHTML = html`<div class="loading">${t('common.loading')}</div>`;

    const [{ users }, { tokens }] = await Promise.all([
        api.get('/users'),
        api.get('/tokens'),
    ]);

    host.innerHTML = html`
        <section class="card">
            <header class="card__head">
                <h2>${t('users.section')}</h2>
                <button class="btn btn--small" data-new-user>${t('users.add')}</button>
            </header>
            <table class="table">
                <thead>
                    <tr><th>${t('common.name')}</th><th>${t('users.role')}</th><th>${t('common.client')}</th>
                        <th>${t('users.lastLogin')}</th><th></th></tr>
                </thead>
                <tbody>
                    ${users.map((user) => html`
                        <tr class="${user.active ? '' : 'is-inactive'}">
                            <td>
                                <strong>${user.name}</strong><br>
                                <span class="muted">${user.email}</span>
                            </td>
                            <td>${user.role === 'admin' ? t('users.roleAdmin') : t('users.roleClient')}
                                ${user.role === 'client' && !user.show_costs
                                    ? html`<br><span class="tag">${t('users.noCosts')}</span>` : ''}
                                ${user.project_filter
                                    ? html`<br><span class="tag">
                                        ${t('users.projectCount', { count: user.project_filter.length })}</span>` : ''}
                            </td>
                            <td>${user.client_name ?? t('common.dash')}</td>
                            <td class="muted">${user.last_login_at
                                ? formatDateTime(user.last_login_at)
                                : t('common.never')}</td>
                            <td class="num">
                                <button class="icon-btn" data-edit-user="${user.id}" title="${t('common.edit')}">✎</button>
                                ${user.id === state.user?.id
                                    ? ''
                                    : html`<button class="icon-btn" data-delete-user="${user.id}"
                                        title="${t('common.delete')}">🗑</button>`}
                            </td>
                        </tr>`)}
                </tbody>
            </table>
        </section>

        <section class="card">
            <header class="card__head">
                <h2>${t('tokens.section')}</h2>
                <button class="btn btn--small" data-new-token>${t('tokens.add')}</button>
            </header>
            <div class="card__body">
                <p class="muted">${t('tokens.hint')} <code>Authorization: Bearer …</code></p>
            </div>
            ${tokens.length ? html`
                <table class="table">
                    <thead><tr><th>${t('tokens.label')}</th><th>${t('tokens.account')}</th>
                        <th>${t('tokens.lastUsed')}</th><th></th></tr></thead>
                    <tbody>
                        ${tokens.map((token) => html`
                            <tr>
                                <td>${token.label}</td>
                                <td class="muted">${token.email}</td>
                                <td class="muted">${token.last_used_at
                                    ? formatDateTime(token.last_used_at) : t('common.never')}</td>
                                <td class="num">
                                    <button class="icon-btn" data-revoke="${token.id}"
                                        title="${t('tokens.revoke')}">🗑</button>
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
            if (!await confirmDialog(t('users.deleteTitle'), t('users.deleteText'))) return;
            try {
                await api.delete(`/users/${del.dataset.deleteUser}`);
                await renderUsers(host);
            } catch (error) { toastError(error); }
            return;
        }

        if (event.target.closest('[data-new-token]')) return createToken(host);

        const revoke = event.target.closest('[data-revoke]');
        if (revoke) {
            if (!await confirmDialog(t('tokens.revokeTitle'), t('tokens.revokeText'), t('tokens.revoke'))) return;
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
        <label class="field"><span class="field__label">${t('common.name')}</span>
            <input class="input" name="name" value="${user?.name ?? ''}"></label>
        <label class="field"><span class="field__label">${t('common.email')}</span>
            <input class="input" type="email" name="email" value="${user?.email ?? ''}"></label>
        <label class="field">
            <span class="field__label">${t('common.password')}${user ? t('users.passwordKeep') : ''}</span>
            <input class="input" type="password" name="password" autocomplete="new-password"
                minlength="${MIN_PASSWORD}" placeholder="${t('settings.minCharsPlaceholder', { n: MIN_PASSWORD })}">
            <span class="field__hint">${t('settings.minChars', { n: MIN_PASSWORD })}</span></label>
        <label class="field"><span class="field__label">${t('users.role')}</span>
            <select class="input" name="role">
                <option value="client" ${user?.role === 'admin' ? '' : 'selected'}>${t('users.roleClientOption')}</option>
                <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>${t('users.roleAdmin')}</option>
            </select></label>
        <div data-client-fields>
            <label class="field"><span class="field__label">${t('common.client')}</span>
                <select class="input" name="client_id">
                    ${clients.map((c) => html`
                        <option value="${c.id}" ${user?.client_id === c.id ? 'selected' : ''}>${c.name}</option>`)}
                </select></label>
            <label class="field">
                <span class="field__label">${t('users.visibleProjects')}</span>
                <select class="input" name="project_filter" multiple size="6"></select>
                <span class="field__hint">${t('users.visibleProjectsHint')}</span>
            </label>
            <label class="switch">
                <input type="checkbox" name="show_costs" ${user ? (user.show_costs ? 'checked' : '') : 'checked'}>
                <span>${t('users.showCosts')}</span></label>
        </div>
        <label class="switch">
            <input type="checkbox" name="active" ${user ? (user.active ? 'checked' : '') : 'checked'}>
            <span>${t('users.active')}</span></label>`;

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
        title: user ? t('users.edit') : t('users.add'),
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

    toast(t('common.saved'), 'ok', 2000);
    await renderUsers(host);
}

async function createToken(host) {
    const node = document.createElement('div');
    node.innerHTML = html`
        <label class="field"><span class="field__label">${t('tokens.label')}</span>
            <input class="input" name="label" placeholder="${t('tokens.labelPlaceholder')}"></label>
        <label class="field"><span class="field__label">${t('tokens.expiresDays')}</span>
            <input class="input" type="number" name="expires_days" min="1" max="3650"></label>`;

    const data = await saveDialog({
        title: t('tokens.createTitle'),
        body: node,
        saveLabel: t('common.create'),
        save: () => api.post('/tokens', {
            label: node.querySelector('[name=label]').value.trim() || 'Token',
            expires_days: node.querySelector('[name=expires_days]').value || undefined,
        }),
    });
    if (!data) return;

    await dialog({
        title: t('tokens.createdTitle'),
        body: html`
            <p>${data.hint}</p>
            <pre><code>${data.token}</code></pre>`,
        buttons: [{ label: t('common.understood'), value: 'ok', kind: 'primary' }],
    });

    await renderUsers(host);
}
