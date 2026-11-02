/**
 * Repeating events in the app (src/utils/eventRepeat.js): the repeats the
 * form offers for a first date, how a choice holds up when the date moves,
 * and how a repeating event reads, in El Salvador time and in both
 * languages (with the real locale strings).
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    dateChip, fitRepeat, inLastWeek, repeatChoiceLabel, repeatChoices, repeatLabel, weekOfMonth, weekdayName,
} from '../../src/utils/eventRepeat.js';

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

/** A moment in El Salvador time (UTC-6). */
const sv = (text) => new Date(`${text.replace(' ', 'T')}:00-06:00`).toISOString();

const SAT_7_NOV = sv('2026-11-07 09:00'); // the first Saturday of November 2026
const SAT_28_NOV = sv('2026-11-28 09:00'); // its last
const SAT_31_OCT = sv('2026-10-31 09:00'); // October's fifth and last Saturday

test('the choices a first date has, as Google Calendar offers them', () => {
    assert.deepEqual(repeatChoices(SAT_7_NOV), ['', 'WEEKLY', 'BIWEEKLY', 'MONTHLY_NTH']);
    assert.deepEqual(repeatChoices(SAT_28_NOV), ['', 'WEEKLY', 'BIWEEKLY', 'MONTHLY_NTH', 'MONTHLY_LAST']);
    // A fifth Saturday isn't in every month: only "the last" then.
    assert.deepEqual(repeatChoices(SAT_31_OCT), ['', 'WEEKLY', 'BIWEEKLY', 'MONTHLY_LAST']);
    // No date yet: only "Doesn't repeat".
    assert.deepEqual(repeatChoices(null), ['']);
    assert.deepEqual(repeatChoices('not a date'), ['']);
});

test('the choices read as in a calendar app', () => {
    const labels = (date, t, lang) => repeatChoices(date).map((r) => repeatChoiceLabel(r, date, t, lang));
    assert.deepEqual(labels(SAT_28_NOV, en, 'en'), [
        "Doesn't repeat", 'Every week on Saturday', 'Every other Saturday', 'Every month on the fourth Saturday', 'Every month on the last Saturday',
    ]);
    assert.deepEqual(labels(SAT_7_NOV, es, 'es'), [
        'No se repite', 'Cada semana el sábado', 'Cada dos semanas el sábado', 'Cada mes el primer sábado',
    ]);
});

test('a repeating event in a list: the short label', () => {
    assert.equal(repeatLabel('WEEKLY', SAT_7_NOV, en, 'en'), 'Every Saturday');
    assert.equal(repeatLabel('BIWEEKLY', SAT_7_NOV, en, 'en'), 'Every other Saturday');
    assert.equal(repeatLabel('MONTHLY_NTH', SAT_7_NOV, en, 'en'), 'First Saturday of every month');
    assert.equal(repeatLabel('MONTHLY_NTH', sv('2026-11-26 18:00'), en, 'en'), 'Fourth Thursday of every month');
    assert.equal(repeatLabel('MONTHLY_LAST', SAT_28_NOV, en, 'en'), 'Last Saturday of every month');
    assert.equal(repeatLabel('MONTHLY_NTH', SAT_7_NOV, es, 'es'), 'Primer sábado de cada mes');
    assert.equal(repeatLabel('MONTHLY_LAST', SAT_28_NOV, es, 'es'), 'Último sábado de cada mes');
    assert.equal(repeatLabel('WEEKLY', SAT_7_NOV, es, 'es'), 'Cada sábado');
    // A one-off has none.
    assert.equal(repeatLabel('', SAT_7_NOV, en, 'en'), '');
    assert.equal(repeatLabel(undefined, SAT_7_NOV, en, 'en'), '');
});

test('weekdays and weeks are El Salvador\'s: 11 PM Saturday there is Sunday in UTC', () => {
    const late = sv('2026-11-07 23:00');
    assert.equal(late, '2026-11-08T05:00:00.000Z');
    assert.equal(weekdayName(late, 'en'), 'Saturday');
    assert.equal(weekOfMonth(late), 1);
    assert.equal(repeatChoiceLabel('MONTHLY_NTH', late, en, 'en'), 'Every month on the first Saturday');
    // 31 October at 11 PM is 1 November in UTC: still October's last Saturday.
    const lastSat = sv('2026-10-31 23:00');
    assert.equal(inLastWeek(lastSat), true);
    assert.deepEqual(repeatChoices(lastSat), ['', 'WEEKLY', 'BIWEEKLY', 'MONTHLY_LAST']);
    // And half past midnight on 1 November is the first Sunday.
    const early = sv('2026-11-01 00:30');
    assert.equal(inLastWeek(early), false);
    assert.equal(repeatLabel('MONTHLY_NTH', early, en, 'en'), 'First Sunday of every month');
});

test('the last week of 31, 30, 28 and 29-day months', () => {
    assert.equal(inLastWeek(sv('2026-12-25 12:00')), true); // 31 days: from the 25th
    assert.equal(inLastWeek(sv('2026-12-24 12:00')), false);
    assert.equal(inLastWeek(sv('2026-11-24 12:00')), true); // 30 days: from the 24th
    assert.equal(inLastWeek(sv('2026-11-23 12:00')), false);
    assert.equal(inLastWeek(sv('2027-02-22 12:00')), true); // 28 days: from the 22nd
    assert.equal(inLastWeek(sv('2027-02-21 12:00')), false);
    assert.equal(inLastWeek(sv('2028-02-23 12:00')), true); // 2028 is a leap year: from the 23rd
    assert.equal(inLastWeek(sv('2028-02-22 12:00')), false);
});

test('when the first date moves, the choice follows it sensibly', () => {
    // Weekly and every other week fit any date.
    assert.equal(fitRepeat('BIWEEKLY', SAT_31_OCT), 'BIWEEKLY');
    // The last Saturday, moved out of the month's last week: that Saturday of the month.
    assert.equal(fitRepeat('MONTHLY_LAST', SAT_7_NOV), 'MONTHLY_NTH');
    // The first Saturday, moved to a fifth: the last.
    assert.equal(fitRepeat('MONTHLY_NTH', SAT_31_OCT), 'MONTHLY_LAST');
    assert.equal(fitRepeat('MONTHLY_NTH', SAT_28_NOV), 'MONTHLY_NTH');
    assert.equal(fitRepeat('', SAT_7_NOV), '');
    // While the date is cleared, the choice waits for one.
    assert.equal(fitRepeat('MONTHLY_LAST', null), 'MONTHLY_LAST');
});

test('date chips', () => {
    assert.equal(dateChip(SAT_7_NOV, 'en'), 'Sat 7 Nov');
    assert.equal(dateChip(sv('2026-11-21 09:00'), 'en', { weekday: false }), '21 Nov');
    assert.equal(dateChip(sv('2026-11-07 23:00'), 'en'), 'Sat 7 Nov');
    assert.equal(dateChip(SAT_7_NOV, 'es'), 'Sáb 7 Nov');
});
