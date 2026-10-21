import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDark, opaqueHex } from './barColors.js';

test('computed colours become #rrggbb', () => {
    assert.equal(opaqueHex('rgb(0, 71, 171)'), '#0047ab');
    assert.equal(opaqueHex('rgba(0, 0, 78, 1)'), '#00004e');
    assert.equal(opaqueHex('rgb(247 243 242)'), '#f7f3f2');
    assert.equal(opaqueHex('rgb(0 71 171 / 90%)'), '#0047ab');
    assert.equal(opaqueHex('#FAFAFA'), '#fafafa');
    assert.equal(opaqueHex('#fff'), '#ffffff');
});

test('see-through and non-colours are skipped', () => {
    assert.equal(opaqueHex('rgba(0, 0, 0, 0)'), null);
    assert.equal(opaqueHex('transparent'), null);
    assert.equal(opaqueHex('rgba(255, 255, 255, 0.1)'), null);
    assert.equal(opaqueHex(''), null);
    assert.equal(opaqueHex(undefined), null);
});

test('the header blues take light icons, the off-white page dark ones', () => {
    assert.equal(isDark('#0047ab'), true);
    assert.equal(isDark('#00004e'), true);
    assert.equal(isDark('#0f172a'), true);
    assert.equal(isDark('#f7f3f2'), false);
    assert.equal(isDark('#ffffff'), false);
});
