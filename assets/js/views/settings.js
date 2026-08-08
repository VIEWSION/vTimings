// Einstellungen und Import.

import { api } from '../api.js';
import { state, loadSettings, invalidateTree } from '../store.js';
import { dialog, toast, toastError } from '../ui.js';
import { html } from '../util.js';
import { renderUsers } from './users.js';

export const settingsView = {
    title: 'Einstellungen',

    async render(root) {
        await loadSettings();
        const s = state.settings;

        root.innerHTML = html`
            <section class="stack stack--narrow">
                <form class="card" id="settings-form">
                    <header class="card__head"><h2>Zeiterfassung</h2></header>
                    <div class="card__body">
                        <label class="switch">
                            <input type="checkbox" name="rounding_enabled" ${s.rounding_enabled === '1' ? 'checked' : ''}>
                            <span>Zeiten runden</span>
                        </label>
                        <div class="filters__row">
                            <label class="field field--inline">
                                <span class="field__label">Raster (Minuten)</span>
                                <input class="input" type="number" name="rounding_minutes" min="1" max="240"
                                    value="${s.rounding_minutes ?? 15}">
                            </label>
                            <label class="field field--inline">
                                <span class="field__label">Richtung</span>
                                <select class="input" name="rounding_mode">
                                    <option value="nearest" ${s.rounding_mode === 'nearest' ? 'selected' : ''}>zum nächsten</option>
                                    <option value="up" ${s.rounding_mode === 'up' ? 'selected' : ''}>aufrunden</option>
                                    <option value="down" ${s.rounding_mode === 'down' ? 'selected' : ''}>abrunden</option>
                                </select>
                            </label>
                        </div>
                        <p class="muted">Start und Ende werden je einzeln auf das Raster gelegt – wie in Timings.</p>
                        <div class="filters__row">
                            <label class="field field--inline">
                                <span class="field__label">Vorgabe-Stundensatz</span>
                                <input class="input" type="number" name="default_rate" step="0.01" min="0"
                                    value="${s.default_rate ?? 0}">
                            </label>
                            <label class="field field--inline">
                                <span class="field__label">Schnellwahl-Einträge</span>
                                <input class="input" type="number" name="recent_limit" min="1" max="50"
                                    value="${s.recent_limit ?? 10}">
                            </label>
                        </div>
                        <button class="btn btn--primary" type="submit">Speichern</button>
                    </div>
                </form>

                <section class="card">
                    <header class="card__head"><h2>Import</h2></header>
                    <div class="card__body">
                        <p class="muted">Timings-Export (CSV, Semikolon-getrennt) einlesen. Bereits vorhandene
                            Einträge werden anhand ihres Inhalts erkannt und übersprungen.</p>
                        <input type="file" id="import-file" accept=".csv,text/csv" class="input">
                        <div class="filters__row">
                            <button class="btn" id="import-dry" disabled>Prüfen</button>
                            <button class="btn btn--primary" id="import-go" disabled>Importieren</button>
                        </div>
                        <div id="import-report"></div>
                    </div>
                </section>

                <form class="card" id="issuer-form">
                    <header class="card__head"><h2>Absender für Ausdrucke</h2></header>
                    <div class="card__body">
                        <p class="muted">Erscheint als Briefkopf auf dem Leistungsnachweis.
                            Bleibt alles leer, beginnt der Nachweis direkt mit dem Titel.</p>
                        <label class="field"><span class="field__label">Name / Firma</span>
                            <input class="input" name="issuer_name" value="${s.issuer_name ?? ''}"></label>
                        <label class="field"><span class="field__label">Logo (URL oder data:-URI)</span>
                            <input class="input" name="issuer_logo" value="${s.issuer_logo ?? ''}"
                                placeholder="assets/icons/logo.svg"></label>
                        <label class="field"><span class="field__label">Anschrift (rechts oben)</span>
                            <textarea class="input" name="issuer_address" rows="4">${s.issuer_address ?? ''}</textarea></label>
                        <div class="filters__row">
                            <label class="field field--grow"><span class="field__label">Fußzeile links</span>
                                <input class="input" name="issuer_footer" value="${s.issuer_footer ?? ''}"></label>
                            <label class="field field--grow"><span class="field__label">Fußzeile rechts</span>
                                <input class="input" name="issuer_contact" value="${s.issuer_contact ?? ''}"></label>
                        </div>
                        <button class="btn btn--primary" type="submit">Speichern</button>
                    </div>
                </form>

                <div id="users"></div>

                <section class="card">
                    <header class="card__head"><h2>Konto</h2></header>
                    <div class="card__body">
                        <p>Angemeldet als <strong>${state.user?.name}</strong>
                            <span class="muted">(${state.user?.email})</span></p>
                        <button class="btn" id="change-password">Passwort ändern</button>
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
            toast('Einstellungen gespeichert.', 'ok', 2000);
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
            toast('Absenderdaten gespeichert.', 'ok', 2000);
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
        <label class="field"><span class="field__label">Bisheriges Passwort</span>
            <input class="input" type="password" name="current" autocomplete="current-password"></label>
        <label class="field"><span class="field__label">Neues Passwort (mind. 10 Zeichen)</span>
            <input class="input" type="password" name="next" autocomplete="new-password"></label>`;

    const result = await dialog({
        title: 'Passwort ändern',
        body: node,
        buttons: [
            { label: 'Abbrechen', value: null },
            { label: 'Ändern', value: 'go', kind: 'primary' },
        ],
    });
    if (result !== 'go') return;

    try {
        await api.post('/auth/password', {
            current_password: node.querySelector('[name=current]').value,
            new_password: node.querySelector('[name=next]').value,
        });
        toast('Passwort geändert.', 'ok', 3000);
    } catch (error) {
        toastError(error);
    }
}

async function runImport(root, dryRun) {
    const file = root.querySelector('#import-file').files[0];
    if (!file) return;

    const host = root.querySelector('#import-report');
    host.innerHTML = '<div class="loading">Lese Datei …</div>';

    try {
        const text = await file.text();
        const { report } = await api.upload('/import/timings-csv', text, { dry_run: dryRun ? '1' : '0' });
        host.innerHTML = renderReport(report, dryRun);
        if (!dryRun) {
            invalidateTree();
            toast(`${report.imported} Einträge importiert.`, 'ok', 5000);
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
            <h3>${dryRun ? 'Prüfung – es wurde nichts geschrieben' : 'Import abgeschlossen'}</h3>
            <table class="table table--kv">
                ${{ __raw: [
                    line('Zeilen gelesen', r.lines),
                    line('davon verwertbar', r.parsed),
                    line('Zeitraum', `${fmtDate(r.range.from)} – ${fmtDate(r.range.to)}`),
                    line('Summe', `${r.totals.hhmm} (${r.totals.decimal} h)`),
                    line('Neue Kunden', r.new.clients.length),
                    line('Neue Projekte', r.new.projects),
                    line('Neue Teilprojekte', r.new.subprojects),
                    line('über Mitternacht', r.flags.overnight),
                    line('nicht auf Raster', r.flags.unrounded),
                    line('Ende vor Start', r.flags.negative),
                    line('ohne Notiz', r.flags.no_note),
                    line('Duplikate in Datei', r.skips.duplicates_in_file),
                    line('bereits vorhanden', r.skips.already_imported),
                    dryRun ? '' : line('geschrieben', `${r.imported} (${r.skipped} übersprungen)`),
                ].join('') }}
            </table>
            ${r.errors.length ? html`
                <details class="report__errors">
                    <summary>${r.errors.length} fehlerhafte Zeile(n)</summary>
                    <ul>${r.errors.slice(0, 50).map((e) => html`<li>Zeile ${e.line}: ${e.message} <code>${e.raw}</code></li>`)}</ul>
                </details>` : ''}
        </div>`;
}

function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('de-DE');
}
