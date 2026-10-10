/**
 * The app's side of sessions (src/services/session.js and the request
 * wrapper in src/services/api.js): renewing the access token, signing out
 * when the server says the session is over, and keeping it through network
 * failures.
 *
 * Run: npm run test:unit   (node --test, with fetch and storage stubbed)
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
const events = [];
globalThis.window = { dispatchEvent: (e) => events.push(e.type) };
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };

let native = false;
window.Capacitor = { isNativePlatform: () => native };

// fetch: answers queued per test; every call is recorded.
let calls = [];
let answers = [];
globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    if (next instanceof Error) throw next;
    await new Promise((r) => setImmediate(r));
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
};

const session = await import('../../src/services/session.js');
const api = await import('../../src/services/api.js');

/** A JWT-shaped token that expires `seconds` from now. Unsigned: the app only reads exp. */
function tokenExpiringIn(seconds, tag = 'x', lifetime = 900) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + seconds;
    return `${b64({ alg: 'HS256' })}.${b64({ iat: exp - lifetime, exp, tag })}.sig`;
}

beforeEach(() => {
    store.clear();
    events.length = 0;
    calls = [];
    answers = [];
    native = false;
});

// ─── Reading tokens ──────────────────────────────────────────────────────────

test('reads how long an access token has left', () => {
    const left = session.secondsLeft(tokenExpiringIn(900));
    assert.ok(left > 895 && left <= 900);
    assert.equal(session.secondsLeft('not-a-jwt'), 0);
    assert.equal(session.secondsLeft(tokenExpiringIn(-30)), 0);
});

// ─── Refresh ─────────────────────────────────────────────────────────────────

test('web: refreshes from the cookie and never stores a refresh token', async () => {
    store.set('bies_token', tokenExpiringIn(-5, 'old'));
    const fresh = tokenExpiringIn(900, 'new');
    answers.push({ body: { token: fresh, refreshToken: 'rt1.should.not-be-kept' } });

    assert.equal(await session.refreshSession(), fresh);
    assert.equal(calls[0].url, '/api/auth/refresh');
    assert.deepEqual(calls[0].body, {});
    // The expired token rides along only for the server's rate limit.
    assert.match(calls[0].init.headers.Authorization, /^Bearer /);
    assert.equal(store.get('bies_token'), fresh);
    assert.equal(store.has('bies_refresh'), false);
});

test('native: sends its refresh token and keeps the new one', async () => {
    native = true;
    store.set('bies_token', tokenExpiringIn(-5));
    store.set('bies_refresh', 'rt1.s.one');
    answers.push({ body: { token: tokenExpiringIn(900), refreshToken: 'rt1.s.two' } });

    await session.refreshSession();
    assert.deepEqual(calls[0].body, { refreshToken: 'rt1.s.one' });
    assert.equal(store.get('bies_refresh'), 'rt1.s.two');
});

test('callers that arrive during a refresh share it', async () => {
    store.set('bies_token', tokenExpiringIn(-5));
    answers.push({ body: { token: tokenExpiringIn(900) } });

    const results = await Promise.all([session.refreshSession(), session.refreshSession(), session.refreshSession()]);
    assert.equal(calls.length, 1);
    assert.equal(new Set(results).size, 1);
});

test('signs out when the server says the session is over', async () => {
    store.set('bies_token', tokenExpiringIn(-5));
    store.set('bies_user', '{}');
    answers.push({ status: 401, body: { reason: 'session_ended' } });

    assert.equal(await session.refreshSession(), null);
    assert.equal(store.has('bies_token'), false);
    assert.equal(store.has('bies_user'), false);
    assert.deepEqual(events, ['bies:unauthorized']);
});

test('keeps the session when the server can’t be reached', async () => {
    const stale = tokenExpiringIn(-5);
    store.set('bies_token', stale);
    answers.push(new TypeError('Failed to fetch'));

    await assert.rejects(session.refreshSession());
    assert.equal(store.get('bies_token'), stale);
    assert.deepEqual(events, []);
    // freshAccessToken hands back the old token and lets the request fail on its own.
    answers.push(new TypeError('Failed to fetch'));
    assert.equal(await session.freshAccessToken(), stale);
});

test('a short-lived token isn’t refreshed on every call', () => {
    // 20-second tokens: refresh in the last 5 seconds, not the last 60.
    assert.equal(session.needsRefresh(tokenExpiringIn(15, 'x', 20)), false);
    assert.equal(session.needsRefresh(tokenExpiringIn(4, 'x', 20)), true);
    assert.equal(session.needsRefresh(tokenExpiringIn(61)), false);
    assert.equal(session.needsRefresh(tokenExpiringIn(59)), true);
    assert.equal(session.needsRefresh('garbage'), true);
});

test('refreshes ahead of expiry, not on every call', async () => {
    const plenty = tokenExpiringIn(600);
    store.set('bies_token', plenty);
    assert.equal(await session.freshAccessToken(), plenty);
    assert.equal(calls.length, 0);

    store.set('bies_token', tokenExpiringIn(30));
    answers.push({ body: { token: tokenExpiringIn(900, 'renewed') } });
    assert.notEqual(await session.freshAccessToken(), plenty);
    assert.equal(calls.length, 1);
});

