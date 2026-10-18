/**
 * Opportunities' lists and helpers (src/components/opportunities/
 * opportunityOptions.js): the app's lists and limits match the server's,
 * each type's money and summary, El Salvador's day for closing, and the
 * amounts people type.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    OPPORTUNITY_TYPES, OPPORTUNITY_KINDS, KIND_REQUIRED, INDUSTRIES, STAGES, MAX_PHOTOS, MAX_OPEN, TYPE_FIELDS,
    amountOf, daysLeft, elSalvadorToday, formatDay, fullDollars, hasField, industryOf, isOpen, parseDollars,
    plainText, shortDollars, summaryOf, typeLine, typesShown, isTypeShown,
} from '../../src/components/opportunities/opportunityOptions.js';

const server = readFileSync(new URL('../../server/src/controllers/project.controller.ts', import.meta.url), 'utf8');
const quoted = (text) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const serverList = (name) => quoted(server.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))[1]);
const serverBlock = (name) => server.match(new RegExp(`(?:export )?const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\};`))[1];
/** A `type: [...]` entry of a block of lists (OPPORTUNITY_KINDS, TYPE_FIELDS). */
const entryOf = (block, type) => quoted(block.match(new RegExp(`'?${type}'?: \\[([^\\]]*)\\]`))[1]);
const numberIn = (name) => Number(server.match(new RegExp(`export const ${name} = (\\d+);`))[1]);

test("the app's lists and limits are the server's", () => {
    assert.deepEqual(OPPORTUNITY_TYPES, serverList('OPPORTUNITY_TYPES'));
    assert.deepEqual(INDUSTRIES, serverList('INDUSTRIES'));
    assert.deepEqual(STAGES, serverList('STAGES'));
    assert.deepEqual(KIND_REQUIRED, quoted(server.match(/const KIND_REQUIRED[^=]*= \[([^\]]*)\]/)[1]));
    const kinds = serverBlock('OPPORTUNITY_KINDS');
    const fields = serverBlock('TYPE_FIELDS');
    for (const type of OPPORTUNITY_TYPES) {
        assert.deepEqual(OPPORTUNITY_KINDS[type], entryOf(kinds, type), `kinds of ${type}`);
        assert.deepEqual(TYPE_FIELDS[type], entryOf(fields, type), `fields of ${type}`);
    }
    assert.equal(MAX_PHOTOS, numberIn('MAX_PHOTOS'));
    assert.equal(MAX_OPEN, numberIn('MAX_OPEN_PER_MEMBER'));
});

