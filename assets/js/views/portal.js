// Kundenportal: die letzten 100 Tage – Projekte, Tagesverlauf, Leistungen.
//
// Die Antwort der API enthält bereits die Tageswerte je Projekt. Das
// Umschalten auf ein einzelnes Projekt zeichnet deshalb nur neu und holt
// nichts nach.

import { api } from '../api.js';
import { state } from '../store.js';
import { t } from '../i18n.js';
import { bindOnce, toastError } from '../ui.js';
import { dayLabel, decimal, formatDate, formatDateTime, hhmm, html, money } from '../util.js';

const ENTRY_LIMIT = 25;

let data = null;
let selected = null;

export const portalView = {
    async render(root) {
        root.innerHTML = html`<div class="loading">${t('common.loading')}</div>`;

        try {
            data = await api.get('/portal', {
                client_id: state.user?.role === 'admin' ? previewClientId() : undefined,
            });
            selected = null;
            paint(root);
        } catch (error) {
            toastError(error);
            root.innerHTML = html`<div class="card"><p class="card__body">${error.message}</p></div>`;
        }
    },

    destroy() {
        data = null;
        selected = null;
    },
};

function previewClientId() {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    return params.get('client_id') || undefined;
}

// -- Darstellung ------------------------------------------------------------

function paint(root) {
    if (!data) return;

    const costs = data.can_see_costs;
    // Auswahl und Klickbarkeit ergeben nur einen Sinn, wenn es überhaupt
    // etwas zum Eingrenzen gibt.
    const selectable = data.projects.length > 1;
    const project = selectable ? data.projects.find((p) => p.id === selected) ?? null : null;
    const entries = project ? data.entries.filter((e) => e.project_id === project.id) : data.entries;
    const totals = project ? projectTotals(project, entries, costs) : data.totals;
    const withBudget = (project ? [project] : data.projects).filter((p) => p.progress);

    root.innerHTML = html`
        <section class="stack">
            <header class="portal__head card">
                <div>
                    <h1>${data.client.name}</h1>
                    <p class="muted">
                        ${formatDate(data.period.from)} – ${formatDate(data.period.to)}
                        · ${t('portal.asOf', { time: formatDateTime(data.generated_at) })}
                    </p>
                </div>
                <div class="portal__totals">
                    <span class="portal__big">${totals.hhmm}</span>
                    <span class="muted">
                        ${t('portal.hoursInDays', { hours: decimal(totals.decimal), days: data.period.days })}
                    </span>
                    ${costs && totals.amount !== undefined
                        ? html`<span class="portal__amount">${money(totals.amount, data.client.currency)}</span>`
                        : ''}
                    <span class="muted portal__lifetime">
                        ${t('portal.lifetime', { duration: data.lifetime.hhmm })}
                    </span>
                </div>
            </header>

            ${data.projects.length ? html`
                <section class="card">
                    <header class="card__head">
                        <h2>${t('portal.projects')}</h2>
                        ${project
                            ? html`<button class="btn btn--small" data-clear>${t('portal.clearSelection')}</button>`
                            : html`<span class="badge badge--head">${data.projects.length}</span>`}
                    </header>
                    <table class="table table--stats ${selectable ? 'table--clickable' : ''}">
                        <thead>
                            <tr>
                                <th>${t('common.project')}</th>
                                <th class="num">${t('common.hoursHead')}</th>
                                ${costs ? html`<th class="num">${t('common.amount')}</th>` : ''}
                                <th class="num">${t('common.entriesHead')}</th>
                            </tr>
                        </thead>
                        <tbody>${data.projects.map((p) => projectRow(p, costs, selectable))}</tbody>
                    </table>
                    ${selectable ? html`
                        <p class="muted card__body table__hint">${t('portal.selectHint')}</p>` : ''}
                </section>

                <section class="card">
                    <header class="card__head">
                        <h2>${t('portal.history')}</h2>
                        ${project ? html`<span class="badge">${project.name}</span>` : ''}
                    </header>
                    ${dailyChart(project)}
                </section>

                ${withBudget.length ? html`
                    <section class="card">
                        <header class="card__head">
                            <h2>${t('portal.progress')}</h2>
                            <span class="muted">${t('portal.progressHint')}</span>
                        </header>
                        <ul class="budgets">${withBudget.map(budgetRow)}</ul>
                    </section>` : ''}

                <section class="card">
                    <header class="card__head">
                        <h2>${t('portal.recent')}</h2>
                        <span class="badge">${t('portal.inPeriod', { count: entries.length })}</span>
                    </header>
                    <ul class="entrylist">
                        ${entries.slice(0, ENTRY_LIMIT).map((entry) => entryRow(entry, costs))}
                    </ul>
                    ${entries.length > ENTRY_LIMIT ? html`
                        <p class="muted card__body table__hint">
                            ${t('portal.shownOf', { shown: ENTRY_LIMIT, total: entries.length })}
                        </p>` : ''}
                </section>`
            : html`
                <div class="card">
                    <p class="card__body muted">${t('portal.emptyPeriod', { days: data.period.days })}</p>
                </div>`}
        </section>`;

    bindOnce(root, 'Portal', 'click', onClick);
}

