import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowRightLeft, Check, Loader2, User } from 'lucide-react';
import { adminApi, directoryApi, profilesApi } from '../../services/api';
import { getAssetUrl } from '../../utils/assets';
import { isPlaceholderName } from '../../utils/profileComplete';
import ModerationSheet from '../moderation/ModerationSheet';
import '../moderation/Moderation.css';
import './ListingOwnership.css';

/**
 * Handing a listing to the member who runs it, on the listing page:
 * OwnershipBanner shows the open requests the viewer can answer, and
 * OwnershipSheet claims a listing ("This is my business"), offers it to the
 * member who runs it, or (staff) moves it. Server: listingTransfer.controller.
 */

const personName = (person, t) => {
    const name = person?.profile?.name;
    return isPlaceholderName(name) ? t('directory.ownership.aMember') : name;
};

const errorText = (err, t) => err?.message || t('directory.ownership.error');

/**
 * @param {object} props.listing   with `transfers` from GET /directory/:id
 * @param {(notice?: string) => void} props.onChanged  refetch, and say what happened
 */
export function OwnershipBanner({ listing, user, isStaff, isFarm, onChanged }) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(null); // the transfer being answered
    const [error, setError] = useState('');
    const transfers = Array.isArray(listing.transfers) ? listing.transfers : [];
    if (!user?.id || transfers.length === 0) return null;

    const context = isFarm ? 'farm' : undefined;
    const me = user.id;
    const k = (key) => `directory.ownership.${key}`;

    const answer = (call, transferId, notice) => async () => {
        setBusy(transferId);
        setError('');
        try {
            await call(transferId);
            onChanged(notice);
        } catch (err) {
            setError(errorText(err, t));
        } finally {
            setBusy(null);
        }
    };
    const accept = directoryApi.acceptTransfer;
    const decline = directoryApi.declineTransfer;
    const cancel = directoryApi.cancelTransfer;

    const rows = transfers.map((tr) => {
        const from = personName(tr.fromUser, t);
        const to = personName(tr.toUser, t);
        if (tr.kind === 'claim' && tr.toUserId === me) {
            return { tr, text: t(k('myClaim'), { owner: from }), actions: [{ label: t(k('cancelRequest')), run: answer(cancel, tr.id), secondary: true }] };
        }
        if (tr.kind === 'claim' && tr.fromUserId === me) {
            if (tr.ownerDeclinedAt) return { tr, text: t(k('ownerSaidNo'), { name: to }), actions: [] };
            return {
                tr,
                text: t(k('claimToOwner'), { name: to, context }),
                hint: t(k('claimToOwnerHint')),
                actions: [
                    { label: t(k('handOver')), run: answer(accept, tr.id, t(k('handedOver'), { name: to })) },
                    { label: t(k('sayNo')), run: answer(decline, tr.id), secondary: true },
                ],
            };
        }
        if (tr.kind === 'claim' && isStaff) {
            return {
                tr,
                text: t(k(tr.ownerDeclinedAt ? 'claimToStaffDeclined' : 'claimToStaff'), { name: to }),
                actions: [
                    { label: t(k('handOver')), run: answer(accept, tr.id, t(k('handedOver'), { name: to })) },
                    { label: t(k('decline')), run: answer(decline, tr.id), secondary: true },
                ],
            };
        }
        if (tr.kind === 'offer' && tr.toUserId === me) {
            return {
                tr,
                text: t(k('offerToMe'), { name: from, context }),
                actions: [
                    { label: t(k('accept')), run: answer(accept, tr.id, t(k('movedToYou'))) },
                    { label: t(k('sayNo')), run: answer(decline, tr.id), secondary: true },
                ],
            };
        }
        if (tr.kind === 'offer' && tr.fromUserId === me) {
            return { tr, text: t(k('myOffer'), { name: to }), actions: [{ label: t(k('takeBack')), run: answer(cancel, tr.id), secondary: true }] };
        }
        return null;
    }).filter(Boolean);
    if (rows.length === 0) return null;

    return (
        <div className="own-banner">
            {rows.map(({ tr, text, hint, actions }) => (
                <div key={tr.id} className="own-row">
                    <ArrowRightLeft size={18} className="own-icon" aria-hidden="true" />
                    <div className="own-body">
                        <p className="own-text">{text}</p>
                        {tr.message && <p className="own-message">“{tr.message}”</p>}
                        {hint && <p className="own-hint">{hint}</p>}
                        {actions.length > 0 && (
                            <div className="own-actions">
                                {actions.map(({ label, run, secondary }) => (
                                    <button
                                        key={label}
                                        type="button"
                                        className={`own-button${secondary ? ' secondary' : ''}`}
                                        onClick={run}
                                        disabled={!!busy}
                                    >
                                        {busy === tr.id && !secondary && <Loader2 size={14} className="mod-spin" />}
                                        {label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            ))}
            {error && <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
        </div>
    );
}

/**
 * @param {'claim'|'offer'|'staff'} props.mode
 * @param {(notice: string) => void} props.onDone
 */
export function OwnershipSheet({ mode, listing, user, isFarm, onClose, onDone }) {
    const { t } = useTranslation();
    const k = (key) => `directory.ownership.${key}`;
    const context = isFarm ? 'farm' : undefined;
    const [message, setMessage] = useState('');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null); // null: nothing searched yet
    const [picked, setPicked] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    // Members to hand it to, as the name is typed.
    useEffect(() => {
        if (mode === 'claim') return undefined;
        const q = query.trim();
        if (q.length < 2) { setResults(null); return undefined; }
        let cancelled = false;
        const timer = setTimeout(() => {
            profilesApi.list({ search: q, limit: 8 })
                .then((res) => {
                    if (cancelled) return;
                    const rows = (res?.data || []).filter((p) => p.user?.id && p.user.id !== listing.ownerId && p.user.id !== user?.id);
                    setResults(rows);
                })
                .catch(() => { if (!cancelled) setResults([]); });
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [query, mode, listing.ownerId, user?.id]);

    const send = async () => {
        setBusy(true);
        setError('');
        try {
            if (mode === 'claim') {
                await directoryApi.claim(listing.id, message.trim());
                onDone(t(k('requestSent')));
            } else if (mode === 'offer') {
                const res = await directoryApi.offer(listing.id, picked.user.id);
                onDone(res?.moved ? t(k('handedOver'), { name: picked.name }) : t(k('offerSent'), { name: picked.name }));
            } else {
                await adminApi.moveDirectoryListing(listing.id, picked.user.id);
                onDone(t(k('handedOver'), { name: picked.name }));
            }
        } catch (err) {
            setError(errorText(err, t));
            setBusy(false);
        }
    };

    if (mode === 'claim') {
        const owner = personName(listing.owner, t);
        return (
            <ModerationSheet title={t(k('claimTitle'), { context })} onClose={onClose}>
                <p className="mod-muted">{t(k('claimBody'), { owner })}</p>
                <label className="mod-label" htmlFor="own-message">{t(k('messageLabel'))}</label>
                <textarea
                    id="own-message"
                    className="mod-textarea"
                    maxLength={500}
                    value={message}
                    placeholder={t(k('messagePlaceholder'))}
                    onChange={(e) => setMessage(e.target.value)}
                />
                {error && <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
                <div className="mod-actions">
                    <button type="button" className="mod-button" onClick={send} disabled={busy}>
                        {busy && <Loader2 size={18} className="mod-spin" />}
                        {t(k('claimSend'))}
                    </button>
                </div>
            </ModerationSheet>
        );
    }

    const staff = mode === 'staff';
    return (
        <ModerationSheet title={t(k(staff ? 'staffTitle' : 'offerTitle'))} onClose={onClose}>
            <p className="mod-muted">{t(k(staff ? 'staffBody' : 'offerBody'), { name: listing.name })}</p>
            <label className="mod-label" htmlFor="own-search">{t(k('searchLabel'))}</label>
            <input
                id="own-search"
                className="own-search"
                type="search"
                value={query}
                autoComplete="off"
                placeholder={t(k('searchPlaceholder'))}
                onChange={(e) => { setQuery(e.target.value); setPicked(null); }}
            />
            {results && results.length === 0 && <p className="mod-hint">{t(k('noMatches'))}</p>}
            {results && results.length > 0 && (
                <ul className="own-results" aria-label={t(k('searchLabel'))}>
                    {results.map((p) => {
                        const selected = picked?.user?.id === p.user.id;
                        const sub = [p.title, p.company].filter(Boolean).join(' · ') || p.location;
                        return (
                            <li key={p.user.id}>
                                <button
                                    type="button"
                                    className={`own-person${selected ? ' selected' : ''}`}
                                    aria-pressed={selected}
                                    onClick={() => setPicked(p)}
                                >
                                    <span className="own-avatar">
                                        {p.avatar ? <img src={getAssetUrl(p.avatar)} alt="" /> : <User size={18} />}
                                    </span>
                                    <span className="own-person-text">
                                        <span className="own-person-name">{p.name}</span>
                                        {sub && <span className="own-person-sub">{sub}</span>}
                                    </span>
                                    {selected && <Check size={18} className="own-check" aria-hidden="true" />}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
            {error && <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
            <div className="mod-actions">
                <button type="button" className="mod-button" onClick={send} disabled={!picked || busy}>
                    {busy && <Loader2 size={18} className="mod-spin" />}
                    {picked ? t(k(staff ? 'staffSend' : 'offerSend'), { name: picked.name }) : t(k(staff ? 'staffTitle' : 'offerTitle'))}
                </button>
            </div>
        </ModerationSheet>
    );
}
