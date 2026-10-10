/**
 * Session edge cases found in review, kept as regression tests: server
 * hiccups at startup, sign-outs that must reach every tab, push
 * notifications after logout, WebSocket reconnect storms, device clocks that
 * are off, logout racing a new sign-in, and refreshes that never answer.
 *
 * Run: npm run test:unit   (node --test, with fetch, storage and WebSocket stubbed)
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Browser stand-ins ───────────────────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const events = [];
globalThis.window = {
    dispatchEvent: (e) => events.push(e.type),
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://localhost', href: 'http://localhost/' },
};
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
let native = false;
window.Capacitor = { isNativePlatform: () => native, getPlatform: () => (native ? 'ios' : 'web') };

// fetch: every call recorded; `server(url, init)` answers ({status, body} | Error | Promise).
let calls = [];
let server = () => { throw new Error('no server'); };
globalThis.fetch = async (url, init = {}) => {
    const call = {
        url: url.replace(/^\/api/, ''),
        method: init.method || 'GET',
        auth: init.headers?.Authorization,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
        signal: init.signal,
        done: false,
    };
    calls.push(call);
    await new Promise((r) => setImmediate(r));
    const out = await server(call.url, init);
    call.done = true;
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out?.body ?? {}), { status: out?.status ?? 200 });
};

const session = await import('../../src/services/session.js');
const api = await import('../../src/services/api.js');
const { authService } = await import('../../src/services/authService.js');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);
/** A JWT issued at `iat` (seconds) lasting `life` seconds. Unsigned: the app only reads claims. */
const jwtAt = (iat, life = 900, tag = 'x') => `${b64({ alg: 'HS256' })}.${b64({ iat, exp: iat + life, tag })}.sig`;
const tokenExpiringIn = (s, tag = 'x', life = 900) => jwtAt(nowS() + s - life, life, tag);
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
    store.clear();
    events.length = 0;
    calls = [];
    native = false;
    server = () => { throw new Error('no server'); };
});

// ─── A server hiccup at startup ──────────────────────────────────────────────

test('startup: a refresh answering 503 keeps the session', async () => {
    store.set('bies_token', tokenExpiringIn(-120, 'stale')); // app reopened after 15+ minutes
    store.set('bies_user', JSON.stringify({ id: 'u1' }));
    server = (url) => {
        if (url === '/auth/refresh') return { status: 503, body: { error: 'Please try again in a moment' } };
        if (url === '/auth/me') return { status: 401, body: { reason: 'token_expired' } };
    };

    const user = await authService.restoreSession();
    assert.deepEqual(user, { id: 'u1' });
    assert.equal(store.has('bies_token'), true);
    assert.deepEqual(events, []);
});

test('startup: a full outage keeps the session', async () => {
    store.set('bies_token', tokenExpiringIn(-120, 'stale'));
    store.set('bies_user', JSON.stringify({ id: 'u1' }));
    server = () => new TypeError('Failed to fetch');
    assert.deepEqual(await authService.restoreSession(), { id: 'u1' });
    assert.equal(store.has('bies_token'), true);
});

test('a request whose refresh can’t reach the server fails as "try again", not "signed out"', async () => {
    store.set('bies_token', tokenExpiringIn(600));
    server = (url) => (url === '/auth/refresh' ? new TypeError('Failed to fetch') : { status: 401, body: { reason: 'token_expired' } });
    await assert.rejects(api.notificationsApi.list({ limit: 20 }), (e) => e.status === 503);
    assert.equal(store.has('bies_token'), true);
    assert.deepEqual(events, []);
});

// ─── Sign-outs reach every tab ───────────────────────────────────────────────

test('a session-over answer signs this tab out even if another tab already cleared storage', async () => {
    server = () => ({ status: 401, body: { reason: 'session_ended' } });
    await assert.rejects(api.notificationsApi.list({ limit: 20 }), (e) => e.status === 401);
    assert.deepEqual(events, ['bies:unauthorized']);
});

test('a request that simply went out signed out doesn’t fire a sign-out', async () => {
    server = () => ({ status: 401, body: { reason: 'missing_token' } });
    await assert.rejects(api.notificationsApi.list({ limit: 20 }));
    assert.deepEqual(events, []);
});

