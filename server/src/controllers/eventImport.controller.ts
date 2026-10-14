import { Request, Response } from 'express';
import { safeGet } from '../utils/safeFetch';

/**
 * POST /events/import-url
 * Fetch an event URL and extract event data from OG tags + JSON-LD.
 * Works with any event platform (Luma, Satlantis, Eventbrite, Meetup, etc.)
 */
export async function importEventFromUrl(req: Request, res: Response): Promise<void> {
    try {
        const { url } = req.body;

        if (!url || typeof url !== 'string') {
            res.status(400).json({ error: 'URL is required' });
            return;
        }

        // Basic URL validation
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            res.status(400).json({ error: 'Invalid URL' });
            return;
        }

        if (!['http:', 'https:'].includes(parsed.protocol)) {
            res.status(400).json({ error: 'Only HTTP/HTTPS URLs are supported' });
            return;
        }

        // SSRF protection: block private/internal IPs and localhost
        const hostname = parsed.hostname.toLowerCase();
        if (isPrivateHost(hostname)) {
            res.status(400).json({ error: 'Internal/private URLs are not allowed' });
            return;
        }

        // Fetch the page: https only, every address checked (no internal
        // hosts, however the name resolves or redirects), 2 MB, 10 seconds.
        const page = await safeGet(url, {
            timeoutMs: 10_000,
            maxBytes: 2 * 1024 * 1024,
            headers: { 'User-Agent': 'BIES-EventImport/1.0 (+https://buildinelsalvador.com)', Accept: 'text/html' },
        });
        if (!page) {
            res.status(400).json({ error: "Couldn't load that page. Check the link starts with https:// and try again." });
            return;
        }
        const html = page.body.toString('utf-8');

        // Parse OG meta tags
        const og = extractOgTags(html);

        // Parse JSON-LD structured data
        const jsonLd = extractJsonLd(html);

        // Detect platform
        const host = parsed.hostname.replace('www.', '');
        const platform = detectPlatform(host);

        // Build event data, preferring JSON-LD (more structured) over OG tags
        const eventData = buildEventData(og, jsonLd, url, platform);

        res.json({ ...eventData, sourceUrl: url, platform });
    } catch (error) {
        console.error('Event import error:', error);
        res.status(500).json({ error: 'Failed to import event data' });
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractOgTags(html: string): Record<string, string> {
    const tags: Record<string, string> = {};
    // Match <meta property="og:*" content="*"> and <meta name="*" content="*">
    const metaRegex = /<meta\s+(?:[^>]*?\s)?(?:property|name)=["']([^"']+)["']\s+content=["']([^"']*)["'][^>]*>/gi;
    let match;
    while ((match = metaRegex.exec(html)) !== null) {
        tags[match[1].toLowerCase()] = decodeHtmlEntities(match[2]);
    }
    // Also try reversed order: content before property
    const metaRegex2 = /<meta\s+content=["']([^"']*)["']\s+(?:property|name)=["']([^"']+)["'][^>]*>/gi;
    while ((match = metaRegex2.exec(html)) !== null) {
        tags[match[2].toLowerCase()] = decodeHtmlEntities(match[1]);
    }
    return tags;
}

function extractJsonLd(html: string): any | null {
    const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
        try {
            const data = JSON.parse(match[1].trim());
            // Could be an array or single object
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
                if (isEventType(item['@type'])) {
                    return item;
                }
                // Check @graph array (common in some sites)
                if (item['@graph']) {
                    const event = item['@graph'].find((g: any) => isEventType(g['@type']));
                    if (event) return event;
                }
            }
        } catch {
            // Invalid JSON-LD, skip
        }
    }
    return null;
}

const EVENT_TYPES = new Set(['Event', 'SocialEvent', 'BusinessEvent', 'MusicEvent', 'EducationEvent', 'ExhibitionEvent', 'Festival', 'Hackathon']);

