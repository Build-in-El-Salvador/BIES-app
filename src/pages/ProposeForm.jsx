import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, ImagePlus, Loader2, MapPin, Minus, Move, Pencil, Plus, Store, X } from 'lucide-react';
import { directoryApi, eventsApi, uploadApi } from '../services/api';
import { dayBefore, fromFormFields, toFormFields } from '../utils/eventFormat';
import Avatar from '../components/Avatar';
import BackButton from '../components/BackButton';
import CoverPhoto from '../components/CoverPhoto';
import { useCoverFramer } from '../components/CoverFramer';
import { COVER_ASPECT } from '../utils/coverFrame';

/**
 * Proposing a meetup (/events/propose, ?venue=<listing> from a business's
 * page; /events/propose/:id to edit one). What the plan is, when, where (a
 * business or farm on BIES, tagged: its address, map link and photo fill
 * in; or a place typed in, with a Google Maps link and a cover photo), how
 * many members it needs by when, and the most it can take. A place typed in
 * can go into the Business Directory afterwards, if the member likes.
 */

const MIN = 2;
const MAX = 50;

const EMPTY = {
    title: '', about: '', startDate: '', startTime: '13:00', endTime: '',
    placeName: '', mapUrl: '', thumbnail: '', coverFrame: '',
    minAttendees: 3, decideDate: '', decideTime: '12:00', maxAttendees: '', priceLabel: '',
};

