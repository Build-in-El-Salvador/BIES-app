/**
 * The account screens' text (src/i18n/locales, `account.*`), rendered in both
 * languages through i18next and accountErrorMessage(): every server reason
 * has words, plurals included, and nothing shows as a raw key.
 *
 * Run: npm run test:unit   (node --test)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import i18next from 'i18next';
import { accountErrorMessage } from '../../src/components/account/accountErrors.js';

const en = JSON.parse(readFileSync(new URL('../../src/i18n/locales/en.json', import.meta.url)));
const es = JSON.parse(readFileSync(new URL('../../src/i18n/locales/es.json', import.meta.url)));
await i18next.init({
    resources: { en: { translation: en }, es: { translation: es } },
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
});

const reasons = [
    { reason: 'rate_limited', retryAfterSeconds: 30 },
    { reason: 'rate_limited', retryAfterSeconds: 600 },
    { reason: 'busy' },
    { reason: 'send_failed' },
    { reason: 'invalid_code', attemptsLeft: 1 },
    { reason: 'invalid_code', attemptsLeft: 3 },
    { reason: 'invalid_code', attemptsLeft: 0 },
    { reason: 'code_expired' },
    { reason: 'challenge_expired' },
    { reason: 'bad_signature' },
    { reason: 'not_hosted' },
    { reason: 'review_account' },
    { reason: 'something new' },
];

function keys(node, prefix = '') {
    return Object.entries(node).flatMap(([k, v]) =>
        (typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

test('English and Spanish have the same account text', () => {
    assert.deepEqual(keys(es.account).sort(), keys(en.account).sort());
});

for (const lng of ['en', 'es']) {
    test(`${lng}: every account error has words, plurals included`, () => {
        const t = i18next.getFixedT(lng);
        const out = reasons.map((data) => accountErrorMessage(t, { data }));
        for (const message of out) assert.ok(message && !message.startsWith('account.'), message);
        assert.notEqual(out[0], out[1], 'one minute vs many');
        assert.notEqual(out[4], out[5], 'one try left vs many');
        assert.notEqual(out[11], out[12], 'the review account has its own words');
        for (const n of [1, 2, 59]) assert.ok(!t('account.code.resendIn', { count: n }).startsWith('account.'));
    });
}