test('the WebSocket’s 4003 signs out every tab, including the second one to hear it', async () => {
    store.set('bies_token', tokenExpiringIn(600));
    const sockets = [];
    globalThis.WebSocket = class {
        static OPEN = 1;
        constructor() { sockets.push(this); }
        close() {}
        send() {}
    };
    const tabB = new api.BiesWebSocket(null, null, null);
    await tabB.connect();
    store.delete('bies_token'); // tab A handled its own 4003 first
    sockets[0].onclose({ code: 4003 });
    assert.deepEqual(events, ['bies:unauthorized']);
    assert.equal(tabB.shouldReconnect, false);
});

// ─── Push notifications after logout ─────────────────────────────────────────

test('logout removes the phone’s push registration in the same request', async () => {
    native = true;
    const token = tokenExpiringIn(600, 'A');
    store.set('bies_token', token);
    store.set('bies_refresh', 'rt1.A.0.mac');
    server = () => ({ body: { message: 'Logged out successfully' } });

    await authService.logout({ pushToken: 'apns-device-token' });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /auth/logout']);
    assert.equal(calls[0].auth, `Bearer ${token}`);
    assert.deepEqual(calls[0].body, { refreshToken: 'rt1.A.0.mac', pushToken: 'apns-device-token' });
});

test('logout in the last minute of a token doesn’t refresh first', async () => {
    const token = tokenExpiringIn(30, 'A');
    store.set('bies_token', token);
    server = () => ({ body: {} });
    await authService.logout();
    assert.deepEqual(calls.map((c) => c.url), ['/auth/logout']);
    assert.equal(calls[0].auth, `Bearer ${token}`);
});

// ─── WebSocket reconnects back off ───────────────────────────────────────────

function fakeSockets(closeCode) {
    const sockets = [];
    globalThis.WebSocket = class {
        static OPEN = 1;
        constructor(url, protocols) {
            sockets.push({ url, protocols });
            // The server accepts the upgrade, then closes after its checks.
            setImmediate(() => {
                this.readyState = 1;
                this.onopen?.();
                setImmediate(() => { this.readyState = 3; this.onclose?.({ code: closeCode }); });
            });
        }
        close() {}
        send() {}
    };
    return sockets;
}

async function runReconnects(ws, sockets, rounds) {
    const delays = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => { delays.push(ms); return realSetTimeout(fn, 0, ...a); };
    try {
        ws.connect();
        for (let i = 0; i < 5000 && sockets.length < rounds; i++) await tick();
    } finally {
        ws.shouldReconnect = false;
        globalThis.setTimeout = realSetTimeout;
    }
    for (let i = 0; i < 20; i++) await tick();
    return delays;
}

test('WebSocket: a server that accepts and then refuses (4001) gets backed off', async () => {
    store.set('bies_token', tokenExpiringIn(-30));
    server = (url) => (url === '/auth/refresh' ? { status: 503, body: {} } : { status: 404 });
    const sockets = fakeSockets(4001);
    const delays = await runReconnects(new api.BiesWebSocket(null, null, null), sockets, 8);
    const waits = delays.filter((ms) => ms >= 1000);
    // It doubles before the refresh finishes, so the first wait is already 2 s.
    assert.deepEqual(waits.slice(0, 6), [2000, 4000, 8000, 16000, 30000, 30000]);
});

test('WebSocket: a failing session check (1011) gets backed off', async () => {
    store.set('bies_token', tokenExpiringIn(600));
    const sockets = fakeSockets(1011);
    const delays = await runReconnects(new api.BiesWebSocket(null, null, null), sockets, 6);
    assert.deepEqual(delays.slice(0, 5), [1000, 2000, 4000, 8000, 16000]);
});

test('WebSocket: after a healthy connection drops, it reconnects quickly again', async () => {
    store.set('bies_token', tokenExpiringIn(600));
    const sockets = [];
    globalThis.WebSocket = class {
        static OPEN = 1;
        constructor() {
            sockets.push(this);
            setImmediate(() => {
                this.readyState = 1;
                this.onopen?.();
                this.onmessage?.({ data: JSON.stringify({ type: 'connected' }) });
                setImmediate(() => { this.readyState = 3; this.onclose?.({ code: 1006 }); });
            });
        }
        close() {}
        send() {}
    };
    const delays = await runReconnects(new api.BiesWebSocket(null, null, null), sockets, 5);
    assert.deepEqual(delays.slice(0, 4), [1000, 1000, 1000, 1000]);
});

