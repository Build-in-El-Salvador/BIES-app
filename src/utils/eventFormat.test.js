import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    dayTile, timeOf, whenShort, fullDay, timeRange, dayKey, monthKey, monthHeading,
    toFormFields, fromFormFields, ticketProvider, hostOf, partnerPath, isFree,
} from './eventFormat.js';

// Sat 14 Nov 2026, 7:00 PM in El Salvador = 01:00 UTC on the 15th.
const NIGHT = '2026-11-15T01:00:00.000Z';
const LATE = '2026-11-15T05:00:00.000Z'; // 11:00 PM

test('times are El Salvador time, whatever the device says', () => {
    assert.deepEqual(dayTile(NIGHT, 'en'), { month: 'Nov', day: '14', weekday: 'Sat' });
    assert.equal(whenShort(NIGHT, 'en'), 'Sat 14 Nov · 7:00 PM');
    assert.equal(fullDay(NIGHT, 'en'), 'Saturday 14 November');
    assert.equal(dayKey(NIGHT), '2026-11-14');
    assert.equal(monthKey(NIGHT), '2026-11');
});

test('a time range, on one day or across two', () => {
    assert.equal(timeRange(NIGHT, LATE, 'en'), '7:00 PM – 11:00 PM');
    assert.equal(timeRange(NIGHT, null, 'en'), '7:00 PM');
    assert.equal(timeRange(NIGHT, '2026-11-15T08:00:00.000Z', 'en'), 'Sat 14 Nov, 7:00 PM – Sun 15 Nov, 2:00 AM');
});

test('Spanish reads as Spanish', () => {
    assert.equal(dayTile(NIGHT, 'es').weekday, 'Sáb');
    assert.equal(fullDay(NIGHT, 'es'), 'Sábado 14 Noviembre');
    assert.match(timeOf(NIGHT, 'es'), /^7:00/);
});

test('month headings name the year only when it is not this one', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    assert.equal(monthHeading(NIGHT, 'en', now), 'November');
    assert.equal(monthHeading('2027-01-10T18:00:00Z', 'en', now), 'January 2027');
});

test("the form's fields round-trip in El Salvador time (no day lost on save)", () => {
    assert.deepEqual(toFormFields(NIGHT), { date: '2026-11-14', time: '19:00' });
    assert.equal(fromFormFields('2026-11-14', '19:00'), NIGHT);
    assert.equal(fromFormFields(...Object.values(toFormFields(NIGHT))), NIGHT);
    assert.equal(fromFormFields('', '19:00'), null);
    assert.deepEqual(toFormFields(null), { date: '', time: '' });
});

test('where tickets are sold, by the link', () => {
    assert.equal(ticketProvider('https://lu.ma/bies-night'), 'Luma');
    assert.equal(ticketProvider('https://luma.com/event/x'), 'Luma');
    assert.equal(ticketProvider('https://pretix.eu/bies/night/'), 'pretix');
    assert.equal(ticketProvider('https://www.eventbrite.com/e/123'), 'Eventbrite');
    assert.equal(ticketProvider('https://tickets.example.sv/a'), 'tickets.example.sv');
    assert.equal(ticketProvider('not a link'), '');
});

test('who hosts it: its business, else the member', () => {
    const member = { host: { id: 'u1', nostrPubkey: 'pk', profile: { name: 'Mateo', avatar: '/a.jpg' } } };
    assert.deepEqual(hostOf(member), { kind: 'member', name: 'Mateo', image: '/a.jpg', path: '/builder/pk' });
    const farm = { ...member, hostListing: { id: 'l1', name: 'Finca', type: 'FARM', logo: '', photo: '/p.jpg', isOfficial: false } };
    assert.deepEqual(hostOf(farm), { kind: 'listing', name: 'Finca', image: '/p.jpg', path: '/farms/l1', isOfficial: false });
    assert.equal(partnerPath({ kind: 'listing', listingId: 'b1', listingType: 'PROVIDER' }), '/trusted/b1');
    assert.equal(partnerPath({ kind: 'member', userId: 'u2' }), '/builder/u2');
    assert.equal(partnerPath({ kind: 'other', name: 'X' }), '');
});

test('free: said so, or no ticket link and no price', () => {
    assert.equal(isFree({ priceLabel: 'Free' }), true);
    assert.equal(isFree({ priceLabel: 'gratis ' }), true);
    assert.equal(isFree({ priceLabel: '', ticketUrl: '' }), true);
    assert.equal(isFree({ priceLabel: '$15', ticketUrl: 'https://lu.ma/x' }), false);
    assert.equal(isFree({ priceLabel: '', ticketUrl: 'https://lu.ma/x' }), false);
});
