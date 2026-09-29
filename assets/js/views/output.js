// Auswertung innerhalb der Einträge: Summentabelle, Leistungsnachweis und
// Export. Kein eigener View – entries.js bindet das ein und liefert, worauf
// es sich bezieht: die aktuellen Filter oder die angehakten Einträge.

import { api } from '../api.js';
import { LANGS, t } from '../i18n.js';
import { loadPref, savePref } from '../prefs.js';
import { saveDialog } from '../ui.js';
import { decimal, html, money } from '../util.js';

export const GROUP_KEYS = ['client', 'project', 'subproject', 'month', 'week', 'day', 'year'];

/** Beschriftung einer Gruppierung – erst beim Zeichnen, wegen der Sprache. */
export function groupLabel(key) {
    return t('reports.group' + key[0].toUpperCase() + key.slice(1));
}

// -- Summen -----------------------------------------------------------------

export function groupChips(active) {
    return html`
        <div class="chips stats__groups">
            <span class="field__label">${t('reports.groupBy')}</span>
            ${GROUP_KEYS.map((key) => html`
                <button type="button" class="chip ${active === key ? 'is-active' : ''}"
                        data-group="${key}">${groupLabel(key)}</button>`)}
        </div>`;
}

/** Summentabelle aus der Antwort von GET /api/stats. */
export function statsHtml(data, groupBy) {
    if (!data.groups.length) {
        return html`<div class="card"><p class="muted card__body">${t('entries.empty')}</p></div>`;
    }

    const max = Math.max(...data.groups.map((g) => g.minutes)) || 1;

    return html`
        <section class="card">
            <table class="table table--stats">
                <thead>
                    <tr>
                        <th>${groupLabel(groupBy)}</th>
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
}

// -- Leistungsnachweis und Export -------------------------------------------

let templates = null;
let formats = null;

async function catalog() {
    if (!templates || !formats) {
        const [tpl, fmt] = await Promise.all([api.get('/report/templates'), api.get('/export/formats')]);
        templates = tpl.templates;
        formats = fmt.formats;
    }
}

/**
 * Optionen des Leistungsnachweises. Übernimmt beim ersten Mal, was die
 * frühere Seite "Auswertung" gespeichert hatte.
 */
function reportOptions() {
    const defaults = { template: '', lang: '', costs: false, group_days: false, times: false, notes: true };
    const saved = loadPref('reportOptions', null) ?? loadPref('reports', null)?.options ?? {};
    for (const key of Object.keys(defaults)) {
        if (typeof saved[key] === typeof defaults[key]) defaults[key] = saved[key];
    }
    return defaults;
}

/**
 * Worauf sich die Ausgabe bezieht – oben im Dialog, damit ein vergessener
 * Suchbegriff oder ein fehlender Kunde auffällt, bevor der Nachweis beim
 * Kunden landet.
 *
 * `scope`: { selection: bool, count, hhmm, query, warnings: [] }
 */
function scopeHtml(scope) {
    return html`
        <div class="outscope">
            <span class="outscope__label">${scope.selection ? t('output.scopeSelection') : t('output.scopeFilter')}</span>
            <strong>${t('output.summary', { count: scope.count, hours: scope.hhmm })}</strong>
            ${scope.warnings.map((text) => html`<p class="outscope__warn">${text}</p>`)}
        </div>`;
}

function assertNotEmpty(scope) {
    if (!scope.count) throw new Error(t('output.empty'));
}

export async function reportDialog(scope) {
    await catalog();
    const options = reportOptions();

    const node = document.createElement('div');
    node.innerHTML = html`
        ${scopeHtml(scope)}
        <div class="filters__row">
            <label class="field field--inline field--grow">
                <span class="field__label">${t('reports.template')}</span>
                <select class="input" name="template">
                    ${templates.map((tpl) => html`<option value="${tpl.key}">${tpl.label}</option>`)}
                </select>
            </label>
            <label class="field field--inline">
                <span class="field__label">${t('common.language')}</span>
                <select class="input" name="lang">
                    <option value="">${t('reports.langByClient')}</option>
                    ${LANGS.map((code) => html`<option value="${code}">${t('lang.' + code)}</option>`)}
                </select>
            </label>
        </div>
        <div class="outopts">
            <label class="switch"><input type="checkbox" name="costs"> <span>${t('reports.optCosts')}</span></label>
            <label class="switch"><input type="checkbox" name="group_days"> <span>${t('reports.optGroupDays')}</span></label>
            <label class="switch"><input type="checkbox" name="times"> <span>${t('reports.optTimes')}</span></label>
            <label class="switch"><input type="checkbox" name="notes"> <span>${t('common.notes')}</span></label>
        </div>
        <p class="muted">${t('reports.openHint')}</p>`;

    const get = (name) => node.querySelector(`[name=${name}]`);
    if (templates.some((tpl) => tpl.key === options.template)) get('template').value = options.template;
    get('lang').value = options.lang;
    for (const key of ['costs', 'group_days', 'times', 'notes']) get(key).checked = options[key];

    await saveDialog({
        title: t('reports.statement'),
        body: node,
        saveLabel: t('reports.open'),
        // Nichts davor abwarten: window.open muss noch im Klick passieren,
        // sonst hält der Browser das Fenster für ein Popup und blockt es.
        save: () => {
            assertNotEmpty(scope);
            const chosen = {
                template: get('template').value,
                lang: get('lang').value,
                costs: get('costs').checked,
                group_days: get('group_days').checked,
                times: get('times').checked,
                notes: get('notes').checked,
            };
            savePref('reportOptions', chosen);
            window.open(api.url('/report', {
                ...scope.query,
                template: chosen.template,
                lang: chosen.lang,
                costs: chosen.costs ? 1 : 0,
                group_days: chosen.group_days ? 1 : 0,
                times: chosen.times ? 1 : 0,
                notes: chosen.notes ? 1 : 0,
            }), '_blank', 'noopener');
        },
    });
}

export async function exportDialog(scope) {
    await catalog();
    const saved = loadPref('exportFormat', '');
    const current = formats.some((f) => f.key === saved) ? saved : formats[0]?.key;

    const node = document.createElement('div');
    node.innerHTML = html`
        ${scopeHtml(scope)}
        <fieldset class="outformats">
            <legend class="field__label">${t('output.format')}</legend>
            ${formats.map((f) => html`
                <label class="switch">
                    <input type="radio" name="format" value="${f.key}"
                        ${f.key === current ? { __raw: 'checked' } : ''}>
                    <span>${f.label}</span>
                </label>`)}
        </fieldset>`;

    await saveDialog({
        title: t('reports.export'),
        body: node,
        saveLabel: t('output.download'),
        save: () => {
            assertNotEmpty(scope);
            const format = node.querySelector('[name=format]:checked')?.value || current;
            savePref('exportFormat', format);
            window.location.href = api.url('/api/export', { ...scope.query, format });
        },
    });
}
