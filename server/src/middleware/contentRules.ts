import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { config } from '../config';
import { objectionableField, objectionableResponse } from '../services/contentFilter';

/**
 * Refuse a request whose named body fields hold objectionable text
 * (services/contentFilter.ts). 422, with the field, so the app can point at it.
 */
export function screenContent(fields: string[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const body = req.body ?? {};
        const present: Record<string, unknown> = {};
        for (const field of fields) {
            if (body[field] !== undefined) present[field] = body[field];
        }
        const field = objectionableField(present);
        if (field) {
            res.status(422).json(objectionableResponse(field));
            return;
        }
        next();
    };
}

/**
 * Publishing anything on BIES needs the current terms of use accepted
 * (POST /api/account/terms). The app shows them on the first sign-in, and
 * again whenever TERMS_VERSION changes. Reports and blocks never need them.
 * Must come after `authenticate`.
 */
export async function requireTerms(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { termsVersion: true } });
        if (user?.termsVersion !== config.termsVersion) {
            res.status(403).json({
                error: 'Please accept the terms of use first',
                reason: 'terms_required',
                termsVersion: config.termsVersion,
            });
            return;
        }
    } catch (error) {
        console.error('[Terms] Check failed:', error);
        res.status(503).json({ error: 'Please try again in a moment' });
        return;
    }
    next();
}