test('a refresh still in flight at logout doesn’t sign back in', async () => {
    store.set('bies_token', tokenExpiringIn(-5));
    answers.push({ body: { token: tokenExpiringIn(900) } }); // the refresh
    answers.push({ body: {} }); // the logout

    const pending = session.refreshSession();
    const loggedOut = session.logoutSession();
    assert.equal(await pending, null);
    await loggedOut;
    assert.equal(store.has('bies_token'), false);
});

// ─── Logout ──────────────────────────────────────────────────────────────────

test('logout tells the server with the access token, and the native refresh token', async () => {
    native = true;
    const token = tokenExpiringIn(600);
    store.set('bies_token', token);
    store.set('bies_refresh', 'rt1.s.one');
    answers.push({ body: {} });

    await session.logoutSession();
    assert.equal(calls[0].url, '/api/auth/logout');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(calls[0].body, { refreshToken: 'rt1.s.one' });
    assert.equal(store.size, 0);
});

test('an offline logout finishes on the next launch', async () => {
    native = true;
    const token = tokenExpiringIn(600);
    store.set('bies_token', token);
    store.set('bies_refresh', 'rt1.s.0.one');
    answers.push(new TypeError('Failed to fetch'));

    await session.logoutSession({ pushToken: 'apns-1' });
    assert.equal(store.has('bies_token'), false, 'signed out locally at once');
    assert.equal(store.has('bies_refresh'), false);
    assert.equal(JSON.parse(store.get('bies_logout_pending')).length, 1);

    answers.push({ body: {} });
    await session.retryPendingLogout();
    assert.equal(calls[1].init.headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(calls[1].body, { refreshToken: 'rt1.s.0.one', pushToken: 'apns-1' });
    assert.equal(store.has('bies_logout_pending'), false);
});

test('a logout the server refuses is retried too, not dropped', async () => {
    store.set('bies_token', tokenExpiringIn(600));
    answers.push({ status: 500, body: { error: 'Logout failed' } });
    await session.logoutSession();
    assert.equal(JSON.parse(store.get('bies_logout_pending')).length, 1);
});

test('a retried logout after a new sign-in ends only the old session', async () => {
    native = true;
    const old = tokenExpiringIn(600, 'old');
    store.set('bies_token', old);
    store.set('bies_refresh', 'rt1.old.0.mac');
    answers.push(new TypeError('Failed to fetch'));
    await session.logoutSession();

    // Signed in again before the retry.
    session.saveSession({ token: tokenExpiringIn(900, 'new'), refreshToken: 'rt1.new.0.mac' });
    answers.push({ body: {} });
    await session.retryPendingLogout();
    assert.equal(calls[1].init.headers.Authorization, `Bearer ${old}`);
    assert.deepEqual(calls[1].body, { refreshToken: 'rt1.old.0.mac' });
    assert.equal(store.get('bies_refresh'), 'rt1.new.0.mac', 'the new session is untouched');
    assert.equal(store.has('bies_logout_pending'), false);
});

// ─── The request wrapper (api.js) ────────────────────────────────────────────

test('api: refreshes and resends once when the token has expired', async () => {
    store.set('bies_token', tokenExpiringIn(600, 'thought-valid'));
    const fresh = tokenExpiringIn(900, 'fresh');
    answers.push({ status: 401, body: { reason: 'token_expired' } });
    answers.push({ body: { token: fresh } });
    answers.push({ body: { id: 'u1' } });

    assert.deepEqual(await api.authApi.me(), { id: 'u1' });
    assert.equal(calls[1].url, '/api/auth/refresh');
    assert.equal(calls[2].init.headers.Authorization, `Bearer ${fresh}`);
});

test('api: signs out when the session is over, not on other errors', async () => {
    store.set('bies_token', tokenExpiringIn(600));
    answers.push({ status: 403, body: { error: 'Requires one of: ADMIN' } });
    await assert.rejects(api.authApi.me());
    assert.equal(store.has('bies_token'), true);

    // A 401 that isn't about the session (a route's own check) keeps it too.
    answers.push({ status: 401, body: { error: 'Invalid signature' } });
    await assert.rejects(api.authApi.me());
    assert.equal(store.has('bies_token'), true);

    answers.push({ status: 401, body: { reason: 'suspended' } });
    await assert.rejects(api.authApi.me());
    assert.equal(store.has('bies_token'), false);
    assert.deepEqual(events, ['bies:unauthorized']);
});

test('api: a wrong sign-in code leaves the current session alone', async () => {
    store.set('bies_token', tokenExpiringIn(600));
    answers.push({ status: 401, body: { error: 'Invalid signature' } });
    await assert.rejects(api.authApi.nostrLogin('ab'.repeat(32), {}, null));
    assert.equal(store.has('bies_token'), true);
    assert.deepEqual(events, []);
});
