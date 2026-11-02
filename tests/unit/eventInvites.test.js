/**
 * Invites to a proposed meetup in words (src/utils/eventFormat.js): the
 * first name in "Edwin invited you", and when a meetup still takes invites.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstNameOf, invitesOpen } from '../../src/utils/eventFormat.js';

test('the first word of a name; nothing for a placeholder', () => {
    assert.equal(firstNameOf('Edwin Rivas'), 'Edwin');
    assert.equal(firstNameOf('  Ana  '), 'Ana');
    assert.equal(firstNameOf('María José Pérez'), 'María');
    assert.equal(firstNameOf('nostr:1a2b3c4d'), '');
    assert.equal(firstNameOf(''), '');
    assert.equal(firstNameOf(undefined), '');
});

test('a meetup takes invites while people can join and before it starts', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const later = (h) => new Date(now + h * 3600_000).toISOString();
    assert.equal(invitesOpen({ stage: 'proposed', decideBy: later(24), startDate: later(48) }, now), true);
    assert.equal(invitesOpen({ stage: 'on', decideBy: later(-24), startDate: later(2) }, now), true);
    // Past its decide-by while still proposed: nobody can join.
    assert.equal(invitesOpen({ stage: 'proposed', decideBy: later(-1), startDate: later(48) }, now), false);
    assert.equal(invitesOpen({ stage: 'calledOff', decideBy: later(24), startDate: later(48) }, now), false);
    assert.equal(invitesOpen({ stage: 'on', decideBy: later(-48), startDate: later(-1) }, now), false);
    // A usual event isn't invited to this way.
    assert.equal(invitesOpen({ stage: null, startDate: later(48) }, now), false);
    assert.equal(invitesOpen(null, now), false);
});
