// The auth proxy against hostile clients (node --test index.test.mjs): bad
// AUTH messages and floods before sign-in close that connection and leave
// the proxy up for everyone else; a member taken off the whitelist is
// disconnected. Runs the real proxy with a stand-in upstream relay.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bies-proxy-'));
const whitelist = path.join(dir, 'whitelist.txt');
const UPSTREAM = 47781;
const PROXY = 47782;
const member = generateSecretKey();
let upstream;
let proxy;

before(async () => {
    fs.writeFileSync(whitelist, `${getPublicKey(member)}\n`);
    upstream = new WebSocketServer({ port: UPSTREAM });
    upstream.on('connection', (ws) => ws.on('message', (m) => ws.send(JSON.stringify(['ECHO', String(m)]))));
    proxy = spawn(process.execPath, ['index.js'], {
        cwd: path.dirname(new URL(import.meta.url).pathname),
        env: { ...process.env, PROXY_PORT: String(PROXY), UPSTREAM_RELAY: `ws://127.0.0.1:${UPSTREAM}`, WHITELIST_PATH: whitelist, RELAY_URL: `ws://127.0.0.1:${PROXY}`, RECHECK_MS: '200' },
        stdio: 'ignore',
    });
    for (let i = 0; i < 50; i++) {
        if (await connect().then((ws) => { ws.close(); return true; }, () => false)) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('proxy did not start');
});

after(() => {
    proxy?.kill();
    upstream?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PROXY}/relay`, { headers: { host: `127.0.0.1:${PROXY}` } });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}
const challengeOf = (ws) => new Promise((resolve) => ws.on('message', function onMsg(m) {
    const msg = JSON.parse(String(m));
    if (msg[0] === 'AUTH') { ws.off('message', onMsg); resolve(msg[1]); }
}));
const closed = (ws) => new Promise((resolve) => ws.once('close', (code) => resolve(code)));

test('a malformed AUTH closes that connection and the proxy stays up', async () => {
    for (const bad of [['AUTH', null], ['AUTH', 'x'], ['AUTH', { kind: 22242 }], ['AUTH', { kind: 22242, pubkey: 'a', tags: [1] }]]) {
        const ws = await connect();
        await challengeOf(ws);
        const done = closed(ws);
        ws.send(JSON.stringify(bad));
        assert.equal(await done, 4001, JSON.stringify(bad));
    }
    const ws = await connect();
    ws.close();
});

test('flooding before signing in closes the connection', async () => {
    const ws = await connect();
    await challengeOf(ws);
    const done = closed(ws);
    for (let i = 0; i < 60; i++) ws.send(JSON.stringify(['REQ', `s${i}`, { kinds: [1] }]));
    assert.equal(await done, 4001);
});

test('a member taken off the whitelist is disconnected', async () => {
    const ws = await connect();
    const challenge = await challengeOf(ws);
    const auth = finalizeEvent({
        kind: 22242, created_at: Math.floor(Date.now() / 1000), content: '',
        tags: [['relay', `ws://127.0.0.1:${PROXY}/relay`], ['challenge', challenge]],
    }, member);
    const ok = new Promise((resolve) => ws.on('message', (m) => { const msg = JSON.parse(String(m)); if (msg[0] === 'OK') resolve(msg[2]); }));
    ws.send(JSON.stringify(['AUTH', auth]));
    assert.equal(await ok, true);

    const done = closed(ws);
    fs.writeFileSync(whitelist, '');
    assert.equal(await done, 4003);
});
