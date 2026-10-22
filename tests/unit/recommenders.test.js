/**
 * "Recommended by" on a business or farm (src/components/directory/recommenders.js):
 * the members who vouch for it, the first to recommend it first, and nobody
 * who doesn't recommend it.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recommenders, writtenReviews, reviewCount } from '../../src/components/directory/recommenders.js';

const review = (id, vote, createdAt) => ({ id, vote, createdAt, user: { id: `u-${id}`, profile: { name: id } } });

test('lists vouches only, the earliest first, whatever order the server sent', () => {
    const listing = {
        endorsements: [
            review('newest', 1, '2026-10-22T10:00:00.000Z'),
            review('critic', -1, '2026-10-01T10:00:00.000Z'),
            review('first', 1, '2026-09-01T10:00:00.000Z'),
            review('second', 1, '2026-09-15T10:00:00.000Z'),
        ],
    };
    assert.deepEqual(recommenders(listing).map((r) => r.id), ['first', 'second', 'newest']);
});

test('is empty signed out (no reviews come) or with missing data', () => {
    assert.deepEqual(recommenders({ endorsements: [] }), []);
    assert.deepEqual(recommenders({}), []);
    assert.deepEqual(recommenders(null), []);
    assert.deepEqual(recommenders({ endorsements: [{ id: 'x', vote: 1, createdAt: '2026-10-01' }] }), []);
});

test('Reviews hold what members wrote; a bare vouch is only a face, except my own', () => {
    const words = { ...review('words', 1, '2026-10-02'), comment: 'Best steak in town.' };
    const bare = { ...review('bare', 1, '2026-10-03'), comment: '' };
    const spaces = { ...review('spaces', 1, '2026-10-04'), comment: '   ' };
    const critic = { ...review('critic', -1, '2026-10-05'), comment: 'They took the deposit and never came back.' };
    const mine = { ...review('mine', 1, '2026-10-06'), comment: '' };
    const all = [words, bare, spaces, critic, mine];

    assert.deepEqual(writtenReviews(all, mine).map((r) => r.id), ['words', 'critic', 'mine']);
    assert.deepEqual(writtenReviews(all, null).map((r) => r.id), ['words', 'critic']);
    assert.equal(reviewCount(all), 2);                    // my bare vouch isn't a review
    assert.deepEqual(recommenders({ endorsements: all }).map((r) => r.id), ['words', 'bare', 'spaces', 'mine']);
    assert.deepEqual(writtenReviews(undefined, null), []);
});
