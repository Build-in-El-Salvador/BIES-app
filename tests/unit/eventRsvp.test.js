/**
 * "I'm going" on an event's page (src/components/events/eventRsvp.js): when
 * the date an event shows is over (no answer then), and what a failed answer
 * says.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isOver, rsvpErrorText, OVER_AFTER_MS } from '../../src/components/events/eventRsvp.js';

const now = Date.parse('2026-11-03T18:00:00Z');
const at = (hoursFromNow) => new Date(now + hoursFromNow * 3600_000).toISOString();

test('an event with an end is over once the end has passed', () => {
    assert.equal(isOver({ startDate: at(-3), endDate: at(-1) }, now), true);
    assert.equal(isOver({ startDate: at(-3), endDate: at(1) }, now), false);
    assert.equal(isOver({ startDate: at(2), endDate: at(4) }, now), false);
});

test('the end decides, not start + 6 h, when there is one', () => {
    // A day-long event that started 8 hours ago and ends tonight is still on.
    assert.equal(isOver({ startDate: at(-8), endDate: at(3) }, now), false);
    // One that ended an hour after it started, two hours ago, is over.
    assert.equal(isOver({ startDate: at(-3), endDate: at(-2) }, now), true);
});

test('with no end it is over six hours after its start', () => {
    assert.equal(OVER_AFTER_MS, 6 * 3600_000);
    assert.equal(isOver({ startDate: at(-5), endDate: null }, now), false);
    assert.equal(isOver({ startDate: at(-7) }, now), true);
    assert.equal(isOver({ startDate: new Date(now - OVER_AFTER_MS).toISOString() }, now), false, 'exactly six hours: not yet');
    assert.equal(isOver({ startDate: new Date(now - OVER_AFTER_MS - 1).toISOString() }, now), true);
    assert.equal(isOver({ startDate: at(24) }, now), false);
});

test('an event without a usable date is never taken as over', () => {
    assert.equal(isOver({}, now), false);
    assert.equal(isOver({ startDate: 'not a date' }, now), false);
    assert.equal(isOver({ startDate: at(-1), endDate: 'not a date' }, now), false);
    assert.equal(isOver(null, now), false);
});

test('it is over now by default', () => {
    assert.equal(isOver({ startDate: '2020-01-01T10:00:00Z' }), true);
    assert.equal(isOver({ startDate: new Date(Date.now() + 3600_000).toISOString() }), false);
});

const fallback = "Couldn't save your answer. Try again.";
const apiError = (status, data) => Object.assign(new Error(data?.error || `Request failed (${status})`), { status, data });

test("a failed answer says the server's reason when it gave one", () => {
    assert.equal(rsvpErrorText(apiError(409, { error: 'Event is at full capacity', reason: 'full' }), fallback), 'Event is at full capacity');
    assert.equal(rsvpErrorText(apiError(403, { error: 'This event is invite only' }), fallback), 'This event is invite only');
});

test('offline, no answer or a server fault: the fixed line', () => {
    // fetch itself failing (offline): no status, no data.
    assert.equal(rsvpErrorText(new TypeError('Failed to fetch'), fallback), fallback);
    // The API client's "could not reach the server" (503) and other 5xx.
    assert.equal(rsvpErrorText(apiError(503, { error: 'Could not reach the server. Please try again.' }), fallback), fallback);
    assert.equal(rsvpErrorText(apiError(500, { error: 'Failed to RSVP' }), fallback), fallback);
    // A 4xx without words, or blank ones.
    assert.equal(rsvpErrorText(apiError(400, {}), fallback), fallback);
    assert.equal(rsvpErrorText(apiError(400, { error: '   ' }), fallback), fallback);
    assert.equal(rsvpErrorText(undefined, fallback), fallback);
});

test('the fixed line is there in English and Spanish', () => {
    for (const lang of ['en', 'es']) {
        const strings = JSON.parse(fs.readFileSync(new URL(`../../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
        const text = strings.events?.detail?.rsvpFailed;
        assert.equal(typeof text, 'string', `${lang}: events.detail.rsvpFailed is missing`);
        assert.ok(text.trim().length > 0);
    }
    const en = JSON.parse(fs.readFileSync(new URL('../../src/i18n/locales/en.json', import.meta.url), 'utf8'));
    assert.equal(en.events.detail.rsvpFailed, fallback);
});
