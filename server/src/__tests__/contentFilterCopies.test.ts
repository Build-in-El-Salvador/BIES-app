/**
 * Feed posts and replies are screened by copies of this server's word
 * filter: in the app before signing (src/utils/contentFilter.js) and in the
 * relay's proxy (relay-proxy/contentFilter.js). Each is built on its own, so
 * they're copies, not imports: this fails when a copy's lists or results
 * drift from services/contentFilter.ts.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';
import * as server from '../services/contentFilter';

const COPIES = {
    app: path.resolve(__dirname, '../../../src/utils/contentFilter.js'),
    proxy: path.resolve(__dirname, '../../../relay-proxy/contentFilter.js'),
};
const load = (file: string) => import(pathToFileURL(file).href);

const SAMPLES = [
    'you are a whore', 'F4GG0T', 'eres un maricón', 'hijo de puta', 'just kill   yourself', '<b>ni</b>gger',
    'wh​ore', 'рuta', 'Suicídate', 'A negro coffee, please', 'Vergón el evento!', 'Kike is coming',
    '$500 for the matate', 'Disputa resuelta', 'computadora', '', 'Great meetup tonight! 🎉', 'k.y.s', 'm4lp4rid0s',
];

describe.each(Object.entries(COPIES))('the %s copy', (_name, file) => {
    it('has the same words and phrases', async () => {
        const copy = await load(file);
        expect(copy.WORDS).toEqual(server.WORDS);
        expect(copy.PHRASES).toEqual(server.PHRASES);
    });

    it('finds the same things', async () => {
        const copy = await load(file);
        for (const text of [...SAMPLES, ...server.WORDS, ...server.PHRASES]) {
            expect(copy.normalize(text), text).toBe(server.normalize(text));
            expect(copy.findObjectionable(text), text).toBe(server.findObjectionable(text));
        }
    });
});
