import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import { sanitize } from './middleware/sanitize';
import { auditLog, forgetOldAuditIps } from './middleware/audit';
import { featureGate } from './middleware/featureGate';
import { rateLimitKey } from './utils/rateLimitKey';
import { attachWebSocketServer } from './services/websocket.service';
import { deleteOldSessions } from './services/session.service';
import { deleteOldReports } from './services/moderation.service';
import { startTwitterRefreshLoop } from './services/twitter.service';
import { initWebPush, cleanupStaleSubscriptions } from './services/webpush.service';
import { initApns } from './services/apns.service';
import { startPointsScorer, startPointsMaintenanceLoop } from './services/points.indexer';
import { startBountyMaintenanceLoop } from './services/bounty.service';
import { publishBadgeDefinitions } from './services/badges.publisher';

// ─── Version ─────────────────────────────────────────────────────────────────
const versionFile = path.resolve(__dirname, '..', '..', 'version.json');
const appVersion: string = fs.existsSync(versionFile)
    ? JSON.parse(fs.readFileSync(versionFile, 'utf8')).version
    : process.env.APP_VERSION || '0.0.0';

// ─── Route imports ────────────────────────────────────────────────────────────
import authRoutes from './routes/auth.routes';
import profileRoutes from './routes/profile.routes';
import projectRoutes from './routes/project.routes';
import uploadRoutes from './routes/upload.routes';
import messageRoutes from './routes/message.routes';
import watchlistRoutes from './routes/watchlist.routes';
import investmentRoutes from './routes/investment.routes';
import notificationRoutes from './routes/notification.routes';
import eventRoutes from './routes/events.routes';
import coworkRoutes from './routes/cowork.routes';
import analyticsRoutes from './routes/analytics.routes';
import searchRoutes from './routes/search.routes';
import adminRoutes from './routes/admin.routes';
import investorRoutes from './routes/investor.routes';
import contactRoutes from './routes/contact.routes';
import statsRoutes from './routes/stats.routes';
import settingsRoutes from './routes/settings.routes';
import accountRoutes from './routes/account.routes';
import contentRoutes from './routes/content.routes';
import newsRoutes from './routes/news.routes';
import mediaRoutes from './routes/media.routes';
import matchRoutes from './routes/match.routes';
import nip05Routes from './routes/nip05.routes';
import walletRoutes from './routes/wallet.routes';
import feedbackRoutes, { adminFeedbackRouter } from './routes/feedback.routes';
import pointsRoutes from './routes/points.routes';
import directoryRoutes from './routes/directory.routes';
import talentRoutes from './routes/talent.routes';
import albumRoutes from './routes/album.routes';
import coursesRoutes from './routes/courses.routes';
import voucherRoutes from './routes/voucher.routes';
import marketplaceRoutes from './routes/marketplace.routes';
import bountyRoutes from './routes/bounty.routes';
import flagsRoutes from './routes/flags.routes';
import signerRoutes from './routes/signer.routes';
import moderationRoutes from './routes/moderation.routes';
import { servableUploadsOnly } from './middleware/uploads';

const app = express();

// ─── Trust proxy (for correct IP behind Nginx / load balancer) ───────────────
// Must match the number of proxies in front of the server, or every visitor
// shares one IP and one rate limit. Production: TRUST_PROXY=2.
app.set('trust proxy', config.trustProxy);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'wss:', 'https:'],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameSrc: ["'none'"],
        },
    },
    crossOriginEmbedderPolicy: false, // Allow media loading from S3
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
    },
}));

// ─── Health check (before CORS so Docker healthchecks work) ──────────────────
app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        version: appVersion,
        timestamp: new Date().toISOString(),
    });
});

