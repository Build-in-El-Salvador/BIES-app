/**
 * The Nostr picture a member with no BIES photo gets (scripts/fillAvatarsFromNostr.ts):
 * an https picture from their newest kind 0, and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { pictureOf, newestByAuthor } from '../scripts/fillAvatarsFromNostr';

const kind0 = (pubkey: string, created_at: number, content: unknown, kind = 0) =>
    ({ id: `${pubkey}-${created_at}`, pubkey, created_at, kind, tags: [], sig: '', content: typeof content === 'string' ? content : JSON.stringify(content) });

describe('the picture a member gets from Nostr', () => {
    it('is the https picture from their newest profile', () => {
        const newest = newestByAuthor([
            kind0('a', 100, { picture: 'https://old.example/a.jpg' }),
            kind0('a', 200, { picture: ' https://cdn.example/a.jpg ' }),
            kind0('b', 150, { name: 'No photo' }),
            kind0('a', 300, { picture: 'https://note.example/x.jpg' }, 1), // not a profile
        ]);
        expect(pictureOf(newest.get('a'))).toBe('https://cdn.example/a.jpg');
        expect(pictureOf(newest.get('b'))).toBeNull();
        expect(pictureOf(newest.get('nobody'))).toBeNull();
    });

    it('is never anything but an https address', () => {
        for (const picture of ['http://plain.example/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/uploads/x.jpg', 42]) {
            expect(pictureOf(kind0('a', 1, { picture }) as any)).toBeNull();
        }
        expect(pictureOf(kind0('a', 1, '{not json') as any)).toBeNull();
    });
});
