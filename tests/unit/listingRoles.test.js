/**
 * Who a business or farm listing is to a member (src/components/directory/listingRoles.js):
 * who runs it (as runsListing on the server), the three connections on the
 * Add a business form, and the businesses a member works at on their profile.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ADDED_AS_STAFF, connectionFields, connectionOf, runnerIdOf, runnerOf, runsListing, worksAt,
} from '../../src/components/directory/listingRoles.js';

const owner = { id: 'ana', profile: { name: 'Ana' } };
const linked = { id: 'ben', profile: { name: 'Ben' } };
const listing = (fields = {}) => ({
    id: 'l1', ownerId: 'ana', owner, memberUserId: null, memberUser: null, isOwnBusiness: false, addedAs: '', ...fields,
});

test('the member who added it as their own business runs it', () => {
    const own = listing({ isOwnBusiness: true });
    assert.equal(runnerIdOf(own), 'ana');
    assert.equal(runsListing(own, 'ana'), true);
    assert.equal(runnerOf(own), owner);
});

test('nobody runs a recommendation', () => {
    const rec = listing();
    assert.equal(runnerIdOf(rec), null);
    assert.equal(runsListing(rec, 'ana'), false);
    assert.equal(runnerOf(rec), null);
});

test("someone who works there doesn't run what they added", () => {
    const staff = listing({ isOwnBusiness: true, addedAs: ADDED_AS_STAFF });
    assert.equal(runnerIdOf(staff), null);
    assert.equal(runsListing(staff, 'ana'), false);
    assert.equal(runnerOf(staff), null);
});

test('a linked member runs it, whoever added it and however', () => {
    for (const fields of [{}, { isOwnBusiness: true }, { isOwnBusiness: true, addedAs: ADDED_AS_STAFF }]) {
        const l = listing({ ...fields, memberUserId: 'ben', memberUser: linked });
        assert.equal(runnerIdOf(l), 'ben');
        assert.equal(runsListing(l, 'ben'), true);
        assert.equal(runsListing(l, 'ana'), false);
        assert.equal(runnerOf(l), linked);
    }
});

test('signed out, or with no listing, nobody runs it', () => {
    assert.equal(runsListing(listing({ isOwnBusiness: true }), undefined), false);
    assert.equal(runsListing(null, 'ana'), false);
    assert.equal(runnerIdOf(undefined), null);
    assert.equal(runnerOf(null), null);
});

test('the form reads and writes the three connections', () => {
    assert.equal(connectionOf(listing()), 'customer');
    assert.equal(connectionOf(listing({ isOwnBusiness: true })), 'owner');
    assert.equal(connectionOf(listing({ isOwnBusiness: true, addedAs: ADDED_AS_STAFF })), 'staff');
    // STAFF only means something on the business's own listing.
    assert.equal(connectionOf(listing({ addedAs: ADDED_AS_STAFF })), 'customer');
    assert.equal(connectionOf(null), 'customer');

    assert.deepEqual(connectionFields('customer'), { isOwnBusiness: false, addedAs: '' });
    assert.deepEqual(connectionFields('owner'), { isOwnBusiness: true, addedAs: '' });
    assert.deepEqual(connectionFields('staff'), { isOwnBusiness: true, addedAs: ADDED_AS_STAFF });
    for (const c of ['customer', 'owner', 'staff']) assert.equal(connectionOf(connectionFields(c)), c);
});

test('works at: the teams they are on, less what they run or the profile shows already', () => {
    const shop = listing({ id: 'shop', isOwnBusiness: true, addedAs: ADDED_AS_STAFF });
    const cafe = listing({ id: 'cafe', ownerId: 'zoe', isOwnBusiness: true });
    const theirs = listing({ id: 'theirs', isOwnBusiness: true });
    const linkedToThem = listing({ id: 'linked', ownerId: 'zoe', memberUserId: 'ana' });

    assert.deepEqual(worksAt([shop, cafe, theirs, linkedToThem], 'ana').map((l) => l.id), ['shop', 'cafe']);
    assert.deepEqual(worksAt([shop, cafe], 'ana', [cafe]).map((l) => l.id), ['shop']);
    assert.deepEqual(worksAt([shop, shop], 'ana').map((l) => l.id), ['shop']);
    assert.deepEqual(worksAt(undefined, 'ana'), []);
    assert.deepEqual(worksAt([null, { name: 'no id' }], 'ana'), []);
});
