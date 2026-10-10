/**
 * BIES API Client
 *
 * Centralised HTTP client for all backend communication.
 *
 * Features:
 *  - The session's access token on every request, renewed before it expires
 *    and once more if the server says it has (services/session.js)
 *  - Signs out when the server says the session is over
 *  - Consistent error format
 *  - All API methods co-located here for easy maintenance
 */

import {
    API_BASE as BASE_URL,
    endSession,
    freshAccessToken,
    isSessionOver,
    refreshSession,
    waitForLogout,
} from './session.js';

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

// Sign-in endpoints answer 401 for a wrong code or signature, which says
// nothing about the session this device already has.
const isSignInPath = (path) => /^\/auth\/(email\/|nostr-|refresh|logout)/.test(path);

// What a caller sees when a refresh couldn't reach the server: try again
// later, not "signed out".
const unreachable = () => new Response(
    JSON.stringify({ error: 'Could not reach the server. Please try again.' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
);

/**
 * Fetch with the current access token. If the server says the token has
 * expired, refresh once and resend: a 401 from `authenticate` means nothing
 * was done. If it says the session is over, sign out.
 */
async function sendAuthorized(path, init) {
    const send = (token) => fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });

    // Signing in needs no token, and must wait for a logout still being sent.
    if (isSignInPath(path)) {
        await waitForLogout();
        return send(null);
    }

    let res = await send(await freshAccessToken());
    if (res.status === 401) {
        let { reason } = await res.clone().json().catch(() => ({}));
        if (reason === 'token_expired') {
            let token;
            try {
                token = await refreshSession();
            } catch {
                return unreachable();
            }
            if (!token) return res; // the session is over; refreshSession signed out
            res = await send(token);
            if (res.status !== 401) return res;
            ({ reason } = await res.clone().json().catch(() => ({})));
        }
        // The server has just said this session is over: sign out even if
        // another tab already cleared the shared storage. A missing token
        // only means this request went out signed out.
        if (isSessionOver(reason)) endSession({ force: reason !== 'missing_token' });
    }
    return res;
}