function isEventType(type: any): boolean {
    if (!type) return false;
    if (typeof type === 'string') return EVENT_TYPES.has(type);
    if (Array.isArray(type)) return type.some(t => EVENT_TYPES.has(t));
    return false;
}

function detectPlatform(host: string): string {
    if (host.includes('lu.ma')) return 'luma';
    if (host.includes('satlantis')) return 'satlantis';
    if (host.includes('eventbrite')) return 'eventbrite';
    if (host.includes('meetup.com')) return 'meetup';
    if (host.includes('eventos')) return 'eventos';
    return 'generic';
}

function buildEventData(og: Record<string, string>, jsonLd: any, sourceUrl: string, platform: string) {
    const event: Record<string, any> = {};

    // Title
    event.title = jsonLd?.name || og['og:title'] || og['twitter:title'] || '';

    // Description — strip HTML tags for plain text
    const rawDesc = jsonLd?.description || og['og:description'] || og['twitter:description'] || '';
    event.description = rawDesc.replace(/<[^>]+>/g, '').trim();

    // Image
    event.thumbnail = jsonLd?.image?.url || jsonLd?.image || og['og:image'] || og['twitter:image'] || '';
    if (Array.isArray(event.thumbnail)) event.thumbnail = event.thumbnail[0];

    // Dates
    if (jsonLd?.startDate) {
        try {
            const d = new Date(jsonLd.startDate);
            event.startDate = d.toISOString().split('T')[0];
            event.startTime = d.toTimeString().slice(0, 5);
        } catch { /* ignore */ }
    }
    if (jsonLd?.endDate) {
        try {
            const d = new Date(jsonLd.endDate);
            event.endDate = d.toISOString().split('T')[0];
            event.endTime = d.toTimeString().slice(0, 5);
        } catch { /* ignore */ }
    }

    // Location
    const loc = jsonLd?.location;
    if (loc) {
        if (typeof loc === 'string') {
            event.locationName = loc;
        } else if (loc['@type'] === 'Place' || loc.name) {
            event.locationName = loc.name || '';
            const addr = loc.address;
            if (typeof addr === 'string') {
                event.locationAddress = addr;
            } else if (addr) {
                event.locationAddress = [
                    addr.streetAddress, addr.addressLocality,
                    addr.addressRegion, addr.addressCountry,
                ].filter(Boolean).join(', ');
            }
        } else if (loc['@type'] === 'VirtualLocation' || loc.url) {
            event.isOnline = true;
            event.onlineUrl = loc.url || '';
        }
    }

    // Online event detection
    if (jsonLd?.eventAttendanceMode?.includes?.('Online') || og['og:type']?.includes?.('online')) {
        event.isOnline = true;
    }

    // Ticket URL
    event.ticketUrl = jsonLd?.offers?.url || jsonLd?.url || sourceUrl;

    // Max attendees
    if (jsonLd?.maximumAttendeeCapacity) {
        event.maxAttendees = parseInt(jsonLd.maximumAttendeeCapacity, 10) || null;
    }

    // Organizer
    event.organizer = jsonLd?.organizer?.name || '';

    return event;
}

function isPrivateHost(hostname: string): boolean {
    // Block localhost variants
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') return true;
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;

    // Block private IP ranges
    const parts = hostname.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => !isNaN(p))) {
        if (parts[0] === 10) return true;                                     // 10.0.0.0/8
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
        if (parts[0] === 192 && parts[1] === 168) return true;                // 192.168.0.0/16
        if (parts[0] === 169 && parts[1] === 254) return true;                // 169.254.0.0/16 (link-local)
        if (parts[0] === 0) return true;                                       // 0.0.0.0/8
    }

    // Block IPv6 loopback
    if (hostname.startsWith('[::') || hostname.startsWith('[fe80:') || hostname.startsWith('[fd')) return true;

    return false;
}

function decodeHtmlEntities(str: string): string {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/');
}
