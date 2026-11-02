import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardDate, cardText, SHARE_ASPECT, shareFormat } from '../../src/utils/shareCard.js';

test('a shared event says when it starts as the BIES posters do, in El Salvador', () => {
    // Sat 14 Nov 2026, 7:00 PM in El Salvador (UTC-6)
    assert.equal(cardDate('2026-11-15T01:00:00.000Z'), 'Saturday, November 14 · 7 PM');
    assert.equal(cardDate(new Date('2026-11-07T14:30:00.000Z')), 'Saturday, November 7 · 8:30 AM');
    assert.equal(cardDate(''), '');
    assert.equal(cardDate('not a date'), '');
});

test('a BIES event shares a square poster; any other, the wide card', () => {
    assert.equal(shareFormat(true), 'square');
    assert.equal(shareFormat(false), 'wide');
    assert.equal(SHARE_ASPECT.square, 1);
    // The wide card is 1200 × 630; its cover is the right 792px.
    assert.equal(SHARE_ASPECT.wide, 792 / 630);
});

test("a card's name and place leave out emoji and letters its font lacks, as the server does", () => {
    assert.equal(cardText('🎉 Party 🇸🇻 time 👍🏽 ❤️ ☕'), 'Party time');
    assert.equal(cardText('Café\nPlaya  1️⃣ 👨‍👩‍👧'), 'Café Playa 1');
    assert.equal(cardText('Cafe\u0301 中文 Ñandú — “sí”'), 'Café Ñandú — “sí”');
    assert.equal(cardText('🎉🎉'), '');
    assert.equal(cardText(undefined), '');
});
