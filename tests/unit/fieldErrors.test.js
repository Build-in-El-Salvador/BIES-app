import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldErrorText } from '../../src/utils/fieldErrors.js';

const words = {
    'common.fieldNames.phone': 'the phone number',
    'common.fieldNames.website': 'the website',
    'common.fieldNames.hours': 'the hours',
    'common.fieldNames.something': 'a field',
    'common.checkTheForm': 'Check the form, then try again.',
    'common.and': 'and',
};
const t = (key, vars) => (key === 'common.checkFields' ? `Check ${vars.fields}, then try again.` : words[key] ?? key);

test('names the fields to look at, in words, once each', () => {
    assert.equal(fieldErrorText(t, [{ field: 'phone', message: 'Invalid string: must match pattern /^[+0-9]*$/' }]), 'Check the phone number, then try again.');
    assert.equal(
        fieldErrorText(t, [{ field: 'phone' }, { field: 'website' }, { field: 'phone' }, { field: 'hours' }]),
        'Check the phone number, the website and the hours, then try again.',
    );
    assert.equal(fieldErrorText(t, [{ field: 'customSections.0.title' }]), 'Check custom sections, then try again.');
    assert.equal(fieldErrorText(t, []), 'Check the form, then try again.');
    assert.equal(fieldErrorText(t, undefined), 'Check the form, then try again.');
});
