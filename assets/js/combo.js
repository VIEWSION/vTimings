// Auswahlfeld mit Farbpunkten und Suche – als Aufsatz auf ein <select>.
//
// Die native Liste lässt sich unter macOS nicht gestalten (keine Farben,
// keine Suche). Statt sie zu ersetzen, bleibt das <select> unsichtbar im
// Formular und ist weiterhin die einzige Quelle für den Wert: FormData,
// `select.value`, `change`-Ereignisse und Feldfehler funktionieren wie
// vorher. Der Aufsatz zeigt nur an und schreibt die Auswahl zurück.
//
// Farben kommen aus `data-color` an den <option>-Elementen. Werden die
// Optionen neu befüllt oder das Feld gesperrt, zieht ein MutationObserver
// die Anzeige nach – die Views müssen davon nichts wissen.
//
// Benutzung: <select data-combo …> ins Markup, danach enhanceCombos(root).

import { t } from './i18n.js';
import { esc } from './util.js';

/** Ab so vielen Einträgen erscheint das Suchfeld. */
const SEARCH_FROM = 8;

let open = null; // der gerade geöffnete Aufsatz – es gibt immer nur einen

/** Alle noch nicht versehenen <select data-combo> unterhalb von `root`. */
export function enhanceCombos(root) {
    for (const select of root.querySelectorAll('select[data-combo]:not([data-combo-ready])')) {
        combo(select);
    }
}

function combo(select) {
    select.dataset.comboReady = '1';
    select.classList.add('combo__native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    // Vor dem <select>, damit ein umschließendes <label> den Knopf auslöst
    // (ein Label bedient sein erstes bedienbares Element).
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'input combo__button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    select.before(button);

    const sync = () => {
        button.disabled = select.disabled;
        button.classList.toggle('is-invalid', select.classList.contains('is-invalid'));

        const chosen = [...select.selectedOptions];
        let label;
        let color = '';
        if (select.multiple) {
            label = chosen.length === 0
                ? (select.dataset.placeholder || t('combo.none'))
                : chosen.length <= 2
                    ? chosen.map((o) => o.textContent).join(', ')
                    : t('combo.selected', { count: chosen.length });
            if (chosen.length === 1) color = chosen[0].dataset.color || '';
        } else {
            label = chosen[0]?.textContent ?? '';
            color = chosen[0]?.dataset.color || '';
        }

        button.innerHTML = `${dot(color)}<span class="combo__label">${esc(label)}</span>` +
            '<span class="combo__chevron" aria-hidden="true"></span>';
    };

    // Neu befüllte Optionen, programmatisch gesetzter Wert (kommt meist im
    // selben Zug wie das Befüllen), gesperrt/entsperrt, Feldfehler.
    new MutationObserver(sync).observe(select, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'class', 'selected'],
    });
    select.addEventListener('change', sync);
    select.comboSync = sync;

    button.addEventListener('click', () => (open?.select === select ? close() : show(select, button, sync)));
    button.addEventListener('keydown', (event) => {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            show(select, button, sync);
        }
    });

    sync();
}

function dot(color) {
    return color
        ? `<span class="dot" style="background:${esc(color)}"></span>`
        : '<span class="dot dot--none"></span>';
}

