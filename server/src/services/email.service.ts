/**
 * Transactional email through Resend's HTTPS API.
 *
 * The VPS provider drops all outbound SMTP, so mail goes over HTTPS. The
 * buildinelsalvador.com domain is already verified in Resend (pretix tickets
 * use it). Without RESEND_API_KEY, development prints each email to the
 * console instead, and production throws so callers can report it.
 */

import { config } from '../config';

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

export interface OutgoingEmail {
    to: string;
    subject: string;
    text: string;
    html: string;
    /** Where replies go. The sending address takes no mail. */
    replyTo?: string;
}

export class EmailNotConfiguredError extends Error {
    constructor() {
        super('Email sending is not configured (RESEND_API_KEY is unset)');
        this.name = 'EmailNotConfiguredError';
    }
}

/**
 * Send one email. Resolves once Resend has accepted it; throws otherwise.
 */
export async function sendEmail(message: OutgoingEmail): Promise<void> {
    if (!config.email.resendApiKey) {
        if (config.nodeEnv === 'production') throw new EmailNotConfiguredError();
        console.log(`[Email] (dev, not sent) To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`);
        return;
    }

    const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.email.resendApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: config.email.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!res.ok) {
        // Resend's error body names the problem (bad key, unverified domain,
        // quota) and never echoes the API key.
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`Resend rejected the email: HTTP ${res.status} ${detail}`);
    }
}
