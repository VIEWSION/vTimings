// Dünne Schicht über fetch: CSRF-Token, Fehlerobjekte, Basispfad.

const BASE = document.documentElement.dataset.base || '';

let csrf = null;

export class ApiError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details || {};
    }

    /** Feldfehler aus einer 422 als { feld: meldung }. */
    get fields() {
        return this.details.fields || {};
    }
}

async function request(method, path, { body, query, raw } = {}) {
    const url = new URL(`${BASE}/api${path}`, window.location.origin);
    for (const [key, value] of Object.entries(query || {})) {
        if (value !== null && value !== undefined && value !== '') {
            url.searchParams.set(key, value);
        }
    }

    const headers = { Accept: 'application/json' };
    if (csrf) headers['X-CSRF-Token'] = csrf;

    let payload;
    if (raw !== undefined) {
        payload = raw;
        headers['Content-Type'] = 'text/csv; charset=utf-8';
    } else if (body !== undefined) {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
        method,
        headers,
        body: payload,
        credentials: 'same-origin',
    });

    if (response.status === 204) return null;

    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        throw new ApiError(response.status, 'invalid_response', 'Unerwartete Antwort vom Server.');
    }

    if (!response.ok) {
        const error = data?.error || {};
        throw new ApiError(response.status, error.code || 'error', error.message || 'Unbekannter Fehler.', error.details);
    }

    return data;
}

export const api = {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body, query) => request('POST', path, { body, query }),
    patch: (path, body) => request('PATCH', path, { body }),
    delete: (path, query) => request('DELETE', path, { query }),

    /** CSV-Rohdaten hochladen (Import). */
    upload: (path, csvText, query) => request('POST', path, { raw: csvText, query }),

    setCsrf(token) {
        csrf = token;
    },

    url(path, query = {}) {
        const url = new URL(`${BASE}${path}`, window.location.origin);
        for (const [key, value] of Object.entries(query)) {
            if (value !== null && value !== undefined && value !== '') {
                url.searchParams.set(key, value);
            }
        }
        return url.toString();
    },
};
