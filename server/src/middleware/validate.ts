import { Request, Response, NextFunction } from 'express';
import { ZodType, ZodError } from 'zod';

/**
 * Validate request body against a Zod schema.
 */
export function validate(schema: ZodType) {
    return (req: Request, res: Response, next: NextFunction): void => {
        try {
            req.body = schema.parse(req.body);
            next();
        } catch (error) {
            if (error instanceof ZodError) {
                const formattedErrors = error.issues.map((e) => ({
                    field: e.path.join('.'),
                    message: e.message,
                }));
                res.status(400).json({ error: 'Validation failed', details: formattedErrors });
            } else {
                next(error);
            }
        }
    };
}

/**
 * Validate request query params against a Zod schema.
 */
export function validateQuery(schema: ZodType) {
    return (req: Request, res: Response, next: NextFunction): void => {
        try {
            req.query = schema.parse(req.query) as Request['query'];
            next();
        } catch (error) {
            if (error instanceof ZodError) {
                const formattedErrors = error.issues.map((e) => ({
                    field: e.path.join('.'),
                    message: e.message,
                }));
                res.status(400).json({ error: 'Invalid query parameters', details: formattedErrors });
            } else {
                next(error);
            }
        }
    };
}
