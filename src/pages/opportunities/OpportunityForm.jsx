import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, X, Trash2, Bitcoin, ImagePlus, Star, FileText, ChevronRight } from 'lucide-react';
import { projectsApi, uploadApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { objectionableMessage } from '../../components/moderation/objectionable';
import BackButton from '../../components/BackButton';
import { getAssetUrl } from '../../utils/assets';
import TypeBadge, { TYPE_STYLE, styleOf } from '../../components/opportunities/TypeBadge';
import {
    OPPORTUNITY_TYPES, OPPORTUNITY_KINDS, KIND_REQUIRED, INDUSTRIES, STAGES, MAX_PHOTOS, MAX_OPEN,
    asWebLink, elSalvadorToday, fullDollars, hasField, industryOf, isOpen, parseDollars, plainText,
} from '../../components/opportunities/opportunityOptions';

const emptyForm = {
    title: '',
    kind: '',
    category: '',
    description: '',
    stage: '',
    fundingGoal: '',
    raisedAmount: '',
    price: '',
    revenue: '',
    pay: '',
    location: '',
    remote: false,
    btcAccepted: false,
    closesOn: '',
    whatsapp: '',
    email: '',
    websiteUrl: '',
    requiresDeckApproval: true,
};

const DECK_TYPES = '.pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation';
// As the server takes them.
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 5000;
const PHONE = /^[+0-9\s()-]{1,30}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The fields that show their own error; for others, the message goes at the top.
const FIELD_ERRORS = ['title', 'kind', 'description', 'stage', 'fundingGoal', 'raisedAmount', 'price', 'revenue', 'closesOn', 'whatsapp', 'email', 'websiteUrl'];
const asText = (n) => (n === null || n === undefined || n === 0 ? '' : String(n));

/**
 * Post or edit an opportunity (/opportunities/new, /opportunities/:id/edit).
 * A new one starts with what it is (?type= picks it): a raise, a business
 * for sale, a job, a partnership or a program. Then the add-listing cards,
 * with only that type's fields: what it is (title, kind, industry, what it
 * says), the money and facts of its type, where and until when, photos (the
 * first is the cover), and how members reach its member. Only its member
 * edits it, and can delete it here; its type stays what it was posted as.
 *
 * @param {boolean} editMode - true at /opportunities/:id/edit
 */
const OpportunityForm = ({ editMode = false }) => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const navigate = useNavigate();
    const { id } = useParams();
    const [params] = useSearchParams();
    const location = useLocation();

    const [type, setType] = useState(() => (OPPORTUNITY_TYPES.includes(params.get('type')) ? params.get('type') : ''));
    const [form, setForm] = useState(emptyForm);
    const [photos, setPhotos] = useState([]);
    const [hasDeck, setHasDeck] = useState(false);
    const [deckFile, setDeckFile] = useState(null);
    // Its closing day as it was: one that has passed can stay, but not be set now.
    const [savedClosesOn, setSavedClosesOn] = useState('');

    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [atLimit, setAtLimit] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
    // A field the member must fix: shown beside it, and it gets the focus.
    const [fieldError, setFieldError] = useState(null); // { id, message }
    const [uploading, setUploading] = useState(false);
    const [photoError, setPhotoError] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const deleteRef = useRef(null);

    const isBusy = submitting || deleting || uploading;

    // Edit: load it (only its member edits it; the API says so too).
    // New: is there room for another open one?
    useEffect(() => {
        if (!user?.id) return undefined;
        let cancelled = false;
        (async () => {
            try {
                if (editMode) {
                    const o = await projectsApi.get(id);
                    if (cancelled) return;
                    if (o.ownerId !== user.id) {
                        setLoadError(t('opportunities.form.notYours'));
                        return;
                    }
                    setType(OPPORTUNITY_TYPES.includes(o.type) ? o.type : 'investment');
                    setForm({
                        title: o.title || '',
                        kind: o.kind || '',
                        category: o.category ? industryOf(o.category) : '',
                        description: plainText(o.description),
                        stage: o.stage || '',
                        fundingGoal: asText(o.fundingGoal),
                        raisedAmount: asText(o.raisedAmount),
                        price: asText(o.price),
                        revenue: asText(o.revenue),
                        pay: o.pay || '',
                        location: o.location || '',
                        remote: !!o.remote,
                        btcAccepted: !!o.btcAccepted,
                        closesOn: o.closesOn || '',
                        whatsapp: o.whatsapp || '',
                        email: o.email || '',
                        websiteUrl: o.websiteUrl || '',
                        requiresDeckApproval: o.requiresDeckApproval !== false,
                    });
                    setPhotos((Array.isArray(o.photos) && o.photos.length ? o.photos : [o.thumbnail]).filter(Boolean));
                    setHasDeck(!!o.hasDeck);
                    setSavedClosesOn(o.closesOn || '');
                    // Posted, but its pitch deck didn't upload (handleSubmit).
                    if (location.state?.deckFailed) setSubmitError(t('opportunities.form.deckFailed'));
                } else {
                    const mine = await projectsApi.list({ ownerId: user.id, limit: 50 });
                    const open = (Array.isArray(mine?.data) ? mine.data : []).filter((o) => isOpen(o)).length;
                    if (!cancelled) setAtLimit(open >= MAX_OPEN);
                }
            } catch (err) {
                if (!cancelled && editMode) setLoadError(err.message || t('opportunities.notFound'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [editMode, id, user?.id]);

    // The question to delete opens at the bottom of a long form: bring it into view.
    useEffect(() => {
        if (confirmDelete) deleteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, [confirmDelete]);

    const clearFieldError = (fieldId) => {
        if (fieldError?.id === fieldId) setFieldError(null);
    };

    const handleChange = (e) => {
        const { name, value, type: inputType, checked } = e.target;
        clearFieldError(`of-${name}`);
        if (['whatsapp', 'email', 'websiteUrl'].includes(name)) clearFieldError('of-contact');
        setForm((prev) => ({ ...prev, [name]: inputType === 'checkbox' ? checked : value }));
    };
    const setField = (name, value) => {
        clearFieldError(`of-${name}`);
        setForm((prev) => ({ ...prev, [name]: value }));
    };

    const chooseType = (next) => {
        setType(next);
        // Kinds belong to their type.
        setForm((prev) => ({ ...prev, kind: '' }));
        setFieldError(null);
        window.scrollTo({ top: 0 });
    };

    // ─── Photos: up to MAX_PHOTOS, uploaded one after another ─────────────────
    const handlePhotos = async (e) => {
        const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
        e.target.value = ''; // allow choosing the same file again
        if (!files.length) return;
        setUploading(true);
        setPhotoError('');
        let room = MAX_PHOTOS - photos.length;
        for (const file of files) {
            if (room <= 0) break;
            try {
                const result = await uploadApi.media(file);
                setPhotos((prev) => (prev.length < MAX_PHOTOS && !prev.includes(result.url) ? [...prev, result.url] : prev));
                room -= 1;
            } catch (err) {
                setPhotoError(err?.message || t('opportunities.form.uploadFailed'));
            }
        }
        setUploading(false);
    };
    const removePhoto = (url) => setPhotos((prev) => prev.filter((p) => p !== url));
    const makeCover = (url) => setPhotos((prev) => [url, ...prev.filter((p) => p !== url)]);

    // ─── Submit ───────────────────────────────────────────────────────────────
    const money = (name) => parseDollars(form[name]);

    const buildPayload = () => {
        const payload = {
            title: form.title.trim(),
            kind: form.kind,
            category: form.category || 'OTHER',
            description: form.description.trim(),
            location: form.location.trim(),
            closesOn: form.closesOn,
            photos,
            whatsapp: form.whatsapp.trim(),
            email: form.email.trim(),
            websiteUrl: asWebLink(form.websiteUrl),
        };
        if (!editMode) payload.type = type;
        if (hasField(type, 'stage')) payload.stage = form.stage || 'IDEA';
        if (hasField(type, 'fundingGoal')) payload.fundingGoal = money('fundingGoal');
        if (hasField(type, 'raisedAmount')) payload.raisedAmount = money('raisedAmount') || 0;
        // No price (0 too): on request.
        if (hasField(type, 'price')) payload.price = money('price') || null;
        if (hasField(type, 'revenue')) payload.revenue = money('revenue');
        if (hasField(type, 'pay')) payload.pay = form.pay.trim();
        if (hasField(type, 'remote')) payload.remote = form.remote;
        if (hasField(type, 'btcAccepted')) payload.btcAccepted = form.btcAccepted;
        if (hasField(type, 'requiresDeckApproval')) payload.requiresDeckApproval = form.requiresDeckApproval;
        return payload;
    };

    const showFieldError = (problem) => {
        setFieldError(problem);
        // No way to reach them: WhatsApp, the first of the three, gets the focus.
        const field = document.getElementById(problem.id === 'of-contact' ? 'of-whatsapp' : problem.id);
        field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        field?.focus({ preventScroll: true });
    };

    const showError = (message) => {
        setSubmitError(message);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    /** The first thing to fix before it can be posted, or null. */
    const firstProblem = () => {
        const badAmount = ['fundingGoal', 'raisedAmount', 'price', 'revenue'].find((f) => hasField(type, f) && Number.isNaN(money(f)));
        if (!form.title.trim()) return { id: 'of-title', message: t('opportunities.form.titleRequired') };
        // Older projects could have longer ones.
        if (form.title.trim().length > MAX_TITLE) return { id: 'of-title', message: t('opportunities.form.tooLong', { max: MAX_TITLE }) };
        if (!form.kind && KIND_REQUIRED.includes(type)) return { id: 'of-kind', message: t(`opportunities.form.kindRequired.${type}`) };
        if (!form.description.trim()) return { id: 'of-description', message: t('opportunities.form.descriptionRequired') };
        if (form.description.trim().length > MAX_DESCRIPTION) return { id: 'of-description', message: t('opportunities.form.tooLong', { max: MAX_DESCRIPTION }) };
        if (type === 'investment' && !form.stage) return { id: 'of-stage', message: t('opportunities.form.stageRequired') };
        if (badAmount) return { id: `of-${badAmount}`, message: t('opportunities.form.amountInvalid') };
        if (type === 'investment' && !money('fundingGoal')) return { id: 'of-fundingGoal', message: t('opportunities.form.raisingRequired') };
        // A typed date gets past the calendar's limit.
        if (form.closesOn && form.closesOn < elSalvadorToday() && form.closesOn !== savedClosesOn) return { id: 'of-closesOn', message: t('opportunities.form.closesOnPassed') };
        if (form.whatsapp.trim() && !PHONE.test(form.whatsapp.trim())) return { id: 'of-whatsapp', message: t('opportunities.form.whatsappInvalid') };
        if (form.email.trim() && !EMAIL.test(form.email.trim())) return { id: 'of-email', message: t('opportunities.form.emailInvalid') };
        if (!form.whatsapp.trim() && !form.email.trim() && !form.websiteUrl.trim()) return { id: 'of-contact', message: t('opportunities.form.contactRequired') };
        return null;
    };

    const handleSubmit = async () => {
        setSubmitError('');
        const problem = firstProblem();
        if (problem) {
            showFieldError(problem);
            return;
        }
        setSubmitting(true);
        try {
            const payload = buildPayload();
            const saved = editMode ? await projectsApi.update(id, payload) : await projectsApi.create(payload);
            if (deckFile && type === 'investment') {
                try {
                    await uploadApi.deck(deckFile, saved.id);
                    setDeckFile(null);
                } catch {
                    // The rest is saved. Editing: Save again tries the deck again.
                    if (editMode) {
                        showError(t('opportunities.form.deckFailedEdit'));
                        return;
                    }
                    // Posting: it's up; the deck can go up from Edit.
                    navigate(`/opportunities/${saved.id}/edit`, { replace: true, state: { deckFailed: true } });
                    return;
                }
            }
            // Back never reopens this form: a new one takes the form's place; an
            // edited one returns to where the form was opened from (its page), or
            // opens its page when the form was opened directly, or in place of
            // the new one's form (its pitch deck didn't upload).
            if (editMode && !location.state?.deckFailed && window.history.state?.idx > 0) navigate(-1);
            else navigate(`/opportunities/${saved.id}`, { replace: true });
        } catch (err) {
            const reason = err?.data?.reason;
            const field = err?.data?.field;
            if (objectionableMessage(t, err)) showError(objectionableMessage(t, err));
            else if (reason === 'invalid' && field) showFieldError({ id: `of-${field}`, message: err.message });
            else if (reason === 'too_many') showError(t('opportunities.form.tooMany', { max: err.data.max || MAX_OPEN }));
            else if (reason === 'not_your_photo') showError(t('opportunities.form.notYourPhoto'));
            else if (err.data?.details?.length) {
                // What the server took issue with, beside it when it can be.
                const field = err.data.details[0].field;
                if (FIELD_ERRORS.includes(field)) showFieldError({ id: `of-${field}`, message: t('opportunities.form.fieldInvalid') });
                else showError(t('opportunities.form.saveFailed'));
            } else showError(err.message || t('opportunities.form.saveFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async () => {
        setDeleting(true);
        setSubmitError('');
        try {
            await projectsApi.delete(id);
            navigate('/opportunities?mine=1', { replace: true });
        } catch (err) {
            setDeleting(false);
            setConfirmDelete(false);
            showError(err.message || t('opportunities.form.deleteFailed'));
        }
    };

    if (loading) {
        return (
            <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto', color: 'var(--color-gray-500)' }} />
            </div>
        );
    }

    if (loadError || atLimit) {
        return (
            <div className="container">
                <div style={{ textAlign: 'center', padding: '4rem 1rem', maxWidth: 480, margin: '0 auto' }}>
                    <h2>{atLimit ? t('opportunities.form.atLimitTitle') : t('opportunities.notFound')}</h2>
                    <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0', lineHeight: 1.5 }}>
                        {atLimit ? t('opportunities.form.tooMany', { max: MAX_OPEN }) : loadError}
                    </p>
                    <Link to={atLimit ? '/opportunities?mine=1' : '/opportunities'} style={{ marginTop: '1.5rem', display: 'inline-flex', textDecoration: 'none', fontWeight: 600, color: 'var(--color-primary)' }}>
                        {atLimit ? t('opportunities.form.seeYours') : t('opportunities.back')}
                    </Link>
                </div>
            </div>
        );
    }

    const fieldErrorFor = (fieldId) => (fieldError?.id === fieldId
        ? <p className="of-field-error" id={`${fieldId}-error`}>{fieldError.message}</p>
        : null);
    const invalid = (fieldId) => ({
        'aria-invalid': fieldError?.id === fieldId || undefined,
        'aria-describedby': fieldError?.id === fieldId ? `${fieldId}-error` : undefined,
    });

    // ─── First: what is it? ───────────────────────────────────────────────────
    if (!type) {
        return (
            <div className="opportunity-form-page">
                <div className="container">
                    <div className="of-content">
                        <div className="of-header">
                            <div className="back-head">
                                <BackButton fallback="/opportunities" />
                                <h1 className="of-title">{t('opportunities.form.createTitle')}</h1>
                            </div>
                            <p className="of-subtitle">{t('opportunities.form.chooseType')}</p>
                        </div>
                        <div className="of-types">
                            {OPPORTUNITY_TYPES.map((ty) => {
                                const { Icon, color, tint } = TYPE_STYLE[ty];
                                return (
                                    <button key={ty} type="button" className="of-type" onClick={() => chooseType(ty)}>
                                        <span className="of-type-icon" style={{ background: tint, color }}><Icon size={24} aria-hidden="true" /></span>
                                        <span className="of-type-text">
                                            <span className="of-type-name">{t(`opportunities.types.${ty}`)}</span>
                                            <span className="of-type-hint">{t(`opportunities.typeHints.${ty}`)}</span>
                                        </span>
                                        <ChevronRight size={20} className="of-type-chevron" aria-hidden="true" />
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
                <FormStyles />
            </div>
        );
    }

    const kinds = OPPORTUNITY_KINDS[type] || [];
    const today = elSalvadorToday();
    const { color } = styleOf(type);
    const applies = type === 'job' || type === 'program';

    return (
        <div className="opportunity-form-page">
            <div className="container">
                <div className="of-content">
                    <div className="of-header">
                        <div className="back-head">
                            <BackButton fallback="/opportunities" />
                            <h1 className="of-title">{editMode ? t('opportunities.form.editTitle') : t(`opportunities.form.createTitles.${type}`)}</h1>
                        </div>
                        <div className="of-type-chosen">
                            <TypeBadge opportunity={{ type }} size="md" />
                            {!editMode && (
                                <button type="button" className="of-link-btn" onClick={() => chooseType('')}>{t('opportunities.form.changeType')}</button>
                            )}
                        </div>
                    </div>

                    {submitError && (
                        <div className="of-error-banner" role="alert"><AlertCircle size={16} /> {submitError}</div>
                    )}

                    {/* What it is */}
                    <div className="of-card">
                        <h3 className="of-card-heading">{t('opportunities.form.basicsHeading')}</h3>

                        <div className="of-group">
                            <label className="of-label" htmlFor="of-title">{t('opportunities.form.titleLabel')} *</label>
                            <input
                                id="of-title" type="text" name="title" value={form.title} onChange={handleChange}
                                className="of-input" maxLength={120} placeholder={t(`opportunities.form.titlePlaceholder.${type}`)}
                                required {...invalid('of-title')}
                            />
                            {fieldErrorFor('of-title')}
                        </div>

                        {kinds.length > 0 && (
                            <div className="of-group" role="radiogroup" aria-labelledby="of-kind-label">
                                <span className="of-label" id="of-kind-label">
                                    {t(`opportunities.form.kindLabel.${type}`)}{KIND_REQUIRED.includes(type) ? ' *' : ''}
                                </span>
                                <div className="of-chips">
                                    {kinds.map((k, i) => (
                                        <button
                                            key={k}
                                            id={i === 0 ? 'of-kind' : undefined}
                                            type="button"
                                            role="radio"
                                            aria-checked={form.kind === k}
                                            className={`of-chip${form.kind === k ? ' active' : ''}`}
                                            onClick={() => setField('kind', form.kind === k && !KIND_REQUIRED.includes(type) ? '' : k)}
                                            {...(i === 0 ? invalid('of-kind') : {})}
                                        >
                                            {t(`opportunities.kinds.${type}.${k}`)}
                                        </button>
                                    ))}
                                </div>
                                {fieldErrorFor('of-kind')}
                            </div>
                        )}

                        <div className="of-group">
                            <label className="of-label" htmlFor="of-category">{t('opportunities.industry')}</label>
                            <select id="of-category" name="category" value={form.category} onChange={handleChange} className="of-input">
                                <option value="">{t('opportunities.form.chooseIndustry')}</option>
                                {INDUSTRIES.map((c) => <option key={c} value={c}>{t(`opportunities.industries.${c}`)}</option>)}
                            </select>
                        </div>

                        <div className="of-group" style={{ marginBottom: 0 }}>
                            <label className="of-label" htmlFor="of-description">{t('opportunities.form.descriptionLabel')} *</label>
                            <textarea
                                id="of-description" name="description" value={form.description} onChange={handleChange}
                                className="of-input" rows={6} maxLength={5000} placeholder={t(`opportunities.form.descriptionPlaceholder.${type}`)}
                                {...invalid('of-description')}
                            />
                            {fieldErrorFor('of-description')}
                        </div>
                    </div>

                    {/* The facts its type has */}
                    {type === 'investment' && (
                        <div className="of-card">
                            <h3 className="of-card-heading">{t('opportunities.form.raiseHeading')}</h3>
                            <div className="of-group" role="radiogroup" aria-labelledby="of-stage-label">
                                <span className="of-label" id="of-stage-label">{t('opportunities.stage')} *</span>
                                <div className="of-chips">
                                    {STAGES.map((s, i) => (
                                        <button
                                            key={s}
                                            id={i === 0 ? 'of-stage' : undefined}
                                            type="button"
                                            role="radio"
                                            aria-checked={form.stage === s}
                                            className={`of-chip${form.stage === s ? ' active' : ''}`}
                                            onClick={() => setField('stage', s)}
                                            {...(i === 0 ? invalid('of-stage') : {})}
                                        >
                                            {t(`opportunities.stages.${s}`)}
                                        </button>
                                    ))}
                                </div>
                                {fieldErrorFor('of-stage')}
                            </div>
                            <div className="of-row">
                                <MoneyField id="fundingGoal" label={`${t('opportunities.form.raisingLabel')} *`} form={form} onChange={handleChange} invalid={invalid} errorFor={fieldErrorFor} />
                                <MoneyField id="raisedAmount" label={t('opportunities.form.raisedLabel')} form={form} onChange={handleChange} invalid={invalid} errorFor={fieldErrorFor} />
                            </div>
                            <BtcCheck type={type} form={form} onChange={handleChange} t={t} />

                            <div className="of-deck">
                                <span className="of-label">{t('opportunities.deck.title')}</span>
                                <p className="of-hint" style={{ marginTop: 0, marginBottom: '0.6rem' }}>{t('opportunities.form.deckHint')}</p>
                                <div className="of-deck-row">
                                    <label className="of-deck-btn">
                                        <FileText size={16} aria-hidden="true" />
                                        {deckFile ? deckFile.name : hasDeck ? t('opportunities.form.deckReplace') : t('opportunities.form.deckAdd')}
                                        <input type="file" accept={DECK_TYPES} className="of-file-input" onChange={(e) => { setDeckFile(e.target.files?.[0] || null); e.target.value = ''; }} />
                                    </label>
                                    {deckFile && (
                                        <button type="button" className="of-icon-btn" onClick={() => setDeckFile(null)} aria-label={t('opportunities.form.deckRemove')}>
                                            <X size={16} />
                                        </button>
                                    )}
                                    {!deckFile && hasDeck && <span className="of-deck-on">{t('opportunities.form.deckUploaded')}</span>}
                                </div>
                                <label className="of-check" style={{ marginTop: '0.8rem', marginBottom: 0 }}>
                                    <input type="checkbox" name="requiresDeckApproval" checked={form.requiresDeckApproval} onChange={handleChange} />
                                    <span>{t('opportunities.form.deckAskFirst')}</span>
                                </label>
                            </div>
                        </div>
                    )}

                    {type === 'business-for-sale' && (
                        <div className="of-card">
                            <h3 className="of-card-heading">{t('opportunities.form.saleHeading')}</h3>
                            <div className="of-row">
                                <MoneyField id="price" label={t('opportunities.form.askingLabel')} hint={t('opportunities.form.askingHint')} form={form} onChange={handleChange} invalid={invalid} errorFor={fieldErrorFor} />
                                <MoneyField id="revenue" label={t('opportunities.form.revenueLabel')} form={form} onChange={handleChange} invalid={invalid} errorFor={fieldErrorFor} />
                            </div>
                            <BtcCheck type={type} form={form} onChange={handleChange} t={t} />
                        </div>
                    )}

                    {type === 'job' && (
                        <div className="of-card">
                            <h3 className="of-card-heading">{t('opportunities.form.jobHeading')}</h3>
                            <div className="of-group">
                                <label className="of-label" htmlFor="of-pay">{t('opportunities.facts.pay')}</label>
                                <input id="of-pay" type="text" name="pay" value={form.pay} onChange={handleChange} className="of-input" maxLength={120} placeholder={t('opportunities.form.payPlaceholder')} />
                            </div>
                            <BtcCheck type={type} form={form} onChange={handleChange} t={t} />
                        </div>
                    )}

                    {type === 'program' && (
                        <div className="of-card">
                            <h3 className="of-card-heading">{t('opportunities.form.programHeading')}</h3>
                            <MoneyField id="price" label={t('opportunities.form.upToLabel')} hint={t('opportunities.form.upToHint')} form={form} onChange={handleChange} invalid={invalid} errorFor={fieldErrorFor} />
                        </div>
                    )}

                    {/* Where, and until when */}
                    <div className="of-card">
                        <h3 className="of-card-heading">{t('opportunities.form.whereHeading')}</h3>
                        <div className="of-row">
                            <div className="of-group">
                                <label className="of-label" htmlFor="of-location">{t('opportunities.form.locationLabel')}</label>
                                <input id="of-location" type="text" name="location" value={form.location} onChange={handleChange} className="of-input" maxLength={120} placeholder={t('opportunities.form.locationPlaceholder')} />
                            </div>
                            <div className="of-group">
                                <label className="of-label" htmlFor="of-closesOn">{t('opportunities.form.closesLabel')}</label>
                                <input id="of-closesOn" type="date" name="closesOn" value={form.closesOn} min={editMode ? undefined : today} onChange={handleChange} className="of-input" {...invalid('of-closesOn')} />
                                {fieldErrorFor('of-closesOn')}
                            </div>
                        </div>
                        <p className="of-hint" style={{ marginTop: '-0.5rem' }}>{t('opportunities.form.closesHint')}</p>
                        {hasField(type, 'remote') && (
                            <label className="of-check" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
                                <input type="checkbox" name="remote" checked={form.remote} onChange={handleChange} />
                                <span>{t(`opportunities.form.remoteLabel.${type}`)}</span>
                            </label>
                        )}
                    </div>

                    {/* Photos */}
                    <div className="of-card">
                        <h3 className="of-card-heading">{t('opportunities.photos')}</h3>
                        <p className="of-hint" style={{ marginTop: 0, marginBottom: '0.9rem' }}>{t('opportunities.form.photosHint', { max: MAX_PHOTOS })}</p>
                        <div className="of-photo-grid">
                            {photos.map((url, i) => (
                                <div key={url} className={`of-photo-thumb${i === 0 ? ' cover' : ''}`}>
                                    <img src={getAssetUrl(url)} alt="" />
                                    {i === 0 ? (
                                        <span className="of-cover-tag">{t('opportunities.form.cover')}</span>
                                    ) : (
                                        <button type="button" className="of-photo-star" onClick={() => makeCover(url)} aria-label={t('opportunities.form.makeCover')} disabled={isBusy}>
                                            <Star size={14} />
                                        </button>
                                    )}
                                    <button type="button" className="of-photo-remove" onClick={() => removePhoto(url)} aria-label={t('opportunities.form.removePhoto')} disabled={isBusy}>
                                        <X size={14} />
                                    </button>
                                </div>
                            ))}
                            {photos.length < MAX_PHOTOS && (
                                <label className="of-photo-add" style={{ cursor: uploading ? 'not-allowed' : 'pointer' }}>
                                    {uploading ? <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /> : <ImagePlus size={22} />}
                                    <span>{t('opportunities.form.addPhotos')}</span>
                                    <input type="file" accept="image/*" multiple onChange={handlePhotos} className="of-file-input" disabled={uploading} />
                                </label>
                            )}
                        </div>
                        {photoError && <p className="of-field-error" role="alert">{photoError}</p>}
                    </div>

                    {/* How members reach them */}
                    <div className="of-card">
                        <h3 className="of-card-heading">{t('opportunities.form.contactHeading')} *</h3>
                        <p className="of-hint" style={{ marginTop: 0, marginBottom: '1rem' }}>{t('opportunities.form.contactHint')}</p>
                        <div className="of-row">
                            <div className="of-group">
                                <label className="of-label" htmlFor="of-whatsapp">WhatsApp</label>
                                <input type="tel" id="of-whatsapp" name="whatsapp" value={form.whatsapp} onChange={handleChange} className="of-input" maxLength={30} placeholder="+503 6123 4567" {...invalid(fieldError?.id === 'of-whatsapp' ? 'of-whatsapp' : 'of-contact')} />
                                {fieldErrorFor('of-whatsapp')}
                            </div>
                            <div className="of-group">
                                <label className="of-label" htmlFor="of-email">{t('opportunities.form.emailLabel')}</label>
                                <input type="email" id="of-email" name="email" value={form.email} onChange={handleChange} className="of-input" maxLength={254} {...invalid('of-email')} />
                                {fieldErrorFor('of-email')}
                            </div>
                        </div>
                        <div className="of-group" style={{ marginBottom: 0 }}>
                            <label className="of-label" htmlFor="of-websiteUrl">{applies ? t('opportunities.form.applyLinkLabel') : t('opportunities.form.websiteLabel')}</label>
                            <input type="text" id="of-websiteUrl" name="websiteUrl" value={form.websiteUrl} onChange={handleChange} className="of-input" maxLength={300} placeholder="https://…" {...invalid('of-websiteUrl')} />
                            {fieldErrorFor('of-websiteUrl')}
                        </div>
                        {fieldErrorFor('of-contact')}
                    </div>

                    <div className="of-actions">
                        <button type="button" onClick={() => navigate(-1)} className="btn btn-outline" disabled={submitting || deleting}>
                            {t('common.cancel')}
                        </button>
                        <button type="button" onClick={handleSubmit} disabled={isBusy} className="btn btn-primary" style={{ background: color, borderColor: color }}>
                            {submitting && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: '-3px' }} />}
                            {editMode ? t('opportunities.form.save') : t('opportunities.form.submit')}
                        </button>
                    </div>

                    {editMode && (
                        <div className="of-delete">
                            {confirmDelete ? (
                                <div className="of-delete-confirm" role="alert" ref={deleteRef}>
                                    <p>{t('opportunities.form.deleteConfirm')}</p>
                                    <div className="of-delete-buttons">
                                        <button type="button" className="btn btn-outline" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                                            {t('common.cancel')}
                                        </button>
                                        <button type="button" className="of-danger-btn" onClick={handleDelete} disabled={deleting}>
                                            {deleting && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />}
                                            {t('opportunities.form.deleteYes')}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button type="button" className="of-delete-link" onClick={() => setConfirmDelete(true)} disabled={isBusy}>
                                    <Trash2 size={15} /> {t('opportunities.form.delete')}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
            <FormStyles />
        </div>
    );
};

/** A dollar amount, typed as people do: 250000, 250,000, $250k, 1.5m. */
const MoneyField = ({ id, label, hint, form, onChange, invalid, errorFor }) => {
    const value = parseDollars(form[id]);
    const fieldId = `of-${id}`;
    return (
        <div className="of-group">
            <label className="of-label" htmlFor={fieldId}>{label}</label>
            <div className="of-money">
                <span className="of-money-sign" aria-hidden="true">$</span>
                <input
                    id={fieldId} type="text" inputMode="decimal" name={id} value={form[id]} onChange={onChange}
                    className="of-input of-money-input" maxLength={20} placeholder="0" autoComplete="off"
                    {...invalid(fieldId)}
                />
            </div>
            {value > 999 && <p className="of-hint">{fullDollars(value)}</p>}
            {hint && <p className="of-hint">{hint}</p>}
            {errorFor(fieldId)}
        </div>
    );
};

/** "Pays in bitcoin" and its kin, for the types that have it. */
const BtcCheck = ({ type, form, onChange, t }) => (
    <label className="of-check" style={{ marginBottom: 0 }}>
        <input type="checkbox" name="btcAccepted" checked={form.btcAccepted} onChange={onChange} />
        <Bitcoin size={17} style={{ color: '#f7931a' }} aria-hidden="true" />
        <span>{t(`opportunities.form.btcLabel.${type}`)}</span>
    </label>
);

// Shared by both screens and the field components above (they're outside the
// page's own tree, so the rules are global, under the page's class).
const FormStyles = () => (
    <style jsx global>{`
        .opportunity-form-page {
            padding-top: var(--page-top, 1.5rem);
            padding-bottom: 4rem;
        }
        .opportunity-form-page .of-content {
            max-width: 760px;
            margin: 0 auto;
        }
        .opportunity-form-page .of-header {
            margin-bottom: 1.25rem;
        }
        .opportunity-form-page .of-title {
            font-size: 1.6rem;
            font-weight: 700;
            margin: 0 0 0.25rem;
            color: var(--color-gray-900);
        }
        .opportunity-form-page .of-subtitle {
            color: var(--color-gray-500);
            font-size: 0.95rem;
            line-height: 1.5;
            margin: 0.25rem 0 0;
        }
        .opportunity-form-page .of-type-chosen {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            margin-top: 0.5rem;
        }
        .opportunity-form-page .of-link-btn {
            background: none;
            border: none;
            padding: 0;
            color: var(--color-primary);
            font-weight: 600;
            font-size: 0.88rem;
            cursor: pointer;
        }
        .opportunity-form-page .of-types {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }
        .opportunity-form-page .of-type {
            display: flex;
            align-items: center;
            gap: 0.9rem;
            width: 100%;
            padding: 1rem;
            text-align: left;
            background: var(--color-surface);
            border: 1px solid var(--color-gray-200);
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-sm);
            cursor: pointer;
            font: inherit;
            color: inherit;
        }
        .opportunity-form-page .of-type:hover,
        .opportunity-form-page .of-type:focus-visible {
            border-color: var(--color-primary);
        }
        .opportunity-form-page .of-type-icon {
            width: 52px;
            height: 52px;
            border-radius: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .opportunity-form-page .of-type-text {
            display: flex;
            flex-direction: column;
            gap: 2px;
            flex: 1;
            min-width: 0;
        }
        .opportunity-form-page .of-type-name {
            font-weight: 700;
            font-size: 1rem;
        }
        .opportunity-form-page .of-type-hint {
            font-size: 0.85rem;
            color: var(--color-gray-500);
            line-height: 1.4;
        }
        .opportunity-form-page .of-type-chevron {
            color: var(--color-gray-400);
            flex-shrink: 0;
        }
        .opportunity-form-page .of-error-banner {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.75rem 1rem;
            background: var(--color-red-tint);
            color: var(--color-error, #B91C1C);
            border-radius: var(--radius-md);
            margin-bottom: 1.25rem;
            font-size: 0.9rem;
        }
        .opportunity-form-page .of-card {
            background: var(--color-surface);
            border: 1px solid var(--color-gray-200);
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-sm);
            padding: 1.5rem;
            margin-bottom: 1.25rem;
        }
        .opportunity-form-page .of-card-heading {
            font-size: 1.05rem;
            font-weight: 700;
            margin: 0 0 1.25rem;
            padding-bottom: 0.75rem;
            border-bottom: 1px solid var(--color-gray-200);
        }
        .opportunity-form-page .of-group {
            margin-bottom: 1.1rem;
            position: relative;
            min-width: 0;
        }
        .opportunity-form-page .of-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0.75rem;
        }
        .opportunity-form-page .of-label {
            display: block;
            font-size: 0.85rem;
            font-weight: 600;
            color: var(--color-gray-700);
            margin-bottom: 0.4rem;
        }
        .opportunity-form-page .of-input {
            width: 100%;
            padding: 0.65rem 0.9rem;
            border: 1px solid var(--color-gray-300);
            background: var(--color-surface);
            color: inherit;
            border-radius: var(--radius-md);
            outline: none;
            font-size: 0.95rem;
            font-family: inherit;
            transition: border-color 0.2s, box-shadow 0.2s;
            box-sizing: border-box;
        }
        .opportunity-form-page .of-input:focus {
            border-color: var(--color-primary);
            box-shadow: 0 0 0 3px rgba(0, 82, 204, 0.1);
        }
        .opportunity-form-page textarea.of-input { resize: vertical; }
        .opportunity-form-page select.of-input { appearance: auto; cursor: pointer; }
        .opportunity-form-page .of-input[aria-invalid="true"] { border-color: #b91c1c; }
        .opportunity-form-page .of-money {
            position: relative;
        }
        .opportunity-form-page .of-money-sign {
            position: absolute;
            left: 0.85rem;
            top: 50%;
            transform: translateY(-50%);
            color: var(--color-gray-500);
            font-weight: 600;
        }
        .opportunity-form-page .of-money-input {
            padding-left: 1.7rem;
        }
        .opportunity-form-page .of-hint {
            margin: 0.4rem 0 0;
            font-size: 0.78rem;
            line-height: 1.45;
            color: var(--color-gray-500);
        }
        .opportunity-form-page .of-field-error {
            margin: 0.4rem 0 0;
            font-size: 0.82rem;
            font-weight: 600;
            color: #b91c1c;
        }
        .opportunity-form-page .of-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .opportunity-form-page .of-chip {
            padding: 0.5rem 0.95rem;
            border-radius: var(--radius-full);
            border: 1px solid var(--color-gray-300);
            background: var(--color-surface);
            color: var(--color-gray-700);
            font-size: 0.88rem;
            font-weight: 600;
            cursor: pointer;
        }
        .opportunity-form-page .of-chip.active {
            background: var(--color-primary);
            border-color: var(--color-primary);
            color: white;
        }
        .opportunity-form-page .of-chip[aria-invalid="true"] { border-color: #b91c1c; }
        .opportunity-form-page .of-check {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.92rem;
            font-weight: 600;
            color: var(--color-gray-700);
            cursor: pointer;
            margin-bottom: 1rem;
        }
        .opportunity-form-page .of-check input[type='checkbox'] {
            width: 18px;
            height: 18px;
            margin: 0;
            accent-color: var(--color-primary);
            cursor: pointer;
            flex-shrink: 0;
        }
        .opportunity-form-page .of-deck {
            margin-top: 1.25rem;
            padding-top: 1.1rem;
            border-top: 1px solid var(--color-gray-100);
        }
        .opportunity-form-page .of-deck-row {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            flex-wrap: wrap;
        }
        .opportunity-form-page .of-deck-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 0.55rem 1rem;
            border-radius: var(--radius-full);
            border: 1px dashed var(--color-gray-300);
            color: var(--color-gray-700);
            font-weight: 600;
            font-size: 0.88rem;
            cursor: pointer;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .opportunity-form-page .of-deck-on {
            font-size: 0.82rem;
            font-weight: 700;
            color: var(--color-success-text, #047857);
        }
        .opportunity-form-page .of-icon-btn {
            width: 36px;
            height: 36px;
            min-height: 0;
            padding: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid var(--color-gray-200);
            border-radius: 50%;
            background: var(--color-surface);
            color: var(--color-gray-600);
            cursor: pointer;
        }
        .opportunity-form-page .of-file-input {
            position: absolute;
            width: 1px;
            height: 1px;
            opacity: 0;
            pointer-events: none;
        }
        .opportunity-form-page .of-photo-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
            gap: 0.5rem;
        }
        .opportunity-form-page .of-photo-thumb {
            position: relative;
            aspect-ratio: 4 / 3;
            border-radius: 10px;
            overflow: hidden;
            background: var(--color-gray-100);
        }
        .opportunity-form-page .of-photo-thumb.cover {
            outline: 2px solid var(--color-primary);
            outline-offset: 1px;
        }
        .opportunity-form-page .of-photo-thumb img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
        }
        .opportunity-form-page .of-cover-tag {
            position: absolute;
            left: 6px;
            bottom: 6px;
            padding: 1px 8px;
            border-radius: 999px;
            background: var(--color-primary);
            color: white;
            font-size: 0.7rem;
            font-weight: 700;
        }
        .opportunity-form-page .of-photo-remove,
        .opportunity-form-page .of-photo-star {
            position: absolute;
            top: 4px;
            width: 30px;
            height: 30px;
            min-height: 0;
            padding: 0;
            border: none;
            border-radius: 50%;
            background: rgba(0, 0, 0, 0.6);
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }
        .opportunity-form-page .of-photo-remove { right: 4px; }
        .opportunity-form-page .of-photo-star { left: 4px; }
        .opportunity-form-page .of-photo-add {
            position: relative;
            aspect-ratio: 4 / 3;
            border-radius: 10px;
            border: 1.5px dashed var(--color-gray-300);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 4px;
            color: var(--color-gray-500);
            font-size: 0.78rem;
            font-weight: 600;
            text-align: center;
            padding: 0.25rem;
        }
        .opportunity-form-page .of-actions {
            display: flex;
            justify-content: flex-end;
            gap: 0.75rem;
            margin-top: 0.5rem;
        }
        .opportunity-form-page .of-delete {
            margin-top: 2rem;
            text-align: center;
        }
        .opportunity-form-page .of-delete-link {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: none;
            border: none;
            color: #b91c1c;
            font-weight: 600;
            cursor: pointer;
        }
        .opportunity-form-page .of-delete-confirm {
            padding: 1rem;
            border: 1px solid #fecaca;
            border-radius: var(--radius-lg);
            background: #fef2f2;
        }
        .opportunity-form-page .of-delete-confirm p {
            margin: 0 0 0.75rem;
            color: #7f1d1d;
            font-weight: 600;
        }
        .opportunity-form-page .of-delete-buttons {
            display: flex;
            justify-content: center;
            gap: 0.75rem;
        }
        .opportunity-form-page .of-danger-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 0.6rem 1.2rem;
            border: none;
            border-radius: var(--radius-full);
            background: #b91c1c;
            color: white;
            font-weight: 700;
            cursor: pointer;
        }
        @media (max-width: 560px) {
            .opportunity-form-page .of-row {
                grid-template-columns: 1fr;
                gap: 0;
            }
            .opportunity-form-page .of-card {
                padding: 1.15rem;
            }
        }
    `}</style>
);

export default OpportunityForm;
