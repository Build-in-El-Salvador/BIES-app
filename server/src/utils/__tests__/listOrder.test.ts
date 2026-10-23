import { describe, expect, it } from 'vitest';
import { alphabetical, inIdOrder, inOrder, missingLast, newestFirst, pageIds, priceLevel } from '../listOrder';

const rows = (...names: string[]) => names.map((name, i) => ({ id: `id${i}`, name }));
const names = (list: { name: string }[]) => list.map((r) => r.name);

describe('listOrder', () => {
    it('sorts A–Z as people read it: case and accents in place', () => {
        const sorted = rows('Zona Rosa', 'árbol', 'iShop', 'Arca', 'Ñandú', 'Nube', 'Arbor').sort(inOrder(alphabetical((r) => r.name)));
        expect(names(sorted)).toEqual(['árbol', 'Arbor', 'Arca', 'iShop', 'Nube', 'Ñandú', 'Zona Rosa']);
    });

    it('reads a price level from $ to $$$$ only', () => {
        expect(['$', '$$', ' $$$ ', '$$$$'].map(priceLevel)).toEqual([1, 2, 3, 4]);
        expect(['', '$$$$$', '$5/lb', 'Stays from $250 a night', null, undefined].map(priceLevel)).toEqual([null, null, null, null, null, null]);
    });

    it('puts a missing value last, whichever the direction', () => {
        const list = [{ id: 'a', v: 3 }, { id: 'b', v: null }, { id: 'c', v: 1 }, { id: 'd', v: 2 }];
        expect([...list].sort(inOrder(missingLast((r) => r.v, 1))).map((r) => r.id)).toEqual(['c', 'd', 'a', 'b']);
        expect([...list].sort(inOrder(missingLast((r) => r.v, -1))).map((r) => r.id)).toEqual(['a', 'd', 'c', 'b']);
        const days = [{ id: 'x', d: '' }, { id: 'y', d: '2026-11-02' }, { id: 'z', d: '2026-10-30' }];
        expect([...days].sort(inOrder(missingLast((r) => r.d, 1))).map((r) => r.id)).toEqual(['z', 'y', 'x']);
    });

    it('breaks ties with the next order, then the id', () => {
        const at = (day: number) => new Date(Date.UTC(2026, 9, day));
        const list = [{ id: 'b', n: 1, at: at(1) }, { id: 'a', n: 1, at: at(1) }, { id: 'c', n: 1, at: at(5) }];
        const order = inOrder<typeof list[number]>((x, y) => x.n - y.n, newestFirst((r) => r.at));
        expect([...list].sort(order).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    });

    it('pages through the order, and puts fetched rows back in it', () => {
        const list = rows('C', 'A', 'B', 'D');
        const order = inOrder(alphabetical<{ id: string; name: string }>((r) => r.name));
        expect(pageIds(list, order, 0, 2)).toEqual(['id1', 'id2']);
        expect(pageIds(list, order, 2, 2)).toEqual(['id0', 'id3']);
        expect(names(inIdOrder(['id2', 'id1'], list))).toEqual(['B', 'A']);
        expect(inIdOrder(['gone', 'id0'], list).map((r) => r.id)).toEqual(['id0']);
    });
});
