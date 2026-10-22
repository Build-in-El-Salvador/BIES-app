import { CapacitorHttp } from '@capacitor/core';
import { asData, asResponse } from './nativeResponse.js';

/**
 * In the phone app, API calls go through the phone's own networking
 * (CapacitorHttp) instead of the web view's fetch. The app's pages come from
 * capacitor://localhost (https://localhost on Android), so every API call
 * from the web view is cross-origin, and WebKit first asks the server about
 * each new address (a CORS OPTIONS request: one more round trip for every new
 * page, member or listing). The phone's networking has no such check.
 *
 * Only what the API client sends: JSON or nothing. Uploads (FormData) and
 * calls to other services stay on fetch. The answer is a fetch Response.
 * `timeoutMs` bounds the whole request, as AbortSignal.timeout does for fetch.
 */
export async function nativeFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DOMException('The request timed out', 'TimeoutError')), timeoutMs);
    });
    try {
        const result = await Promise.race([
            CapacitorHttp.request({
                url,
                method,
                // The app's own origin, which the server knows (CORS_NATIVE_ORIGIN):
                // it tells the server this is the phone app, as fetch does.
                headers: { ...(globalThis.location?.origin ? { Origin: globalThis.location.origin } : {}), ...headers },
                data: asData(body, headers),
                responseType: 'text',
                connectTimeout: timeoutMs,
                readTimeout: timeoutMs,
            }),
            timeout,
        ]);
        return asResponse(result);
    } finally {
        clearTimeout(timer);
    }
}

/** Whether a request can go this way: a JSON body or none (not FormData, Blob...). */
export const canSendNatively = (body) => body === undefined || body === null || typeof body === 'string';