const withHttps = (url) => { const u = (url || '').trim(); return u && !/^https?:\/\//i.test(u) ? `https://${u}` : u; };

export default function ProposeForm() {
    const { id } = useParams();
    const editing = !!id;
    const [params] = useSearchParams();
    const venueParam = params.get('venue');
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [form, setForm] = useState(EMPTY);
    const [venue, setVenue] = useState(null); // the business or farm on BIES it's at
    const [stage, setStage] = useState('proposed'); // editing one that's on: its number and deadline are settled
    const [decideTouched, setDecideTouched] = useState(editing);
    const [loading, setLoading] = useState(editing || !!venueParam);
    const [notYours, setNotYours] = useState(false);
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState(null); // { id, placeName }: proposed, at a place not on BIES
    // Businesses matching what's typed in Where.
    const [matches, setMatches] = useState([]);
    const [suggesting, setSuggesting] = useState(false);
    const whereRef = useRef(null);

    const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e?.target ? e.target.value : e }));

    /** Tag a business or farm: its name, address, map link and photo. */
    const tag = (listing) => {
        setVenue(listing);
        setSuggesting(false);
        setMatches([]);
        setForm((f) => ({
            ...f,
            placeName: listing.name,
            mapUrl: listing.mapUrl || '',
            thumbnail: listing.photo || '',
            coverFrame: listing.photo ? (listing.coverFrame || '') : '',
        }));
    };
    const untag = () => {
        setVenue(null);
        setForm((f) => ({ ...f, mapUrl: '', thumbnail: '', coverFrame: '' }));
        requestAnimationFrame(() => whereRef.current?.focus());
    };

    useEffect(() => {
        if (editing) {
            eventsApi.get(id).then((e) => {
                if (!e.canDelete) { setNotYours(true); return; }
                const start = toFormFields(e.startDate);
                const end = toFormFields(e.endDate);
                const decide = toFormFields(e.decideBy);
                setForm({
                    title: e.title || '', about: e.description || '',
                    startDate: start.date, startTime: start.time, endTime: end.time,
                    placeName: e.venueListing?.name || e.locationName || '', mapUrl: e.locationMapUrl || '',
                    thumbnail: e.thumbnail || '', coverFrame: e.coverFrame || '',
                    minAttendees: e.minAttendees || 3, decideDate: decide.date, decideTime: decide.time || '12:00',
                    maxAttendees: e.maxAttendees ? String(e.maxAttendees) : '', priceLabel: e.priceLabel || '',
                });
                setVenue(e.venueListing || null);
                setStage(e.stage || 'proposed');
            }).catch(() => setNotYours(true)).finally(() => setLoading(false));
            return;
        }
        if (venueParam) {
            directoryApi.get(venueParam)
                .then((res) => tag(res?.data || res))
                .catch(() => {})
                .finally(() => setLoading(false));
        }
    }, [editing, id, venueParam]);

    // Businesses and farms on BIES with a name like what's typed.
    const typed = form.placeName.trim();
    useEffect(() => {
        if (venue || !suggesting || typed.length < 2) { setMatches([]); return undefined; }
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const res = await directoryApi.list({ search: typed, limit: 6 });
                if (!cancelled) setMatches(res?.data || []);
            } catch {
                if (!cancelled) setMatches([]);
            }
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [typed, venue, suggesting]);

    // Decide by the day before, at noon, until the member picks another time.
    useEffect(() => {
        if (decideTouched || !form.startDate) return;
        setForm((f) => ({ ...f, decideDate: dayBefore(f.startDate), decideTime: '12:00' }));
    }, [form.startDate, decideTouched]);

    // A cover for a place that isn't on BIES: positioned, then uploaded.
    const cover = useCoverFramer(COVER_ASPECT.event, async ({ file, frame }) => {
        if (!file) { setForm((f) => ({ ...f, coverFrame: frame })); return; }
        setUploading(true);
        setError('');
        try {
            const res = await uploadApi.media(file);
            setForm((f) => ({ ...f, thumbnail: res.url, coverFrame: frame }));
        } catch (err) {
            setError(err?.message || t('events.propose.failed'));
        } finally {
            setUploading(false);
        }
    });

    const submit = async (e) => {
        e.preventDefault();
        setError('');
        const startDate = fromFormFields(form.startDate, form.startTime);
        const endDate = form.endTime ? fromFormFields(form.startDate, form.endTime) : '';
        const decideBy = fromFormFields(form.decideDate, form.decideTime);
        if (!form.title.trim() || !startDate || !typed) { setError(t('events.propose.required')); return; }
        const open = stage === 'proposed';
        if (open && !decideBy) { setError(t('events.propose.reasons.decide_by_missing')); return; }
        const max = parseInt(form.maxAttendees, 10);
        const payload = {
            title: form.title.trim(),
            description: form.about.trim(),
            category: 'MEETUP',
            startDate,
            ...(endDate && endDate > startDate ? { endDate } : {}),
            isOnline: false,
            location: venue ? [venue.name, venue.location].filter(Boolean).join(', ') : typed,
            locationName: typed,
            locationAddress: venue?.location || '',
            locationMapUrl: withHttps(form.mapUrl),
            venueListingId: venue?.id || null,
            thumbnail: form.thumbnail,
            coverFrame: form.thumbnail ? form.coverFrame : '',
            ...(open ? { minAttendees: form.minAttendees, decideBy } : {}),
            maxAttendees: Number.isFinite(max) && max > 0 ? max : null,
            priceLabel: form.priceLabel.trim(),
        };
        setSaving(true);
        try {
            if (editing) {
                await eventsApi.update(id, payload);
                navigate(`/events/${id}`, { replace: true });
                return;
            }
            const saved = await eventsApi.create(payload);
            // Somewhere not on BIES yet: offer to add it to the Business Directory.
            if (!venue) { setDone({ id: saved.id, placeName: typed }); setSaving(false); window.scrollTo(0, 0); return; }
            navigate(`/events/${saved.id}`, { replace: true });
        } catch (err) {
            const reason = err?.data?.reason;
            setError((reason && t(`events.propose.reasons.${reason}`, { defaultValue: '' })) || err?.message || t('events.propose.failed'));
            setSaving(false);
        }
    };

    if (loading) return <div className="container" style={{ padding: '4rem 1rem', textAlign: 'center' }}><Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} /></div>;
    if (notYours) {
        return (
            <div className="container" style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--color-gray-500)' }}>
                <BackButton fallback={id ? `/events/${id}` : '/events'} />
                <p>{t('events.propose.notYours')}</p>
            </div>
        );
    }

    if (done) {
        return (
            <div className="pf-done container">
                <span className="pf-done-icon"><Check size={28} aria-hidden="true" /></span>
                <h1>{t('events.propose.doneTitle')}</h1>
                <p>{t('events.propose.doneHint')}</p>
                <section className="pf-addplace">
                    <span className="pf-addplace-icon"><Store size={22} aria-hidden="true" /></span>
                    <h2>{t('events.propose.addPlaceTitle', { name: done.placeName })}</h2>
                    <p>{t('events.propose.addPlaceHint')}</p>
                    <button
                        type="button"
                        className="pf-btn"
                        onClick={() => navigate('/trusted/new', {
                            replace: true,
                            state: { fromEvent: { eventId: done.id, name: done.placeName, mapUrl: withHttps(form.mapUrl), photo: form.thumbnail, coverFrame: form.coverFrame } },
                        })}
                    >
                        {t('events.propose.addPlace')}
                    </button>
                    <button type="button" className="pf-btn quiet" onClick={() => navigate(`/events/${done.id}`, { replace: true })}>
                        {t('events.propose.notNow')}
                    </button>
                </section>
                <style jsx>{`
                    .pf-done { max-width: 560px; margin: 0 auto; padding: 2.5rem 1rem 3rem; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; box-sizing: border-box; }
                    .pf-done-icon { width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--color-success-bg, #ECFDF5); color: var(--color-success-text); }
                    .pf-done h1 { margin: 0; font-family: var(--font-display); font-size: 1.9rem; color: var(--color-gray-900); }
                    .pf-done > p { margin: 0; color: var(--color-gray-500); max-width: 40ch; }
                    .pf-addplace {
                        margin-top: 18px; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 10px;
                        padding: 20px 16px; border-radius: 18px; background: var(--color-surface); border: 1px solid var(--color-gray-200);
                    }
                    .pf-addplace-icon { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: rgba(0, 71, 171, 0.08); color: var(--color-primary); }
                    .pf-addplace h2 { margin: 0; font-family: var(--font-display); font-size: 1.4rem; line-height: 1.1; color: var(--color-gray-900); overflow-wrap: anywhere; }
                    .pf-addplace p { margin: 0 0 6px; font-size: 0.9rem; color: var(--color-gray-500); }
                    .pf-btn { width: 100%; height: 50px; border-radius: var(--radius-full); border: 0; cursor: pointer; background: var(--color-primary); color: #FFFFFF; font-size: 1rem; font-weight: 700; }
                    .pf-btn.quiet { background: none; color: var(--color-gray-700); border: 1px solid var(--color-gray-300); }
                `}</style>
            </div>
        );
    }

    const showMatches = suggesting && !venue && typed.length >= 2;

    return (
        <form className="pf container" onSubmit={submit} noValidate>
            <div className="pf-head">
                <BackButton fallback={editing ? `/events/${id}` : '/events'} />
                <h1>{editing ? t('events.propose.editTitle') : t('events.propose.newTitle')}</h1>
            </div>
            {!editing && <p className="pf-intro">{t('events.propose.intro')}</p>}

            <section className="pf-group">
                <label className="pf-label" htmlFor="pf-title">{t('events.propose.title')}</label>
                <input id="pf-title" className="pf-input" maxLength={200} placeholder={t('events.propose.titlePlaceholder')} value={form.title} onChange={set('title')} />
            </section>

            <section className="pf-group">
                <h2 className="pf-h">{t('events.propose.when')}</h2>
                <label className="pf-label" htmlFor="pf-date">{t('events.propose.date')}</label>
                <input id="pf-date" type="date" className="pf-input" value={form.startDate} onChange={set('startDate')} />
                <div className="pf-pair">
                    <div>
                        <label className="pf-label" htmlFor="pf-start">{t('events.propose.starts')}</label>
                        <input id="pf-start" type="time" className="pf-input" value={form.startTime} onChange={set('startTime')} />
                    </div>
                    <div>
                        <label className="pf-label" htmlFor="pf-end">{t('events.propose.ends')}</label>
                        <input id="pf-end" type="time" className="pf-input" value={form.endTime} onChange={set('endTime')} />
                    </div>
                </div>
                <p className="pf-hint">{t('events.propose.timeHint')}</p>
            </section>

            <section className="pf-group">
                <h2 className="pf-h">{t('events.propose.where')}</h2>
                {venue ? (
                    <>
                        <div className="pf-venue">
                            <span className="pf-venue-photo"><Avatar src={venue.logo || venue.photo} size={48} fallback={<Store size={20} />} /></span>
                            <span className="pf-venue-text">
                                <b>{venue.name}</b>
                                {venue.location && <span>{venue.location}</span>}
                            </span>
                            <button type="button" className="pf-venue-x" onClick={untag} aria-label={t('events.propose.change')}><X size={18} /></button>
                        </div>
                        <label className="pf-label" htmlFor="pf-map">{t('events.propose.mapLink')}</label>
                        <input id="pf-map" className="pf-input" inputMode="url" placeholder="https://maps.app.goo.gl/…" value={form.mapUrl} onChange={set('mapUrl')} />
                        <p className="pf-hint">{venue.mapUrl && form.mapUrl === venue.mapUrl ? t('events.propose.mapFromBusiness') : t('events.propose.mapLinkHint')}</p>
                    </>
                ) : (
                    <>
                        <div className="pf-where">
                            <MapPin size={18} className="pf-where-icon" aria-hidden="true" />
                            <input
                                id="pf-where"
                                ref={whereRef}
                                className="pf-input"
                                maxLength={200}
                                autoComplete="off"
                                placeholder={t('events.propose.wherePlaceholder')}
                                aria-label={t('events.propose.where')}
                                value={form.placeName}
                                onChange={(e) => { setSuggesting(true); set('placeName')(e); }}
                            />
                        </div>
                        {showMatches && (
                            <div className="pf-matches" role="listbox" aria-label={t('events.propose.inBusinesses')}>
                                {matches.length > 0 && <p className="pf-matches-h">{t('events.propose.inBusinesses')}</p>}
                                {matches.map((l) => (
                                    <button key={l.id} type="button" role="option" aria-selected="false" className="pf-match" onClick={() => tag(l)}>
                                        <span className="pf-match-photo"><Avatar src={l.logo || l.photo} size={40} fallback={<Store size={18} />} /></span>
                                        <span className="pf-match-text">
                                            <b>{l.name}</b>
                                            <span>{[l.category && t(`directory.categories.${l.category}`, { defaultValue: '' }), l.location].filter(Boolean).join(' · ')}</span>
                                        </span>
                                    </button>
                                ))}
                                <button type="button" role="option" aria-selected="false" className="pf-match typed" onClick={() => setSuggesting(false)}>
                                    <span className="pf-match-photo plain"><Pencil size={17} aria-hidden="true" /></span>
                                    <span className="pf-match-text">
                                        <b>{t('events.propose.useTyped', { name: typed })}</b>
                                        <span>{t('events.propose.useTypedHint')}</span>
                                    </span>
                                </button>
                            </div>
                        )}
                        <p className="pf-hint">{t('events.propose.tagHint')}</p>
                        <label className="pf-label" htmlFor="pf-map">{t('events.propose.mapLink')}</label>
                        <input id="pf-map" className="pf-input" inputMode="url" placeholder="https://maps.app.goo.gl/…" value={form.mapUrl} onChange={set('mapUrl')} />
                        <p className="pf-hint">{t('events.propose.mapLinkHint')}</p>
                    </>
                )}
            </section>

            <section className="pf-group">
                <span className="pf-label">{t('events.propose.cover')}</span>
                {venue ? (
                    <>
                        {form.thumbnail && <div className="pf-cover"><CoverPhoto src={form.thumbnail} frame={form.coverFrame} /></div>}
                        <p className="pf-hint">{t('events.propose.coverFromBusiness', { name: venue.name })}</p>
                    </>
                ) : form.thumbnail ? (
                    <>
                        <div className="pf-cover">
                            <CoverPhoto src={form.thumbnail} frame={form.coverFrame} />
                            {uploading && <span className="pf-cover-busy"><Loader2 size={22} className="pf-spin" /></span>}
                        </div>
                        <div className="pf-cover-tools">
                            <button type="button" className="pf-small quiet" onClick={() => cover.adjust(form.thumbnail, form.coverFrame)} disabled={uploading}>
                                <Move size={14} aria-hidden="true" /> {t('coverPhoto.position')}
                            </button>
                            <label className="pf-small">{t('events.propose.changeCover')}<input type="file" accept="image/*" hidden onChange={cover.choose} disabled={uploading} /></label>
                            <button type="button" className="pf-small quiet" onClick={() => setForm((f) => ({ ...f, thumbnail: '', coverFrame: '' }))}>{t('events.propose.removeCover')}</button>
                        </div>
                    </>
                ) : (
                    <label className="pf-cover-empty">
                        {uploading ? <Loader2 size={22} className="pf-spin" /> : <ImagePlus size={22} />}
                        <span>{uploading ? t('events.propose.uploading') : t('events.propose.addCover')}</span>
                        <input type="file" accept="image/*" hidden onChange={cover.choose} disabled={uploading} />
                    </label>
                )}
                {cover.framer}
            </section>

            <section className="pf-group">
                <h2 className="pf-h">{t('events.propose.numbers')}</h2>
                {stage === 'proposed' && (
                    <>
                        <span className="pf-label" id="pf-min-l">{t('events.propose.goesAheadIf')}</span>
                        <div className="pf-stepper" role="group" aria-labelledby="pf-min-l">
                            <button type="button" className="pf-step" aria-label={t('events.propose.fewer')} disabled={form.minAttendees <= MIN}
                                onClick={() => setForm((f) => ({ ...f, minAttendees: Math.max(MIN, f.minAttendees - 1) }))}>
                                <Minus size={18} />
                            </button>
                            <span className="pf-step-n" aria-live="polite">{form.minAttendees}</span>
                            <button type="button" className="pf-step" aria-label={t('events.propose.more')} disabled={form.minAttendees >= MAX}
                                onClick={() => setForm((f) => ({ ...f, minAttendees: Math.min(MAX, f.minAttendees + 1) }))}>
                                <Plus size={18} />
                            </button>
                            <span className="pf-step-words">{t('events.propose.peopleIn')}</span>
                        </div>
                        <label className="pf-label" htmlFor="pf-decide">{t('events.propose.decideBy')}</label>
                        <div className="pf-pair">
                            <input id="pf-decide" type="date" className="pf-input" value={form.decideDate} max={form.startDate || undefined}
                                onChange={(e) => { setDecideTouched(true); set('decideDate')(e); }} />
                            <input type="time" className="pf-input" aria-label={t('events.propose.decideBy')} value={form.decideTime}
                                onChange={(e) => { setDecideTouched(true); set('decideTime')(e); }} />
                        </div>
                        <p className="pf-hint">{t('events.propose.decideByHint')}</p>
                    </>
                )}
                <label className="pf-label" htmlFor="pf-max">{t('events.propose.maxCapacity')} <span className="pf-optional">{t('events.propose.optional')}</span></label>
                <input id="pf-max" type="number" inputMode="numeric" min={form.minAttendees} max={500} className="pf-input" placeholder={t('events.propose.maxCapacityPlaceholder')} value={form.maxAttendees} onChange={set('maxAttendees')} />
                <p className="pf-hint">{t('events.propose.maxCapacityHint')}</p>
            </section>

            <section className="pf-group">
                <label className="pf-label" htmlFor="pf-cost">{t('events.propose.cost')}</label>
                <input id="pf-cost" className="pf-input" maxLength={40} placeholder={t('events.propose.costPlaceholder')} value={form.priceLabel} onChange={set('priceLabel')} />
                <label className="pf-label" htmlFor="pf-about">{t('events.propose.about')} <span className="pf-optional">{t('events.propose.optional')}</span></label>
                <textarea id="pf-about" className="pf-input pf-area" rows={4} maxLength={5000} placeholder={t('events.propose.aboutPlaceholder')} value={form.about} onChange={set('about')} />
            </section>

            {error && <div className="pf-error" role="alert"><AlertCircle size={16} /> <span>{error}</span></div>}
            <button type="submit" className="pf-submit" disabled={saving || uploading}>
                {saving ? <><Loader2 size={18} className="pf-spin" /> {t('events.propose.saving')}</> : editing ? t('events.propose.save') : t('events.propose.submit')}
            </button>

            <style jsx>{`
                .pf { max-width: 640px; margin: 0 auto; padding-top: var(--page-top, 1.5rem); padding-bottom: 3rem; display: flex; flex-direction: column; gap: 14px; box-sizing: border-box; }
                .pf-head { display: flex; align-items: center; gap: 10px; }
                .pf-head h1 { margin: 0; font-family: var(--font-display); font-size: 1.8rem; color: var(--color-gray-900); }
                .pf-intro { margin: -4px 0 0; font-size: 0.9rem; color: var(--color-gray-500); }
                .pf-group { background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: 16px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
                .pf-h { margin: 0; font-family: var(--font-display); font-size: 1.3rem; color: var(--color-gray-900); }
                .pf-label { font-size: 0.85rem; font-weight: 600; color: var(--color-gray-800); margin-top: 4px; }
                .pf-optional { font-weight: 400; color: var(--color-gray-500); }
                .pf-hint { margin: -2px 0 0; font-size: 0.8rem; color: var(--color-gray-500); }
                .pf-input {
                    width: 100%; box-sizing: border-box; min-height: 44px; padding: 0 12px; border-radius: 12px;
                    border: 1px solid var(--color-gray-200); background: var(--color-surface); font: inherit; font-size: 0.95rem; color: inherit;
                }
                .pf-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1); }
                /* iOS draws date and time boxes at their own width, past the card: fit them. */
                .pf-input[type='date'], .pf-input[type='time'] { -webkit-appearance: none; appearance: none; display: block; min-width: 0; max-width: 100%; height: 44px; line-height: 42px; text-align: left; }
                .pf-input::-webkit-date-and-time-value { text-align: left; margin: 0; }
                .pf-area { padding: 10px 12px; min-height: 96px; resize: vertical; line-height: 1.45; }
                .pf-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
                .pf-where { position: relative; display: flex; align-items: center; }
                .pf-where .pf-input { padding-left: 38px; }
                .pf-where :global(.pf-where-icon) { position: absolute; left: 12px; color: var(--color-gray-400); }
                .pf-matches { border: 1px solid var(--color-gray-200); border-radius: 14px; overflow: hidden; background: var(--color-surface); box-shadow: var(--shadow-md); }
                .pf-matches-h { margin: 0; padding: 10px 12px 4px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--color-gray-500); }
                .pf-match { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; border: 0; background: none; cursor: pointer; text-align: left; font: inherit; color: inherit; }
                .pf-match:hover { background: var(--color-gray-100); }
                .pf-match.typed { border-top: 1px solid var(--color-gray-200); }
                .pf-match-photo { width: 40px; height: 40px; border-radius: 10px; overflow: hidden; flex: none; background: var(--color-gray-100); display: flex; align-items: center; justify-content: center; color: var(--color-gray-500); }
                .pf-match-photo :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
                .pf-match-text { min-width: 0; display: flex; flex-direction: column; }
                .pf-match-text b { font-size: 0.95rem; color: var(--color-gray-900); overflow-wrap: anywhere; }
                .pf-match-text span { font-size: 0.8rem; color: var(--color-gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .pf-venue { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; border: 1.5px solid var(--color-primary); background: rgba(0, 71, 171, 0.04); }
                .pf-venue-photo { width: 48px; height: 48px; border-radius: 12px; overflow: hidden; flex: none; background: var(--color-gray-100); display: flex; align-items: center; justify-content: center; color: var(--color-gray-500); }
                .pf-venue-photo :global(img) { width: 100%; height: 100%; object-fit: cover; display: block; }
                .pf-venue-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
                .pf-venue-text b { font-size: 1rem; color: var(--color-gray-900); }
                .pf-venue-text span { font-size: 0.82rem; color: var(--color-gray-500); }
                .pf-venue-x { width: 40px; height: 40px; border-radius: 50%; border: 0; background: var(--color-gray-100); color: var(--color-gray-700); display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
                .pf-cover { position: relative; border-radius: 14px; overflow: hidden; aspect-ratio: 16 / 10; background: var(--color-gray-100); }
                .pf-cover-busy { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.6); }
                .pf-cover-tools { display: flex; flex-wrap: wrap; gap: 8px; }
                .pf-small {
                    flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 40px; padding: 0 14px;
                    border-radius: var(--radius-full); border: 0; cursor: pointer; background: var(--color-primary); color: #FFFFFF; font-weight: 700; font-size: 0.85rem;
                }
                .pf-small.quiet { border: 1px solid var(--color-gray-300); background: var(--color-surface); color: var(--color-gray-900); }
                .pf-small:disabled { opacity: 0.5; cursor: default; }
                .pf-cover-empty {
                    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; aspect-ratio: 16 / 10; cursor: pointer;
                    border: 1.5px dashed var(--color-gray-300); border-radius: 14px; color: var(--color-gray-500); font-size: 0.9rem; font-weight: 600;
                }
                .pf-stepper { display: flex; align-items: center; gap: 12px; }
                .pf-step { width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--color-gray-300); background: var(--color-surface); color: var(--color-gray-900); display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
                .pf-step:disabled { opacity: 0.4; cursor: default; }
                .pf-step-n { min-width: 28px; text-align: center; font-family: var(--font-display); font-size: 1.9rem; line-height: 1; color: var(--color-gray-900); }
                .pf-step-words { font-size: 0.9rem; color: var(--color-gray-700); line-height: 1.3; }
                .pf-error { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 12px; background: #FEF2F2; color: #B91C1C; font-size: 0.9rem; }
                .pf-submit {
                    height: 52px; border: 0; border-radius: var(--radius-full); cursor: pointer;
                    background: var(--color-primary); color: #FFFFFF; font-size: 1rem; font-weight: 700;
                    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
                }
                .pf-submit:disabled { opacity: 0.7; cursor: default; }
                .pf :global(.pf-spin) { animation: spin 1s linear infinite; }
            `}</style>
        </form>
    );
}
