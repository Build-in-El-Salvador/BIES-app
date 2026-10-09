/**
 * Audit logging middleware.
 *
 * Logs significant state-changing operations (POST/PUT/DELETE) to the AuditLog table.
 * Read operations (GET) are not logged here to avoid log bloat
 * (use analytics for read tracking instead).
 *
 * Runs asynchronously and never blocks the response.
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';

// Map of route patterns → action names
const ACTION_MAP: Array<{ method: string; pattern: RegExp; action: string }> = [
    { method: 'POST', pattern: /^\/api\/auth\/email\/verify/, action: 'AUTH_EMAIL_LOGIN' },
    { method: 'POST', pattern: /^\/api\/auth\/nostr-login/, action: 'AUTH_NOSTR_LOGIN' },
    { method: 'PUT',  pattern: /^\/api\/auth\/role/, action: 'AUTH_ROLE_CHANGED' },
    { method: 'PUT',  pattern: /^\/api\/profiles\/me/, action: 'PROFILE_UPDATE' },
    { method: 'POST', pattern: /^\/api\/projects/, action: 'PROJECT_CREATE' },
    { method: 'PUT',  pattern: /^\/api\/projects\//, action: 'PROJECT_UPDATE' },
    { method: 'DELETE', pattern: /^\/api\/projects\//, action: 'PROJECT_DELETE' },
    { method: 'POST', pattern: /^\/api\/investments/, action: 'INVESTMENT_CREATE' },
    { method: 'PUT',  pattern: /^\/api\/investments\//, action: 'INVESTMENT_UPDATE' },
    { method: 'POST', pattern: /^\/api\/upload\//, action: 'FILE_UPLOAD' },
    { method: 'POST', pattern: /^\/api\/admin\//, action: 'ADMIN_ACTION' },
    { method: 'PUT',  pattern: /^\/api\/admin\//, action: 'ADMIN_ACTION' },
    { method: 'DELETE', pattern: /^\/api\/admin\//, action: 'ADMIN_ACTION' },
    { method: 'POST', pattern: /^\/api\/auth\/logout/, action: 'AUTH_LOGOUT' },
    { method: 'POST', pattern: /^\/api\/projects\/.*\/deck\/request/, action: 'DECK_REQUEST' },
    { method: 'PUT',  pattern: /^\/api\/projects\/.*\/deck\/requests\//, action: 'DECK_REVIEW' },
    { method: 'POST', pattern: /^\/api\/profiles\/.*\/follow/, action: 'FOLLOW_CREATE' },
    { method: 'DELETE', pattern: /^\/api\/profiles\/.*\/follow/, action: 'FOLLOW_DELETE' },
    { method: 'POST', pattern: /^\/api\/contact/, action: 'CONTACT_SUBMIT' },
    { method: 'PUT',  pattern: /^\/api\/settings\//, action: 'SETTINGS_UPDATE' },
    { method: 'DELETE', pattern: /^\/api\/settings\/account/, action: 'ACCOUNT_DELETE' },
    { method: 'POST', pattern: /^\/api\/content\//, action: 'CONTENT_CREATE' },
    { method: 'PUT',  pattern: /^\/api\/content\//, action: 'CONTENT_UPDATE' },
    { method: 'POST', pattern: /^\/api\/vouchers$/, action: 'VOUCHER_CREATE' },
    { method: 'POST', pattern: /^\/api\/vouchers\/code\/.*\/redeem/, action: 'VOUCHER_REDEEM' },
    { method: 'POST', pattern: /^\/api\/vouchers\/.*\/revoke/, action: 'VOUCHER_REVOKE' },
];

function resolveAction(method: string, path: string): string | null {
    for (const entry of ACTION_MAP) {
        if (entry.method === method && entry.pattern.test(path)) {
            return entry.action;
        }
    }
    return null;
}

export function auditLog(req: Request, res: Response, next: NextFunction): void {
    const action = resolveAction(req.method, req.path);

    if (!action) {
        next();
        return;
    }

    // Run after response is sent (non-blocking)
    res.on('finish', () => {
        const ipAddress = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').split(',')[0].trim();
        const userAgent = req.headers['user-agent'] || '';

        // Only log successful or client-error responses (not 5xx internal errors)
        if (res.statusCode >= 500) return;

        const metadata: Record<string, unknown> = {
            statusCode: res.statusCode,
            path: req.path,
        };

        // Include non-sensitive body keys for context
        if (req.body) {
            const safeKeys = ['role', 'category', 'stage', 'status', 'type'];
            for (const key of safeKeys) {
                if (req.body[key] !== undefined) metadata[key] = req.body[key];
            }
        }

        prisma.auditLog.create({
            data: {
                // Sign-in routes have no req.user; they name the account in res.locals.
                userId: req.user?.id || res.locals.auditUserId || null,
                action,
                resource: req.path,
                ipAddress,
                userAgent,
                metadata: JSON.stringify(metadata),
            },
        }).catch((err) => console.error('[Audit] Failed to write audit log:', err.message));
    });

    next();
}
