/**
 * What a farm sells (src/pages/directory/produceIcons.js): the farm
 * directory's "what they sell" chips filter on this, so a word inside
 * another word mustn't count ("fresas" isn't beef).
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { produceKind } from '../../src/pages/directory/produceIcons.js';

test('reads what a product is from its label, in English or Spanish', () => {
    assert.equal(produceKind('Grass-fed beef'), 'beef');
    assert.equal(produceKind('Carne de res'), 'beef');
    assert.equal(produceKind('Huevos de campo'), 'egg');
    assert.equal(produceKind('Café de altura'), 'coffee');
    assert.equal(produceKind('Pollos'), 'chicken');
    assert.equal(produceKind('Queso fresco'), 'milk');
    assert.equal(produceKind('Frutas y verduras'), 'vegetable');
});

test("doesn't match a keyword inside another word", () => {
    assert.equal(produceKind('Fresas'), null); // not "res"
    assert.equal(produceKind('Avena'), null); // not "ave"
});

test('a chosen icon wins, and "leaf" means other', () => {
    assert.equal(produceKind({ label: 'Mystery box', icon: 'egg' }), 'egg');
    assert.equal(produceKind({ label: 'Eggs', icon: 'leaf' }), null);
    assert.equal(produceKind({ label: 'Eggs' }), 'egg');
    assert.equal(produceKind(null), null);
});