// ─── Version endpoint ────────────────────────────────────────────────────────
app.get('/api/version', (_req, res) => {
    res.json({
        version: appVersion,
        environment: config.nodeEnv,
        commit: process.env.GIT_COMMIT ?? 'unknown',
        commitShort: process.env.GIT_COMMIT_SHORT ?? 'unknown',
        branch: process.env.GIT_BRANCH ?? 'unknown',
        committedAt: process.env.GIT_COMMITTED_AT ?? null,
    });
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Web origins from CORS_ORIGIN plus the Capacitor native WebView origins
// (capacitor://localhost on iOS, https://localhost on Android)
const allowedOrigins = [config.corsOrigin, config.corsNativeOrigin]
    .join(',')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no Origin (same-origin browser requests and server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        // Reject with false instead of throwing — avoids triggering the 500
        // error handler for simple CORS mismatches (returns 403-like with no
        // Access-Control-Allow-Origin header, so the browser blocks it).
        callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Compression (gzip) ───────────────────────────────────────────────────────
app.use(compression());

// ─── Rate limiting ────────────────────────────────────────────────────────────
// General: 300 req / 15 min per account when signed in, per IP otherwise
// (utils/rateLimitKey.ts): a room on one Wi-Fi shares an IP.
// 300 per 15 min = 20/min, which is generous but safe
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
    skip: (req) => req.method === 'OPTIONS',
    keyGenerator: rateLimitKey,
});

// Upload: 60 files per 15 min per account (per IP signed out), so a room on
// one Wi-Fi doesn't share one budget and an album's photos go up in one go.
// Only uploads count: not deck downloads, nor the cleanup after a delete.
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Upload limit reached, please try again later' },
    skip: (req) => req.method !== 'POST' || req.path === '/discard',
    keyGenerator: rateLimitKey,
});

// Search / autocomplete: 120 per minute (frequent UI calls)
const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Search rate limit reached' },
});

// Contact form: 5 per hour
const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Too many contact submissions. Please try again later.' },
});

app.use('/api/', generalLimiter);
app.use('/api/upload', uploadLimiter);
app.use('/api/search', searchLimiter);
app.use('/api/contact', contactLimiter);

// ─── Body parsing ─────────────────────────────────────────────────────────────
// After the limiters, so a request over its limit is turned away before its
// body is read. Bodies are small JSON (files go up as multipart, through
// multer, in upload.routes); compressed bodies aren't taken, so a small
// request can't unpack into a big one.
app.use(express.json({ limit: '1mb', inflate: false }));
app.use(express.urlencoded({ extended: true, limit: '100kb', inflate: false }));

// ─── Input sanitization ───────────────────────────────────────────────────────
app.use(sanitize);

// ─── NIP-05 identity (must be before other routes) ───────────────────────────
app.use('/.well-known', nip05Routes);

// ─── Static files (local upload fallback) ────────────────────────────────────
app.use('/uploads', servableUploadsOnly, express.static(path.join(__dirname, '..', 'uploads')));

// ─── Audit logging (runs after auth middleware attaches req.user) ─────────────
app.use(auditLog);

