// Startseite: laufende Timer, Schnellwahl, Tagesübersicht.

import { api, ApiError } from '../api.js';
import { state, loadTimers, loadRecent, invalidateTree } from '../store.js';
import { bindOnce, dialog, pickSubproject, toast, toastError, confirmDialog } from '../ui.js';
import { clock, esc, hhmm, html, money, todayISO, dayLabel, localISO } from '../util.js';

let ticker = null;

export const timerView = {
    title: 'Timer',

    async render(root) {
        root.innerHTML = '<div class="loading">Lade …</div>';

        const [, , today] = await Promise.all([
            loadTimers(),
            loadRecent(),
            api.get('/entries', { from: todayISO(), to: todayISO(), group: 'day', limit: 200 }),
        ]);

        root.innerHTML = html`
            <section class="stack">
                <div id="running"></div>
                <section class="card">
                    <header class="card__head">
                        <h2>Schnellwahl</h2>
                        <button class="btn btn--ghost" id="pick-other">Anderes Projekt …</button>
                    </header>
                    <ul class="quicklist">${state.recent.map(quickItem)}</ul>
                </section>
                <section class="card">
                    <header class="card__head">
                        <h2>${dayLabel(todayISO())}</h2>
                        <span class="badge">${today.totals.hhmm}${today.totals.amount !== undefined
                            ? ` · ${money(today.totals.amount)}` : ''}</span>
                    </header>
                    ${today.days.length
                        ? html`<ul class="entrylist">${today.days[0].entries.map(entryRow)}</ul>`
                        : '<p class="muted card__body">Heute noch nichts erfasst.</p>'}
                </section>
            </section>`;

        drawRunning(root);
        bind(root);
        startTicking(root);
    },

    destroy() {
        stopTicking();
    },
};

// -- Darstellung ------------------------------------------------------------

function quickItem(sub) {
    return html`
        <li>
            <button class="quick" data-start="${sub.id}">
                <span class="dot" style="background:${sub.color || 'var(--border)'}"></span>
                <span class="quick__text">
                    <strong>${sub.name}</strong>
                    <span class="muted">${sub.client_name} · ${sub.project_name}</span>
                </span>
                <span class="quick__go" aria-hidden="true">▶</span>
            </button>
        </li>`;
}

function entryRow(entry) {
    return html`
        <li class="entry">
            <span class="dot" style="background:${entry.color || 'var(--border)'}"></span>
            <span class="entry__times">${entry.start_time}–${entry.end_time}</span>
            <span class="entry__main">
                <span class="entry__path">${entry.subproject_name}<span class="muted"> · ${entry.client_name}</span></span>
                ${entry.note ? html`<span class="entry__note">${entry.note}</span>` : ''}
            </span>
            <span class="entry__dur">${entry.hhmm}</span>
        </li>`;
}

function drawRunning(root) {
    const host = root.querySelector('#running');
    if (!host) return;

    if (!state.timers.length) {
        host.innerHTML = html`
            <div class="card card--idle">
                <p class="muted">Kein Timer läuft.</p>
                <button class="btn btn--primary btn--big" id="start-any">Aufzeichnung starten</button>
            </div>`;
        return;
    }

    host.innerHTML = state.timers.map((timer) => html`
        <div class="card card--running" style="--accent-color:${timer.color || 'var(--accent)'}">
            <div class="running__head">
                <span class="running__path">
                    <strong>${timer.subproject_name}</strong>
                    <span class="muted">${timer.client_name} · ${timer.project_name}</span>
                </span>
                <button class="icon-btn" data-edit-timer="${timer.id}" title="Timer bearbeiten">✎</button>
            </div>
            <div class="running__clock" data-since="${timer.started_at}">${clock(timer.elapsed_sec)}</div>
            <div class="running__meta muted">seit ${timer.start_time}${timer.note ? ' · ' + timer.note : ''}</div>
            <div class="running__actions">
                <button class="btn btn--primary btn--big" data-stop="${timer.id}">Stoppen</button>
                <button class="btn btn--ghost" data-discard="${timer.id}">Verwerfen</button>
            </div>
        </div>`).join('');
}

// -- Verhalten --------------------------------------------------------------

function bind(root) {
    // Die Ansicht baut sich nach jedem Stoppen neu auf, der Wirt bleibt aber
    // derselbe – deshalb nur einmal binden.
    bindOnce(root, 'Timer', 'click', async (event) => {
        const start = event.target.closest('[data-start]');
        if (start) return startTimer(root, Number(start.dataset.start));

        if (event.target.closest('#start-any, #pick-other')) {
            const id = await pickSubproject({ title: 'Womit fängst du an?' });
            if (id) await startTimer(root, id);
            return;
        }

        const stop = event.target.closest('[data-stop]');
        if (stop) return stopTimer(root, Number(stop.dataset.stop));

        const discard = event.target.closest('[data-discard]');
        if (discard) return discardTimer(root, Number(discard.dataset.discard));

        const edit = event.target.closest('[data-edit-timer]');
        if (edit) return editTimer(root, Number(edit.dataset.editTimer));
    });
}