function projectRow(project, costs, selectable) {
    const max = Math.max(1, ...data.projects.map((p) => p.minutes));
    const active = project.id === selected;

    return html`
        <tr class="${active ? 'is-selected' : ''}" ${selectable ? { __raw: `data-project="${project.id}"` } : ''}>
            <td>
                <span class="statbar" style="--share:${(project.minutes / max) * 100}%;
                    --bar:${project.color || 'var(--accent)'}"></span>
                ${project.name}
            </td>
            <td class="num">${project.hhmm}</td>
            ${costs ? html`<td class="num">${money(project.amount ?? 0, data.client.currency)}</td>` : ''}
            <td class="num muted">${project.entries}</td>
        </tr>`;
}

/**
 * Ein Balken je Kalendertag, in der Höhe nach Projekten segmentiert.
 *
 * Alle Tage teilen sich die verfügbare Breite, damit der ganze Zeitraum
 * ohne Scrollen sichtbar bleibt. Beschriftet wird nichts – das Datum steht
 * im title-Attribut.
 */
function dailyChart(project) {
    const days = data.days;
    const minutesOf = (day) => (project ? (day.projects[project.id] ?? 0) : day.minutes);

    // Maßstab am dargestellten Ausschnitt, sonst verschwindet ein kleines
    // Projekt neben dem größten Tag des Gesamtzeitraums.
    const max = Math.max(1, ...days.map(minutesOf));

    return html`
        <div class="daychart" style="--rows:${max}">
            ${days.map((day) => {
                const minutes = minutesOf(day);
                const segments = project
                    ? (minutes ? [[project.id, minutes]] : [])
                    : Object.entries(day.projects);

                return html`
                    <div class="daychart__col" title="${dayTitle(day, minutes)}">
                        <span class="daychart__stack" style="height:${(minutes / max) * 100}%">
                            ${segments.map(([id, mins]) => html`
                                <span class="daychart__seg"
                                      style="height:${(mins / (minutes || 1)) * 100}%;
                                             background:${colorOf(Number(id))}"></span>`)}
                        </span>
                    </div>`;
            })}
        </div>`;
}

function dayTitle(day, minutes) {
    const date = formatDate(day.date, true);
    return minutes ? `${date} · ${hhmm(minutes)}` : date;
}

function colorOf(projectId) {
    return data.projects.find((p) => p.id === projectId)?.color || 'var(--accent)';
}

function entryRow(entry, costs) {
    return html`
        <li class="entry">
            <span class="dot" style="background:${colorOf(entry.project_id)}"></span>
            <span class="entry__times">${dayLabel(entry.date)}</span>
            <span class="entry__main">
                <span class="entry__path">${entry.subproject_name}
                    <span class="muted"> · ${entry.project_name}</span></span>
                ${entry.note ? html`<span class="entry__note">${entry.note}</span>` : ''}
            </span>
            <span class="entry__dur">${entry.hhmm}
                ${costs && entry.amount !== undefined
                    ? html`<span class="muted entry__amount">${money(entry.amount, data.client.currency)}</span>`
                    : ''}</span>
        </li>`;
}

function budgetRow(project) {
    const p = project.progress;
    const over = p.percent > 100;

    return html`
        <li class="budgets__item">
            <div class="budgets__head">
                <strong>${project.name}</strong>
                <span class="${over ? 'is-over' : 'muted'}">
                    ${decimal(p.used_hours)} / ${decimal(p.budget_hours)} h (${decimal(p.percent)} %)
                </span>
            </div>
            <span class="progress progress--big">
                <span class="progress__bar ${over ? 'is-over' : ''}"
                      style="width:${Math.min(100, p.percent)}%"></span>
            </span>
            <span class="muted budgets__rest">
                ${over
                    ? t('portal.overBudget', { hours: decimal(Math.abs(p.remaining_hours)) })
                    : t('portal.remaining', { hours: decimal(p.remaining_hours) })}
            </span>
        </li>`;
}

function projectTotals(project, entries, costs) {
    const out = {
        minutes: project.minutes,
        hhmm: project.hhmm,
        decimal: project.decimal,
        entries: entries.length,
    };
    if (costs) out.amount = project.amount ?? 0;
    return out;
}

// -- Verhalten --------------------------------------------------------------

function onClick(event) {
    // Ohne mehrere Projekte gibt es weder das Attribut noch etwas zum
    // Eingrenzen – die Prüfung ist hier nur zur Klarheit.
    if (!data || data.projects.length <= 1) return;

    const root = event.currentTarget;

    if (event.target.closest('[data-clear]')) {
        selected = null;
        return paint(root);
    }

    const row = event.target.closest('[data-project]');
    if (!row) return;

    const id = Number(row.dataset.project);
    // Erneuter Klick auf dasselbe Projekt hebt die Auswahl auf.
    selected = selected === id ? null : id;
    paint(root);
}
