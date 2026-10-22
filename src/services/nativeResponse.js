/**
 * What the phone's own networking (CapacitorHttp: { status, headers, data })
 * answered, as a fetch Response, so callers of the API client don't change.
 * `data` is text, or what the plugin already parsed from JSON. Pure, so tests
 * can import it.
 */

// Statuses a Response can't have a body with.
const NO_BODY = new Set([101, 204, 205, 304]);

export function asResponse({ status, headers = {}, data }) {
    const text = data === undefined || data === null ? ''
        : typeof data === 'string' ? data
            : JSON.stringify(data);
    const flat = {};
    for (const [name, value] of Object.entries(headers || {})) {
        flat[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return new Response(NO_BODY.has(status) ? null : text, { status, headers: flat });
}

/** The request body for the plugin: JSON as an object (as it wants it), anything else as is. */
export function asData(body, headers = {}) {
    if (body === undefined || body === null) return undefined;
    const type = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
    if (typeof body === 'string' && type.includes('application/json')) {
        try {
            return JSON.parse(body);
        } catch {
            return body;
        }
    }
    return body;
}
