import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Loader2, Link2, AlertCircle, MapPin, Video } from 'lucide-react';
import { directoryApi, eventsApi, uploadApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { getAssetUrl } from '../utils/assets';
import { fromFormFields, toFormFields } from '../utils/eventFormat';
import BackButton from '../components/BackButton';
import RichTextEditor from '../components/RichTextEditor';
import MemberSearchSelect from '../components/MemberSearchSelect';
import PartnerPicker from '../components/events/PartnerPicker';

/**
 * Adding or editing an event (/events/create, /events/edit/:id). Who hosts
 * it (me, or a business or farm I run or am on the team of: BIES's own
 * page makes it a BIES event), its cover and words, when (El Salvador
 * time) and where, the ticket link and price line (the app doesn't sell
 * tickets), co-hosts and sponsors, and who can see it.
 */

const KINDS = ['NETWORKING', 'MEETUP', 'WORKSHOP', 'CONFERENCE', 'HACKATHON', 'DEMO_DAY', 'OTHER'];
const VISIBILITIES = ['PUBLIC', 'PRIVATE', 'DRAFT'];

const EMPTY = {
    hostListingId: '', thumbnail: '', title: '', category: 'NETWORKING', description: '',
    startDate: '', startTime: '19:00', endDate: '', endTime: '',
    online: false, locationName: '', locationAddress: '', locationMapUrl: '', onlineUrl: '',
    ticketUrl: '', bitcoinUrl: '', priceLabel: '', visibility: 'PUBLIC',
};

/** An event's co-hosts and sponsors as the picker holds them. */
const pickerValue = (partners = []) => partners.map((p) => ({
    role: p.role, kind: p.kind, userId: p.userId, listingId: p.listingId, listingType: p.listingType,
    name: p.name, image: p.image, url: p.url,
}));

/** …and as the API takes them. */
const partnersPayload = (value) => value.map((p) => (p.kind === 'member' ? { role: p.role, userId: p.userId }
    : p.kind === 'listing' ? { role: p.role, listingId: p.listingId }
        : { role: p.role, name: p.name, logo: p.image || '', url: p.url || '' }));

const withHttps = (url) => { const u = (url || '').trim(); return u && !/^https?:\/\//i.test(u) ? `https://${u}` : u; };

export default function EventForm() {
    const { id } = useParams();
    const editing = !!id;
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { user } = useAuth();
    const [form, setForm] = useState(EMPTY);
    const [partners, setPartners] = useState([]);
    const [guests, setGuests] = useState([]);
    const [represented, setRepresented] = useState([]);
    const [loading, setLoading] = useState(editing);
    const [notYours, setNotYours] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [uploading, setUploading] = useState(false);
    const [importUrl, setImportUrl] = useState('');
    const [importing, setImporting] = useState(false);
    const [imported, setImported] = useState(false);
    const [otherVisibility, setOtherVisibility] = useState(''); // an older event's invite-only or limited setting

    const set = (key) => (e) => {
        const value = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
        setForm((f) => ({ ...f, [key]: value }));
    };

    useEffect(() => {
        directoryApi.represented().then((res) => setRepresented(res?.data || [])).catch(() => {});
    }, []);

    useEffect(() => {
        if (!editing) return;
        eventsApi.get(id).then((e) => {
            if (!e.canEdit) { setNotYours(true); return; }
            const start = toFormFields(e.startDate);
            const end = toFormFields(e.endDate);
            setForm({
                hostListingId: e.hostListing?.id || '', thumbnail: e.thumbnail || '', title: e.title || '',
                category: e.category || 'NETWORKING', description: e.description || '',
                startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time,
                online: !!e.isOnline, locationName: e.locationName || '', locationAddress: e.locationAddress || '',
                locationMapUrl: e.locationMapUrl || '', onlineUrl: e.onlineUrl || '',
                ticketUrl: e.ticketUrl || '', bitcoinUrl: e.bitcoinUrl || '', priceLabel: e.priceLabel || '',
                visibility: VISIBILITIES.includes(e.visibility) ? e.visibility : 'PUBLIC',
            });
            if (!VISIBILITIES.includes(e.visibility)) setOtherVisibility(e.visibility);
            setPartners(pickerValue(e.partners));
            setGuests((e.guestList || []).map((g) => ({ name: g.name, userId: g.userId })));
        }).catch(() => setNotYours(true)).finally(() => setLoading(false));
    }, [editing, id]);

    // A business being edited by its team keeps its host even if it isn't in my list.
    const hostChoices = represented.some((l) => l.id === form.hostListingId) || !form.hostListingId
        ? represented
        : [...represented, { id: form.hostListingId, name: t('events.form.hostAs') }];
    const hostListing = hostChoices.find((l) => l.id === form.hostListingId);

    const importFrom = async () => {
        if (!importUrl.trim()) return;
        setImporting(true);
        setError('');
        try {
            const data = await eventsApi.importUrl(withHttps(importUrl));
            const start = toFormFields(data.startAt);
            const end = toFormFields(data.endAt);
            setForm((f) => ({
                ...f,
                ...(data.title && { title: data.title }),
                ...(data.description && { description: data.description }),
                ...(data.startAt && { startDate: start.date, startTime: start.time }),
                ...(data.endAt && { endDate: end.date, endTime: end.time }),
                ...(data.locationName && { locationName: data.locationName }),
                ...(data.locationAddress && { locationAddress: data.locationAddress }),
                ...(data.isOnline !== undefined && { online: !!data.isOnline }),
                ...(data.onlineUrl && { onlineUrl: data.onlineUrl }),
                ticketUrl: data.ticketUrl || data.sourceUrl || f.ticketUrl,
                ...(data.thumbnail && { thumbnail: data.thumbnail }),
            }));
            setImported(true);
            setImportUrl('');
        } catch (err) {
            setError(err?.message || t('events.form.failed'));
        } finally {
            setImporting(false);
        }
    };

    const uploadCover = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true);
        setError('');
        try {
            const res = await uploadApi.media(file);
            setForm((f) => ({ ...f, thumbnail: res.url }));
        } catch (err) {
            setError(err?.message || t('events.form.failed'));
        } finally {
            setUploading(false);
            e.target.value = '';
        }
    };

    const submit = async (e) => {
        e.preventDefault();
        setError('');
        const startDate = fromFormFields(form.startDate, form.startTime);
        const endDate = fromFormFields(form.endDate || (form.endTime ? form.startDate : ''), form.endTime);
        const description = (form.description || '').replace(/<p><br><\/p>/g, '').trim();
        if (!form.title.trim() || !description || !startDate) { setError(t('events.form.required')); return; }
        if (endDate && endDate < startDate) { setError(t('events.form.endBeforeStart')); return; }
        const location = form.online ? '' : [form.locationName, form.locationAddress].map((s) => s.trim()).filter(Boolean).join(', ');
        const visibility = otherVisibility && form.visibility === 'PUBLIC' ? otherVisibility : form.visibility;
        const payload = {
            title: form.title.trim(),
            description,
            category: form.category,
            visibility,
            startDate,
            ...(endDate ? { endDate } : {}),
            isOnline: form.online,
            onlineUrl: form.online ? withHttps(form.onlineUrl) : '',
            location,
            locationName: form.online ? '' : form.locationName.trim(),
            locationAddress: form.online ? '' : form.locationAddress.trim(),
            locationMapUrl: form.online ? '' : withHttps(form.locationMapUrl),
            thumbnail: form.thumbnail,
            ticketUrl: withHttps(form.ticketUrl),
            bitcoinUrl: withHttps(form.bitcoinUrl),
            priceLabel: form.priceLabel.trim(),
            hostListingId: form.hostListingId || null,
            partners: partnersPayload(partners),
            ...(visibility === 'PRIVATE' || visibility === 'INVITE_ONLY' ? { guestList: guests.map((g) => ({ name: g.name, userId: g.userId })) } : {}),
            ...(editing ? {} : { nostrPublish: 'bies' }),
        };
        setSaving(true);
        try {
            const saved = editing ? await eventsApi.update(id, payload) : await eventsApi.create(payload);
            navigate(`/events/${saved.id || id}`, { replace: editing });
        } catch (err) {
            const reason = err?.data?.reason;
            setError((reason && t(`events.form.reasons.${reason}`, { defaultValue: '' }))
                || err?.data?.details?.map((d) => `${d.field}: ${d.message}`).join(', ')
                || err?.message || t('events.form.failed'));
            setSaving(false);
        }
    };

    if (loading) return <div className="container" style={{ padding: '4rem 1rem', textAlign: 'center' }}><Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} /></div>;
    if (notYours) {
        return (
            <div className="container" style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--color-gray-500)' }}>
                <BackButton fallback={id ? `/events/${id}` : '/events'} />
                <p>{t('events.form.notYours')}</p>
            </div>
        );
    }

    return (
        <form className="event-form container" onSubmit={submit} noValidate>
            <div className="ef-head">
                <BackButton fallback={editing ? `/events/${id}` : '/events'} />
                <h1>{editing ? t('events.form.editTitle') : t('events.form.newTitle')}</h1>
            </div>

            {!editing && (
                <section className="ef-group">
                    <label className="ef-label" htmlFor="ef-import">{t('events.form.importLabel')}</label>
                    <p className="ef-hint">{t('events.form.importHint')}</p>
                    <div className="ef-inline">
                        <span className="ef-input-icon"><Link2 size={16} aria-hidden="true" /></span>
                        <input id="ef-import" className="ef-input" inputMode="url" placeholder="https://lu.ma/…" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
                        <button type="button" className="ef-small-btn" onClick={importFrom} disabled={importing || !importUrl.trim()}>
                            {importing ? <Loader2 size={16} className="ef-spin" /> : t('events.form.importButton')}
                        </button>
                    </div>
                    {imported && <p className="ef-ok">{t('events.form.imported')}</p>}
                </section>
            )}

            {(represented.length > 0 || form.hostListingId) && (
                <section className="ef-group">
                    <label className="ef-label" htmlFor="ef-host">{t('events.form.hostAs')}</label>
                    <select id="ef-host" className="ef-input" value={form.hostListingId} onChange={set('hostListingId')}>
                        <option value="">{t('events.form.me', { name: user?.profile?.name || user?.name || '' })}</option>
                        {hostChoices.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                    {hostListing?.isOfficial && <p className="ef-ok">{t('events.form.officialHint', { name: hostListing.name })}</p>}
                </section>
            )}

            <section className="ef-group">
                <span className="ef-label">{t('events.form.cover')}</span>
                {form.thumbnail ? (
                    <div className="ef-cover">
                        <img src={getAssetUrl(form.thumbnail)} alt="" />
                        <div className="ef-cover-tools">
                            <label className="ef-small-btn">{t('events.form.changeCover')}<input type="file" accept="image/*" hidden onChange={uploadCover} /></label>
                            <button type="button" className="ef-small-btn quiet" onClick={() => setForm((f) => ({ ...f, thumbnail: '' }))}>{t('events.form.removeCover')}</button>
                        </div>
                    </div>
                ) : (
                    <label className="ef-cover-empty">
                        {uploading ? <Loader2 size={22} className="ef-spin" /> : <ImagePlus size={22} />}
                        <span>{uploading ? t('events.form.uploading') : t('events.form.addCover')}</span>
                        <input type="file" accept="image/*" hidden onChange={uploadCover} />
                    </label>
                )}
                <label className="ef-label" htmlFor="ef-title">{t('events.form.title')}</label>
                <input id="ef-title" className="ef-input" maxLength={200} placeholder={t('events.form.titlePlaceholder')} value={form.title} onChange={set('title')} />
                <label className="ef-label" htmlFor="ef-kind">{t('events.form.category')}</label>
                <select id="ef-kind" className="ef-input" value={form.category} onChange={set('category')}>
                    {KINDS.map((k) => <option key={k} value={k}>{t(`events.kinds.${k}`)}</option>)}
                </select>
                <span className="ef-label">{t('events.form.description')}</span>
                <RichTextEditor value={form.description} onChange={set('description')} placeholder={t('events.form.descriptionPlaceholder')} />
            </section>

            <section className="ef-group">
                <h2 className="ef-h">{t('events.form.when')}</h2>
                <div className="ef-two">
                    <div>
                        <label className="ef-label" htmlFor="ef-start">{t('events.form.starts')}</label>
                        <div className="ef-pair">
                            <input id="ef-start" type="date" className="ef-input" value={form.startDate} onChange={set('startDate')} />
                            <input type="time" className="ef-input" aria-label={t('events.form.starts')} value={form.startTime} onChange={set('startTime')} />
                        </div>
                    </div>
                    <div>
                        <label className="ef-label" htmlFor="ef-end">{t('events.form.ends')}</label>
                        <div className="ef-pair">
                            <input id="ef-end" type="date" className="ef-input" value={form.endDate} min={form.startDate || undefined} onChange={set('endDate')} />
                            <input type="time" className="ef-input" aria-label={t('events.form.ends')} value={form.endTime} onChange={set('endTime')} />
                        </div>
                    </div>
                </div>
                <p className="ef-hint">{t('events.form.timeHint')}</p>
            </section>

            <section className="ef-group">
                <h2 className="ef-h">{t('events.form.where')}</h2>
                <div className="ef-seg" role="group" aria-label={t('events.form.where')}>
                    <button type="button" aria-pressed={!form.online} className={!form.online ? 'on' : ''} onClick={() => setForm((f) => ({ ...f, online: false }))}><MapPin size={15} /> {t('events.form.inPerson')}</button>
                    <button type="button" aria-pressed={form.online} className={form.online ? 'on' : ''} onClick={() => setForm((f) => ({ ...f, online: true }))}><Video size={15} /> {t('events.form.online')}</button>
                </div>
                {form.online ? (
                    <>
                        <label className="ef-label" htmlFor="ef-online">{t('events.form.onlineLink')}</label>
                        <input id="ef-online" className="ef-input" inputMode="url" placeholder="https://zoom.us/j/…" value={form.onlineUrl} onChange={set('onlineUrl')} />
                        <p className="ef-hint">{t('events.form.onlineLinkHint')}</p>
                    </>
                ) : (
                    <>
                        <label className="ef-label" htmlFor="ef-venue">{t('events.form.venue')}</label>
                        <input id="ef-venue" className="ef-input" maxLength={200} placeholder={t('events.form.venuePlaceholder')} value={form.locationName} onChange={set('locationName')} />
                        <label className="ef-label" htmlFor="ef-address">{t('events.form.address')}</label>
                        <input id="ef-address" className="ef-input" maxLength={500} value={form.locationAddress} onChange={set('locationAddress')} />
                        <label className="ef-label" htmlFor="ef-map">{t('events.form.mapLink')}</label>
                        <input id="ef-map" className="ef-input" inputMode="url" value={form.locationMapUrl} onChange={set('locationMapUrl')} />
                        <p className="ef-hint">{t('events.form.mapLinkHint')}</p>
                    </>
                )}
            </section>

            <section className="ef-group">
                <h2 className="ef-h">{t('events.form.tickets')}</h2>
                <label className="ef-label" htmlFor="ef-tickets">{t('events.form.ticketLink')}</label>
                <input id="ef-tickets" className="ef-input" inputMode="url" placeholder="https://lu.ma/…" value={form.ticketUrl} onChange={set('ticketUrl')} />
                <p className="ef-hint">{t('events.form.ticketLinkHint')}</p>
                <label className="ef-label" htmlFor="ef-bitcoin">{t('events.form.bitcoinLink')}</label>
                <input id="ef-bitcoin" className="ef-input" inputMode="url" placeholder="https://pretix.eu/…" value={form.bitcoinUrl} onChange={set('bitcoinUrl')} />
                <p className="ef-hint">{t('events.form.bitcoinLinkHint')}</p>
                <label className="ef-label" htmlFor="ef-price">{t('events.form.price')}</label>
                <input id="ef-price" className="ef-input" maxLength={40} placeholder={t('events.form.pricePlaceholder')} value={form.priceLabel} onChange={set('priceLabel')} />
            </section>

            <section className="ef-group">
                <h2 className="ef-h">{t('events.form.partners')}</h2>
                <p className="ef-hint">{t('events.form.partnersHint')}</p>
                <PartnerPicker value={partners} onChange={setPartners} exclude={{ userId: form.hostListingId ? '' : user?.id, listingId: form.hostListingId }} />
            </section>

            <section className="ef-group">
                <h2 className="ef-h">{t('events.form.visibility')}</h2>
                <div className="ef-choices">
                    {VISIBILITIES.map((v) => (
                        <label key={v} className={`ef-choice${form.visibility === v ? ' on' : ''}`}>
                            <input type="radio" name="visibility" value={v} checked={form.visibility === v} onChange={set('visibility')} />
                            {t(`events.form.visibilities.${v}`)}
                        </label>
                    ))}
                </div>
                {(form.visibility === 'PRIVATE' || otherVisibility === 'INVITE_ONLY') && (
                    <>
                        <span className="ef-label">{t('events.form.guests')}</span>
                        <MemberSearchSelect value={guests} onChange={setGuests} />
                    </>
                )}
            </section>

            {error && <div className="ef-error" role="alert"><AlertCircle size={16} /> <span>{error}</span></div>}
            <button type="submit" className="ef-submit" disabled={saving || uploading}>
                {saving ? <><Loader2 size={18} className="ef-spin" /> {t('events.form.saving')}</> : editing ? t('events.form.save') : t('events.form.create')}
            </button>

            <style jsx>{`
                .event-form { max-width: 640px; margin: 0 auto; padding-top: var(--page-top, 1.5rem); padding-bottom: 3rem; display: flex; flex-direction: column; gap: 14px; box-sizing: border-box; }
                .ef-head { display: flex; align-items: center; gap: 10px; }
                .ef-head h1 { margin: 0; font-family: var(--font-display); font-size: 1.8rem; color: var(--color-gray-900); }
                .ef-group { background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: 16px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
                .ef-h { margin: 0; font-family: var(--font-display); font-size: 1.3rem; color: var(--color-gray-900); }
                .ef-label { font-size: 0.85rem; font-weight: 600; color: var(--color-gray-800); margin-top: 4px; }
                .ef-hint { margin: -2px 0 0; font-size: 0.8rem; color: var(--color-gray-500); }
                .ef-ok { margin: 0; font-size: 0.8rem; color: var(--color-success-text); font-weight: 600; }
                .ef-input {
                    width: 100%; box-sizing: border-box; min-height: 44px; padding: 0 12px; border-radius: 12px;
                    border: 1px solid var(--color-gray-200); background: var(--color-surface); font: inherit; font-size: 0.95rem; color: inherit;
                }
                .ef-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1); }
                .ef-inline { display: flex; align-items: center; gap: 8px; position: relative; }
                .ef-inline .ef-input { padding-left: 34px; }
                .ef-input-icon { position: absolute; left: 12px; color: var(--color-gray-400); display: flex; }
                .ef-small-btn {
                    flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 40px; padding: 0 14px;
                    border-radius: var(--radius-full); border: 0; cursor: pointer; background: var(--color-primary); color: #FFFFFF; font-weight: 700; font-size: 0.85rem;
                }
                .ef-small-btn.quiet { background: rgba(255, 255, 255, 0.92); color: var(--color-gray-900); }
                .ef-small-btn:disabled { opacity: 0.5; cursor: default; }
                .ef-cover { position: relative; border-radius: 14px; overflow: hidden; aspect-ratio: 16 / 9; background: var(--color-gray-100); }
                .ef-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
                .ef-cover-tools { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 8px; }
                .ef-cover-empty {
                    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; aspect-ratio: 16 / 9; cursor: pointer;
                    border: 1.5px dashed var(--color-gray-300); border-radius: 14px; color: var(--color-gray-500); font-size: 0.9rem; font-weight: 600;
                }
                .ef-two { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
                .ef-pair { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 8px; }
                .ef-seg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 4px; border-radius: 12px; background: var(--color-gray-100); }
                .ef-seg button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 38px; border: 0; border-radius: 9px; background: none; cursor: pointer; font-weight: 600; color: var(--color-gray-500); }
                .ef-seg button.on { background: var(--color-surface); color: var(--color-gray-900); box-shadow: var(--shadow-sm); }
                .ef-choices { display: flex; flex-direction: column; gap: 6px; }
                .ef-choice { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--color-gray-200); border-radius: 12px; cursor: pointer; font-size: 0.9rem; }
                .ef-choice.on { border-color: var(--color-primary); background: rgba(0, 71, 171, 0.05); }
                .ef-error { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 12px; background: #FEF2F2; color: #B91C1C; font-size: 0.9rem; }
                .ef-submit {
                    height: 52px; border: 0; border-radius: var(--radius-full); cursor: pointer;
                    background: var(--color-primary); color: #FFFFFF; font-size: 1rem; font-weight: 700;
                    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
                }
                .ef-submit:disabled { opacity: 0.7; cursor: default; }
                .event-form :global(.ef-spin) { animation: spin 1s linear infinite; }
                @media (min-width: 640px) { .ef-two { grid-template-columns: 1fr 1fr; } }
            `}</style>
        </form>
    );
}
