// Kleiner Knopf zum Leeren neben der Beschriftung eines Feldes – für
// Datumsfelder (dates.js), Auswahlfelder (combo.js) und Textfelder.
// Opt-in über `data-clearable` am Feld; es muss in einem `.field`-Label
// stehen, sonst bleibt es ohne Knopf. Der Knopf erscheint nur, wenn etwas
// drinsteht.

import { t } from './i18n.js';
import { icon } from './icons.js';

/**
 * Hängt den Knopf an das Label des Feldes. `isEmpty()` sagt, ob schon alles
 * leer ist, `clear()` leert. Liefert die Funktion, die die Sichtbarkeit
 * nachzieht; sie steht auch als `control._clearSync` bereit.
 */
export function attachClear(control, { isEmpty, clear }) {
    const field = control.closest('.field');
    if (!field) return () => {};

    const label = field.querySelector('.field__label');
    if (!label) return () => {};

    field.classList.add('field--clearable');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'field__clear';
    button.title = t('common.clear');
    button.setAttribute('aria-label', t('common.clear'));
    button.innerHTML = icon('close', 12);
    label.append(button); // gleich hinter den Namen des Feldes

    // Gesetzter Filter: Beschriftung und Rahmen treten hervor (siehe CSS).
    const sync = () => {
        const empty = isEmpty();
        button.hidden = empty || control.disabled;
        field.classList.toggle('is-filled', !empty && !control.disabled);
    };
    button.addEventListener('click', clear);

    control._clearSync = sync;
    new MutationObserver(sync).observe(control, { attributes: true, attributeFilter: ['disabled'] });
    sync();
    return sync;
}

/**
 * Programmatisch gesetzte Werte (Filter zurücksetzen) lösen kein Ereignis aus –
 * deshalb den Setter von `value` an der Instanz abfangen.
 */
export function watchValue(element, callback) {
    const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    Object.defineProperty(element, 'value', {
        get() { return proto.get.call(this); },
        set(v) { proto.set.call(this, v); callback(); },
        configurable: true,
    });
}

const fire = (element) => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
};

/** Text-/Suchfelder und Auswahlfelder (auch die mit combo.js) mit `data-clearable`. */
export function enhanceClearables(root) {
    const fields = 'input[data-clearable]:not([type=date]):not([data-clear-ready]), select[data-clearable]:not([data-clear-ready])';
    for (const element of root.querySelectorAll(fields)) {
        element.dataset.clearReady = '1';

        if (element.tagName === 'SELECT') {
            const isEmpty = () => (element.multiple ? element.selectedOptions.length === 0 : element.value === '');
            const sync = attachClear(element, {
                isEmpty,
                clear() {
                    if (element.multiple) for (const option of element.options) option.selected = false;
                    else element.value = '';
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    element.comboSync?.();
                },
            });
            element.addEventListener('change', sync);
            if (!element.comboSync) watchValue(element, sync); // die Combo meldet sich selbst
        } else {
            const sync = attachClear(element, {
                isEmpty: () => element.value === '',
                clear() {
                    element.value = '';
                    fire(element);
                    element.focus();
                },
            });
            element.addEventListener('input', sync);
            watchValue(element, sync);
        }
    }
}
