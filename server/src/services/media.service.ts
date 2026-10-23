import axios from 'axios';
import Parser from 'rss-parser';
import { cache, TTL } from './redis.service';
import { config } from '../config';

interface SubstackItem {
    title: string;
    excerpt?: string;
    link: string;
    date?: string;
    thumbnail?: string | null;
    author?: string;
}

interface YouTubeItem {
    videoId: string;
    title: string;
    description?: string;
    link: string;
    date?: string;
    thumbnail: string;
}

const parser = new Parser({
    customFields: {
        item: [
            ['media:group', 'mediaGroup'],
            ['media:thumbnail', 'mediaThumbnail'],
        ],
    },
});

const CACHE_TTL = 15 * 60; // 15 minutes

/**
 * Fetch Substack feed from https://buildinelsalvador.substack.com/feed
 */
export async function fetchSubstackFeed(): Promise<SubstackItem[]> {
    const cacheKey = 'media:substack';

    // Try cache first
    const cached = await cache.getJson<SubstackItem[]>(cacheKey);
    if (cached) {
        console.log('[Media] Serving Substack feed from cache');
        return cached;
    }

    try {
        console.log('[Media] Fetching Substack feed...');
        const feed = await parser.parseURL('https://buildinelsalvador.substack.com/feed');

        const items: SubstackItem[] = (feed.items || []).map((item: any) => ({
            title: item.title || 'Untitled',
            excerpt: item.contentSnippet ? item.contentSnippet.slice(0, 200) : undefined,
            link: item.link || '',
            date: item.pubDate || item.published,
            thumbnail: item['media:thumbnail']?.[0]?.$.url || item.enclosure?.url || null,
            author: item.creator || feed.title || 'Build in El Salvador',
        }));

        // Cache the result
        await cache.setJson(cacheKey, items, CACHE_TTL);
        console.log(`[Media] Cached ${items.length} Substack items`);

        return items;
    } catch (error: any) {
        console.error('[Media] Error fetching Substack feed:', error.message);
        return [];
    }
}

/**
 * Get YouTube channel ID
 * Checks config first, then tries to extract from channel page
 */
async function getYouTubeChannelId(): Promise<string> {
    // If channel ID is configured via env var, use it
    if (config.youtubeChannelId) {
        return config.youtubeChannelId;
    }

    try {
        console.log('[Media] YouTube channel ID not configured, attempting to extract from channel page...');
        const channelPageUrl = 'https://www.youtube.com/@Buildinelsalvador';
        const response = await axios.get(channelPageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            timeout: 10000,
        });

        // Look for channelId in the page HTML
        // Pattern: "channelId":"UCxxxxxx"
        const channelIdMatch = response.data.match(/"channelId":"(UC[^"]+)"/);
        if (channelIdMatch && channelIdMatch[1]) {
            console.log('[Media] Extracted YouTube channel ID from page');
            return channelIdMatch[1];
        }

        throw new Error('Could not extract channel ID from page');
    } catch (error: any) {
        console.warn('[Media] Failed to get YouTube channel ID:', error.message);
        return '';
    }
}

/**
 * Fetch YouTube feed from @Buildinelsalvador channel
 * Uses YouTube's RSS feed (no API key required)
 */
export async function fetchYouTubeFeed(): Promise<YouTubeItem[]> {
    const cacheKey = 'media:youtube';

    // Try cache first
    const cached = await cache.getJson<YouTubeItem[]>(cacheKey);
    if (cached) {
        console.log('[Media] Serving YouTube feed from cache');
        return cached;
    }

    try {
        console.log('[Media] Fetching YouTube feed...');

        // Get channel ID dynamically
        const channelId = await getYouTubeChannelId();
        if (!channelId) {
            console.warn('[Media] Could not get YouTube channel ID, returning empty feed');
            return [];
        }

        // YouTube RSS feed using channel_id parameter
        const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        const feed = await parser.parseURL(feedUrl);

        const items: YouTubeItem[] = (feed.items || []).map((item: any) => {
            // Extract video ID from YouTube URL: https://www.youtube.com/watch?v=VIDEO_ID
            const videoId = (item.link || '').split('v=')[1]?.split('&')[0] || '';

            // Get thumbnail from media:group or construct from video ID
            let thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
            if (item.mediaGroup?.['media:thumbnail']?.[0]?.$.url) {
                thumbnail = item.mediaGroup['media:thumbnail'][0].$.url;
            }

            return {
                videoId,
                title: item.title || 'Untitled',
                description: item.contentSnippet ? item.contentSnippet.slice(0, 200) : undefined,
                link: item.link || '',
                date: item.pubDate || item.published,
                thumbnail,
            };
        });

        // Cache the result
        await cache.setJson(cacheKey, items, CACHE_TTL);
        console.log(`[Media] Cached ${items.length} YouTube items`);

        return items;
    } catch (error: any) {
        console.error('[Media] Error fetching YouTube feed:', error.message);
        return [];
    }
}
