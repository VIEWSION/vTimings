// Wiederverwendete Bausteine: Toasts, Dialoge, Teilprojekt-Auswahl.

import { esc, html } from './util.js';
import { flatSubprojects, loadTree } from './store.js';

// -- Meldungen --------------------------------------------------------------

export function toast(message, kind = 'info', timeout = 4000) {
    let host = document.querySelector('.toasts');
    if (!host) {
        host = document.createElement('div');
        host.className = 'toasts';
        document.body.append(host);
    }

    const node = document.createElement('div');
    node.className = `toast toast--${kind}`;
    node.textContent = message;
    node.addEventListener('click', () => node.remove());
    host.append(node);

    if (timeout) setTimeout(() => node.remove(), timeout);
}

export function toastError(error) {
    const fields = error?.fields ? Object.values(error.fields) : [];
    toast(fields.length ? `${error.message} ${fields.join(' ')}` : (error?.message || 'Fehler'), 'error', 7000);
}

// -- Dialoge ----------------------------------------------------------------

/**
 * Modaler Dialog. `render` liefert das Innere, `buttons` die Aktionen.
 * Auflösung mit dem Wert des geklickten Buttons (null bei Abbruch).
 */
export function dialog({ title, body, buttons = [], onMount }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.innerHTML = html`
            <div class="dialog" role="dialog" aria-modal="true" aria-label="${title}">
                <header class="dialog__head">
                    <h2>${title}</h2>
                    <button class="icon-btn" data-close aria-label="Schließen">✕</button>
                </header>
                <div class="dialog__body"></div>
                <footer class="dialog__foot"></footer>
            </div>`;

        const bodyHost = overlay.querySelector('.dialog__body');
        if (body instanceof Node) bodyHost.append(body);
        else bodyHost.innerHTML = body;

        const foot = overlay.querySelector('.dialog__foot');
        for (const button of buttons) {
            const el = document.createElement('button');
            el.className = `btn ${button.kind ? 'btn--' + button.kind : ''}`;
            el.textContent = button.label;
            el.addEventListener('click', async () => {
                if (button.validate) {
                    const ok = await button.validate(overlay);
                    if (ok === false) return;
                }
                close(button.value ?? button.label);
            });
            foot.append(el);
        }

        function close(value) {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(value);
        }
        function onKey(event) {
            if (event.key === 'Escape') close(null);
        }

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay || event.target.hasAttribute('data-close')) close(null);
        });
        document.addEventListener('keydown', onKey);
        document.body.append(overlay);

        onMount?.(overlay);
        overlay.querySelector('input, select, textarea, button')?.focus();
    });
}

export async function confirmDialog(title, message, confirmLabel = 'Löschen') {
    const result = await dialog({
        title,
        body: html`<p>${message}</p>`,
        buttons: [
            { label: 'Abbrechen', value: false },
            { label: confirmLabel, value: true, kind: 'danger' },
        ],
    });
    return result === true;
}

// -- Teilprojekt-Auswahl ----------------------------------------------------

/**
 * Durchsuchbare Auswahl über Kunde | Projekt | Teilprojekt.
 * Liefert die gewählte Teilprojekt-ID oder null.
 */
export async function pickSubproject({ title = 'Teilprojekt wählen', current = null } = {}) {
    await loadTree();
    const all = flatSubprojects();

    const node = document.createElement('div');
    node.className = 'picker';
    node.innerHTML = html`
        <input class="input picker__search" type="search" placeholder="Suchen …" autocomplete="off">
        <ul class="picker__list"></ul>`;

    const search = node.querySelector('.picker__search');
    const list = node.querySelector('.picker__list');
    let selected = current;

    function draw() {
        const needle = search.value.trim().toLowerCase();
        const matches = (needle
            ? all.filter((s) => `${s.client_name} ${s.project_name} ${s.name}`.toLowerCase().includes(needle))
            : all
        ).slice(0, 300);

        list.innerHTML = matches.length
            ? matches.map((sub) => html`
                <li>
                    <button class="picker__item ${sub.id === selected ? 'is-selected' : ''}" data-id="${sub.id}">
                        <span class="dot" style="background:${sub.color || 'var(--border)'}"></span>
                        <span class="picker__path">
                            <span class="picker__client">${sub.client_name}</span>
                            <span class="picker__project">${sub.project_name}</span>
                            <strong>${sub.name}</strong>
                        </span>
                        <span class="picker__rate">${sub.effective_rate} €</span>
                    </button>
                </li>`).join('')
            : '<li class="picker__empty">Kein Treffer.</li>';
    }

    search.addEventListener('input', draw);
    list.addEventListener('click', (event) => {
        const button = event.target.closest('[data-id]');
        if (!button) return;
        selected = Number(button.dataset.id);
        draw();
        node.closest('.overlay')?.querySelector('.dialog__foot .btn--primary')?.click();
    });
    draw();

    const result = await dialog({
        title,
        body: node,
        buttons: [
            { label: 'Abbrechen', value: null },
            { label: 'Übernehmen', value: 'ok', kind: 'primary' },
        ],
    });

    return result === 'ok' ? selected : null;
}

// -- Formular-Helfer --------------------------------------------------------

export function field(label, inputHtml, hint = '') {
    return html`
        <label class="field">
            <span class="field__label">${label}</span>
            ${{ __raw: inputHtml }}
            ${hint ? { __raw: `<span class="field__hint">${esc(hint)}</span>` } : ''}
        </label>`;
}

export function values(root) {
    const out = {};
    for (const el of root.querySelectorAll('[name]')) {
        out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return out;
}
