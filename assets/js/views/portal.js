// Kundenportal: Fortschritt, Verlauf, Leistungsübersicht – nur lesend.

import { api } from '../api.js';
import { state } from '../store.js';
import { toastError } from '../ui.js';
import { dayLabel, decimal, hhmm, html, money } from '../util.js';

/** Vorgabe: die letzten 100 Tage. 0 bedeutet "ohne Datumsgrenzen". */
const view = { days: 100, projectId: null, showEmpty: false };

const RANGES = [
    [30, '30 Tage'],
    [100, '100 Tage'],
    [365, '1 Jahr'],
    [0, 'Gesamt'],
];

export const portalView = {
    title: 'Übersicht',

    async render(root) {
        root.innerHTML = '<div class="loading">Lade …</div>';

        try {
            const data = await api.get('/portal', {
                days: view.days,
                project_id: view.projectId ?? '',
                client_id: state.user?.role === 'admin' ? previewClientId() : undefined,
            });
            draw(root, data);
        } catch (error) {
            toastError(error);
            root.innerHTML = html`<div class="card"><p class="card__body">${error.message}</p></div>`;
        }
    },
};

function previewClientId() {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    return params.get('client_id') || undefined;
}

function draw(root, data) {
    const costs = data.can_see_costs;
    const withBudget = data.projects.filter((p) => p.progress);
    const selected = data.projects.find((p) => p.id === data.selected_project) ?? null;

    // Balkenlänge relativ zum stärksten Projekt im Zeitraum.
    const maxMinutes = Math.max(1, ...data.projects.map((p) => p.period?.minutes ?? 0));

    // Nach Aufwand sortiert; Projekte ohne Aufwand im Zeitraum sind
    // eingeklappt, sonst besteht die Tabelle überwiegend aus Nullzeilen.
    const sorted = [...data.projects].sort((a, b) =>
        (b.period?.minutes ?? 0) - (a.period?.minutes ?? 0) || a.name.localeCompare(b.name, 'de'));
    const active = sorted.filter((p) => (p.period?.minutes ?? 0) > 0 || p.id === data.selected_project);
    const idle = sorted.filter((p) => !active.includes(p));

    root.innerHTML = html`
        <section class="stack">
            <header class="portal__head card">
                <div>
                    <h1>${data.client.name}</h1>
                    <p class="muted">Stand ${new Date(data.generated_at).toLocaleString('de-DE')}</p>
                </div>
                <div class="portal__totals">
                    <span class="portal__big">${data.period.totals.hhmm}</span>
                    <span class="muted">${rangeLabel(data.period)}</span>
                    ${costs && data.period.totals.amount !== undefined
                        ? html`<span class="portal__amount">${money(data.period.totals.amount, data.client.currency)}</span>`
                        : ''}
                    <span class="muted portal__lifetime">
                        insgesamt ${data.lifetime.hhmm}${costs && data.lifetime.amount !== undefined
                            ? ` · ${money(data.lifetime.amount, data.client.currency)}` : ''}
                    </span>
                </div>
            </header>

            <div class="chips portal__ranges">
                ${RANGES.map(([days, label]) => html`
                    <button class="chip ${view.days === days ? 'is-active' : ''}" data-days="${days}">${label}</button>`)}
            </div>

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
                    <h2>Projekte</h2>
                    ${selected
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
                    <tbody>
                        ${active.length
                            ? active.map((project) => projectRow(project, maxMinutes, costs, data))
                            : html`<tr><td colspan="4" class="muted">Im gewählten Zeitraum wurde nichts erfasst.</td></tr>`}
                        ${view.showEmpty ? idle.map((project) => projectRow(project, maxMinutes, costs, data)) : ''}
                    </tbody>
                </table>
                ${idle.length ? html`
                    <button class="btn btn--ghost btn--small table__more" data-toggle-empty>
                        ${view.showEmpty
                            ? 'Projekte ohne Aufwand ausblenden'
                            : `${idle.length} weitere Projekte ohne Aufwand im Zeitraum`}
                    </button>` : ''}
                <p class="muted card__body table__hint">Projekt anklicken, um Verlauf und Leistungen darauf einzugrenzen.</p>
            </section>

            ${data.by_month.length ? html`
                <section class="card">
                    <header class="card__head">
                        <h2>Verlauf</h2>
                        ${selected ? html`<span class="badge">${selected.name}</span>` : ''}
                    </header>
                    ${sparkline(data.by_month)}
                </section>` : ''}

            <section class="card">
                <header class="card__head">
                    <h2>Letzte Leistungen</h2>
                    <span class="badge">${data.entries_total} im Zeitraum</span>
                </header>
                ${data.entries.length ? html`
                    <ul class="entrylist">${data.entries.map((entry) => entryRow(entry, costs, data))}</ul>`
                    : '<p class="muted card__body">Im gewählten Zeitraum wurde nichts erfasst.</p>'}
            </section>

            <div class="portal__actions">
                <button class="btn" id="portal-print">Leistungsnachweis öffnen</button>
            </div>
        </section>`;

    bind(root, data);
}

