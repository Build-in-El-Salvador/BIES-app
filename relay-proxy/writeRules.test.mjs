// node --test writeRules.test.mjs: what the proxy doesn't pass on from a
// member, beside the word filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteRules } from './writeRules.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bies-write-rules-'));
const removedPath = path.join(dir, 'removed.txt');
const ME = 'a'.repeat(64);
const REMOVED = '1'.repeat(64);
const event = (id, kind = 1, tags = []) => ['EVENT', { id, kind, tags, pubkey: ME, content: 'hi' }];

test('a removed post, and a repost of it, stay out; other events pass', () => {
    const rules = createWriteRules({ removedPath });
    assert.equal(rules.refusal(event(REMOVED), ME, 100), null, 'nothing removed yet');
    fs.writeFileSync(removedPath, `${REMOVED}\nnot-an-id\n`);
    assert.deepEqual(rules.refusal(event(REMOVED), ME, 100), ['OK', REMOVED, false, 'blocked: removed by a moderator']);
    assert.equal(rules.refusal(event('2'.repeat(64), 6, [['e', REMOVED], ['p', ME]]), ME, 100)[2], false);
    assert.equal(rules.refusal(event('3'.repeat(64), 16, [['e', REMOVED]]), ME, 100)[2], false);
    // A reply that mentions it isn't a repost; other messages aren't events.
    assert.equal(rules.refusal(event('4'.repeat(64), 1, [['e', REMOVED, '', 'reply']]), ME, 100), null);
    assert.equal(rules.refusal(['REQ', 'sub', { ids: [REMOVED] }], ME, 100), null);
});

test('a member writes so much a minute, an hour and a day; then waits', () => {
    let clock = 0;
    const rules = createWriteRules({ removedPath: path.join(dir, 'none.txt'), limits: { perMinute: 3, perHour: 5, bytesPerDay: 1000 }, now: () => clock });
    const send = (who = ME, bytes = 10) => rules.refusal(event(String(++clock).padStart(64, '0')), who, bytes);
    for (let i = 0; i < 3; i++) assert.equal(send(), null);
    assert.match(send()[3], /^rate-limited:/);
    assert.equal(send('b'.repeat(64)), null, 'another member is counted on their own');
    clock += 61_000;
    assert.equal(send(), null);
    assert.equal(send(), null);
    assert.match(send()[3], /^rate-limited:/, 'five an hour');
    clock += 3_600_000;
    assert.match(send(ME, 2000)[3], /^rate-limited:/, 'bytes a day');
    assert.equal(send(ME, 100), null);
});
