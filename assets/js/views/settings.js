// Einstellungen und Import.

import { api } from '../api.js';
import { state, loadSettings, invalidateTree } from '../store.js';
import { t } from '../i18n.js';
import { saveDialog, toast, toastError } from '../ui.js';
import { formatDate, html } from '../util.js';
import { renderUsers } from './users.js';

/** Vom Server erzwungene Mindestlänge – siehe UserRepo::MIN_PASSWORD. */
const MIN_PASSWORD = 10;

export const settingsView = {
    async render(root) {
        await loadSettings();
        const s = state.settings;

        root.innerHTML = html`
            <section class="stack stack--narrow">
                <form class="card" id="settings-form">
                    <header class="card__head"><h2>${t('settings.tracking')}</h2></header>
                    <div class="card__body">
                        <label class="switch">
                            <input type="checkbox" name="rounding_enabled" ${s.rounding_enabled === '1' ? 'checked' : ''}>
                            <span>${t('settings.rounding')}</span>
                        </label>
                        <div class="filters__row">
                            <label class="field field--inline">
                                <span class="field__label">${t('settings.roundingMinutes')}</span>
                                <input class="input" type="number" name="rounding_minutes" min="1" max="240"
                                    value="${s.rounding_minutes ?? 15}">
                            </label>
                            <label class="field field--inline">
                                <span class="field__label">${t('settings.roundingMode')}</span>
                                <select class="input" name="rounding_mode">
                                    <option value="nearest" ${s.rounding_mode === 'nearest' ? 'selected' : ''}>${t('settings.roundingNearest')}</option>
                                    <option value="up" ${s.rounding_mode === 'up' ? 'selected' : ''}>${t('settings.roundingUp')}</option>
                                    <option value="down" ${s.rounding_mode === 'down' ? 'selected' : ''}>${t('settings.roundingDown')}</option>
                                </select>
                            </label>
                        </div>
                        <p class="muted">${t('settings.roundingHint')}</p>
                        <div class="filters__row">
                            <label class="field field--inline">
                                <span class="field__label">${t('settings.defaultRate')}</span>
                                <input class="input" type="number" name="default_rate" step="0.01" min="0"
                                    value="${s.default_rate ?? 0}">
                            </label>
                            <label class="field field--inline">
                                <span class="field__label">${t('settings.recentLimit')}</span>
                                <input class="input" type="number" name="recent_limit" min="1" max="50"
                                    value="${s.recent_limit ?? 10}">
                            </label>
                        </div>
                        <button class="btn btn--primary" type="submit">${t('common.save')}</button>
                    </div>
                </form>

                <section class="card">
                    <header class="card__head"><h2>${t('settings.import')}</h2></header>
                    <div class="card__body">
                        <p class="muted">${t('settings.importHint')}</p>
                        <input type="file" id="import-file" accept=".csv,text/csv" class="input">
                        <div class="filters__row">
                            <button class="btn" id="import-dry" disabled>${t('settings.importCheck')}</button>
                            <button class="btn btn--primary" id="import-go" disabled>${t('settings.importRun')}</button>
                        </div>
                        <div id="import-report"></div>
                    </div>
                </section>

                <form class="card" id="issuer-form">
                    <header class="card__head"><h2>${t('settings.issuer')}</h2></header>
                    <div class="card__body">
                        <p class="muted">${t('settings.issuerHint')}</p>
                        <label class="field"><span class="field__label">${t('settings.issuerName')}</span>
                            <input class="input" name="issuer_name" value="${s.issuer_name ?? ''}"></label>
                        <label class="field"><span class="field__label">${t('settings.issuerLogo')}</span>
                            <input class="input" name="issuer_logo" value="${s.issuer_logo ?? ''}"
                                placeholder="assets/icons/logo.svg"></label>
                        <label class="field"><span class="field__label">${t('settings.issuerAddress')}</span>
                            <textarea class="input" name="issuer_address" rows="4">${s.issuer_address ?? ''}</textarea></label>
                        <div class="filters__row">
                            <label class="field field--grow"><span class="field__label">${t('settings.issuerFooterLeft')}</span>
                                <input class="input" name="issuer_footer" value="${s.issuer_footer ?? ''}"></label>
                            <label class="field field--grow"><span class="field__label">${t('settings.issuerFooterRight')}</span>
                                <input class="input" name="issuer_contact" value="${s.issuer_contact ?? ''}"></label>
                        </div>
                        <button class="btn btn--primary" type="submit">${t('common.save')}</button>
                    </div>
                </form>

                <div id="users"></div>

                <section class="card">
                    <header class="card__head"><h2>${t('settings.account')}</h2></header>
                    <div class="card__body">
                        <p>${t('settings.signedInAs')} <strong>${state.user?.name}</strong>
                            <span class="muted">(${state.user?.email})</span></p>
                        <p class="muted">${t('settings.langHint')}</p>
                        <button class="btn" id="change-password">${t('settings.changePassword')}</button>
                    </div>
                </section>
            </section>`;

        bind(root);
        renderUsers(root.querySelector('#users')).catch(toastError);
    },
};

