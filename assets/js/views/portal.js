// Kundenportal: Fortschritt, Verlauf, Leistungsübersicht – nur lesend.

import { api } from '../api.js';
import { state } from '../store.js';
import { toastError } from '../ui.js';
import { dayLabel, decimal, html, money, todayISO } from '../util.js';

const filters = { from: '', to: '' };

export const portalView = {
    title: 'Übersicht',

    async render(root) {
        root.innerHTML = '<div class="loading">Lade …</div>';

        try {
            const data = await api.get('/portal', {
                ...filters,
                client_id: state.user?.role === 'admin' ? previewClientId() : undefined,
            });
            draw(root, data);
        } catch (error) {
            toastError(error);
            root.innerHTML = html`
                <div class="card"><p class="card__body">${error.message}</p></div>`;
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

    root.innerHTML = html`
        <section class="stack">
            <header class="portal__head card">
                <div>
                    <h1>${data.client.name}</h1>
                    <p class="muted">Stand ${new Date(data.generated_at).toLocaleString('de-DE')}</p>
                </div>
                <div class="portal__totals">
                    <span class="portal__big">${data.lifetime.hhmm}</span>
                    <span class="muted">${decimal(data.lifetime.decimal)} Stunden gesamt</span>
                    ${costs && data.lifetime.amount !== undefined
                        ? html`<span class="portal__amount">${money(data.lifetime.amount, data.client.currency)}</span>`
                        : ''}
                </div>
            </header>

            ${withBudget.length ? html`
                <section class="card">
                    <header class="card__head"><h2>Projektfortschritt</h2></header>
                    <ul class="budgets">
                        ${withBudget.map(budgetRow)}
                    </ul>
                </section>` : ''}

            <section class="card">
                <header class="card__head">
                    <h2>Projekte</h2>
                    <span class="badge">${data.projects.length}</span>
                </header>
                <table class="table table--stats">
                    <thead>
                        <tr>
                            <th>Projekt</th>
                            <th class="num">Stunden</th>
                            ${costs ? html`<th class="num">Betrag</th>` : ''}
                            <th class="num">Einträge</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.projects.map((project) => html`
                            <tr>
                                <td>
                                    <span class="dot" style="background:${project.color || 'var(--border)'}"></span>
                                    ${project.name}
                                </td>
                                <td class="num">${project.stats?.hhmm ?? '00:00'}</td>
                                ${costs ? html`<td class="num">${money(project.stats?.amount ?? 0, data.client.currency)}</td>` : ''}
                                <td class="num muted">${project.stats?.entries ?? 0}</td>
                            </tr>`)}
                    </tbody>
                </table>
            </section>

            ${data.by_month.length ? html`
                <section class="card">
                    <header class="card__head"><h2>Verlauf</h2></header>
                    ${sparkline(data.by_month)}
                </section>` : ''}

            <section class="card">
                <header class="card__head">
                    <h2>Letzte Leistungen</h2>
                    <span class="badge">${data.entries_total} gesamt</span>
                </header>
                <ul class="entrylist">
                    ${data.entries.map((entry) => html`
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
                        </li>`)}
                </ul>
            </section>

            <div class="portal__actions">
                <button class="btn" id="portal-print">Leistungsnachweis öffnen</button>
            </div>
        </section>`;

    root.querySelector('#portal-print').addEventListener('click', () => {
        window.open(api.url('/report', {
            client_id: data.client.id,
            costs: costs ? 1 : 0,
            notes: 1,
        }), '_blank', 'noopener');
    });
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

/** Balkenverlauf über die Monate – ohne Bibliothek, reines CSS. */
function sparkline(months) {
    const ordered = fillMonthGaps([...months].reverse());
    const max = Math.max(...ordered.map((m) => m.minutes)) || 1;

    return html`
        <div class="spark">
            ${ordered.map((month) => html`
                <div class="spark__col" title="${month.label}: ${month.hhmm}">
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
