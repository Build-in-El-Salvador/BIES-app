/**
 * The list pages' requests and cache keys (src/utils/listRequests.js), which
 * prefetchLists.js shares: the key the bottom bar fetches ahead of time is the
 * one a page looks up, and filters keep their own keys.
 *
 * Run: npm run test:unit   (node --test; no network)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    directoryKey, directoryRequest, membersKey, membersPageSize, opportunitiesKey, opportunitiesRequest,
} from '../../src/utils/listRequests.js';

test('a directory list opened from the bar has the key the page looks up', () => {
    // What DirectoryList asks for on first open (no search, category or Saved).
    const page = directoryRequest({ type: 'PROVIDER', search: '', category: '', saved: false });
    assert.equal(directoryKey(page), 'directory:{"type":"PROVIDER","limit":50,"sort":"score"}');
    assert.equal(directoryKey(directoryRequest({ type: 'PROVIDER' })), directoryKey(page));
    assert.notEqual(directoryKey(directoryRequest({ type: 'FARM' })), directoryKey(page));
    assert.deepEqual(directoryRequest({ type: 'FARM', search: 'café', category: 'food', saved: true }),
        { type: 'FARM', limit: 50, sort: 'score', search: 'café', category: 'food', saved: 'true' });
});

test("opportunities: no filters is the page's first request; each filter is its own list", () => {
    const empty = {
        query: '', type: '', kind: '', stage: '', category: '', minAmount: '', maxAmount: '',
        remoteOnly: false, btcOnly: false, mineOnly: false, savedOnly: false,
    };
    assert.equal(opportunitiesKey(opportunitiesRequest(empty)), 'opportunities:{"limit":50}');
    assert.equal(opportunitiesKey(opportunitiesRequest({})), opportunitiesKey(opportunitiesRequest(empty)));
    assert.equal(opportunitiesKey(opportunitiesRequest({}, { types: ['job', 'project'] })), 'opportunities:{"limit":50,"types":"job,project"}');
    assert.deepEqual(opportunitiesRequest({ query: 'solar', mineOnly: true }, { userId: 'u1' }), { limit: 50, search: 'solar', ownerId: 'u1' });
    // Mine without a signed-in member isn't a filter.
    assert.deepEqual(opportunitiesRequest({ mineOnly: true }), { limit: 50 });
});

test("members: the page size follows the view, and the key the page's", () => {
    assert.equal(membersPageSize('icons'), 48);
    assert.equal(membersPageSize('list'), 24);
    assert.equal(membersKey(48), 'members:48:');
    assert.equal(membersKey(24, 'ana'), 'members:24:ana');
});
