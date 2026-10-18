// Opportunities' lists and rules: a mirror of server/src/controllers/
// project.controller.ts (keep both in sync). Pure, so tests can import it.

import { htmlToText } from '../../utils/text.js';
import { APP_HIDDEN_OPPORTUNITY_TYPES } from '../../config/appScope.js';

export { asWebLink, shortLink } from '../talent/talentOptions.js';

// The tags the older projects' rich-text editor wrote (bold, lists, lines,
// pasted paragraphs). Anything else in angle brackets is what was typed, like
// "<ana@cafe.sv>".
const EDITOR_TAG = /<\/?(?:div|p|br|b|i|u|s|strong|em|span|font|a|ul|ol|li|h[1-6]|blockquote)\b[^>]*>/i;

/** Older projects' descriptions were HTML (a rich-text editor): their text, a line for each block. */
export const plainText = (text) => (EDITOR_TAG.test(text || '') ? htmlToText(text) : text || '');

/** What an opportunity is (labels: opportunities.types.*). */
export const OPPORTUNITY_TYPES = ['investment', 'business-for-sale', 'job', 'partnership', 'program'];

/**
 * The types shown here: the phone app leaves some out
 * (APP_HIDDEN_OPPORTUNITY_TYPES), the website shows them all. An older
 * project with no type is an investment.
 */
export const typesShown = (native) => (native
    ? OPPORTUNITY_TYPES.filter((ty) => !APP_HIDDEN_OPPORTUNITY_TYPES.includes(ty))
    : OPPORTUNITY_TYPES);
export const isTypeShown = (type, native) => typesShown(native).includes(type || 'investment');

/**
 * The kinds within each type (labels: opportunities.kinds.<type>.*): an
 * investment's deal, a job's hours, who a partnership is looking for, what a
 * program is. A business for sale has none.
 */
export const OPPORTUNITY_KINDS = {
    investment: ['equity', 'convertible', 'loan', 'revenue-share', 'other'],
    'business-for-sale': [],
    job: ['full-time', 'part-time', 'contract', 'internship', 'volunteer'],
    partnership: ['co-founder', 'partner', 'distributor', 'supplier', 'sponsor', 'other'],
    program: ['grant', 'accelerator', 'competition', 'other'],
};

/** The types that must say their kind; an investment's deal is optional. */
export const KIND_REQUIRED = ['job', 'partnership', 'program'];

/** Industries (labels: opportunities.industries.*). */
export const INDUSTRIES = [
    'AGRICULTURE', 'CONSTRUCTION', 'EDUCATION', 'ENERGY', 'ENTERTAINMENT', 'FINTECH', 'FOOD', 'HEALTH',
    'INFRASTRUCTURE', 'LOGISTICS', 'REAL_ESTATE', 'RETAIL', 'SERVICES', 'TECHNOLOGY', 'TOURISM', 'OTHER',
];

/** An investment's stage (labels: opportunities.stages.*). */
export const STAGES = ['IDEA', 'MVP', 'GROWTH', 'SCALING'];

export const MAX_PHOTOS = 6;
/** Opportunities a member can have open at once. */
export const MAX_OPEN = 10;

/** What each type asks for, besides what every opportunity has. */
export const TYPE_FIELDS = {
    investment: ['stage', 'fundingGoal', 'raisedAmount', 'btcAccepted', 'requiresDeckApproval'],
    'business-for-sale': ['price', 'revenue', 'btcAccepted'],
    job: ['pay', 'remote', 'btcAccepted'],
    partnership: ['remote'],
    program: ['price', 'remote'],
};

export const hasField = (type, field) => (TYPE_FIELDS[type] || []).includes(field);

/** Industries older projects had, as they're shown now. */
const FOLDED_INDUSTRIES = { FITNESS: 'HEALTH', SAAS: 'TECHNOLOGY', WEB3: 'TECHNOLOGY', ECOMMERCE: 'RETAIL' };

/** An opportunity's industry as one of today's, or '' without one. */
export function industryOf(category) {
    if (!category) return '';
    const industry = FOLDED_INDUSTRIES[category] || category;
    return INDUSTRIES.includes(industry) ? industry : 'OTHER';
}

/**
 * The money an opportunity is about, by type: what an investment is raising,
 * a business's asking price, the most a program gives. { field, value }, the
 * value null when it isn't given; null for a type without one.
 */
