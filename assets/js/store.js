// Gemeinsamer Zustand. Views abonnieren, was sie brauchen.

import { api } from './api.js';
import { lang, setLang } from './i18n.js';

const listeners = new Set();

export const state = {
    user: null,
    settings: {},
    timers: [],
    recent: [],
    tree: null,
    ready: false,
};

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function notify() {
    for (const fn of listeners) fn(state);
}

export async function loadSession() {
    const data = await api.get('/auth/me');
    api.setCsrf(data.csrf);
    state.user = data.user;
    if (data.user) setLang(data.user.lang);
    notify();
    return data.user;
}

export async function login(email, password) {
    const data = await api.post('/auth/login', { email, password });
    api.setCsrf(data.csrf);
    state.user = data.user;
    setLang(data.user.lang);
    notify();
    return data.user;
}

/**
 * Sprache wechseln. Der Server merkt sie sich dort, wo sie hingehört – beim
 * Kundenzugang im Kundenprofil, beim Administrator in den Einstellungen.
 */
export async function changeLang(value) {
    if (value === lang()) return value;

    const data = await api.patch('/auth/lang', { lang: value });
    setLang(data.lang);
    if (state.user) state.user.lang = data.lang;
    notify();
    return data.lang;
}

export async function logout() {
    await api.post('/auth/logout');
    state.user = null;
    state.tree = null;
    state.timers = [];
    notify();
}

export async function loadSettings() {
    const data = await api.get('/settings');
    state.settings = data.settings;
    notify();
}

export async function loadTimers() {
    const data = await api.get('/timer');
    state.timers = data.timers;
    notify();
    return state.timers;
}

export async function loadRecent() {
    const data = await api.get('/entries/recent');
    state.recent = data.subprojects;
    notify();
    return state.recent;
}

export async function loadTree({ force = false, archived = false } = {}) {
    if (state.tree && !force) return state.tree;
    const data = await api.get('/tree', archived ? {} : { archived: '0' });
    state.tree = data;
    notify();
    return data;
}

export function invalidateTree() {
    state.tree = null;
}

/** Flache Liste aller Teilprojekte für Auswahlfelder. */
export function flatSubprojects() {
    const out = [];
    for (const client of state.tree?.clients || []) {
        for (const project of client.projects) {
            for (const sub of project.subprojects) {
                out.push({ ...sub, client_name: client.name, project_name: project.name });
            }
        }
    }
    return out;
}
