import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Plus, User, X } from 'lucide-react';
import { directoryApi, profilesApi } from '../../services/api';
import Avatar from '../Avatar';
import { isPlaceholderName } from '../../utils/profileComplete';
import ModerationSheet from '../moderation/ModerationSheet';
import '../moderation/Moderation.css';
import './ListingOwnership.css';

/**
 * A business's team on its page: the member who runs it, then the members
 * who represent it (they host events as it). Who runs it manages the team
 * here; someone on it can leave. Server: listingTeam.controller.
 */

/** Runs the listing: its owner when it's their own business, or its linked member (as runsListing on the server). */
export const runsListing = (listing, userId) =>
    !!userId && (listing.memberUserId === userId || (listing.isOwnBusiness && listing.ownerId === userId));

const nameOf = (person, t) => {
    const name = person?.profile?.name;
    return isPlaceholderName(name) ? t('directory.ownership.aMember') : name.trim();
};

const errorText = (err, t) => err?.message || t('directory.team.error');

/**
 * @param {object} props.listing  from GET /directory/:id (with `team`)
 * @param {() => void} props.onChanged  refetch the listing
 */
export default function ListingTeam({ listing, user, isAdmin, titleStyle, onChanged }) {
    const { t } = useTranslation();
    const [sheet, setSheet] = useState(null); // 'manage' | 'leave'
    const team = listing.team || [];
    const runner = listing.memberUser || (listing.isOwnBusiness ? listing.owner : null);
    const canManage = runsListing(listing, user?.id) || !!isAdmin;
    const onTeam = team.some((m) => m.userId === user?.id);
    if (team.length === 0 && !canManage) return null;

    const people = [
        ...(runner ? [{ id: runner.id, user: runner, role: t('directory.team.owner') }] : []),
        ...team.map((m) => ({ id: m.userId, user: m.user })),
    ];
    const done = () => { setSheet(null); onChanged(); };

    return (
        <section className="dir-team" aria-labelledby="dir-team-title">
            <div className="dir-team-head">
                <h2 id="dir-team-title" style={titleStyle}>
                    {t('directory.team.title')}
                    {team.length > 0 && <span className="dir-team-count">{people.length}</span>}
                </h2>
                {canManage ? (
                    <button type="button" className="dir-team-action" onClick={() => setSheet('manage')}>{t('directory.team.manage')}</button>
                ) : onTeam && (
                    <button type="button" className="dir-team-action" onClick={() => setSheet('leave')}>{t('directory.team.leave')}</button>
                )}
            </div>
            {team.length === 0 ? (
                <button type="button" className="dir-team-empty" onClick={() => setSheet('manage')}>
                    <span className="dir-team-plus"><Plus size={20} /></span>
                    <span>{t('directory.team.empty', { name: listing.name })}</span>
                </button>
            ) : (
                <ul className="dir-team-row">
                    {people.map((p) => {
                        const name = nameOf(p.user, t);
                        return (
                            <li key={p.id}>
                                <Link to={`/builder/${p.user.nostrPubkey || p.user.id}`} className="dir-team-person">
                                    <span className="dir-team-photo">
                                        <Avatar src={p.user.profile?.avatar} size={64} fallback={<User size={26} />} />
                                    </span>
                                    <span className="dir-team-name">{name}</span>
                                    {p.role && <span className="dir-team-role">{p.role}</span>}
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}

            {sheet === 'manage' && <TeamSheet listing={listing} user={user} onClose={() => setSheet(null)} onChanged={onChanged} />}
            {sheet === 'leave' && <LeaveSheet listing={listing} user={user} onClose={() => setSheet(null)} onDone={done} />}

            <style jsx>{`
                .dir-team { margin-top: 1.75rem; }
                .dir-team-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
                .dir-team-count { margin-left: 8px; font-weight: 500; color: var(--color-gray-500); }
                .dir-team-action {
                    border: 0; background: none; padding: 4px 0; cursor: pointer;
                    font-size: 0.9rem; font-weight: 600; color: var(--color-primary);
                }
                .dir-team-empty {
                    width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 14px; cursor: pointer;
                    border: 1px dashed var(--color-gray-300); border-radius: var(--radius-lg); background: var(--color-surface);
                    text-align: left; font-size: 0.9rem; color: var(--color-gray-500);
                }
                .dir-team-plus {
                    width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center;
                    background: var(--color-gray-100); color: var(--color-primary);
                }
                .dir-team-row {
                    list-style: none; margin: 0; padding: 0 0 4px;
                    display: flex; gap: 12px; overflow-x: auto;
                    scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch; scrollbar-width: none;
                }
                .dir-team-row::-webkit-scrollbar { display: none; }
                .dir-team-row li { flex: 0 0 76px; scroll-snap-align: start; }
                .dir-team-row :global(.dir-team-person) {
                    display: flex; flex-direction: column; align-items: center; gap: 4px;
                    text-decoration: none; color: var(--color-gray-900); text-align: center;
                }
                .dir-team-photo {
                    width: 64px; height: 64px; border-radius: 50%; overflow: hidden;
                    display: flex; align-items: center; justify-content: center;
                    background: var(--color-gray-100); color: var(--color-gray-400);
                }
                .dir-team-photo :global(img) { width: 100%; height: 100%; object-fit: cover; }
                .dir-team-name {
                    max-width: 100%; margin-top: 2px;
                    font-size: 0.82rem; font-weight: 600; line-height: 1.25;
                    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
                    overflow-wrap: anywhere;
                }
                .dir-team-role { font-size: 0.75rem; color: var(--color-gray-500); }
            `}</style>
        </section>
    );
}

/** Add members to the team, or take them off. */
function TeamSheet({ listing, user, onClose, onChanged }) {
    const { t } = useTranslation();
    const [team, setTeam] = useState(listing.team || []);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null); // null: nothing searched yet
    const [busy, setBusy] = useState(''); // the userId being added or removed
    const [error, setError] = useState('');
    const runnerId = listing.memberUserId || (listing.isOwnBusiness ? listing.ownerId : null);

    useEffect(() => {
        const q = query.trim();
        if (q.length < 2) { setResults(null); return undefined; }
        let cancelled = false;
        const timer = setTimeout(() => {
            profilesApi.list({ search: q, limit: 8 })
                .then((res) => { if (!cancelled) setResults((res?.data || []).filter((p) => p.user?.id)); })
                .catch(() => { if (!cancelled) setResults([]); });
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [query]);

    const add = async (p) => {
        setBusy(p.user.id);
        setError('');
        try {
            const row = await directoryApi.addTeamMember(listing.id, p.user.id);
            setTeam((list) => [...list, row]);
            setQuery('');
            onChanged();
        } catch (err) {
            setError(errorText(err, t));
        } finally {
            setBusy('');
        }
    };
    const remove = async (userId) => {
        setBusy(userId);
        setError('');
        try {
            await directoryApi.removeTeamMember(listing.id, userId);
            setTeam((list) => list.filter((m) => m.userId !== userId));
            onChanged();
        } catch (err) {
            setError(errorText(err, t));
        } finally {
            setBusy('');
        }
    };

    const taken = new Set([runnerId, ...team.map((m) => m.userId)]);
    const shown = (results || []).filter((p) => !taken.has(p.user.id));
    return (
        <ModerationSheet title={t('directory.team.sheetTitle', { name: listing.name })} onClose={onClose}>
            <p className="mod-muted">{t('directory.team.sheetBody', { name: listing.name })}</p>
            {team.length > 0 && (
                <ul className="team-list">
                    {team.map((m) => (
                        <li key={m.userId} className="team-member">
                            <span className="own-avatar"><Avatar src={m.user?.profile?.avatar} size={36} fallback={<User size={18} />} /></span>
                            <span className="own-person-text"><span className="own-person-name">{nameOf(m.user, t)}</span></span>
                            <button
                                type="button"
                                className="team-remove"
                                aria-label={t('directory.team.remove', { name: nameOf(m.user, t) })}
                                onClick={() => remove(m.userId)}
                                disabled={!!busy}
                            >
                                {busy === m.userId ? <Loader2 size={18} className="mod-spin" /> : <X size={18} />}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <label className="mod-label" htmlFor="team-search">{t('directory.team.searchLabel')}</label>
            <input
                id="team-search"
                className="own-search"
                type="search"
                value={query}
                autoComplete="off"
                placeholder={t('directory.team.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
            />
            {results && shown.length === 0 && <p className="mod-hint">{t('directory.team.noMatches')}</p>}
            {shown.length > 0 && (
                <ul className="own-results" aria-label={t('directory.team.searchLabel')}>
                    {shown.map((p) => {
                        const sub = [p.title, p.company].filter(Boolean).join(' · ') || p.location;
                        return (
                            <li key={p.user.id}>
                                <button type="button" className="own-person" onClick={() => add(p)} disabled={!!busy}>
                                    <span className="own-avatar"><Avatar src={p.avatar} size={36} fallback={<User size={18} />} /></span>
                                    <span className="own-person-text">
                                        <span className="own-person-name">{p.name}</span>
                                        {sub && <span className="own-person-sub">{sub}</span>}
                                    </span>
                                    {busy === p.user.id ? <Loader2 size={18} className="mod-spin" /> : <Plus size={18} className="own-check" aria-hidden="true" />}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
            {error && <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
            {user?.id && !runsListing(listing, user.id) && (
                <p className="mod-hint">{t('directory.team.asAdmin')}</p>
            )}

            <style jsx>{`
                .team-list { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
                .team-member {
                    display: flex; align-items: center; gap: 10px; padding: 8px 10px;
                    border: 1px solid var(--color-gray-200); border-radius: var(--radius-md);
                }
                .team-member .own-person-text { flex: 1; min-width: 0; }
                .team-remove {
                    width: 36px; height: 36px; border-radius: 50%; border: 0; cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    background: var(--color-gray-100); color: var(--color-gray-600);
                }
                .own-avatar :global(img) { width: 100%; height: 100%; object-fit: cover; }
            `}</style>
        </ModerationSheet>
    );
}

/** Leave the team (someone on it, not the member who runs it). */
function LeaveSheet({ listing, user, onClose, onDone }) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const leave = async () => {
        setBusy(true);
        setError('');
        try {
            await directoryApi.removeTeamMember(listing.id, user.id);
            onDone();
        } catch (err) {
            setError(errorText(err, t));
            setBusy(false);
        }
    };
    return (
        <ModerationSheet title={t('directory.team.leaveTitle', { name: listing.name })} onClose={onClose}>
            <p className="mod-muted">{t('directory.team.leaveBody', { name: listing.name })}</p>
            {error && <div className="mod-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
            <div className="mod-actions">
                <button type="button" className="mod-button" onClick={leave} disabled={busy}>
                    {busy && <Loader2 size={18} className="mod-spin" />}
                    {t('directory.team.leaveSend')}
                </button>
            </div>
        </ModerationSheet>
    );
}
