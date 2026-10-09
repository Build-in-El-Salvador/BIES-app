import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { z } from 'zod';

export const contactSchema = z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    role: z.enum(['BUILDER', 'INVESTOR', 'MEDIA', 'OTHER']).default('OTHER'),
    message: z.string().min(10).max(5000),
});

/**
 * POST /contact
 * Submit a contact form message.
 */
export async function submitContact(req: Request, res: Response): Promise<void> {
    try {
        const { name, email, role, message } = req.body;
        const ipAddress = req.ip || req.socket.remoteAddress || '';

        const submission = await prisma.contactSubmission.create({
            data: { name, email, role, message, ipAddress },
        });

        res.status(201).json({ message: 'Message received. We will get back to you soon.', id: submission.id });
    } catch (error) {
        console.error('Contact form error:', error);
        res.status(500).json({ error: 'Failed to submit contact form' });
    }
}
