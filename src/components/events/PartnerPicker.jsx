import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, Loader2, Building2, User, Sprout, Globe, Upload } from 'lucide-react';
import { directoryApi, profilesApi, uploadApi } from '../../services/api';
import Avatar from '../Avatar';

/**
 * An event's co-hosts and sponsors in the form: one search over members
 * and businesses and farms on BIES, each with a role (tap to switch
 * Co-host / Sponsor), and someone not on BIES by name, logo and link.
 * `value`: [{ role, kind: 'member'|'listing'|'other', userId?, listingId?,
 * listingType?, name, image, url? }].
 */
export default function PartnerPicker({ value, onChange, exclude = {} }) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [outside, setOutside] = useState(null); // { name, url, logo } while adding someone not on BIES
    const [uploading, setUploading] = useState(false);

    useEffect(() => {
        const q = query.trim();
        if (q.length < 2) { setResults(null); return undefined; }
        let cancelled = false;
        const timer = setTimeout(async () => {
            const [people, places] = await Promise.all([
                profilesApi.list({ search: q, limit: 5 }).catch(() => null),
                directoryApi.list({ search: q, limit: 5 }).catch(() => null),
            ]);
            if (cancelled) return;
            setResults([
                ...(people?.data || []).filter((p) => p.user?.id).map((p) => ({
                    kind: 'member', userId: p.user.id, name: p.name, image: p.avatar || '', sub: [p.title, p.company].filter(Boolean).join(' · '),
                })),
                ...(places?.data || []).map((l) => ({
                    kind: 'listing', listingId: l.id, listingType: l.type, name: l.name, image: l.logo || l.photo || '', sub: l.location || '',
                })),
            ]);
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [query]);

    const keyOf = (p) => (p.userId ? `u:${p.userId}` : p.listingId ? `l:${p.listingId}` : `n:${p.name.toLowerCase()}`);
    const taken = new Set([...value.map(keyOf), ...(exclude.userId ? [`u:${exclude.userId}`] : []), ...(exclude.listingId ? [`l:${exclude.listingId}`] : [])]);
    const add = (p) => {
        onChange([...value, { ...p, role: p.kind === 'member' ? 'COHOST' : 'SPONSOR' }]);
        setQuery('');
    };
    const flip = (i) => onChange(value.map((p, j) => (j === i ? { ...p, role: p.role === 'COHOST' ? 'SPONSOR' : 'COHOST' } : p)));
    const remove = (i) => onChange(value.filter((_, j) => j !== i));
    const kindLabel = (p) => (p.kind === 'member' ? t('events.form.kindMember') : p.kind === 'other' ? t('events.form.kindOutside')
        : p.listingType === 'FARM' ? t('events.form.kindFarm') : t('events.form.kindBusiness'));
    const kindIcon = (p) => (p.kind === 'member' ? <User size={16} /> : p.kind === 'other' ? <Globe size={16} /> : p.listingType === 'FARM' ? <Sprout size={16} /> : <Building2 size={16} />);

    const uploadLogo = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true);
        try {
            const res = await uploadApi.media(file);
            setOutside((o) => ({ ...o, logo: res.url }));
        } catch { /* stays without a logo */ } finally {
            setUploading(false);
            e.target.value = '';
        }
    };
    const addOutside = () => {
        const name = (outside?.name || '').trim();
        if (!name) return;
        let url = (outside.url || '').trim().replace(/^http:\/\//i, 'https://');
        if (url && !/^https:\/\//i.test(url)) url = `https://${url}`;
        onChange([...value, { role: 'SPONSOR', kind: 'other', name, image: outside.logo || '', url }]);
        setOutside(null);
    };

    const shown = (results || []).filter((r) => !taken.has(keyOf(r)));
    return (
        <div className="pp">
            {value.length > 0 && (
                <ul className="pp-list">
                    {value.map((p, i) => (
                        <li key={keyOf(p)} className="pp-row">
                            <span className={`pp-photo${p.kind === 'member' ? '' : ' square'}`}>
                                <Avatar src={p.image} size={36} fallback={kindIcon(p)} />
                            </span>
                            <span className="pp-text"><b>{p.name}</b><small>{kindLabel(p)}</small></span>
                            <button type="button" className="pp-role" onClick={() => flip(i)}>
                                {p.role === 'COHOST' ? t('events.form.cohost') : t('events.form.sponsor')}
                            </button>
                            <button type="button" className="pp-x" onClick={() => remove(i)} aria-label={t('events.form.remove', { name: p.name })}><X size={16} /></button>
                        </li>
                    ))}
                </ul>
            )}
            <input
                type="search"
                className="pp-search"
                value={query}
                autoComplete="off"
                placeholder={t('events.form.searchPartners')}
                aria-label={t('events.form.searchPartners')}
                onChange={(e) => setQuery(e.target.value)}
            />
            {results && shown.length === 0 && <p className="pp-hint">{t('events.form.noMatches')}</p>}
            {shown.length > 0 && (
                <ul className="pp-results">
                    {shown.map((r) => (
                        <li key={keyOf(r)}>
                            <button type="button" className="pp-result" onClick={() => add(r)}>
                                <span className={`pp-photo${r.kind === 'member' ? '' : ' square'}`}><Avatar src={r.image} size={36} fallback={kindIcon(r)} /></span>
                                <span className="pp-text"><b>{r.name}</b><small>{[kindLabel(r), r.sub].filter(Boolean).join(' · ')}</small></span>
                                <Plus size={18} className="pp-plus" aria-hidden="true" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {outside ? (
                <div className="pp-outside">
                    <div className="pp-outside-row">
                        <label className="pp-logo">
                            {outside.logo ? <Avatar src={outside.logo} size={44} fallback={null} /> : uploading ? <Loader2 size={18} className="pp-spin" /> : <Upload size={18} />}
                            <input type="file" accept="image/*" onChange={uploadLogo} hidden />
                            <span className="sr-only">{t('events.form.outsideLogo')}</span>
                        </label>
                        <input className="pp-input" placeholder={t('events.form.outsideName')} aria-label={t('events.form.outsideName')} maxLength={80}
                            value={outside.name || ''} onChange={(e) => setOutside((o) => ({ ...o, name: e.target.value }))} />
                    </div>
                    <input className="pp-input" placeholder={t('events.form.outsideLink')} aria-label={t('events.form.outsideLink')} inputMode="url"
                        value={outside.url || ''} onChange={(e) => setOutside((o) => ({ ...o, url: e.target.value }))} />
                    <div className="pp-outside-actions">
                        <button type="button" className="pp-link" onClick={() => setOutside(null)}>{t('events.detail.cancel')}</button>
                        <button type="button" className="pp-add" onClick={addOutside} disabled={!(outside.name || '').trim() || uploading}>{t('events.form.addOutside')}</button>
                    </div>
                </div>
            ) : (
                <button type="button" className="pp-link" onClick={() => setOutside({})}>+ {t('events.form.notOnBies')}</button>
            )}

            <style jsx>{`
                .pp { display: flex; flex-direction: column; gap: 8px; }
                .pp-list, .pp-results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
                .pp-row, .pp-result {
                    display: flex; align-items: center; gap: 10px; padding: 8px 10px; width: 100%;
                    border: 1px solid var(--color-gray-200); border-radius: 12px; background: var(--color-surface); font: inherit; text-align: left; color: inherit;
                }
                .pp-result { cursor: pointer; }
                .pp-photo { width: 36px; height: 36px; border-radius: 50%; overflow: hidden; flex: none; display: flex; align-items: center; justify-content: center; background: var(--color-gray-100); color: var(--color-gray-500); }
                .pp-photo.square { border-radius: 9px; }
                .pp-photo :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
                .pp-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
                .pp-text b { font-size: 0.9rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .pp-text small { font-size: 0.75rem; color: var(--color-gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .pp-role { flex: none; height: 30px; padding: 0 12px; border-radius: var(--radius-full); border: 0; cursor: pointer; background: rgba(0, 71, 171, 0.08); color: var(--color-primary); font-weight: 700; font-size: 0.8rem; }
                .pp-x { flex: none; width: 32px; height: 32px; border-radius: 50%; border: 0; cursor: pointer; background: var(--color-gray-100); color: var(--color-gray-600); display: flex; align-items: center; justify-content: center; }
                .pp-results :global(.pp-plus) { color: var(--color-primary); flex: none; }
                .pp-search, .pp-input {
                    width: 100%; box-sizing: border-box; min-height: 44px; padding: 0 12px; border-radius: 12px;
                    border: 1px solid var(--color-gray-200); background: var(--color-surface); font: inherit; font-size: 0.95rem; color: inherit;
                }
                .pp-hint { margin: 0; font-size: 0.8rem; color: var(--color-gray-500); }
                .pp-link { align-self: flex-start; border: 0; background: none; padding: 4px 0; cursor: pointer; color: var(--color-primary); font-weight: 600; font-size: 0.85rem; }
                .pp-outside { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px dashed var(--color-gray-300); border-radius: 12px; }
                .pp-outside-row { display: flex; gap: 8px; align-items: center; }
                .pp-logo {
                    width: 44px; height: 44px; flex: none; border-radius: 10px; overflow: hidden; cursor: pointer;
                    display: flex; align-items: center; justify-content: center; background: var(--color-gray-100); color: var(--color-gray-500);
                }
                .pp-logo :global(img) { width: 100%; height: 100%; object-fit: cover; }
                .pp-outside-actions { display: flex; justify-content: flex-end; gap: 12px; align-items: center; }
                .pp-add { height: 36px; padding: 0 16px; border-radius: var(--radius-full); border: 0; background: var(--color-primary); color: #FFFFFF; font-weight: 700; cursor: pointer; }
                .pp-add:disabled { opacity: 0.5; cursor: default; }
                .pp :global(.pp-spin) { animation: spin 1s linear infinite; }
                .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
            `}</style>
        </div>
    );
}
