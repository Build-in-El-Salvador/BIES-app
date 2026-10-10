/**
 * Input sanitization middleware.
 *
 * Strips HTML tags from string fields to prevent stored XSS.
 * Applied globally to all request bodies, query params, and URL params.
 *
 * Note: Does NOT encode for HTML — that's the frontend's responsibility.
 * This layer removes injection vectors at the ingress point.
 */

import { Request, Response, NextFunction } from 'express';

// Lightweight HTML tag stripper — applied recursively, handles nested tag reconstruction
function stripTags(str: string): string {
    let prev = '';
    let result = str;
    // Loop to handle nested/reconstructed tags (e.g. <scr<script>ipt>)
    while (result !== prev) {
        prev = result;
        result = result
            .replace(/<script[\s\S]*?<\/script>/gi, '')  // Remove script blocks
            .replace(/<style[\s\S]*?<\/style>/gi, '')     // Remove style blocks
            .replace(/<[^>]+>/g, '');                      // Remove remaining tags
    }
    return result;
}

function sanitizeValue(value: unknown, key?: string): unknown {
    if (typeof value === 'string') {
        if (key && RICH_HTML_FIELDS.has(key)) {
            return sanitizeRichHtml(value);
        }
        return stripTags(value.trim());
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeValue(item, key));
    }
    if (value !== null && typeof value === 'object') {
        return sanitizeObject(value as Record<string, unknown>);
    }
    return value;
}

// Fields that must never be sanitized (encrypted data and passwords)
const EXEMPT_FIELDS = new Set(['encryptedPrivkey', 'password']);

// Fields that contain rich HTML (user-authored formatted text).
// These get a lighter sanitization: dangerous tags/attributes are removed,
// but safe formatting tags (<b>, <i>, <u>, <span>, <p>, <div>, etc.) are preserved.
const RICH_HTML_FIELDS = new Set(['description', 'body', 'content', 'bio']);

// Decode HTML entities so encoded payloads (&#106;avascript:, &#x6A;, etc.) are caught.
function decodeHtmlEntities(str: string): string {
    return str
        .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);?/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
        .replace(/&tab;|&newline;/gi, '');
}

// Strip only dangerous content from rich HTML, preserving safe formatting tags.
function sanitizeRichHtml(str: string): string {
    // First pass: decode entities in attribute values to catch obfuscated payloads
    let result = str
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object[\s\S]*?>/gi, '')
        .replace(/<embed[\s\S]*?>/gi, '')
        .replace(/<form[\s\S]*?<\/form>/gi, '')
        .replace(/<form[\s\S]*?>/gi, '')
        .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')  // remove event handlers
        .replace(/\son\w+\s*=\s*[^\s>]*/gi, '');

    // Decode entities then strip javascript: protocol (catches &#106;avascript: etc.)
    result = decodeHtmlEntities(result).replace(/javascript\s*:/gi, '');
    // Also strip vbscript: and data: URIs in attributes (additional protocol vectors)
    result = result.replace(/vbscript\s*:/gi, '').replace(/data\s*:[^,]*;base64/gi, '');

    return result.trim();
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
        if (EXEMPT_FIELDS.has(key)) {
            sanitized[key] = val;
        } else {
            sanitized[key] = sanitizeValue(val, key);
        }
    }
    return sanitized;
}

// Routes whose bodies must reach the handler unchanged. The hosted signer
// signs exactly what the member's app sent (stripping or trimming would sign
// different text) and stores none of it; Nostr content is escaped by whatever
// displays it.
const UNSANITIZED_PREFIXES = ['/api/signer/'];

/**
 * Sanitize req.body, req.query, and req.params.
 */
export function sanitize(req: Request, _res: Response, next: NextFunction): void {
    // Match paths the way Express routes them: any case, repeated slashes collapsed.
    const path = req.path.toLowerCase().replace(/\/{2,}/g, '/');
    if (UNSANITIZED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        next();
        return;
    }
    if (req.body && typeof req.body === 'object') {
        req.body = sanitizeObject(req.body);
    }
    // Sanitize query parameters (common XSS vector via reflected values)
    if (req.query && typeof req.query === 'object') {
        (req as any).query = sanitizeObject(req.query as Record<string, unknown>);
    }
    // Sanitize URL parameters
    if (req.params && typeof req.params === 'object') {
        (req as any).params = sanitizeObject(req.params as Record<string, unknown>) as Record<string, string>;
    }
    next();
}
