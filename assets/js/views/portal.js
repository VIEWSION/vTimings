// Kundenportal: die letzten 100 Tage – Projekte, Tagesverlauf, Leistungen.
//
// Die Antwort der API enthält bereits die Tageswerte je Projekt. Das
// Umschalten auf ein einzelnes Projekt zeichnet deshalb nur neu und holt
// nichts nach.

import { api } from '../api.js';
import { state } from '../store.js';
import { bindOnce, toastError } from '../ui.js';
import { dayLabel, decimal, hhmm, html, money } from '../util.js';

const ENTRY_LIMIT = 25;

let data = null;
let selected = null;

export const portalView = {
    title: 'Übersicht',

    async render(root) {
        root.innerHTML = '<div class="loading">Lade …</div>';

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
    const project = data.projects.find((p) => p.id === selected) ?? null;
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
                        · Stand ${new Date(data.generated_at).toLocaleString('de-DE')}
                    </p>
                </div>
                <div class="portal__totals">
                    <span class="portal__big">${totals.hhmm}</span>
                    <span class="muted">${decimal(totals.decimal)} Stunden in ${data.period.days} Tagen</span>
                    ${costs && totals.amount !== undefined
                        ? html`<span class="portal__amount">${money(totals.amount, data.client.currency)}</span>`
                        : ''}
                    <span class="muted portal__lifetime">insgesamt ${data.lifetime.hhmm}</span>
                </div>
            </header>

            ${data.projects.length ? html`
                <section class="card">
                    <header class="card__head">
                        <h2>Projekte</h2>
                        ${project
                            ? html`<button class="btn btn--small" data-clear>Auswahl aufheben</button>`
                            : html`<span class="badge">${data.projects.length}</span>`}
                    </header>
                    <table class="table table--stats table--clickable">
                        <thead>
                            <tr>
                                <th>Projekt</th>
                                <th class="num">Stunden</th>
                                ${costs ? html`<th class="num">Betrag</th>` : ''}
                                <th class="num">Einträge</th>
                            </tr>
                        </thead>
                        <tbody>${data.projects.map((p) => projectRow(p, costs))}</tbody>
                    </table>
                    <p class="muted card__body table__hint">
                        Projekt anklicken, um Verlauf und Leistungen darauf einzugrenzen.
                    </p>
                </section>

                <section class="card">
                    <header class="card__head">
                        <h2>Verlauf</h2>
                        ${project ? html`<span class="badge">${project.name}</span>` : ''}
                    </header>
                    ${dailyChart(project)}
                </section>

                ${withBudget.length ? html`
                    <section class="card">
                        <header class="card__head">
                            <h2>Projektfortschritt</h2>
                            <span class="muted">gesamter Verbrauch</span>
                        </header>
                        <ul class="budgets">${withBudget.map(budgetRow)}</ul>
                    </section>` : ''}

                <section class="card">
                    <header class="card__head">
                        <h2>Letzte Leistungen</h2>
                        <span class="badge">${entries.length} im Zeitraum</span>
                    </header>
                    <ul class="entrylist">
                        ${entries.slice(0, ENTRY_LIMIT).map((entry) => entryRow(entry, costs))}
                    </ul>
                    ${entries.length > ENTRY_LIMIT ? html`
                        <p class="muted card__body table__hint">
                            Zeigt die ${ENTRY_LIMIT} jüngsten von ${entries.length} Einträgen.
                            Die vollständige Liste steht unter „Leistungen“.
                        </p>` : ''}
                </section>`
            : html`
                <div class="card">
                    <p class="card__body muted">
                        In den letzten ${data.period.days} Tagen wurde nichts erfasst.
                    </p>
                </div>`}
        </section>`;

    bindOnce(root, 'Portal', 'click', onClick);
}

function projectRow(project, costs) {
    const max = Math.max(1, ...data.projects.map((p) => p.minutes));
    const active = project.id === selected;

    return html`
        <tr class="${active ? 'is-selected' : ''}" data-project="${project.id}">
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
                    ? `${decimal(Math.abs(p.remaining_hours))} h über Budget`
                    : `${decimal(p.remaining_hours)} h verbleiben`}
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

function formatDate(iso, weekday = false) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('de-DE',
        weekday ? { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }
                : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// -- Verhalten --------------------------------------------------------------

function onClick(event) {
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
