// Einstieg: Anmeldung, Navigation, Shell.

import { api, ApiError } from './api.js';
import { state, loadSession, login, logout, loadTimers, subscribe, changeLang } from './store.js';
import { LANGS, lang, setLang, t } from './i18n.js';
import { toastError } from './ui.js';
import { clock, html } from './util.js';

import { timerView } from './views/timer.js';
import { entriesView } from './views/entries.js';
import { reportsView } from './views/reports.js';
import { masterView } from './views/master.js';
import { settingsView } from './views/settings.js';
import { portalView } from './views/portal.js';

const ADMIN_ROUTES = {
    '/timer': timerView,
    '/eintraege': entriesView,
    '/auswertung': reportsView,
    '/stammdaten': masterView,
    '/einstellungen': settingsView,
    // Nicht in der Navigation: Vorschau auf das Kundenportal, erreichbar über
    // die Stammdaten ("Kundenansicht"). So sieht man, was der Kunde sieht.
    '/uebersicht': portalView,
};

const CLIENT_ROUTES = {
    '/uebersicht': portalView,
    '/leistungen': entriesView,
};

// Die Beschriftungen entstehen erst beim Aufbau der Hülle – nach einem
// Sprachwechsel steht in `t()` sonst noch der alte Text.
const ADMIN_NAV = () => [
    { path: '/timer', label: t('nav.timer'), icon: '⏱' },
    { path: '/eintraege', label: t('nav.entries'), icon: '☰' },
    { path: '/auswertung', label: t('nav.reports'), icon: '◪' },
    { path: '/stammdaten', label: t('nav.master'), icon: '▤' },
    { path: '/einstellungen', label: t('nav.more'), icon: '⚙' },
];

const CLIENT_NAV = () => [
    { path: '/uebersicht', label: t('nav.overview'), icon: '◪' },
    { path: '/leistungen', label: t('nav.services'), icon: '☰' },
];

/** Kundenzugänge bekommen eine eigene, reduzierte Navigation. */
function routes() {
    return state.user?.role === 'client' ? CLIENT_ROUTES : ADMIN_ROUTES;
}

function nav() {
    return state.user?.role === 'client' ? CLIENT_NAV() : ADMIN_NAV();
}

function homePath() {
    return state.user?.role === 'client' ? '/uebersicht' : '/timer';
}

const app = document.querySelector('#app');
let currentView = null;
let pollTimer = null;
let clockTimer = null;
let unsubscribeTopbar = null;
let hashListener = null;
let lastSync = 0;

boot();
registerServiceWorker();

/** Nur unter HTTPS (oder localhost) verfügbar – sonst still überspringen. */
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const base = document.documentElement.dataset.base || '';
    navigator.serviceWorker.register(`${base}/assets/sw.js`, { scope: `${base}/` })
        .catch(() => { /* kein Drama: die App läuft auch ohne */ });
}

async function boot() {
    try {
        await loadSession();
    } catch (error) {
        return renderFatal(error);
    }

    if (!state.user) return renderLogin();
    renderShell();
}

// -- Sprachumschalter -------------------------------------------------------

/**
 * DE | EN als Schaltergruppe. `type="button"`, damit er im Anmeldeformular
 * nicht als Absenden zählt.
 */
function langSwitch(className) {
    return html`
        <div class="langswitch ${className}" role="group" aria-label="${t('lang.switch')}">
            ${LANGS.map((code) => html`
                <button type="button" class="langswitch__btn ${code === lang() ? 'is-active' : ''}"
                        data-lang="${code}" lang="${code}" title="${t('lang.' + code)}"
                        ${code === lang() ? { __raw: 'aria-current="true"' } : ''}>${code.toUpperCase()}</button>`)}
        </div>`;
}

// -- Anmeldung --------------------------------------------------------------

