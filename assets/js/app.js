// Einstieg: Anmeldung, Navigation, Shell.

import { api, ApiError } from './api.js';
import { state, loadSession, login, logout, loadTimers, subscribe, changeLang } from './store.js';
import { LANGS, lang, setLang, t } from './i18n.js';
import { dialog, toastError } from './ui.js';
import { nextTheme, setTheme, theme } from './theme.js';
import { icon } from './icons.js';
import { clock, html } from './util.js';

import { timerView } from './views/timer.js';
import { entriesView } from './views/entries.js';
import { masterView } from './views/master.js';
import { settingsView } from './views/settings.js';
import { portalView } from './views/portal.js';

const ADMIN_ROUTES = {
    '/timer': timerView,
    '/eintraege': entriesView,
    '/stammdaten': masterView,
    '/einstellungen': settingsView,
    // Nicht in der Navigation: Vorschau auf das Kundenportal, erreichbar über
    // die Stammdaten ("Kundenansicht"). So sieht man, was der Kunde sieht.
    '/uebersicht': portalView,
};

// Frühere Adressen, die es als eigene Seite nicht mehr gibt. Die Auswertung
// steckt jetzt in den Einträgen (Darstellung "Summen").
const REDIRECTS = {
    '/auswertung': '/eintraege',
};

const CLIENT_ROUTES = {
    '/uebersicht': portalView,
    '/leistungen': entriesView,
};

// Die Beschriftungen entstehen erst beim Aufbau der Hülle – nach einem
// Sprachwechsel steht in `t()` sonst noch der alte Text.
const ADMIN_NAV = () => [
    { path: '/timer', label: t('nav.timer'), icon: 'timer' },
    { path: '/eintraege', label: t('nav.entries'), icon: 'list' },
    { path: '/stammdaten', label: t('nav.master'), icon: 'folder' },
    { path: '/einstellungen', label: t('nav.more'), icon: 'more' },
];

const CLIENT_NAV = () => [
    { path: '/uebersicht', label: t('nav.overview'), icon: 'chart' },
    { path: '/leistungen', label: t('nav.services'), icon: 'list' },
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
// Programmversion aus index.php (Datei VERSION) – oben links neben dem Namen.
const VERSION = document.documentElement.dataset.version || '';

// Repository (privat) – Changelog, Quellcode und Wünsche liegen dort.
const REPO = 'https://github.com/VIEWSION/vTimings';
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

// -- Darstellung ------------------------------------------------------------

/**
 * Ein Knopf, der reihum automatisch → hell → dunkel schaltet. Das Symbol
 * zeigt die aktuelle Wahl, der Tooltip zusätzlich die nächste.
 */
function themeButton() {
    return html`<button type="button" class="icon-btn topbar__icon" id="theme">${icon(theme())}</button>`;
}

function paintThemeButton(button) {
    const label = t('theme.current', { mode: t('theme.' + theme()), next: t('theme.' + nextTheme()) });
    button.innerHTML = icon(theme()).toString();
    button.title = label;
    button.setAttribute('aria-label', label);
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

// -- Über vTimings ------------------------------------------------------------

/**
 * Kleines Info-Fenster hinter dem Namen oben links. Die GitHub-Links nur für
 * Administratoren: das Repository ist privat, ein Kundenzugang landete dort
 * auf einer 404-Seite.
 */
function showAbout() {
    const base = document.documentElement.dataset.base || '';
    const admin = state.user?.role === 'admin';
    const link = (href, iconName, label) => html`
        <a class="about__link" href="${href}" target="_blank" rel="noopener">
            ${icon(iconName, 18)}<span>${label}</span>
        </a>`;

    dialog({
        title: t('app.about'),
        body: html`
            <div class="about">
                <div class="about__head">
                    <img class="about__logo" src="${base}/assets/icons/icon.svg?v=${VERSION}" alt="" width="56" height="56">
                    <div>
                        <strong class="about__name">vTimings</strong>
                        ${VERSION ? html`<span class="about__version">${t('app.version', { version: VERSION })}</span>` : ''}
                    </div>
                </div>
                <p class="muted about__text">${t('app.tagline')}</p>
                ${admin ? html`
                    <nav class="about__links">
                        ${link(`${REPO}/blob/main/CHANGELOG.md`, 'list', t('app.changelog'))}
                        ${link(REPO, 'open', t('app.source'))}
                        ${link(`${REPO}/issues`, 'edit', t('app.issues'))}
                    </nav>` : ''}
            </div>`.toString(),
    });
}

// -- Shell ------------------------------------------------------------------

function renderShell() {
    const items = nav();

    // Abmelden und Sprachumschalter stehen bewusst neben der Navigation, nicht
    // darin: auf schmalen Displays weicht .topbar__nav der Tabbar, erreichbar
    // bleiben sollen beide trotzdem.
    app.innerHTML = html`
        <div class="shell">
            <header class="topbar">
                <button type="button" class="topbar__brand" id="about" title="${t('app.about')}">
                    vTimings
                    ${VERSION ? html`<span class="topbar__version">v${VERSION}</span>` : ''}
                </button>
                <div class="topbar__timer" id="topbar-timer"></div>
                <nav class="topbar__nav">
                    ${items.map((item) => html`
                        <a class="topbar__link" href="#${item.path}" data-path="${item.path}">${item.label}</a>`)}
                </nav>
                <div class="topbar__tools">
                    ${themeButton()}
                    <button type="button" class="icon-btn topbar__icon topbar__logout" id="logout"
                            title="${t('auth.signOut')}" aria-label="${t('auth.signOut')}">
                        ${icon('power')}
                    </button>
                    ${langSwitch('topbar__lang')}
                </div>
            </header>
            <main class="main" id="view"></main>
            <nav class="tabbar" style="grid-template-columns: repeat(${items.length}, 1fr)">
                ${items.map((item) => html`
                    <a class="tabbar__link" href="#${item.path}" data-path="${item.path}">
                        <span class="tabbar__icon" aria-hidden="true">${icon(item.icon, 22)}</span>
                        <span>${item.label}</span>
                    </a>`)}
            </nav>
        </div>`;

    paintThemeButton(app.querySelector('#theme'));
    app.querySelector('#theme').addEventListener('click', (event) => {
        setTheme(nextTheme());
        paintThemeButton(event.currentTarget);
    });

    app.querySelector('#about').addEventListener('click', showAbout);

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
    if (REDIRECTS[path] && table[REDIRECTS[path]]) {
        // replace() statt neuem Verlaufseintrag; der hashchange ruft route() erneut.
        location.replace(`#${REDIRECTS[path]}`);
        return;
    }
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