// ─── API Routes ───────────────────────────────────────────────────────────────
// Runtime feature toggles: `featureGate(slug)` 404s a whole prefix while the
// flag is off. Core prefixes (auth, profiles, admin, flags, …) are never
// gated — admins must always be able to re-enable a feature. `/api/news` is
// gated per-endpoint inside its router because the Media page and the admin
// panel depend on `/api/news/settings`. Watchlist and matches belong to
// projects, and articles (`/api/content`) to news.
app.use('/api/flags', flagsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/signer', signerRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/projects', featureGate('projects'), projectRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/messages', featureGate('messages'), messageRoutes);
app.use('/api/watchlist', featureGate('projects'), watchlistRoutes);
app.use('/api/investments', featureGate('investors'), investmentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/events', featureGate('events'), eventRoutes);
app.use('/api/cowork', featureGate('cowork'), coworkRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/investors', featureGate('investors'), investorRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/content', featureGate('news'), contentRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/media', featureGate('media'), mediaRoutes);
app.use('/api/match', featureGate('projects'), matchRoutes);
app.use('/api/wallet', featureGate('zaps'), walletRoutes);
app.use('/api/feedback', featureGate('feedback'), feedbackRoutes);
app.use('/api/points', featureGate('points'), pointsRoutes);
app.use('/api/directory', featureGate('directories'), directoryRoutes);
app.use('/api/talent', featureGate('talent'), talentRoutes);
app.use('/api/albums', albumRoutes);
app.use('/api/courses', featureGate('courses'), coursesRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/marketplace', featureGate('marketplace'), marketplaceRoutes);
app.use('/api/bounties', featureGate('bounties'), bountyRoutes);
app.use('/api', moderationRoutes); // /api/reports, /api/blocks

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ─── Global error handler (must be last) ─────────────────────────────────────
app.use(errorHandler);

// ─── Unhandled rejections ─────────────────────────────────────────────────────
// Express 4 drops the promise an async handler returns, so an error thrown
// outside a handler's try/catch would otherwise end the whole process (Node's
// default) and take every member's connection with it. Log it instead.
process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled rejection:', reason);
});

// ─── HTTP server + WebSocket ──────────────────────────────────────────────────
const server = http.createServer(app);
attachWebSocketServer(server);

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(config.port, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                  BIES Backend Server v${appVersion.padEnd(39)}║
╠══════════════════════════════════════════════════════════════════╣
║  Server:   http://localhost:${config.port}                              ║
║  WS:       ws://localhost:${config.port}/ws                            ║
║  Health:   http://localhost:${config.port}/api/health                  ║
║  ENV:      ${config.nodeEnv.padEnd(55)}║
╠══════════════════════════════════════════════════════════════════╣
║  Routes: auth | profiles | projects | upload | messages          ║
║          watchlist | investments | notifications | events        ║
║          analytics | search | admin | contact | stats            ║
║          settings | content | news | match | websocket           ║
╚══════════════════════════════════════════════════════════════════╝
  `);

    // Start background Twitter feed refresh
    startTwitterRefreshLoop();

    // Initialize Web Push notifications
    initWebPush();
    cleanupStaleSubscriptions().catch(() => {});

    // Initialize native push (APNs) — no-ops when unconfigured
    initApns();

    // Delete sessions that ended over 30 days ago and reports closed over 12
    // months ago, and blank audit entries' IP addresses after 90 days
    // (privacy notice), now and twice a day.
    const pruneSessions = () => deleteOldSessions()
        .then((count) => { if (count) console.log(`[Sessions] Deleted ${count} old sessions`); })
        .catch((err) => console.error('[Sessions] Cleanup failed:', err));
    const pruneReports = () => deleteOldReports()
        .then((count) => { if (count) console.log(`[Moderation] Deleted ${count} old reports`); })
        .catch((err) => console.error('[Moderation] Cleanup failed:', err));
    const pruneAuditIps = () => forgetOldAuditIps()
        .then((count) => { if (count) console.log(`[Audit] Removed IP addresses from ${count} entries over 90 days old`); })
        .catch((err) => console.error('[Audit] Cleanup failed:', err));
    pruneSessions();
    pruneReports();
    pruneAuditIps();
    setInterval(() => { pruneSessions(); pruneReports(); pruneAuditIps(); }, 12 * 60 * 60 * 1000).unref();

    // Points scorer (relay indexer) + monthly rollover loop — a scorer
    // failure must never take down the API.
    try {
        startPointsScorer().catch((err) =>
            console.error('[Points] Scorer failed to start:', err)
        );
    } catch (err) {
        console.error('[Points] Scorer failed to start:', err);
    }
    try {
        startPointsMaintenanceLoop();
    } catch (err) {
        console.error('[Points] Maintenance loop failed to start:', err);
    }

    // Bounty maintenance loop (deadline expiry + escrow refunds) — a failure
    // must never take down the API.
    try {
        startBountyMaintenanceLoop();
    } catch (err) {
        console.error('[Bounties] Maintenance loop failed to start:', err);
    }

    // NIP-58 badge definitions (kind 30009, replaceable — republish is
    // harmless). Whitelists the issuer pubkey on the relay first; skipped
    // with one warn log when BIES_ISSUER_PRIVKEY is unset.
    publishBadgeDefinitions().catch((err) =>
        console.error('[Badges] Definition publish failed:', err)
    );
});

export default app;