/** Suche ohne Rücksicht auf Groß-/Kleinschreibung und Akzente. */
function fold(text) {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// -- Aufgeklappte Liste -----------------------------------------------------

function show(select, button, sync) {
    close();

    const options = [...select.options];
    const withSearch = options.length >= SEARCH_FROM;
    const listId = `combo-${Math.random().toString(36).slice(2, 9)}`;

    // An <body>, nicht an das Feld: Karten und Dialoge schneiden über-
    // stehenden Inhalt ab (overflow: hidden bzw. auto).
    const pop = document.createElement('div');
    pop.className = 'combo__pop';
    pop.innerHTML = `
        ${withSearch ? `<input class="input combo__search" type="search" autocomplete="off"
            placeholder="${esc(t('common.searchPlaceholder'))}" aria-controls="${listId}">` : ''}
        <ul class="combo__list" id="${listId}" role="listbox"
            ${select.multiple ? 'aria-multiselectable="true"' : ''}></ul>`;
    document.body.append(pop);

    const search = pop.querySelector('.combo__search');
    const list = pop.querySelector('.combo__list');
    let active = -1;
    let visible = [];

    function filter() {
        const needle = fold(search?.value.trim() ?? '');
        visible = options.filter((o) => !o.disabled && (!needle || fold(o.textContent).includes(needle)));
    }

    function draw() {
        list.innerHTML = visible.length
            ? visible.map((o, i) => `
                <li class="combo__item ${o.selected ? 'is-selected' : ''} ${i === active ? 'is-active' : ''}"
                    role="option" id="${listId}-${i}" data-index="${i}" aria-selected="${o.selected}">
                    ${select.multiple ? `<span class="combo__check" aria-hidden="true">${o.selected ? '✓' : ''}</span>` : ''}
                    ${dot(o.dataset.color || '')}
                    <span class="combo__text">${esc(o.textContent)}</span>
                </li>`).join('')
            : `<li class="combo__empty">${esc(t('common.noMatch'))}</li>`;

        if (active >= 0) {
            list.querySelector(`#${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
            search?.setAttribute('aria-activedescendant', `${listId}-${active}`);
        }
    }

    function choose(index) {
        const option = visible[index];
        if (!option) return;

        if (select.multiple) {
            option.selected = !option.selected;
            active = index;
            draw();
        } else {
            select.value = option.value;
        }
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();

        if (!select.multiple) {
            close();
            button.focus();
        }
    }

    function move(step) {
        if (!visible.length) return;
        active = active < 0 ? (step > 0 ? 0 : visible.length - 1)
            : Math.max(0, Math.min(visible.length - 1, active + step));
        draw();
    }

    function place() {
        const rect = button.getBoundingClientRect();
        const margin = 8;
        const width = Math.min(Math.max(rect.width, 256), window.innerWidth - 2 * margin);
        const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
        const below = window.innerHeight - rect.bottom - margin;
        const above = rect.top - margin;
        const upward = below < 240 && above > below;

        pop.style.width = `${width}px`;
        pop.style.left = `${left}px`;
        pop.style.maxHeight = `${Math.min(360, upward ? above : below) - 4}px`;
        pop.style.top = upward ? '' : `${rect.bottom + 4}px`;
        pop.style.bottom = upward ? `${window.innerHeight - rect.top + 4}px` : '';
    }

    function onKey(event) {
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        else if (event.key === 'Enter') {
            event.preventDefault();
            choose(active >= 0 ? active : 0);
        } else if (event.key === 'Escape') {
            // Nur die Liste schließen, nicht auch gleich den Dialog dahinter.
            event.preventDefault();
            event.stopPropagation();
            close();
            button.focus();
        } else if (event.key === 'Tab') {
            close();
        }
    }

    function onOutside(event) {
        if (!pop.contains(event.target) && event.target !== button && !button.contains(event.target)) close();
    }

    // Scrollen in der Liste selbst darf sie nicht verschieben.
    function onScroll(event) {
        if (!pop.contains(event.target)) place();
    }

    list.addEventListener('mousedown', (event) => event.preventDefault()); // Fokus bleibt in der Suche
    list.addEventListener('click', (event) => {
        const item = event.target.closest('[data-index]');
        if (item) choose(Number(item.dataset.index));
    });
    // Beim Tippen steht der erste Treffer bereit – Enter übernimmt ihn.
    search?.addEventListener('input', () => {
        filter();
        active = search.value.trim() && visible.length ? 0 : -1;
        draw();
    });
    pop.addEventListener('keydown', onKey);

    // Erst nach dem aktuellen Klick einhängen, sonst schließt er sofort wieder.
    setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);

    open = {
        select,
        close() {
            document.removeEventListener('mousedown', onOutside);
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', onScroll, true);
            pop.remove();
            button.setAttribute('aria-expanded', 'false');
        },
    };

    button.setAttribute('aria-expanded', 'true');
    filter();
    active = select.multiple ? -1 : visible.indexOf(select.selectedOptions[0]);
    draw();
    place();

    if (search) search.focus();
    else {
        pop.tabIndex = -1;
        pop.focus();
    }
}

function close() {
    open?.close();
    open = null;
}

// Beim Seitenwechsel verschwindet das Feld – die Liste darf nicht hängen bleiben.
window.addEventListener('hashchange', close);
