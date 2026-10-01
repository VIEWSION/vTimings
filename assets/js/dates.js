// Optionale Datumsfelder: leer steht ein neutrales „––.––.––––“ statt des
// Platzhalters „tt.mm.jjjj“ (der wie ein echtes Datum wirkt), dazu ein kleiner
// Knopf zum Leeren. Opt-in über `data-clearable` am <input type="date">.
//
// Der Wert bleibt im <input>; das Umschließen ändert nichts an FormData oder
// `.value`. Programmatisch gesetzte Werte (Filter zurücksetzen) löst kein
// Ereignis aus – deshalb wird der Setter von `value` an der Instanz abgefangen.

import { attachClear, watchValue } from './clearable.js';

export function enhanceDates(root) {
    for (const input of root.querySelectorAll('input[type=date][data-clearable]:not([data-date-ready])')) {
        dateField(input);
    }
}

function dateField(input) {
    input.dataset.dateReady = '1';

    const wrap = document.createElement('span');
    wrap.className = 'datefield';
    wrap.dataset.empty = '––.––.––––';
    input.before(wrap);
    wrap.append(input);

    const syncButton = attachClear(input, {
        isEmpty: () => input.value === '',
        clear() {
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.focus();
        },
    });

    const sync = () => {
        wrap.classList.toggle('is-empty', input.value === '');
        syncButton();
    };
    watchValue(input, sync);
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);

    sync();
}
