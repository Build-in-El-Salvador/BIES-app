import { Request, Response, NextFunction } from 'express';

/**
 * In front of the uploads folder (index.ts): members' photos and videos only,
 * as storage.service.ts names them (milliseconds-hex.ext), never private/ or
 * any other file. The headers keep a file to what its extension says.
 * deploy/nginx.conf serves the same set.
 */
export const SERVABLE_UPLOAD = /^\/public\/\d{13}-[0-9a-f]{32}\.(jpe?g|png|gif|webp|mp4|m4v|mov|webm)$/i;

export function servableUploadsOnly(req: Request, res: Response, next: NextFunction): void {
    if (!SERVABLE_UPLOAD.test(req.path)) {
        res.status(404).end();
        return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    next();
}
