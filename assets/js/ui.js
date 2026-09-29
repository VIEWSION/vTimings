// Wiederverwendete Bausteine: Toasts, Dialoge, Teilprojekt-Auswahl.

import { esc, html } from './util.js';
import { icon } from './icons.js';
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
 *
 * Abbrechen ist immer das ✕ im Kopf (bzw. Esc oder Klick daneben) – einen
 * eigenen Abbrechen-Button gibt es nicht. Ein Button mit `icon` zeigt nur das
 * Symbol, `label` wird dann Tooltip und Screenreader-Text. `align: 'start'`
 * stellt ihn an den linken Rand (z. B. Löschen).
 */
export function dialog({ title, body, buttons = [], onMount }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.innerHTML = html`
            <div class="dialog" role="dialog" aria-modal="true" aria-label="${title}">
                <header class="dialog__head">
                    <h2>${title}</h2>
                    <button class="icon-btn dialog__close" data-close
                            title="${t('common.close')}" aria-label="${t('common.close')}">${icon('close', 20)}</button>
                </header>
                <div class="dialog__body"></div>
                <footer class="dialog__foot"></footer>
            </div>`;

        // Views reichen ihren Inhalt meist als einzelnes <div> herein. Damit
        // der Abstand von .dialog__body auch zwischen dessen Feldern greift,
        // wird der Wrapper selbst zur Spalte (.dialog__content).
        const bodyHost = overlay.querySelector('.dialog__body');
        if (body instanceof Element) {
            body.classList.add('dialog__content');
            bodyHost.append(body);
        } else if (body instanceof Node) bodyHost.append(body);
        else bodyHost.innerHTML = body;

        const foot = overlay.querySelector('.dialog__foot');
        for (const button of buttons) {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = ['btn', button.kind && 'btn--' + button.kind, button.icon && 'btn--icon',
                button.align === 'start' && 'dialog__start'].filter(Boolean).join(' ');
            if (button.icon) {
                el.innerHTML = icon(button.icon, 20).toString();
                el.title = button.label;
                el.setAttribute('aria-label', button.label);
            } else {
                el.textContent = button.label;
            }
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
        if (!buttons.length) foot.remove();

        function close(value) {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(value);
        }
        function onKey(event) {
            // Bei gestapelten Dialogen (z. B. Löschen bestätigen über dem
            // Bearbeiten) schließt Esc nur den obersten.
            if (event.key !== 'Escape') return;
            const overlays = document.querySelectorAll('.overlay');
            if (overlays[overlays.length - 1] === overlay) close(null);
        }

        overlay.addEventListener('click', (event) => {
            // closest(): der Klick trifft meist das <svg> im Button, nicht ihn selbst.
            if (event.target === overlay || event.target.closest('[data-close]')) close(null);
        });
        document.addEventListener('keydown', onKey);
        document.body.append(overlay);

        onMount?.(overlay);
        // Erstes Bedienelement im Inhalt, nicht das ✕ im Kopf – sonst landet
        // z. B. im Teilprojekt-Picker die Eingabe nicht im Suchfeld.
        const first = ':is(input, select, textarea, button):not(:disabled):not([hidden])';
        (bodyHost.querySelector(first) ?? overlay.querySelector(`.dialog__foot ${first}`))?.focus();
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
 * Mit `remove` kommt links ein Löschen-Button dazu. Er fragt nach und
 * schließt den Dialog nur, wenn das Löschen geklappt hat.
 *
 * `actions` sind weitere Aktionen links daneben: `{ key, label, icon, run,
 * confirm }` – `run` läuft nach der optionalen Rückfrage, bei Erfolg
 * schließt der Dialog mit dem `key`.
 *
 * @returns Rückgabe von `save` (bzw. true), 'removed' nach dem Löschen, der
 *          `key` einer Aktion oder null bei Abbruch.
 */
export async function saveDialog({
    title, body, save, saveLabel = t('common.save'), saveIcon = 'check',
    remove = null, removeLabel = t('common.delete'), removeConfirm = null,
    actions = [],
}) {
    let result;

    const buttons = [];
    for (const action of actions) {
        buttons.push({
            label: action.label,
            icon: action.icon,
            align: 'start',
            value: '__action:' + action.key,
            validate: async () => {
                if (action.confirm && !await confirmDialog(action.confirm.title, action.confirm.text,
                    action.label, action.icon)) {
                    return false;
                }
                try {
                    await action.run();
                    return true;
                } catch (error) {
                    toastError(error);
                    return false;
                }
            },
        });
    }
    if (remove) {
        buttons.push({
            label: removeLabel,
            icon: 'trash',
            kind: 'danger',
            align: 'start',
            value: '__removed',
            validate: async () => {
                if (removeConfirm && !await confirmDialog(removeConfirm.title, removeConfirm.text, removeLabel)) {
                    return false;
                }
                try {
                    await remove();
                    return true;
                } catch (error) {
                    toastError(error);
                    return false;
                }
            },
        });
    }
    buttons.push({
        label: saveLabel,
        icon: saveIcon,
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
    });

    const outcome = await dialog({ title, body, buttons });

    if (outcome === '__removed') return 'removed';
    if (typeof outcome === 'string' && outcome.startsWith('__action:')) return outcome.slice(9);
    return outcome === '__saved' ? (result ?? true) : null;
}

export async function confirmDialog(title, message, confirmLabel = t('common.delete'), confirmIcon = 'trash') {
    const result = await dialog({
        title,
        body: html`<p>${message}</p>`,
        buttons: [
            { label: confirmLabel, value: true, kind: 'danger', icon: confirmIcon },
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
            { label: t('common.apply'), value: 'ok', kind: 'primary', icon: 'check' },
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