async function startTimer(root, subprojectId, onConflict) {
    try {
        await api.post('/timer/start', { subproject_id: subprojectId, on_conflict: onConflict });
        await loadTimers();
        drawRunning(root);
        startTicking(root);
    } catch (error) {
        if (error instanceof ApiError && error.code === 'timer_running') {
            const running = error.details.running?.[0];
            const choice = await dialog({
                title: 'Es läuft bereits ein Timer',
                body: html`<p><strong>${running?.subproject_name}</strong><br>
                    <span class="muted">${running?.client_name} · seit ${running?.start_time}</span></p>
                    <p>Was soll damit passieren?</p>`,
                buttons: [
                    { label: 'Abbrechen', value: null },
                    { label: 'Parallel laufen lassen', value: 'parallel' },
                    { label: 'Stoppen und neu starten', value: 'stop', kind: 'primary' },
                ],
            });
            if (choice) await startTimer(root, subprojectId, choice);
            return;
        }
        toastError(error);
    }
}

async function stopTimer(root, id) {
    const timer = state.timers.find((t) => t.id === id);

    const node = document.createElement('div');
    node.innerHTML = html`
        <p class="muted">${timer?.path} · ${timer?.elapsed_hhmm}</p>
        <label class="field">
            <span class="field__label">Was hast du gemacht?</span>
            <textarea class="input" name="note" rows="5"
                placeholder="Stichpunkte …">${timer?.note || ''}</textarea>
        </label>`;

    const result = await dialog({
        title: 'Aufzeichnung beenden',
        body: node,
        buttons: [
            { label: 'Weiterlaufen lassen', value: null },
            { label: 'Stoppen', value: 'stop', kind: 'primary' },
        ],
    });
    if (result !== 'stop') return;

    try {
        const data = await api.post(`/timer/${id}/stop`, { note: node.querySelector('[name=note]').value });
        await loadTimers();
        await loadRecent();
        invalidateTree();

        if (data.discarded) {
            toast('Zu kurz – nach der Rundung blieb nichts übrig. Kein Eintrag angelegt.', 'info');
        } else {
            toast(`Gespeichert: ${hhmm(data.entry.duration_min)}`, 'ok');
        }
        await timerView.render(root);
    } catch (error) {
        toastError(error);
    }
}

async function discardTimer(root, id) {
    if (!await confirmDialog('Timer verwerfen', 'Die bisher gelaufene Zeit wird nicht gespeichert.', 'Verwerfen')) return;
    try {
        await api.delete(`/timer/${id}`);
        await loadTimers();
        drawRunning(root);
    } catch (error) {
        toastError(error);
    }
}

async function editTimer(root, id) {
    const timer = state.timers.find((t) => t.id === id);
    if (!timer) return;

    const startTime = timer.start_time;
    const node = document.createElement('div');
    node.innerHTML = html`
        <label class="field">
            <span class="field__label">Begonnen um</span>
            <input class="input" type="time" name="start" value="${startTime}" step="60">
        </label>
        <label class="field">
            <span class="field__label">Notiz</span>
            <textarea class="input" name="note" rows="3">${timer.note}</textarea>
        </label>
        <button class="btn btn--ghost" type="button" data-change-project>Teilprojekt wechseln …</button>`;

    let newSubproject = null;
    node.querySelector('[data-change-project]').addEventListener('click', async () => {
        const picked = await pickSubproject({ current: timer.subproject_id });
        if (picked) {
            newSubproject = picked;
            toast('Teilprojekt wird beim Speichern gewechselt.', 'info', 2500);
        }
    });

    const result = await dialog({
        title: 'Timer anpassen',
        body: node,
        buttons: [
            { label: 'Abbrechen', value: null },
            { label: 'Speichern', value: 'save', kind: 'primary' },
        ],
    });
    if (result !== 'save') return;

    const time = node.querySelector('[name=start]').value;
    const payload = { note: node.querySelector('[name=note]').value };
    if (newSubproject) payload.subproject_id = newSubproject;
    if (time && time !== startTime) {
        const [hh, mm] = time.split(':').map(Number);
        const started = new Date(timer.started_at);
        started.setHours(hh, mm, 0, 0);
        payload.started_at = localISO(started);
    }

    try {
        await api.patch(`/timer/${id}`, payload);
        await loadTimers();
        drawRunning(root);
        startTicking(root);
    } catch (error) {
        toastError(error);
    }
}

// -- Laufende Uhr -----------------------------------------------------------

function startTicking(root) {
    stopTicking();
    if (!state.timers.length) return;

    ticker = setInterval(() => {
        for (const el of root.querySelectorAll('[data-since]')) {
            const seconds = (Date.now() - new Date(el.dataset.since).getTime()) / 1000;
            el.textContent = clock(seconds);
        }
    }, 1000);
}

function stopTicking() {
    if (ticker) clearInterval(ticker);
    ticker = null;
}