function renderLogin(message = '') {
    stopPolling();
    currentView?.destroy?.();
    currentView = null;
    app.innerHTML = html`
        <div class="login">
            <form class="login__box card" id="login-form">
                <h1>vTimings</h1>
                <p class="muted">${t('app.tagline')}</p>
                ${message ? html`<p class="login__error">${message}</p>` : ''}
                <label class="field">
                    <span class="field__label">${t('common.email')}</span>
                    <input class="input" type="email" name="email" autocomplete="username" required autofocus>
                </label>
                <label class="field">
                    <span class="field__label">${t('common.password')}</span>
                    <input class="input" type="password" name="password" autocomplete="current-password" required>
                </label>
                <label class="switch login__remember">
                    <input type="checkbox" name="remember" ${rememberChecked() ? 'checked' : ''}>
                    <span>${t('auth.remember')}</span>
                </label>
                <button class="btn btn--primary btn--big" type="submit">${t('auth.signIn')}</button>
                ${langSwitch('login__lang')}
            </form>
        </div>`;

    // Vor der Anmeldung gibt es keine Sitzung, in der die Wahl landen könnte –
    // hier merkt sie sich nur der Browser (localStorage) und der Bildschirm
    // zeichnet sich neu.
    app.querySelector('.login__lang').addEventListener('click', (event) => {
        const button = event.target.closest('[data-lang]');
        if (!button) return;
        setLang(button.dataset.lang);
        renderLogin(message);
    });

    app.querySelector('#login-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        const button = form.querySelector('button');
        button.disabled = true;

        try {
            storeRememberChoice(form.remember.checked);
            await login(form.email.value, form.password.value, form.remember.checked);
            renderShell();
        } catch (error) {
            button.disabled = false;
            renderLogin(error.message);
        }
    });
}

/**
 * Das Häkchen bleibt so gesetzt, wie man es zuletzt gewählt hat – Vorgabe
 * ist an. Liegt bewusst nicht in prefs.js: vor der Anmeldung gibt es noch
 * keinen Benutzer, nach dem sich der Schlüssel richten könnte.
 */
function rememberChecked() {
    try {
        return localStorage.getItem('vt.remember') !== '0';
    } catch {
        return true;
    }
}

function storeRememberChoice(checked) {
    try {
        localStorage.setItem('vt.remember', checked ? '1' : '0');
    } catch { /* privater Modus */ }
}

// -- Shell ------------------------------------------------------------------

function renderShell() {
    const items = nav();

    // Der Sprachumschalter steht bewusst neben der Navigation, nicht darin:
    // auf schmalen Displays weicht .topbar__nav der Tabbar, erreichbar
    // bleiben soll er trotzdem.
    app.innerHTML = html`
        <div class="shell">
            <header class="topbar">
                <span class="topbar__brand">vTimings</span>
                <div class="topbar__timer" id="topbar-timer"></div>
                ${langSwitch('topbar__lang')}
                <nav class="topbar__nav">
                    ${items.map((item) => html`
                        <a class="topbar__link" href="#${item.path}" data-path="${item.path}">${item.label}</a>`)}
                    <button class="btn btn--ghost btn--small" id="logout">${t('auth.signOut')}</button>
                </nav>
            </header>
            <main class="main" id="view"></main>
            <nav class="tabbar" style="grid-template-columns: repeat(${items.length}, 1fr)">
                ${items.map((item) => html`
                    <a class="tabbar__link" href="#${item.path}" data-path="${item.path}">
                        <span class="tabbar__icon" aria-hidden="true">${item.icon}</span>
                        <span>${item.label}</span>
                    </a>`)}
            </nav>
        </div>`;

    app.querySelector('#logout').addEventListener('click', async () => {
        try {
            await logout();
        } catch { /* Session war ohnehin weg */ }
        renderLogin();
    });

    app.querySelector('.topbar__lang').addEventListener('click', async (event) => {
        const button = event.target.closest('[data-lang]');
        if (!button || button.dataset.lang === lang()) return;
        try {
            await changeLang(button.dataset.lang);
        } catch (error) {
            return toastError(error);
        }
        // Die Hülle neu aufbauen zieht die aktuelle Ansicht mit – jede View
        // baut ihr Markup bei jedem render() neu auf.
        renderShell();
    });

    // Beim erneuten Aufbau (z. B. nach An-/Abmelden) die alten Bindungen
    // lösen, sonst laufen sie mehrfach.
    if (hashListener) window.removeEventListener('hashchange', hashListener);
    hashListener = route;
    window.addEventListener('hashchange', hashListener);

    unsubscribeTopbar?.();
    unsubscribeTopbar = subscribe(drawTopbarTimer);

    route();
    startPolling();
}