function bind(root) {
    root.querySelector('#settings-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        try {
            await api.patch('/settings', {
                rounding_enabled: form.rounding_enabled.checked,
                rounding_minutes: Number(form.rounding_minutes.value),
                rounding_mode: form.rounding_mode.value,
                default_rate: Number(form.default_rate.value),
                recent_limit: Number(form.recent_limit.value),
            });
            await loadSettings();
            toast(t('settings.saved'), 'ok', 2000);
        } catch (error) {
            toastError(error);
        }
    });

    root.querySelector('#issuer-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        try {
            await api.patch('/settings', {
                issuer_name: form.issuer_name.value,
                issuer_logo: form.issuer_logo.value,
                issuer_address: form.issuer_address.value,
                issuer_footer: form.issuer_footer.value,
                issuer_contact: form.issuer_contact.value,
            });
            await loadSettings();
            toast(t('settings.issuerSaved'), 'ok', 2000);
        } catch (error) {
            toastError(error);
        }
    });

    root.querySelector('#change-password').addEventListener('click', changePassword);

    const file = root.querySelector('#import-file');
    const dry = root.querySelector('#import-dry');
    const go = root.querySelector('#import-go');

    file.addEventListener('change', () => {
        const has = file.files.length > 0;
        dry.disabled = !has;
        go.disabled = !has;
    });

    dry.addEventListener('click', () => runImport(root, true));
    go.addEventListener('click', () => runImport(root, false));
}

async function changePassword() {
    const node = document.createElement('div');
    node.innerHTML = html`
        <label class="field"><span class="field__label">${t('settings.currentPassword')}</span>
            <input class="input" type="password" name="current_password" autocomplete="current-password"></label>
        <label class="field"><span class="field__label">${t('settings.newPassword')}</span>
            <input class="input" type="password" name="new_password" autocomplete="new-password"
                minlength="${MIN_PASSWORD}" placeholder="${t('settings.minCharsPlaceholder', { n: MIN_PASSWORD })}">
            <span class="field__hint">${t('settings.minChars', { n: MIN_PASSWORD })}</span></label>`;

    const changed = await saveDialog({
        title: t('settings.changePassword'),
        body: node,
        saveLabel: t('common.change'),
        save: () => api.post('/auth/password', {
            current_password: node.querySelector('[name=current_password]').value,
            new_password: node.querySelector('[name=new_password]').value,
        }),
    });

    if (changed) toast(t('settings.passwordChanged'), 'ok', 3000);
}

async function runImport(root, dryRun) {
    const file = root.querySelector('#import-file').files[0];
    if (!file) return;

    const host = root.querySelector('#import-report');
    host.innerHTML = html`<div class="loading">${t('settings.importReading')}</div>`;

    try {
        const text = await file.text();
        const { report } = await api.upload('/import/timings-csv', text, { dry_run: dryRun ? '1' : '0' });
        host.innerHTML = renderReport(report, dryRun);
        if (!dryRun) {
            invalidateTree();
            toast(t('settings.importDone', { count: report.imported }), 'ok', 5000);
        }
    } catch (error) {
        host.innerHTML = '';
        toastError(error);
    }
}

function renderReport(r, dryRun) {
    const line = (label, value) => html`<tr><th>${label}</th><td>${value}</td></tr>`;

    return html`
        <div class="report">
            <h3>${dryRun ? t('import.dryTitle') : t('import.doneTitle')}</h3>
            <table class="table table--kv">
                ${{ __raw: [
                    line(t('import.lines'), r.lines),
                    line(t('import.parsed'), r.parsed),
                    line(t('import.period'), `${fmtDate(r.range.from)} – ${fmtDate(r.range.to)}`),
                    line(t('import.sum'), `${r.totals.hhmm} (${r.totals.decimal} h)`),
                    line(t('import.newClients'), r.new.clients.length),
                    line(t('import.newProjects'), r.new.projects),
                    line(t('import.newSubprojects'), r.new.subprojects),
                    line(t('import.overnight'), r.flags.overnight),
                    line(t('import.unrounded'), r.flags.unrounded),
                    line(t('import.negative'), r.flags.negative),
                    line(t('import.noNote'), r.flags.no_note),
                    line(t('import.dupInFile'), r.skips.duplicates_in_file),
                    line(t('import.already'), r.skips.already_imported),
                    dryRun ? '' : line(t('import.written'),
                        t('import.writtenValue', { imported: r.imported, skipped: r.skipped })),
                ].join('') }}
            </table>
            ${r.errors.length ? html`
                <details class="report__errors">
                    <summary>${t('import.badLines', { count: r.errors.length })}</summary>
                    <ul>${r.errors.slice(0, 50).map((e) => html`
                        <li>${t('import.lineError', { line: e.line, message: e.message })}
                            <code>${e.raw}</code></li>`)}</ul>
                </details>` : ''}
        </div>`;
}

/** Der Bericht liefert nackte ISO-Daten – "—", solange nichts gelesen wurde. */
function fmtDate(iso) {
    return iso ? formatDate(iso.slice(0, 10)) : t('common.dash');
}