async function request(method, path, body = null, options = {}) {
    const res = await sendAuthorized(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...options.headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const data = await res.json().catch(() => ({ error: 'Invalid response from server' }));

    if (!res.ok) {
        const error = new Error(data.error || `Request failed (${res.status})`);
        error.status = res.status;
        error.data = data;
        throw error;
    }

    return data;
}

const get = (path, params = {}) => {
    const qs = Object.keys(params)
        .filter((k) => params[k] !== undefined && params[k] !== '' && params[k] !== null)
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join('&');
    return request('GET', qs ? `${path}?${qs}` : path);
};
const post = (path, body) => request('POST', path, body);
const put = (path, body) => request('PUT', path, body);
const del = (path) => request('DELETE', path);

// ─── Form-data upload helper (for files) ─────────────────────────────────────

async function uploadFile(path, formData) {
    const res = await sendAuthorized(path, {
        method: 'POST',
        headers: {},
        body: formData, // Let browser set Content-Type with boundary
    });

    const data = await res.json().catch(() => ({ error: 'Upload failed' }));
    if (!res.ok) {
        const error = new Error(data.error || 'Upload failed');
        error.status = res.status;
        throw error;
    }
    return data;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Onboarding voucher attribution (single choke point): if the visitor arrived
// via a /join/:code invite link, the code is stashed in localStorage and
// attached to the initial sign-in request, then cleared once
// the server accepts the request.
const withVoucherCode = (body) => {
    const voucherCode = localStorage.getItem('bies_onboarding_code') || undefined;
    return voucherCode ? { ...body, voucherCode } : body;
};

const clearVoucherCode = (data) => {
    localStorage.removeItem('bies_onboarding_code');
    return data;
};

export const authApi = {
    // Email sign-in: a 6-digit code by email, then a session. The first
    // sign-in creates the account, with a key BIES holds.
    emailStart: (email, lang) => post('/auth/email/start', { email, lang }),

    emailVerify: (email, code) =>
        post('/auth/email/verify', withVoucherCode({ email, code }))
            .then(clearVoucherCode),

    nostrChallenge: (pubkey) =>
        get('/auth/nostr-challenge', { pubkey }),

    nostrLogin: (pubkey, signedEvent, fingerprint) =>
        post('/auth/nostr-login', withVoucherCode({ pubkey, signedEvent, fingerprint }))
            .then(clearVoucherCode),

    me: () => get('/auth/me'),

    updateRole: (role) => put('/auth/role', { role }),
};

// ─── Hosted signer (email accounts) ──────────────────────────────────────────
// BIES holds the key: the server signs and returns the event.

export const signerApi = {
    sign: (event) => post('/signer/sign', { event }).then((data) => data.event),
    log: (limit) => get('/signer/log', { limit }),
};

// ─── Profiles ────────────────────────────────────────────────────────────────

export const profilesApi = {
    list: (params = {}) => get('/profiles', params),
    // params: { role, location, search, page, limit }

    get: (id) => get(`/profiles/${id}`),

    me: () => get('/profiles/me'),

    update: (data) => put('/profiles/me', data),

    // NIP-05 availability check
    checkNip05: (name) => get('/profiles/check-nip05', { name }),

    // Follow system
    follow: (id) => post(`/profiles/${id}/follow`),
    unfollow: (id) => del(`/profiles/${id}/follow`),
    getFollowing: (id, params = {}) => get(`/profiles/${id}/following`, params),
    getFollowers: (id, params = {}) => get(`/profiles/${id}/followers`, params),
};

// ─── Projects ────────────────────────────────────────────────────────────────

export const projectsApi = {
    list: (params = {}) => get('/projects', params),
    // params: { category, stage, ownerId, search, featured, sort, page, limit }

    get: (id) => get(`/projects/${id}`),

    create: (data) => post('/projects', data),

    update: (id, data) => put(`/projects/${id}`, data),

    delete: (id) => del(`/projects/${id}`),

    getDeck: (id) => get(`/projects/${id}/deck`),

    submit: (id) => put(`/projects/${id}/submit`, {}),

    expressInterest: (id) => post(`/projects/${id}/interest`, {}),

    requestDeck: (id, data) => post(`/projects/${id}/deck/request`, data),

    getAllDeckRequests: () => get('/projects/builder/deck-requests'),

    reviewDeckRequest: (projectId, requestId, status) =>
        put(`/projects/${projectId}/deck/requests/${requestId}`, { status }),

    postUpdate: (id, title, content) =>
        post(`/projects/${id}/updates`, { title, content }),
};

// ─── Directory (Farms & Certified Providers) ─────────────────────────────────

export const directoryApi = {
    list: (params = {}) => get('/directory', params),
    // params: { type, search, certified, btc, language, sort, page, limit, ownerId }

    get: (id) => get(`/directory/${id}`),

    create: (data) => post('/directory', data),

    update: (id, data) => put(`/directory/${id}`, data),

    delete: (id) => del(`/directory/${id}`),

    endorse: (id, comment = '') => post(`/directory/${id}/endorse`, { comment }),

    unendorse: (id) => del(`/directory/${id}/endorse`),
};

// ─── Marketplace (Shopstr / NIP-99) ──────────────────────────────────────────

export const marketplaceApi = {
    // Custodial-key publish/delete — Nostr-native users sign client-side
    // via nostrService.publishMarketplaceListing / deleteMarketplaceListing.
    publish: (data) => post('/marketplace/publish', data),

    remove: (data) => post('/marketplace/delete', data),

    // Moderation blocklist (GET is public; block/unblock are MOD-only)
    blocklist: () => get('/marketplace/blocklist'),

    block: (data) => post('/marketplace/blocklist', data),

    unblock: (id) => del(`/marketplace/blocklist/${id}`),
};

// ─── Upload ───────────────────────────────────────────────────────────────────

export const uploadApi = {
    media: (file) => {
        const fd = new FormData();
        fd.append('file', file);
        return uploadFile('/upload/media', fd);
    },

    deck: (file, projectId) => {
        const fd = new FormData();
        fd.append('file', file);
        return uploadFile(`/upload/deck?projectId=${projectId}`, fd);
    },
};

// ─── Messages ────────────────────────────────────────────────────────────────

export const messagesApi = {
    conversations: () => get('/messages/conversations'),

    thread: (partnerId, params = {}) =>
        get(`/messages/${partnerId}`, params),

    send: (recipientId, content, isEncrypted = true, nostrEventId = null) =>
        post('/messages', { recipientId, content, isEncrypted, nostrEventId }),

    delete: (id) => del(`/messages/${id}`),

    unreadCount: () => get('/messages/unread-count'),
};

// ─── Watchlist ────────────────────────────────────────────────────────────────

export const watchlistApi = {
    list: () => get('/watchlist'),

    add: (projectId, note = '') => post('/watchlist', { projectId, note }),

    remove: (projectId) => del(`/watchlist/${projectId}`),

    updateNote: (projectId, note) => put(`/watchlist/${projectId}/note`, { note }),

    check: (projectId) => get(`/watchlist/check/${projectId}`),
};

// ─── Investments ──────────────────────────────────────────────────────────────

export const investmentsApi = {
    list: (params = {}) => get('/investments', params),
    // params: { status, projectId, page, limit }

    get: (id) => get(`/investments/${id}`),

    create: (projectId, amount, currency = 'USD', terms = '', notes = '') =>
        post('/investments', { projectId, amount, currency, terms, notes }),

    update: (id, data) => put(`/investments/${id}`, data),

    fundingStats: (projectId) => get(`/investments/stats/${projectId}`),
};

// ─── Zaps ─────────────────────────────────────────────────────────────────────

export const zapsApi = {
    projectZaps: (projectId, params = {}) => get(`/zaps/project/${projectId}`, params),
    // params: { page, limit }

    userZaps: (pubkey, params = {}) => get(`/zaps/user/${pubkey}`, params),
    // params: { page, limit }

    projectZapStats: (projectId) => get(`/zaps/stats/${projectId}`),
};

// ─── Points & Gamification ────────────────────────────────────────────────────

export const pointsApi = {
    leaderboard: (params = {}) => get('/points/leaderboard', params),
    // params: { scope: 'monthly'|'lifetime', limit }

    me: () => get('/points/me'),

    user: (pubkey) => get(`/points/user/${pubkey}`),

    badges: () => get('/points/badges'),

    month: (m) => get(`/points/months/${m}`),
};

// ─── Bounties ─────────────────────────────────────────────────────────────────

export const bountiesApi = {
    list: (params = {}) => get('/bounties', params),
    // params: { status, rewardType, featured, mine, posterId, page, limit }

    get: (id) => get(`/bounties/${id}`),

    create: (data) => post('/bounties', data),
    // data: { title, description, rewardType, amount, deadline? }

    submit: (id, content) => post(`/bounties/${id}/submissions`, { content }),

    updateSubmission: (id, content) => put(`/bounties/${id}/submissions`, { content }),

    award: (id, submissionId) => post(`/bounties/${id}/award`, { submissionId }),

    unaward: (id) => post(`/bounties/${id}/unaward`, {}),

    markPaid: (id, via) => post(`/bounties/${id}/mark-paid`, { via }),
    // via: 'WALLET' | 'MANUAL'

    cancel: (id) => post(`/bounties/${id}/cancel`, {}),

    mirror: (id, eventId) => post(`/bounties/${id}/mirror`, eventId !== undefined ? { eventId } : {}),
};

// ─── Notifications ────────────────────────────────────────────────────────────

export const notificationsApi = {
    list: (params = {}) => get('/notifications', params),
    // params: { unread, page, limit }

    count: () => get('/notifications/count'),

    markRead: (id) => put(`/notifications/${id}/read`, {}),

    markAllRead: () => put('/notifications/read-all', {}),

    delete: (id) => del(`/notifications/${id}`),

    /**
     * Notify a BIES user about a feed interaction (comment, like, reply).
     * Fire-and-forget — errors are silently ignored.
     */
    feedInteraction: (data) => post('/notifications/feed-interaction', data).catch(() => {}),

    // Push subscription management
    getVapidKey: () => get('/notifications/push/vapid-key'),
    pushSubscribe: (subscription) => post('/notifications/push/subscribe', subscription.toJSON()),
    pushUnsubscribe: (endpoint) => request('DELETE', '/notifications/push/subscribe', { endpoint }),

    // Native push (APNs) device token management
    deviceTokenRegister: (token, platform) => post('/notifications/device-token', { token, platform }),
    deviceTokenUnregister: (token) => request('DELETE', '/notifications/device-token', { token }),
};

// ─── Events ───────────────────────────────────────────────────────────────────

export const eventsApi = {
    list: (params = {}) => get('/events', params),
    // params: { category, upcoming, search, isOfficial, isEndorsed, hostId, page, limit }

    listMine: (params = {}) => get('/events/my', params),
    listAttending: (params = {}) => get('/events/attending', params),

    get: (id) => get(`/events/${id}`),

    create: (data) => post('/events', data),

    update: (id, data) => put(`/events/${id}`, data),

    delete: (id) => del(`/events/${id}`),

    endorse: (id, endorse = true) => put(`/events/${id}/endorse`, { endorse }),

    rsvp: (id, status = 'GOING') => post(`/events/${id}/rsvp`, { status }),

    cancelRsvp: (id) => del(`/events/${id}/rsvp`),

    invite: (id, userId) => post(`/events/${id}/invite`, { userId }),

    importUrl: (url) => post('/events/import-url', { url }),

    // Ticketing (non-custodial Lightning payments to the event host)
    buyTicket: (id) => post(`/events/${id}/tickets`),
    // → { ticket: { id, bolt11, amountSats, status, verifySupported, expiresAt, ... } }

    getTicket: (id, ticketId) => get(`/events/${id}/tickets/${ticketId}`),
    // Polling this also triggers server-side LUD-21 settlement verification

    claimTicket: (id, ticketId, preimage) =>
        post(`/events/${id}/tickets/${ticketId}/claim`, { preimage }),

    myEventTickets: (id) => get(`/events/${id}/tickets/mine`),

    myTickets: () => get('/events/tickets/mine'),

    eventTickets: (id) => get(`/events/${id}/tickets`),
    // Host/admin only → { data: [...tickets with buyer], summary: { sold, revenueSats, pending, checkedIn } }

    checkinTicket: (id, ticketId) => post(`/events/${id}/tickets/${ticketId}/checkin`, {}),

    payTicketWithWallet: (id, ticketId, walletType) =>
        post(`/events/${id}/tickets/${ticketId}/pay`, { walletType }),
    // Pays the ticket invoice server-side from the buyer's connected wallet
    // (walletType: 'coinos' | 'blink') → { ticket, paymentStatus: 'PAID' | 'PENDING', preimage? }.
    // Errors carry err.status + err.data.code: 'wallet_not_connected' |
    // 'wallet_token_expired' | 'ticket_not_payable' | 'payment_failed'.
};

// ─── Cowork ───────────────────────────────────────────────────────────────────

export const coworkApi = {
    listVenues: () => get('/cowork/venues'),
    // → { data: Venue[], groups: [{ area, venues: Venue[] }] }

    addVenue: (data) => post('/cowork/venues', data),
    // data: { name, address?, area?, lat?, lng? } → Venue (200 existing | 201 created)

    listSessions: (filter = 'active') => get('/cowork/sessions', { filter }),
    // filter: 'active' | 'past' → { data: Session[] }

    getSession: (id) => get(`/cowork/sessions/${id}`),
    // → Session + attendees: [{ id, name, avatar, nostrPubkey, isHost }]

    createSession: (data) => post('/cowork/sessions', data),
    // data: { title, venueId? | (locationName + lat + lng), note?, amenities?, durationMinutes, startTime? } → Session

    joinSession: (id) => post(`/cowork/sessions/${id}/join`, {}),
    // → { attendeeCount, isAttending: true }

    leaveSession: (id) => del(`/cowork/sessions/${id}/join`),
    // → { attendeeCount, isAttending: false }

    endSession: (id) => post(`/cowork/sessions/${id}/end`, {}),
    // Host/admin only → Session (status: 'ENDED')
};

// ─── Analytics ────────────────────────────────────────────────────────────────

export const analyticsApi = {
    recordView: (projectId) => post(`/analytics/view/${projectId}`, {}),

    builderDashboard: () => get('/analytics/dashboard'),

    investorDashboard: () => get('/analytics/investor-dashboard'),

    project: (id) => get(`/analytics/project/${id}`),

    platform: () => get('/analytics/platform'),
};

// ─── Investor ─────────────────────────────────────────────────────────────────

export const investorApi = {
    requestRole: (data) => post('/investor/request', data),
};

// ─── Vouchers (relay access / onboarding) ────────────────────────────────────
// Public endpoints — work logged-out (the shared request wrapper only attaches
// the Authorization header when a token exists).

export const voucherApi = {
    info: (code) => get(`/vouchers/code/${encodeURIComponent(code)}`),

    redeem: (code, pubkey) =>
        post(`/vouchers/code/${encodeURIComponent(code)}/redeem`, { pubkey }),

    redemptionStatus: (id) => get(`/vouchers/redemptions/${encodeURIComponent(id)}/status`),
};

// ─── Search ───────────────────────────────────────────────────────────────────

export const searchApi = {
    search: (q, type = 'all', page = 1, limit = 10) =>
        get('/search', { q, type, page, limit }),

    suggestions: (q) => get('/search/suggestions', { q }),
};

// ─── Admin ────────────────────────────────────────────────────────────────────

export const adminApi = {
    users: (params = {}) => get('/admin/users', params),
    banUser: (id, banned) => put(`/admin/users/${id}/ban`, { banned }),
    setRole: (id, role) => put(`/admin/users/${id}/role`, { role }),
    setAdmin: (id, isAdmin) => put(`/admin/users/${id}/admin`, { isAdmin }),
    verifyUser: (id) => put(`/admin/users/${id}/verify`, {}),
    featureProject: (id, featured) => put(`/admin/projects/${id}/feature`, { featured }),
    deleteProject: (id) => del(`/admin/projects/${id}`),
    changeProjectOwner: (id, newOwnerId) => put(`/admin/projects/${id}/owner`, { newOwnerId }),
    listProjects: (params = {}) => get('/admin/projects', params),
    reviewProject: (id, action) => put(`/admin/projects/${id}/review`, { action }),
    listEvents: (params = {}) => get('/admin/events', params),
    featureEvent: (id, featured) => put(`/admin/events/${id}/feature`, { featured }),
    deleteUser: (id) => del(`/admin/users/${id}`),
    trashedUsers: (params = {}) => get('/admin/users/trash', params),
    restoreUser: (id) => put(`/admin/users/${id}/restore`, {}),
    purgeUser: (id) => del(`/admin/users/${id}/purge`),
    syncAccounts: (sourceUserId, targetUserId, deleteSource) =>
        post('/admin/users/sync', { sourceUserId, targetUserId, deleteSource }),
    auditLogs: (params = {}) => get('/admin/audit-logs', params),
    broadcast: (message) => post('/admin/broadcast', { message }),
    clearCache: (pattern = '') => post('/admin/cache/clear', { pattern }),
    investorRequests: (params = {}) => get('/admin/investor-requests', params),
    updateInvestorRequest: (id, status) => put(`/admin/investor-requests/${id}`, { status }),
    feedback: (params = {}) => get('/admin/feedback', params),
    updateFeedback: (id, data) => put(`/admin/feedback/${id}`, data),
    deleteFeedback: (id) => del(`/admin/feedback/${id}`),
    adjustPoints: (data) => post('/admin/points/adjust', data),
    listPointEvents: (params = {}) => get('/admin/points/events', params),
    recomputePoints: () => post('/admin/points/recompute', {}),
    grantBadge: (data) => post('/admin/points/badges/grant', data),
    revokeBadge: (userId, badgeId) => del(`/admin/points/badges/${userId}/${badgeId}`),
    listBounties: (params = {}) => get('/admin/bounties', params),
    deleteBounty: (id) => del(`/admin/bounties/${id}`),
    featureBounty: (id, featured) => post(`/admin/bounties/${id}/feature`, { featured }),
    listDirectory: (params = {}) => get('/admin/directory', params),
    reviewDirectoryListing: (id, action) => put(`/admin/directory/${id}/review`, { action }),
    featureDirectoryListing: (id, featured) => put(`/admin/directory/${id}/feature`, { featured }),
    setDirectoryScore: (id, baseScore) => put(`/admin/directory/${id}/score`, { baseScore }),
    recomputeDirectoryScores: () => post('/admin/directory/recompute', {}),
    deleteDirectoryListing: (id) => del(`/admin/directory/${id}`),
    listCourses: (params = {}) => get('/admin/courses', params),
    reviewCourse: (id, action, note) => put(`/admin/courses/${id}/review`, note ? { action, note } : { action }),
    featureCourse: (id, featured) => put(`/admin/courses/${id}/feature`, { featured }),
    deleteCourse: (id) => del(`/admin/courses/${id}`),
    createVoucher: (data) => post('/vouchers', data),
    listVouchers: () => get('/vouchers'),
    voucherRedemptions: (id) => get(`/vouchers/${id}/redemptions`),
    revokeVoucher: (id, revokeAccess) => post(`/vouchers/${id}/revoke`, { revokeAccess }),
    revokeRedemption: (id, revokeAccess) => post(`/vouchers/redemptions/${id}/revoke`, { revokeAccess }),
    updateFlags: (data) => put('/admin/flags', data),
};

// ─── Runtime feature flags (public read; admin write via adminApi) ──────────

export const flagsApi = {
    get: () => get('/flags'),
};

// ─── Courses (LMS) ───────────────────────────────────────────────────────────

export const coursesApi = {
    list: (params = {}) => get('/courses', params),
    // params: { category, level, priced: 'free'|'paid', search, sort: 'recent'|'popular', page, limit }
    get: (id) => get(`/courses/${id}`),
    listMine: () => get('/courses/my'),
    listEnrolled: () => get('/courses/enrolled'),
    create: (data) => post('/courses', data),
    update: (id, data) => put(`/courses/${id}`, data),
    delete: (id) => del(`/courses/${id}`),
    submit: (id) => post(`/courses/${id}/submit`, {}),
    setNostrRefs: (id, data) => post(`/courses/${id}/nostr-refs`, data),

    // Lessons (authoring)
    createLesson: (courseId, data) => post(`/courses/${courseId}/lessons`, data),
    updateLesson: (courseId, lessonId, data) => put(`/courses/${courseId}/lessons/${lessonId}`, data),
    deleteLesson: (courseId, lessonId) => del(`/courses/${courseId}/lessons/${lessonId}`),
    reorderLessons: (courseId, order) => put(`/courses/${courseId}/lessons/reorder`, { order }),

    // Learning (getLesson is the entitlement-gated content endpoint — 402 = paywall)
    getLesson: (courseId, lessonId) => get(`/courses/${courseId}/lessons/${lessonId}`),
    enroll: (id) => post(`/courses/${id}/enroll`, {}),
    unenroll: (id) => del(`/courses/${id}/enroll`),
    progress: (id) => get(`/courses/${id}/progress`),
    completeLesson: (courseId, lessonId, meta = {}) =>
        put(`/courses/${courseId}/lessons/${lessonId}/progress`, { completed: true, meta }),
    submitQuiz: (courseId, lessonId, answers) =>
        post(`/courses/${courseId}/lessons/${lessonId}/quiz`, { answers }),

    // Paid unlock
    purchaseStatus: (id) => get(`/courses/${id}/purchase`),
    claimPurchase: (id, data = {}) => post(`/courses/${id}/purchase/claim`, data),
};

// ─── Content (Media / Blog / Resources) ──────────────────────────────────────

export const contentApi = {
    articles: (params = {}) => get('/content/articles', params),
    // params: { category, search, page, limit }

    article: (idOrSlug) => get(`/content/articles/${idOrSlug}`),

    videos: (params = {}) => get('/content/videos', params),

    resources: (params = {}) => get('/content/resources', params),
};

// ─── News Settings & Feeds ──────────────────────────────────────────────────

export const newsApi = {
    settings: () => get('/news/settings'),
    twitterFeed: () => get('/news/twitter-feed'),
    liveFeed: (keyword) => get('/news/live-feed', keyword ? { keyword } : {}),
    updateSettings: (data) => put('/news/settings', data),
};

// ─── Feedback ───────────────────────────────────────────────────────────────

export const feedbackApi = {
    submit: (data) => post('/feedback', data),
};

// ─── Media (Live Feeds) ──────────────────────────────────────────────────────

export const mediaApi = {
    substack: () => get('/media/substack'),
    youtube: () => get('/media/youtube'),
    getReadState: () => get('/settings/media-read'),
    // Legacy full-array replace — prefer toggleReadState / bulkReadState below
    saveReadState: (data) => put('/settings/media-read', data),
    // Atomically add/remove a single item: itemType is 'watched' | 'read'
    toggleReadState: (itemId, itemType, value) =>
        post('/settings/media-read/toggle', { itemId, itemType, value }),
    // Server-side merge of add/remove deltas: { watched: [], read: [] } each
    bulkReadState: (add = {}, remove = {}) =>
        post('/settings/media-read/bulk', { add, remove }),
};

// ─── User Preferences (persistent across login/logout) ──────────────────────

export const preferencesApi = {
    get: () => get('/settings/preferences'),
    save: (data) => put('/settings/preferences', data),
};

// ─── Health ───────────────────────────────────────────────────────────────────

export const healthApi = {
    check: () => get('/health'),
};

// ─── Wallet (Coinos + Blink, server-mediated) ────────────────────────────────

export const walletApi = {
    createCoinos: (username) => post('/wallet/coinos/create', { username }),
    connectCoinos: (username, password) => post('/wallet/coinos/connect', { username, password }),
    disconnectCoinos: () => post('/wallet/coinos/disconnect'),
    coinosBalance: () => get('/wallet/coinos/balance'),
    coinosPay: (bolt11) => post('/wallet/coinos/pay', { bolt11 }),
    // -> { pr: string /* bolt11 */, hash: string }
    coinosInvoice: (amountSats, memo) => post('/wallet/coinos/invoice', { amountSats, ...(memo ? { memo } : {}) }),
    // -> { transactions: [{ type: 'incoming'|'outgoing', amountSats, createdAt, memo, hash }] }
    coinosTransactions: (limit = 20) => get(`/wallet/coinos/transactions?limit=${limit}`),

    // Blink (Galoy GraphQL API, spoken server-side with the user's API key)
    // -> { username, walletId, lightningAddress }
    blinkConnect: (apiKey) => post('/wallet/blink/connect', { apiKey }),
    blinkDisconnect: () => post('/wallet/blink/disconnect'),
    // -> { sats: number }
    blinkBalance: () => get('/wallet/blink/balance'),
    // -> { status: 'SUCCESS' | 'ALREADY_PAID' | 'PENDING' } (FAILURE throws server-side)
    blinkPay: (bolt11) => post('/wallet/blink/pay', { bolt11 }),
    // -> { pr: string /* bolt11 */, hash: string }
    blinkInvoice: (amountSats, memo) => post('/wallet/blink/invoice', { amountSats, ...(memo ? { memo } : {}) }),
    // -> { transactions: [{ type: 'incoming'|'outgoing', amountSats, createdAt, memo, hash }] }
    blinkTransactions: (limit = 20) => get(`/wallet/blink/transactions?limit=${limit}`),
};

// ─── WebSocket client ─────────────────────────────────────────────────────────

export class BiesWebSocket {
    constructor(onMessage, onConnect, onDisconnect) {
        this.onMessage = onMessage;
        this.onConnect = onConnect;
        this.onDisconnect = onDisconnect;
        this.ws = null;
        this.reconnectDelay = 1000;
        this.maxReconnectDelay = 30000;
        this.shouldReconnect = true;
    }

    async connect() {
        const token = await freshAccessToken();
        if (!token || !this.shouldReconnect) return;

        // The token travels as a subprotocol, not in the URL, which proxies log.
        const wsUrl = BASE_URL.replace(/^http/, 'ws').replace('/api', '') + '/ws';

        try {
            this.ws = new WebSocket(wsUrl, ['bies.v1', token]);

            this.ws.onopen = () => {
                console.log('[WS] Connected');
                if (this.onConnect) this.onConnect();
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    // The server sends this once the session check passed.
                    // Only then is it safe to reconnect quickly again: it can
                    // accept the connection and still close it right after.
                    if (data.type === 'connected') this.reconnectDelay = 1000;
                    if (this.onMessage) this.onMessage(data);
                } catch { /* ignore */ }
            };

            this.ws.onclose = (event) => {
                if (this.onDisconnect) this.onDisconnect();
                // 4003: the session has ended (logout elsewhere, ban, deletion).
                if (event.code === 4003) {
                    this.shouldReconnect = false;
                    endSession({ force: true });
                    return;
                }
                if (!this.shouldReconnect) return;
                const reconnect = () => setTimeout(() => this.connect(), this.reconnectDelay);
                // 4001: the token was refused; get a new one before retrying.
                if (event.code === 4001) {
                    refreshSession().then((fresh) => { if (fresh) reconnect(); }).catch(reconnect);
                } else {
                    reconnect();
                }
                this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
            };

            this.ws.onerror = () => {
                this.ws.close();
            };
        } catch { /* noop */ }
    }

    send(data) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    disconnect() {
        this.shouldReconnect = false;
        this.ws?.close();
    }
}