function projectRow(project, maxMinutes, costs, data) {
    const period = project.period;
    const minutes = period?.minutes ?? 0;
    const active = project.id === data.selected_project;

    return html`
        <tr class="${active ? 'is-selected' : ''} ${minutes ? '' : 'is-empty'}" data-project="${project.id}">
            <td>
                <span class="statbar" style="--share:${(minutes / maxMinutes) * 100}%;
                    --bar:${project.color || 'var(--accent)'}"></span>
                ${project.name}
            </td>
            <td class="num">${period?.hhmm ?? '00:00'}</td>
            ${costs ? html`<td class="num">${money(period?.amount ?? 0, data.client.currency)}</td>` : ''}
            <td class="num muted">${period?.entries ?? 0}</td>
        </tr>`;
}

function entryRow(entry, costs, data) {
    return html`
        <li class="entry">
            <span class="dot" style="background:${entry.color || 'var(--border)'}"></span>
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
                    ${decimal(p.used_hours)} / ${decimal(p.budget_hours)} h
                    (${decimal(p.percent)} %)
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

function rangeLabel(period) {
    if (period.days === 0 || (!period.from && !period.to)) return 'Stunden gesamt';
    if (period.days) return `Stunden in ${period.days} Tagen`;
    return 'Stunden im Zeitraum';
}

// -- Verhalten --------------------------------------------------------------

function bind(root, data) {
    root.addEventListener('click', (event) => {
        const range = event.target.closest('[data-days]');
        if (range) {
            view.days = Number(range.dataset.days);
            return portalView.render(root);
        }

        if (event.target.closest('[data-clear]')) {
            view.projectId = null;
            return portalView.render(root);
        }

        if (event.target.closest('[data-toggle-empty]')) {
            view.showEmpty = !view.showEmpty;
            return portalView.render(root);
        }

        const row = event.target.closest('[data-project]');
        if (row) {
            const id = Number(row.dataset.project);
            // Erneuter Klick auf dasselbe Projekt hebt die Auswahl auf.
            view.projectId = view.projectId === id ? null : id;
            return portalView.render(root);
        }
    });

    root.querySelector('#portal-print').addEventListener('click', () => {
        window.open(api.url('/report', {
            client_id: data.client.id,
            project_id: view.projectId ?? '',
            from: data.period.from ?? '',
            to: data.period.to ?? '',
            costs: data.can_see_costs ? 1 : 0,
            notes: 1,
        }), '_blank', 'noopener');
    });
}

/** Balkenverlauf über die Monate – ohne Bibliothek, reines CSS. */
function sparkline(months) {
    const ordered = fillMonthGaps([...months].reverse());
    const max = Math.max(...ordered.map((m) => m.minutes)) || 1;

    return html`
        <div class="spark">
            ${ordered.map((month) => html`
                <div class="spark__col" title="${month.label}: ${hhmm(month.minutes)}">
                    <span class="spark__bar" style="height:${month.minutes ? Math.max(3, (month.minutes / max) * 100) : 1}%"></span>
                    <span class="spark__label">${month.key.slice(5)}<span class="spark__year">${month.key.slice(2, 4)}</span></span>
                </div>`)}
        </div>`;
}

/**
 * Monate ohne Buchung ergänzen. Ohne das stünden drei weit auseinander
 * liegende Monate nebeneinander und der Verlauf läse sich wie eine
 * durchgehende Reihe.
 */
function fillMonthGaps(months) {
    if (months.length < 2) return months;

    const out = [];
    const [startY, startM] = months[0].key.split('-').map(Number);
    const last = months[months.length - 1].key;
    const known = new Map(months.map((m) => [m.key, m]));

    let year = startY;
    let month = startM;
    // Sicherheitsgrenze: mehr als 10 Jahre Lücke zeichnen wir nicht aus.
    for (let i = 0; i < 120; i++) {
        const key = `${year}-${String(month).padStart(2, '0')}`;
        out.push(known.get(key) ?? { key, label: key, minutes: 0, hhmm: '00:00' });
        if (key === last) break;
        month = month === 12 ? (year++, 1) : month + 1;
    }
    return out;
}
