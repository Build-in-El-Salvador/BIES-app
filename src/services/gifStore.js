import { nostrService } from './nostrService';
import { nostrSigner } from './nostrSigner';
import { mediaService } from './mediaService';

const GIF_KIND = 1063; // NIP-94 file metadata

class GifStore {
    constructor() {
        this.gifs = [];
        this.loading = false;
        this.loaded = false;
        this.listeners = new Set();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        this.listeners.forEach(fn => fn([...this.gifs]));
    }

    async fetchGifs() {
        if (this.loading) return;
        this.loading = true;

        try {
            const filter = {
                kinds: [GIF_KIND],
                '#m': ['image/gif'],
                limit: 200,
            };

            const events = await nostrService.pool.querySync(
                [nostrService.biesRelay, ...nostrService.publicRelays],
                filter
            );

            const gifMap = new Map();
            for (const event of events) {
                const url = event.tags.find(t => t[0] === 'url')?.[1];
                if (!url) continue;
                if (gifMap.has(url)) continue;

                const tags = event.tags
                    .filter(t => t[0] === 't')
                    .map(t => t[1].toLowerCase());

                gifMap.set(url, {
                    id: event.id,
                    url,
                    description: event.content || '',
                    tags,
                    size: event.tags.find(t => t[0] === 'size')?.[1] || null,
                    dim: event.tags.find(t => t[0] === 'dim')?.[1] || null,
                    sha256: event.tags.find(t => t[0] === 'x')?.[1] || null,
                    pubkey: event.pubkey,
                    created_at: event.created_at,
                });
            }

            this.gifs = Array.from(gifMap.values())
                .sort((a, b) => b.created_at - a.created_at);
            this.loaded = true;
            this.notify();
        } catch (err) {
            console.error('[GifStore] Failed to fetch GIFs:', err);
        } finally {
            this.loading = false;
        }
    }

    search(query) {
        if (!query.trim()) return this.gifs;
        const terms = query.toLowerCase().split(/\s+/);
        return this.gifs.filter(gif => {
            const searchText = [gif.description, ...gif.tags].join(' ').toLowerCase();
            return terms.every(term => searchText.includes(term));
        });
    }

    async uploadGif(file, description = '', tags = []) {
        // Shared: other members pick it for their posts too.
        const result = await mediaService.uploadFile(file, { shared: true });
        const dimensions = await mediaService.getImageDimensions(file);

        const eventTags = [
            ['url', result.url],
            ['m', file.type],
            ['x', result.sha256],
            ['size', String(result.size)],
            ['t', 'gif'],
        ];

        if (dimensions) {
            eventTags.push(['dim', `${dimensions.width}x${dimensions.height}`]);
        }

        for (const tag of tags) {
            if (tag.trim()) {
                eventTags.push(['t', tag.trim().toLowerCase()]);
            }
        }

        const event = {
            kind: GIF_KIND,
            created_at: Math.floor(Date.now() / 1000),
            content: description,
            tags: eventTags,
        };

        const signed = await nostrSigner.signEvent(event);
        await Promise.any(nostrService.pool.publish(nostrService.relays, signed));

        const newGif = {
            id: signed.id,
            url: result.url,
            description,
            tags: ['gif', ...tags.map(t => t.trim().toLowerCase()).filter(Boolean)],
            size: result.size,
            dim: dimensions ? `${dimensions.width}x${dimensions.height}` : null,
            sha256: result.sha256,
            pubkey: signed.pubkey,
            created_at: signed.created_at,
        };

        this.gifs = [newGif, ...this.gifs];
        this.notify();

        return newGif;
    }
}

export const gifStore = new GifStore();