export function amountOf(opportunity) {
    const type = opportunity?.type;
    if (type === 'investment') return { field: 'fundingGoal', value: opportunity.fundingGoal ?? null };
    if (type === 'business-for-sale' || type === 'program') return { field: 'price', value: opportunity.price ?? null };
    return null;
}

/** Dollars, short: $900, $25K, $1.2M. */
export function shortDollars(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    const trim = (x) => String(Number(x.toFixed(1)));
    if (n >= 1e9) return `$${trim(n / 1e9)}B`;
    if (n >= 1e6) return `$${trim(n / 1e6)}M`;
    if (n >= 1e3) return `$${trim(n / 1e3)}K`;
    return `$${Math.round(n)}`;
}

/** Dollars in full, for a page: $250,000. */
export function fullDollars(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '';
    return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Today in El Salvador (UTC−6 all year), as YYYY-MM-DD: the server's day. */
export function elSalvadorToday(now = new Date()) {
    return new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Whether it's open: the server says (isOpen); else not closed, and its closing day not over. */
export function isOpen(opportunity, today = elSalvadorToday()) {
    if (typeof opportunity?.isOpen === 'boolean') return opportunity.isOpen;
    return !opportunity?.closedAt && (!opportunity?.closesOn || opportunity.closesOn >= today);
}

/** Days until its closing day (0 = it closes today), or null without one. */
export function daysLeft(opportunity, today = elSalvadorToday()) {
    if (!opportunity?.closesOn) return null;
    const ms = Date.parse(`${opportunity.closesOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
    return Number.isFinite(ms) ? Math.round(ms / (24 * 60 * 60 * 1000)) : null;
}

/** A YYYY-MM-DD day as people read it: "30 Nov 2026" (no time zone shifts it). */
export function formatDay(day, locale = 'en') {
    const date = new Date(`${day}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return day || '';
    return date.toLocaleDateString(locale === 'es' ? 'es-SV' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** What a typed amount ("250,000", "$80k", "1.5m") is in dollars, or null. */
export function parseDollars(text) {
    const raw = String(text ?? '').trim().toLowerCase().replace(/[$,\s]/g, '');
    if (!raw) return null;
    const match = raw.match(/^(\d+(?:\.\d+)?)([km]?)$/);
    if (!match) return NaN;
    const n = Number(match[1]) * (match[2] === 'k' ? 1e3 : match[2] === 'm' ? 1e6 : 1);
    return Number.isFinite(n) ? n : NaN;
}

/**
 * The line under a card's title: what matters most for its type. A job's
 * hours and pay; who a partnership is looking for; a program's kind and
 * size; what a raise is after and its stage; a business's price. `t` is
 * i18next's.
 */
export function summaryOf(opportunity, t) {
    const o = opportunity || {};
    const parts = [];
    const industry = industryOf(o.category);
    const industryLabel = industry && industry !== 'OTHER' ? t(`opportunities.industries.${industry}`) : '';
    const kind = (OPPORTUNITY_KINDS[o.type] || []).includes(o.kind) ? t(`opportunities.kinds.${o.type}.${o.kind}`) : '';
    switch (o.type) {
        case 'investment':
            if (o.fundingGoal) parts.push(t('opportunities.card.raising', { amount: shortDollars(o.fundingGoal) }));
            if (o.stage) parts.push(t(`opportunities.stages.${o.stage}`));
            break;
        case 'business-for-sale':
            parts.push(o.price ? t('opportunities.card.asking', { amount: shortDollars(o.price) }) : t('opportunities.card.priceOnRequest'));
            if (industryLabel) parts.push(industryLabel);
            break;
        case 'job':
            if (kind) parts.push(kind);
            if (o.pay) parts.push(o.pay);
            break;
        case 'program':
            if (kind) parts.push(kind);
            if (o.price) parts.push(t('opportunities.card.upTo', { amount: shortDollars(o.price) }));
            break;
        default:
            if (kind) parts.push(kind);
            if (industryLabel) parts.push(industryLabel);
    }
    return parts.join(' · ');
}

/** "Job · Full-time": its type, and its kind when it has one. */
export function typeLine(opportunity, t) {
    const type = OPPORTUNITY_TYPES.includes(opportunity?.type) ? opportunity.type : 'investment';
    const kind = (OPPORTUNITY_KINDS[type] || []).includes(opportunity?.kind) ? opportunity.kind : '';
    return [t(`opportunities.types.${type}`), kind && t(`opportunities.kinds.${type}.${kind}`)].filter(Boolean).join(' · ');
}
