import dotenv from 'dotenv';
import crypto from 'crypto';
import { parseTrustProxy } from '../utils/trustProxy';
dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

// ─── Security: refuse to start in production with default secrets ───────
if (isProduction) {
    if (!process.env.JWT_SECRET) {
        throw new Error('FATAL: JWT_SECRET environment variable must be set in production');
    }
    if (!process.env.ENCRYPTION_SECRET) {
        throw new Error('FATAL: ENCRYPTION_SECRET environment variable must be set in production');
    }
}

// Public origin of the web app; see appPublicUrl below.
const appPublicUrl = (process.env.APP_PUBLIC_URL || 'https://app.buildinelsalvador.com').replace(/\/+$/, '');

// In development, generate a random secret per process instead of using a static default
const devJwtSecret = crypto.randomBytes(32).toString('hex');
const devEncryptionSecret = crypto.randomBytes(16).toString('hex') + crypto.randomBytes(16).toString('hex');

export const config = {
    port: parseInt(process.env.PORT || '3001', 10),
    nodeEnv,
    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    // Native app WebView origins (Capacitor: capacitor://localhost on iOS,
    // https://localhost on Android) — comma-separated, env-overridable
    corsNativeOrigin: process.env.CORS_NATIVE_ORIGIN || 'capacitor://localhost,https://localhost',
    // Proxies between the visitor and this server (see utils/trustProxy.ts).
    // Production runs behind YunoHost nginx and the container nginx: TRUST_PROXY=2.
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

    // ─── Auth ───────────────────────────────────────────────────────────────
    jwtSecret: process.env.JWT_SECRET || devJwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    encryptionSecret: process.env.ENCRYPTION_SECRET || devEncryptionSecret,

    // ─── Redis (optional — falls back to in-memory) ─────────────────────────
    redisUrl: process.env.REDIS_URL || '',

    // ─── S3 Compatible Storage ───────────────────────────────────────────────
    s3: {
        endpoint: process.env.S3_ENDPOINT || '',
        region: process.env.S3_REGION || 'auto',
        accessKey: process.env.S3_ACCESS_KEY || '',
        secretKey: process.env.S3_SECRET_KEY || '',
        bucket: process.env.S3_BUCKET || 'bies-uploads',
        publicUrl: process.env.S3_PUBLIC_URL || '',
    },

    // ─── Admin ───────────────────────────────────────────────────────────────
    adminPubkeys: (process.env.ADMIN_PUBKEYS || '').split(',').filter(Boolean),

    // ─── Nostr ───────────────────────────────────────────────────────────────
    nostrPrivateRelay: process.env.NOSTR_PRIVATE_RELAY || '',
    nostrPublicRelay: process.env.NOSTR_PUBLIC_RELAY || 'wss://relay.buildinelsalvador.com',
    nostrRelays: (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://relay.primal.net,wss://nos.lol').split(','),

    // ─── BIES issuer identity (NIP-58 badges, certification labels) ──────────
    // Hex or nsec private key. Unset ⇒ Nostr badge publishing is disabled
    // (in-app badges keep working).
    issuerPrivkey: process.env.BIES_ISSUER_PRIVKEY || '',

    // ─── Public app origin ────────────────────────────────────────────────────
    // Used to build absolute URLs embedded in Nostr events (badge artwork).
    appPublicUrl,

    // ─── Hosted signer ────────────────────────────────────────────────────────
    // Relays the app may have BIES sign NIP-42 sign-in challenges for, on
    // behalf of an email account: BIES's own relay only. Comma-separated.
    // Default: the relay behind the web app (wss://app.buildinelsalvador.com/relay).
    // Development: SIGNER_AUTH_RELAYS=ws://localhost:5173/relay
    signer: {
        authRelays: (process.env.SIGNER_AUTH_RELAYS || `${appPublicUrl.replace(/^http/, 'ws')}/relay`)
            .split(',')
            .map((url) => url.trim())
            .filter(Boolean),
    },

    // ─── Twitter/X (gallery-dl + browser cookies) ──────────────────────────
    twitterCookiesPath: process.env.TWITTER_COOKIES_PATH || '',

    // ─── News Feed (gnews.io API) ───────────────────────────────────────────
    gnewsApiKey: process.env.GNEWS_API_KEY || '',

    // ─── Media Feeds (YouTube, etc.) ─────────────────────────────────────────
    youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID || '',

    // ─── Coinos (custodial Lightning wallet) ─────────────────────────────────
    coinosApiUrl: process.env.COINOS_API_URL || 'https://coinos.io/api',

    // ─── Blink (Galoy GraphQL Lightning wallet) ──────────────────────────────
    blinkApiUrl: process.env.BLINK_API_URL || 'https://api.blink.sv/graphql',

    // ─── Email (Resend HTTPS API) ─────────────────────────────────────────────
    // Sign-in codes go out through Resend's HTTPS API; the VPS blocks outbound
    // SMTP. Without a key, development logs each email to the console and
    // production refuses to send (sign-in by email is then unavailable).
    email: {
        resendApiKey: process.env.RESEND_API_KEY || '',
        from: process.env.EMAIL_FROM || 'BIES <login@buildinelsalvador.com>',
        // Ceiling on codes sent per 24 h across all addresses, so a flood of
        // sign-in requests can't use up the Resend quota pretix tickets share.
        // Resend's free plan allows 100 emails a day in total; raise this on
        // a paid plan.
        maxCodesPerDay: parseInt(process.env.EMAIL_CODES_MAX_PER_DAY || '60', 10),
    },

    // ─── App Review sign-in ───────────────────────────────────────────────────
    // A fixed 6-digit code for one address, so Apple and Google reviewers can
    // sign in without inbox access. Off unless both are set. The usual limits
    // still apply: the code must be requested first, and 5 wrong tries burn it.
    reviewLogin: {
        email: (process.env.REVIEW_LOGIN_EMAIL || '').trim().toLowerCase(),
        code: (process.env.REVIEW_LOGIN_CODE || '').trim(),
    },

    // ─── Web Push (VAPID) — optional, for offline push notifications ────────
    vapid: {
        publicKey: process.env.VAPID_PUBLIC_KEY || '',
        privateKey: process.env.VAPID_PRIVATE_KEY || '',
        subject: process.env.VAPID_SUBJECT || 'mailto:admin@bies.io',
    },

    // ─── Native Push (APNs) — optional, for iOS native push notifications ────
    // Leave APNS_KEY_ID / APNS_TEAM_ID / APNS_AUTH_KEY unset to disable.
    apns: {
        keyId: process.env.APNS_KEY_ID || '',
        teamId: process.env.APNS_TEAM_ID || '',
        bundleId: process.env.APNS_BUNDLE_ID || 'com.bies.app',
        // The .p8 auth key PEM. When stored single-line in an env var, real
        // newlines are escaped as "\n" — un-escape them back to real newlines.
        authKey: (process.env.APNS_AUTH_KEY || '').replace(/\\n/g, '\n'),
        // TestFlight / App Store builds use the production APNs host; Xcode
        // debug builds use the sandbox host. Mismatch => BadDeviceToken.
        production: process.env.APNS_PRODUCTION === 'true',
    },
};