async function route() {
    if (!state.user) return;

    const table = routes();
    const path = (location.hash.replace('#', '') || homePath()).split('?')[0];
    const view = table[path] || table[homePath()];

    for (const link of app.querySelectorAll('[data-path]')) {
        link.classList.toggle('is-active', link.dataset.path === path);
    }

    currentView?.destroy?.();
    currentView = view;

    // Für jede Ansicht ein frischer Wirt. Damit sterben alle Listener der
    // vorherigen Ansicht mit dem alten Element – sie können weder doppelt
    // laufen noch in die nächste Ansicht hineinwirken.
    const host = document.createElement('main');
    host.className = 'main';
    host.id = 'view';
    app.querySelector('#view').replaceWith(host);
    host.innerHTML = html`<div class="loading">${t('common.loading')}</div>`;

    try {
        await view.render(host);
    } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
            state.user = null;
            return renderLogin(t('auth.expired'));
        }
        toastError(error);
        host.innerHTML = html`<div class="card"><p class="card__body">${t('shell.viewFailed')}</p></div>`;
    }
}

// -- Laufender Timer in der Kopfzeile ---------------------------------------

function drawTopbarTimer() {
    const host = app.querySelector('#topbar-timer');
    if (!host) return;

    if (!state.timers.length) {
        host.innerHTML = '';
        host.classList.remove('is-running');
        return;
    }

    const timer = state.timers[0];
    host.classList.add('is-running');
    host.innerHTML = html`
        <a href="#/timer" class="topbar__running" title="${timer.path}">
            <span class="pulse" style="background:${timer.color || 'var(--accent)'}"></span>
            <span class="topbar__running-name">${timer.subproject_name}</span>
            <span class="topbar__running-clock" data-since="${timer.started_at}">${clock(timer.elapsed_sec)}</span>
            ${state.timers.length > 1 ? html`<span class="badge">+${state.timers.length - 1}</span>` : ''}
        </a>`;
}

/**
 * Hält den Timer-Zustand geräteübergreifend aktuell: die Uhr läuft lokal,
 * der Abgleich mit dem Server passiert seltener und nur bei sichtbarem Tab.
 */
function startPolling() {
    stopPolling();

    // Kundenzugänge erfassen keine Zeit – für sie gibt es nichts abzugleichen.
    if (state.user?.role === 'client') return;

    clockTimer = setInterval(() => {
        for (const el of app.querySelectorAll('.topbar__running-clock[data-since]')) {
            el.textContent = clock((Date.now() - new Date(el.dataset.since).getTime()) / 1000);
        }
    }, 1000);

    pollTimer = setInterval(async () => {
        if (document.hidden) return;
        try {
            lastSync = Date.now();
            await loadTimers();
        } catch { /* offline: beim nächsten Durchlauf erneut */ }
    }, 30000);

    lastSync = Date.now();
    loadTimers().catch(() => {});
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (clockTimer) clearInterval(clockTimer);
    pollTimer = null;
    clockTimer = null;
}

// Genau einmal registrieren. Innerhalb von startPolling() würde sich bei
// jedem erneuten Aufbau der Hülle ein weiterer Listener ansammeln.
document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.user || state.user.role === 'client') return;

    // Gedrosselt: schnelles Hin- und Herwechseln zwischen Tabs darf keine
    // Anfragenflut auslösen. Ein paar Sekunden alte Daten sind unkritisch,
    // die Uhr läuft ohnehin lokal weiter.
    if (Date.now() - lastSync < 10000) return;
    lastSync = Date.now();
    loadTimers().catch(() => {});
});

function renderFatal(error) {
    app.innerHTML = html`
        <div class="login">
            <div class="login__box card">
                <h1>vTimings</h1>
                <p class="login__error">${error.message}</p>
                ${error.code === 'not_installed' || error.code === 'migration_pending'
                    ? html`<pre><code>php bin/console.php ${error.code === 'not_installed' ? 'install' : 'migrate'}</code></pre>`
                    : ''}
            </div>
        </div>`;
}
