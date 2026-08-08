// Wiederverwendete Bausteine: Toasts, Dialoge, Teilprojekt-Auswahl.

import { esc, html } from './util.js';
import { t } from './i18n.js';
import { flatSubprojects, loadTree } from './store.js';

/**
 * Hängt einen Handler genau einmal an ein Element.
 *
 * Ansichten, die sich selbst neu zeichnen, ersetzen zwar ihren Inhalt, nicht
 * aber den Wirt. Ohne diese Sperre sammelt sich pro Durchlauf ein weiterer
 * Handler an, und ein Klick löst die Aktion vervielfacht aus.
 */
export function bindOnce(root, key, type, handler) {
    const flag = 'bound' + key;
    if (root.dataset[flag] === '1') return;
    root.dataset[flag] = '1';
    root.addEventListener(type, handler);
}

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
    toast(fields.length ? `${error.message} ${fields.join(' ')}` : (error?.message || t('common.error')), 'error', 7000);
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
                    <button class="icon-btn" data-close aria-label="${t('common.close')}">✕</button>
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
                    // Während des Speicherns sperren, sonst löst ein zweiter
                    // Klick denselben Vorgang noch einmal aus.
                    el.disabled = true;
                    try {
                        const ok = await button.validate(overlay);
                        if (ok === false) return;
                    } finally {
                        el.disabled = false;
                    }
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

/**
 * Zeigt Feldfehler aus einer 422 direkt am betroffenen Eingabefeld.
 *
 * @returns {boolean} true, wenn jeder gemeldete Fehler ein Feld gefunden hat.
 *                    Nur dann ist die Meldung im Dialog vollständig – sonst
 *                    braucht es zusätzlich einen Toast.
 */
export function showFieldErrors(root, error) {
    for (const el of root.querySelectorAll('.field__error')) el.remove();
    for (const el of root.querySelectorAll('.is-invalid')) el.classList.remove('is-invalid');

    const fields = error?.fields ?? {};
    const names = Object.keys(fields);
    let placed = 0;

    for (const name of names) {
        const input = root.querySelector(`[name="${CSS.escape(name)}"]`);
        if (!input) continue;

        input.classList.add('is-invalid');
        const hint = document.createElement('span');
        hint.className = 'field__error';
        hint.textContent = fields[name];
        (input.closest('.field') ?? input.parentElement)?.append(hint);

        if (placed === 0) {
            input.focus();
            input.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        placed++;
    }

    return names.length > 0 && placed === names.length;
}

/**
 * Dialog mit Speichern-Aktion.
 *
 * Anders als beim einfachen dialog() bleibt das Fenster bei einem Fehler
 * offen und die Eingaben stehen – der Fehler erscheint am jeweiligen Feld.
 * Geschlossen wird erst, wenn `save` ohne Ausnahme durchläuft.
 *
 * @returns Rückgabe von `save` (bzw. true) oder null bei Abbruch.
 */
export async function saveDialog({ title, body, save, saveLabel = t('common.save'), cancelLabel = t('common.cancel') }) {
    let result;

    const outcome = await dialog({
        title,
        body,
        buttons: [
            { label: cancelLabel, value: null },
            {
                label: saveLabel,
                value: '__saved',
                kind: 'primary',
                validate: async (overlay) => {
                    try {
                        result = await save(overlay);
                        return true;
                    } catch (error) {
                        const complete = showFieldErrors(overlay, error);
                        if (!complete) toastError(error);
                        return false;
                    }
                },
            },
        ],
    });

    return outcome === '__saved' ? (result ?? true) : null;
}

export async function confirmDialog(title, message, confirmLabel = t('common.delete')) {
    const result = await dialog({
        title,
        body: html`<p>${message}</p>`,
        buttons: [
            { label: t('common.cancel'), value: false },
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
export async function pickSubproject({ title = t('picker.title'), current = null } = {}) {
    await loadTree();
    const all = flatSubprojects();

    const node = document.createElement('div');
    node.className = 'picker';
    node.innerHTML = html`
        <input class="input picker__search" type="search" placeholder="${t('common.searchPlaceholder')}" autocomplete="off">
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
            : html`<li class="picker__empty">${t('common.noMatch')}</li>`;
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
            { label: t('common.cancel'), value: null },
            { label: t('common.apply'), value: 'ok', kind: 'primary' },
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
