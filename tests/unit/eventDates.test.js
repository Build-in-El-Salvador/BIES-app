/**
 * One date of a repeating event in the app (src/utils/eventRepeat.js): the
 * notice when the next date is different, the question an edit asks, when
 * it asks it, and short times for the date chips. With the real locale
 * strings, in El Salvador time.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dateChangeNotice, editScope, scopeTitle, shortTime } from '../../src/utils/eventRepeat.js';

const locale = (lang) => JSON.parse(fs.readFileSync(new URL(`../../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
/** i18next's t, for these strings: a key's text with {{values}} filled in. */
const tFor = (lang) => {
    const strings = locale(lang);
    return (key, values = {}) => {
        const text = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), strings);
        assert.equal(typeof text, 'string', `${lang}: ${key} is missing`);
        return text.replace(/{{(\w+)}}/g, (_, name) => values[name]);
    };
};
const en = tFor('en');
const es = tFor('es');
const sv = (text) => new Date(`${text.replace(' ', 'T')}:00-06:00`).toISOString();

// BIES Soccer, Saturdays 4 to 6 PM at the usual field; on 7 November, 10 AM at the beach.
const usual = { startDate: sv('2026-11-07 16:00'), endDate: sv('2026-11-07 18:00'), title: 'BIES Soccer', locationName: 'Usual field', isOnline: false };
const change = (date, what) => ({ key: usual.startDate, time: false, place: false, title: false, details: false, ...what, date: { ...usual, ...date }, usual });

test('the notice says how the date differs, and how it usually is', () => {
    const both = change({ startDate: sv('2026-11-07 10:00'), endDate: sv('2026-11-07 12:00'), locationName: 'Beach field' }, { time: true, place: true });
    assert.deepEqual(dateChangeNotice(both, en, 'en'), {
        lead: 'Sat 7 Nov is different: 10:00 AM at Beach field.',
        usual: 'Usually 4:00 PM at Usual field.',
    });
    const time = change({ startDate: sv('2026-11-07 10:00') }, { time: true });
    assert.deepEqual(dateChangeNotice(time, en, 'en'), { lead: 'Sat 7 Nov is different: 10:00 AM.', usual: 'Usually 4:00 PM.' });
    const place = change({ locationName: 'Beach field' }, { place: true });
    assert.deepEqual(dateChangeNotice(place, en, 'en'), { lead: 'Sat 7 Nov is different: at Beach field.', usual: 'Usually at Usual field.' });
    const online = change({ isOnline: true, locationName: '' }, { place: true });
    assert.equal(dateChangeNotice(online, en, 'en').lead, 'Sat 7 Nov is different: online.');
    // Moved to the Sunday: its day too.
    const moved = change({ startDate: sv('2026-11-08 10:00') }, { time: true });
    assert.equal(dateChangeNotice(moved, en, 'en').lead, 'Sat 7 Nov is different: Sun 8 Nov, 10:00 AM.');
    // Another title or words only.
    assert.deepEqual(dateChangeNotice(change({ title: 'Final' }, { title: true }), en, 'en'), { lead: 'Sat 7 Nov is different from usual.', usual: '' });
    assert.equal(dateChangeNotice(null, en, 'en'), null);
});

test('the notice in Spanish', () => {
    const both = change({ startDate: sv('2026-11-07 10:00'), locationName: 'Beach field' }, { time: true, place: true });
    const notice = dateChangeNotice(both, es, 'es');
    assert.match(notice.lead, /^El Sáb 7 Nov es distinto: 10:00 a\. m\. en Beach field\.$/);
    assert.match(notice.usual, /^Normalmente 4:00 p\. m\. en Usual field\.$/);
});

test('the question names the event and how it repeats', () => {
    assert.equal(scopeTitle('BIES Soccer', 'WEEKLY', usual.startDate, en, 'en'), 'BIES Soccer repeats every Saturday');
    assert.equal(scopeTitle('BIES Soccer', 'BIWEEKLY', usual.startDate, en, 'en'), 'BIES Soccer repeats every other Saturday');
    assert.equal(scopeTitle('BIES Soccer', 'MONTHLY_NTH', usual.startDate, en, 'en'), 'BIES Soccer repeats first Saturday of every month');
    assert.equal(scopeTitle('BIES Soccer', 'WEEKLY', usual.startDate, es, 'es'), 'BIES Soccer se repite cada sábado');
});

test('an edit asks which dates only when it changes what a date can have of its own', () => {
    const before = {
        title: 'BIES Soccer', description: '<p>Five-a-side</p>', startDate: '2026-11-07', startTime: '16:00', endDate: '2026-11-07', endTime: '18:00',
        online: false, locationName: 'Usual field', locationAddress: '', locationMapUrl: '', onlineUrl: '',
        repeat: 'WEEKLY', repeatUntil: '', thumbnail: '', ticketUrl: '', priceLabel: 'Free',
    };
    assert.equal(editScope(before, { ...before }), 'series');
    assert.equal(editScope(before, { ...before, startTime: '10:00' }), 'ask');
    assert.equal(editScope(before, { ...before, locationName: 'Beach field' }), 'ask');
    assert.equal(editScope(before, { ...before, title: 'BIES Football' }), 'ask');
    assert.equal(editScope(before, { ...before, online: true }), 'ask');
    // What's the event's for every date anyway: no question.
    assert.equal(editScope(before, { ...before, thumbnail: '/uploads/new.jpg', priceLabel: '$5' }), 'series');
    // How it repeats is for every date, whatever else changed with it.
    assert.equal(editScope(before, { ...before, repeat: 'BIWEEKLY', startTime: '10:00' }), 'series');
    assert.equal(editScope(before, { ...before, repeatUntil: '2026-12-19' }), 'series');
});

test('date chips keep times short', () => {
    assert.equal(shortTime(sv('2026-11-07 10:00'), 'en'), '10 AM');
    assert.equal(shortTime(sv('2026-11-07 16:30'), 'en'), '4:30 PM');
    assert.equal(shortTime(sv('2026-11-07 23:00'), 'en'), '11 PM');
    assert.match(shortTime(sv('2026-11-07 10:00'), 'es'), /^10 a\. m\.$/);
});