test('every type and kind has its words, in English and Spanish', () => {
    for (const lang of ['en', 'es']) {
        const locale = JSON.parse(readFileSync(new URL(`../../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
        const words = locale.opportunities;
        // The Report sheet's title for one.
        assert.ok(locale.moderation.report.title.opportunity, `${lang} report title`);
        for (const type of OPPORTUNITY_TYPES) {
            assert.ok(words.types[type] && words.typesPlural[type] && words.typeHints[type], `${lang} ${type}`);
            assert.ok(words.form.createTitles[type] && words.form.titlePlaceholder[type] && words.form.descriptionPlaceholder[type], `${lang} form ${type}`);
            for (const kind of OPPORTUNITY_KINDS[type]) assert.ok(words.kinds[type][kind], `${lang} ${type}.${kind}`);
            if (OPPORTUNITY_KINDS[type].length) assert.ok(words.filters.kind[type] && words.form.kindLabel[type], `${lang} kind label ${type}`);
            if (hasField(type, 'btcAccepted')) assert.ok(words.form.btcLabel[type] && words.filters.btc[type], `${lang} btc ${type}`);
            if (hasField(type, 'remote')) assert.ok(words.form.remoteLabel[type], `${lang} remote ${type}`);
            if (amountOf({ type })) assert.ok(words.filters.amount[type], `${lang} amount ${type}`);
        }
        for (const industry of INDUSTRIES) assert.ok(words.industries[industry], `${lang} ${industry}`);
        for (const stage of STAGES) assert.ok(words.stages[stage], `${lang} ${stage}`);
    }
});

test("each type's money: a raise, a price, the most a program gives", () => {
    assert.deepEqual(amountOf({ type: 'investment', fundingGoal: 250000 }), { field: 'fundingGoal', value: 250000 });
    assert.deepEqual(amountOf({ type: 'business-for-sale' }), { field: 'price', value: null });
    assert.deepEqual(amountOf({ type: 'program', price: 10000 }), { field: 'price', value: 10000 });
    assert.equal(amountOf({ type: 'job', price: 5 }), null);
    assert.equal(amountOf({ type: 'partnership' }), null);
});

test('dollars, short and in full', () => {
    assert.equal(shortDollars(900), '$900');
    assert.equal(shortDollars(25000), '$25K');
    assert.equal(shortDollars(250000), '$250K');
    assert.equal(shortDollars(1200000), '$1.2M');
    assert.equal(shortDollars(5000000), '$5M');
    assert.equal(shortDollars(0), '');
    assert.equal(shortDollars(null), '');
    assert.equal(fullDollars(250000), '$250,000');
});

test('amounts typed as people do', () => {
    assert.equal(parseDollars('250000'), 250000);
    assert.equal(parseDollars('$250,000'), 250000);
    assert.equal(parseDollars('250k'), 250000);
    assert.equal(parseDollars('1.5M'), 1500000);
    assert.equal(parseDollars(''), null);
    assert.equal(parseDollars('   '), null);
    assert.ok(Number.isNaN(parseDollars('a lot')));
    assert.ok(Number.isNaN(parseDollars('-5')));
});

test("open and closing go by El Salvador's day", () => {
    // 05:00 UTC on 18 Oct is still 17 Oct in El Salvador (UTC−6).
    assert.equal(elSalvadorToday(new Date('2026-10-18T05:00:00Z')), '2026-10-17');
    assert.equal(elSalvadorToday(new Date('2026-10-18T06:00:00Z')), '2026-10-18');
    const today = '2026-10-17';
    assert.equal(isOpen({ closesOn: '2026-10-17' }, today), true);
    assert.equal(isOpen({ closesOn: '2026-10-16' }, today), false);
    assert.equal(isOpen({ closesOn: '' }, today), true);
    assert.equal(isOpen({ closedAt: '2026-10-01T00:00:00Z' }, today), false);
    // What the server says wins.
    assert.equal(isOpen({ isOpen: false, closesOn: '' }, today), false);
    assert.equal(daysLeft({ closesOn: '2026-10-17' }, today), 0);
    assert.equal(daysLeft({ closesOn: '2026-10-27' }, today), 10);
    assert.equal(daysLeft({ closesOn: '' }, today), null);
    assert.equal(formatDay('2026-11-30', 'en'), '30 Nov 2026');
});

test("older projects' formatted descriptions read as text, a line for each line", () => {
    // What the old editor (a contentEditable) saved.
    assert.equal(plainText('First<div>Second</div><div><br></div><div>Fourth</div>'), 'First\nSecond\n\nFourth');
    assert.equal(plainText('<p>One</p><p>Two <b>bold</b></p>'), 'One\n\nTwo bold');
    assert.equal(plainText('<ul><li>Solar</li><li>Coffee</li></ul>'), 'Solar\nCoffee');
    // Plain text, even with a < in it, stays as it is.
    assert.equal(plainText('Raising 2 < 3 rounds\nLine two'), 'Raising 2 < 3 rounds\nLine two');
    // So does what's typed in angle brackets: an email, a link, a note.
    const typed = 'Send your CV to Ana <ana@cafe.sv> or apply at <https://cafe.sv/jobs> <in person welcome>';
    assert.equal(plainText(typed), typed);
    assert.equal(plainText(''), '');
    assert.equal(plainText(null), '');
});

test("older projects' industries show as today's", () => {
    assert.equal(industryOf('FITNESS'), 'HEALTH');
    assert.equal(industryOf('WEB3'), 'TECHNOLOGY');
    assert.equal(industryOf('SAAS'), 'TECHNOLOGY');
    assert.equal(industryOf('ECOMMERCE'), 'RETAIL');
    assert.equal(industryOf('TOURISM'), 'TOURISM');
    assert.equal(industryOf('SOMETHING_ELSE'), 'OTHER');
    assert.equal(industryOf(''), '');
});

test("a card's lines: its type and kind, then what matters for its type", () => {
    const t = (key, vars) => (vars ? `${key}(${Object.values(vars).join(',')})` : key);
    assert.equal(typeLine({ type: 'job', kind: 'full-time' }, t), 'opportunities.types.job · opportunities.kinds.job.full-time');
    assert.equal(typeLine({ type: 'business-for-sale', kind: 'grant' }, t), 'opportunities.types.business-for-sale');
    assert.equal(summaryOf({ type: 'investment', fundingGoal: 250000, stage: 'MVP' }, t), 'opportunities.card.raising($250K) · opportunities.stages.MVP');
    assert.equal(summaryOf({ type: 'business-for-sale', category: 'TOURISM' }, t), 'opportunities.card.priceOnRequest · opportunities.industries.TOURISM');
    assert.equal(summaryOf({ type: 'job', kind: 'part-time', pay: '$900 a month', category: 'FOOD' }, t), 'opportunities.kinds.job.part-time · $900 a month');
    assert.equal(summaryOf({ type: 'partnership', kind: 'co-founder', category: 'TECHNOLOGY' }, t), 'opportunities.kinds.partnership.co-founder · opportunities.industries.TECHNOLOGY');
    assert.equal(summaryOf({ type: 'program', kind: 'grant', price: 10000 }, t), 'opportunities.kinds.program.grant · opportunities.card.upTo($10K)');
    // A kind that isn't its type's isn't shown.
    assert.equal(summaryOf({ type: 'program', kind: 'full-time' }, t), '');
});

test('the phone app leaves investments out; the website shows every type', () => {
    assert.deepEqual(typesShown(false), OPPORTUNITY_TYPES);
    assert.deepEqual(typesShown(true), ['business-for-sale', 'job', 'partnership', 'program']);
    assert.equal(isTypeShown('job', true), true);
    assert.equal(isTypeShown('investment', true), false);
    // An older project, with no type, is an investment.
    assert.equal(isTypeShown(undefined, true), false);
    assert.equal(isTypeShown(undefined, false), true);
});