// ─── Device clocks ───────────────────────────────────────────────────────────

test('a device clock 20 minutes fast doesn’t refresh before every request', async () => {
    const serverNow = () => nowS() - 1200;
    let n = 0;
    store.set('bies_token', jwtAt(serverNow(), 900, 't0'));
    server = (url) => (url === '/auth/refresh'
        ? { body: { token: jwtAt(serverNow(), 900, `t${++n}`), expiresIn: 900 } }
        : { body: { id: 'u1' } });
    for (let i = 0; i < 5; i++) await api.authApi.me();
    // One refresh teaches the app the server's time; then it stops.
    assert.equal(calls.filter((c) => c.url === '/auth/refresh').length, 1);
});

test('a device clock 10 minutes slow refreshes before the server sees the token expire', async () => {
    const serverNow = () => nowS() + 600;
    store.set('bies_token', jwtAt(serverNow() - 300, 900, 't0'));
    store.set('bies_clock_skew', '600');
    server = (url) => (url === '/auth/refresh'
        ? { body: { token: jwtAt(serverNow(), 900, 't1'), expiresIn: 900 } }
        : { body: { id: 'u1' } });
    // By the server's clock the token has 600 s left: no refresh yet.
    await api.authApi.me();
    assert.equal(calls.filter((c) => c.url === '/auth/refresh').length, 0);
    // Close to the server's expiry, it refreshes even though the device
    // clock says there is plenty of time.
    store.set('bies_token', jwtAt(serverNow() - 870, 900, 't0'));
    await api.authApi.me();
    assert.equal(calls.filter((c) => c.url === '/auth/refresh').length, 1);
});

// ─── Logout racing a new sign-in ─────────────────────────────────────────────

test('native: a sign-in while the logout is still being sent keeps its refresh token', async () => {
    native = true;
    store.set('bies_token', tokenExpiringIn(600, 'A'));
    store.set('bies_refresh', 'rt1.A.0.mac');
    let release;
    const gate = new Promise((r) => { release = r; });
    server = async (url) => {
        if (url === '/auth/logout') { await gate; return { body: {} }; }
    };
    const out = session.logoutSession();
    session.saveSession({ token: tokenExpiringIn(900, 'B'), refreshToken: 'rt1.B.0.mac' });
    release();
    await out;
    assert.equal(store.get('bies_refresh'), 'rt1.B.0.mac');
});

test('a sign-in request waits for the logout still being sent', async () => {
    store.set('bies_token', tokenExpiringIn(600, 'A'));
    let release;
    const gate = new Promise((r) => { release = r; });
    server = async (url) => {
        if (url === '/auth/logout') { await gate; return { body: {} }; }
        if (url === '/auth/email/verify') return { body: { token: tokenExpiringIn(900, 'B'), user: { id: 'u2' } } };
    };
    const out = authService.logout();
    const signIn = api.authApi.emailVerify('b@example.com', '123456');
    for (let i = 0; i < 20; i++) await tick();
    assert.deepEqual(calls.map((c) => c.url), ['/auth/logout'], 'the sign-in hasn’t gone out yet');
    release();
    await out;
    await signIn;
    const order = calls.map((c) => c.url);
    assert.deepEqual(order, ['/auth/logout', '/auth/email/verify']);
    assert.equal(calls[1].auth, undefined, 'signing in sends no old token');
});

// ─── Refreshes that never answer ─────────────────────────────────────────────

test('a refresh gives up after a while instead of holding every request', async () => {
    store.set('bies_token', tokenExpiringIn(-30));
    server = (url) => (url === '/auth/refresh' ? { body: { token: tokenExpiringIn(900) } } : { body: { id: 'u1' } });
    await api.authApi.me();
    const refresh = calls.find((c) => c.url === '/auth/refresh');
    assert.ok(refresh.signal instanceof AbortSignal, 'the refresh request has a timeout');
});
