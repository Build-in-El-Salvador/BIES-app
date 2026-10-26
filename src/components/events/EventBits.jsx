import { useTranslation } from 'react-i18next';
import { ExternalLink, Check } from 'lucide-react';
import Avatar from '../Avatar';
import { openExternal } from '../../utils/openExternal';
import { hostOf, isFree, ticketProvider } from '../../utils/eventFormat';
import { isPlaceholderName } from '../../utils/profileComplete';
import biesLogo from '../../assets/logo-icon.svg';

/**
 * Small pieces an event shows wherever it's listed: the BIES tag, who's
 * behind it (faces and names), its price and where tickets are, and the
 * ticket button (or "I'm going" for a free event with no ticket link).
 */

export function BiesTag({ className = '' }) {
    const { t } = useTranslation();
    return (
        <span className={`ev-bies-tag ${className}`}>
            <img src={biesLogo} alt="" />
            {t('events.card.biesEvent')}
            <style jsx>{`
                .ev-bies-tag {
                    display: inline-flex; align-items: center; gap: 5px;
                    height: 26px; padding: 0 10px 0 4px; border-radius: var(--radius-full);
                    background: rgba(255, 255, 255, 0.95); color: var(--color-primary);
                    font-size: 0.75rem; font-weight: 700; letter-spacing: 0.02em;
                }
                .ev-bies-tag img { width: 18px; height: 18px; }
            `}</style>
        </span>
    );
}

const nameOf = (p) => (isPlaceholderName(p.name) ? '' : (p.name || '').trim());

/** "A", "A and B", "A and 2 more". */
export function namesText(names, t) {
    const list = names.filter(Boolean);
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];
    if (list.length === 2) return t('events.card.two', { a: list[0], b: list[1] });
    return t('events.card.more', { a: list[0], count: list.length - 1 });
}

/** One face: a member's photo, a business's logo, BIES's mark. */
function Face({ image, name, round = true }) {
    const initial = (name || '?').trim()[0]?.toUpperCase() || '?';
    return (
        <span className={`ev-face${round ? '' : ' square'}`}>
            <Avatar src={image} size={24} fallback={<span className="ev-face-initial">{initial}</span>} />
            <style jsx>{`
                .ev-face {
                    width: 24px; height: 24px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
                    margin-left: -8px; border: 2px solid var(--ev-face-ring, var(--color-surface));
                    background: var(--color-gray-100); display: inline-flex; align-items: center; justify-content: center;
                }
                .ev-face.square { border-radius: 7px; }
                .ev-face:first-child { margin-left: 0; }
                .ev-face :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
                .ev-face-initial { font-size: 0.65rem; font-weight: 700; color: var(--color-primary); }
            `}</style>
        </span>
    );
}

/**
 * Who's behind it, in one line with up to three faces: a BIES event names
 * its sponsors (or co-hosts); anyone else's, its host and co-hosts.
 */
export function WhoLine({ event, className = '' }) {
    const { t } = useTranslation();
    const host = hostOf(event);
    const partners = event.partners || [];
    const cohosts = partners.filter((p) => p.role === 'COHOST');
    const sponsors = partners.filter((p) => p.role === 'SPONSOR');
    const faces = [
        { name: host.name, image: host.isOfficial ? biesLogo : host.image, round: host.kind === 'member' },
        ...cohosts.map((p) => ({ name: p.name, image: p.image, round: p.kind === 'member' })),
        ...sponsors.map((p) => ({ name: p.name, image: p.image, round: p.kind === 'member' })),
    ].slice(0, 3);
    let text;
    if (host.isOfficial) {
        text = sponsors.length ? t('events.card.sponsoredBy', { names: namesText(sponsors.map(nameOf), t) })
            : cohosts.length ? t('events.card.with', { names: namesText(cohosts.map(nameOf), t) })
                : t('events.card.by', { names: 'BIES' });
    } else {
        const names = namesText([host.name, ...cohosts.map(nameOf)], t);
        text = sponsors.length
            ? t('events.card.bySponsored', { names, sponsors: namesText(sponsors.map(nameOf), t) })
            : t('events.card.by', { names });
    }
    return (
        <span className={`ev-who ${className}`}>
            <span className="ev-pile">{faces.map((f, i) => <Face key={i} {...f} />)}</span>
            <span className="ev-who-text">{text}</span>
            <style jsx>{`
                .ev-who { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 0.8rem; line-height: 1.3; color: var(--ev-who-color, var(--color-gray-500)); }
                .ev-pile { display: flex; flex-shrink: 0; }
                .ev-who-text { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
            `}</style>
        </span>
    );
}

/** "From $25 / Tickets on Luma", "Free / In the app". */
export function PriceLine({ event, className = '' }) {
    const { t } = useTranslation();
    const label = (event.priceLabel || '').trim() || (isFree(event) ? t('events.card.free') : '');
    const where = event.ticketUrl ? t('events.card.ticketsOn', { provider: ticketProvider(event.ticketUrl) }) : t('events.card.inTheApp');
    return (
        <span className={`ev-price ${className}`}>
            {label && <b>{label}</b>}
            <small>{where}</small>
            <style jsx>{`
                .ev-price { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
                .ev-price b { font-size: 0.9rem; font-weight: 700; color: var(--ev-price-color, var(--color-gray-900)); }
                .ev-price small { font-size: 0.75rem; color: var(--ev-price-sub, var(--color-gray-500)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            `}</style>
        </span>
    );
}

/**
 * The ticket button: opens the host's ticket page in the browser. With no
 * ticket link, "I'm going" (onGoing toggles it).
 */
export function TicketButton({ event, going, onGoing, busy = false, size = 'md' }) {
    const { t } = useTranslation();
    const tickets = !!event.ticketUrl;
    if (!tickets && !onGoing) return null;
    const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (tickets) openExternal(event.ticketUrl);
        else onGoing(!going);
    };
    return (
        <button
            type="button"
            className={`ev-tix ${size}${tickets ? '' : ` going${going ? ' on' : ''}`}`}
            aria-pressed={tickets ? undefined : !!going}
            disabled={!tickets && busy}
            onClick={onClick}
        >
            {tickets ? (
                <>{t('events.card.getTickets')} <ExternalLink size={size === 'lg' ? 16 : 14} aria-hidden="true" /></>
            ) : (
                <>
                    {going && <Check size={size === 'lg' ? 17 : 15} aria-hidden="true" />}
                    {going ? t('events.card.going') : t('events.card.imGoing')}
                </>
            )}
            <style jsx>{`
                .ev-tix {
                    position: relative; z-index: 2;
                    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
                    height: 38px; padding: 0 16px; border-radius: var(--radius-full); border: 0; cursor: pointer;
                    background: var(--color-secondary); color: #FFFFFF;
                    font-size: 0.875rem; font-weight: 700; white-space: nowrap; flex-shrink: 0;
                }
                .ev-tix:hover { background: var(--color-secondary-dark); }
                .ev-tix.lg { height: 48px; padding: 0 22px; font-size: 0.95rem; }
                .ev-tix.going { background: var(--color-surface); color: var(--color-primary); border: 1.5px solid var(--color-primary); }
                .ev-tix.going.on { background: var(--color-primary); color: #FFFFFF; }
                .ev-tix:disabled { opacity: 0.7; cursor: default; }
            `}</style>
        </button>
    );
}
