import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    Loader2, AlertCircle, Camera, X, Plus, Trash2, Bitcoin, Briefcase, ImagePlus, ArrowUp, Play,
} from 'lucide-react';
import { talentApi, uploadApi } from '../../services/api';
import { mediaService } from '../../services/mediaService';
import { useAuth } from '../../context/AuthContext';
import { objectionableMessage } from '../../components/moderation/objectionable';
import TagInput from '../../components/TagInput';
import ImageCropModal from '../../components/ImageCropModal';
import BackButton from '../../components/BackButton';
import { getAssetUrl } from '../../utils/assets';
import {
    TALENT_CATEGORIES, WORK_TYPES, MAX_TALENTS, MAX_WORKS, MAX_WORK_MEDIA, MAX_SKILLS, MAX_LANGUAGES,
    MAX_SKILL_LENGTH, MAX_LANGUAGE_LENGTH, MAX_VIDEO_MB, MAX_VIDEO_SECONDS, asWebLink, isVideo, mediaOf, pictureOf,
} from '../../components/talent/talentOptions';

const emptyForm = {
    title: '',
    category: '',
    about: '',
    location: '',
    rate: '',
    whatsapp: '',
    email: '',
    website: '',
    photo: '',
    available: true,
    remote: false,
    btcAccepted: false,
};

// Each work row has a key of its own, so React keeps its inputs while rows move.
let nextWorkKey = 0;
const newWork = (work = {}) => ({
    key: `work-${++nextWorkKey}`,
    title: work.title || '',
    details: work.details || '',
    link: work.link || '',
    year: work.year || '',
    media: mediaOf(work), // photos and videos: [{ url, poster? }]
});
const hasContent = (w) => !!(w.title.trim() || w.details.trim() || w.link.trim() || w.year.trim() || w.media.length);

/**
 * Add or edit a talent (/talents/new, /talents/:id/edit), with the add-listing
 * form's cards: what you offer (title, category, skills, about), the work
 * you're open to (one-off, short-term, long-term; taking work now; remote;
 * where; rate; bitcoin; languages), your proof of work (examples with
 * photos and videos, a link, the year), a cover photo, and how members reach
 * you. Only the member it belongs to edits it, and can delete it here.
 *
 * @param {boolean} editMode - true at /talents/:id/edit
 */
const TalentForm = ({ editMode = false }) => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const navigate = useNavigate();
    const { id } = useParams();

    const [form, setForm] = useState(emptyForm);
    const [skills, setSkills] = useState([]);
    const [languages, setLanguages] = useState([]);
    const [workTypes, setWorkTypes] = useState([]);
    const [works, setWorks] = useState([]);

    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [atLimit, setAtLimit] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
    // A field the member must fix: shown beside it, and it gets the focus.
    const [fieldError, setFieldError] = useState(null); // { id, message }
    const [uploading, setUploading] = useState(null); // 'photo' | a work's key | null
    const [uploadingVideo, setUploadingVideo] = useState(false);
    // An upload that went wrong, said next to it: { key: a work's key, or 'cover', message }.
    const [mediaError, setMediaError] = useState(null);
    const [cropImage, setCropImage] = useState(null); // { src }
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const deleteRef = useRef(null);

    const isBusy = submitting || deleting || uploading !== null;

    // Edit: load it (only its member edits it; the API says so too).
    // Add: is there room for another?
    useEffect(() => {
        if (!user?.id) return undefined;
        let cancelled = false;
        (async () => {
            try {
                if (editMode) {
                    const talent = await talentApi.get(id);
                    if (cancelled) return;
                    if (talent.userId !== user.id) {
                        setLoadError(t('talent.form.notYours'));
                        return;
                    }
                    setForm({
                        title: talent.title || '',
                        category: talent.category || '',
                        about: talent.about || '',
                        location: talent.location || '',
                        rate: talent.rate || '',
                        whatsapp: talent.whatsapp || '',
                        email: talent.email || '',
                        website: talent.website || '',
                        photo: talent.photo || '',
                        available: talent.available !== false,
                        remote: !!talent.remote,
                        btcAccepted: !!talent.btcAccepted,
                    });
                    setSkills(Array.isArray(talent.skills) ? talent.skills : []);
                    setLanguages(Array.isArray(talent.languages) ? talent.languages : []);
                    setWorkTypes(Array.isArray(talent.workTypes) ? talent.workTypes : []);
                    setWorks((Array.isArray(talent.works) ? talent.works : []).map(newWork));
                } else {
                    const mine = await talentApi.list({ userId: user.id, limit: 1 });
                    if (!cancelled) setAtLimit((mine?.pagination?.total ?? 0) >= MAX_TALENTS);
                }
            } catch (err) {
                if (!cancelled && editMode) setLoadError(err.message || t('talent.notFound'));
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
        const { name, value, type, checked } = e.target;
        clearFieldError(`tf-${name}`);
        setForm((prev) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    };

    const toggleWorkType = (w) => {
        clearFieldError('tf-worktypes');
        setWorkTypes((prev) => (prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w]));
    };

    // ─── Cover photo: select → crop → upload ──────────────────────────────────
    const handleCoverSelect = (e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-selecting the same file
        if (!file) return;
        setCropImage({ src: URL.createObjectURL(file) });
    };

    const handleCropConfirm = async (croppedFile) => {
        URL.revokeObjectURL(cropImage.src);
        setCropImage(null);
        setUploading('photo');
        setMediaError(null);
        try {
            const result = await uploadApi.media(croppedFile);
            setForm((prev) => ({ ...prev, photo: result.url }));
        } catch (err) {
            setMediaError({ key: 'cover', message: uploadProblem(err) });
        } finally {
            setUploading(null);
        }
    };

    // A photo being cropped when the member leaves the form: its copy is let go.
    const cropRef = useRef(null);
    cropRef.current = cropImage;
    useEffect(() => () => {
        if (cropRef.current) URL.revokeObjectURL(cropRef.current.src);
    }, []);

    const handleCropCancel = () => {
        if (cropImage) URL.revokeObjectURL(cropImage.src);
        setCropImage(null);
    };

    // ─── Proof of work ────────────────────────────────────────────────────────
    const updateWork = (key, field, value) => {
        if (field === 'title') clearFieldError(`tf-${key}-title`);
        setWorks((prev) => prev.map((w) => (w.key === key ? { ...w, [field]: value } : w)));
    };
    const addWork = () => setWorks((prev) => (prev.length < MAX_WORKS ? [...prev, newWork()] : prev));
    const removeWork = (key) => setWorks((prev) => prev.filter((w) => w.key !== key));
    const moveWorkUp = (index) => setWorks((prev) => {
        if (index < 1) return prev;
        const next = [...prev];
        [next[index - 1], next[index]] = [next[index], next[index - 1]];
        return next;
    });

    // A video too big or too long for the server, said before it's sent.
    const videoProblem = async (file) => {
        if (file.size > MAX_VIDEO_MB * 1000 * 1000) {
            return t('talent.form.videoTooBig', { size: Math.ceil(file.size / 1000 / 1000), max: MAX_VIDEO_MB });
        }
        const seconds = await mediaService.getVideoDuration(file);
        return seconds > MAX_VIDEO_SECONDS + 1 ? t('talent.form.videoTooLong', { max: MAX_VIDEO_SECONDS / 60 }) : null;
    };

    // What the member is told when an upload fails.
    const uploadProblem = (err) => {
        const reason = err?.data?.reason;
        if (reason === 'too_long') return t('talent.form.videoTooLong', { max: MAX_VIDEO_SECONDS / 60 });
        if (reason === 'too_large') return t('talent.form.videoTooLarge');
        if (reason === 'busy') return t('talent.form.videoBusy');
        return err?.message || t('talent.form.uploadFailed');
    };

    // A work's photos and videos upload one after another, each on its own:
    // one that fails, or is too big or long, doesn't stop the rest, and the
    // free places go to those that can go. The server makes a video smaller
    // first, and sends back a still from it, its poster.
    const handleWorkMedia = async (e, key) => {
        const work = works.find((w) => w.key === key);
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (!files.length) return;
        setUploading(key);
        setMediaError(null);
        let room = MAX_WORK_MEDIA - (work?.media.length || 0);
        let problem = null;
        for (const file of files) {
            if (room <= 0) break;
            const video = file.type.startsWith('video/');
            const tooMuch = video ? await videoProblem(file) : null;
            if (tooMuch) {
                problem = problem || tooMuch;
                continue;
            }
            setUploadingVideo(video);
            try {
                const result = await uploadApi.media(file, { poster: video });
                const item = result.poster ? { url: result.url, poster: result.poster } : { url: result.url };
                setWorks((prev) => prev.map((w) => (
                    w.key === key && w.media.length < MAX_WORK_MEDIA ? { ...w, media: [...w.media, item] } : w
                )));
                room -= 1;
            } catch (err) {
                problem = problem || uploadProblem(err);
            }
        }
        setUploading(null);
        setUploadingVideo(false);
        if (problem) setMediaError({ key, message: problem });
    };
    const removeWorkMedia = (key, url) =>
        setWorks((prev) => prev.map((w) => (w.key === key ? { ...w, media: w.media.filter((m) => m.url !== url) } : w)));

    // ─── Submit ───────────────────────────────────────────────────────────────
    const buildPayload = () => ({
        title: form.title.trim(),
        category: form.category,
        about: form.about.trim(),
        skills,
        workTypes: WORK_TYPES.filter((w) => workTypes.includes(w)),
        available: form.available,
        remote: form.remote,
        location: form.location.trim(),
        rate: form.rate.trim(),
        btcAccepted: form.btcAccepted,
        languages,
        photo: form.photo || '',
        works: works.filter(hasContent).map((w) => ({
            title: w.title.trim(),
            details: w.details.trim(),
            link: asWebLink(w.link),
            year: w.year.trim(),
            media: w.media,
        })),
        whatsapp: form.whatsapp.trim(),
        email: form.email.trim(),
        website: asWebLink(form.website),
    });

    const showFieldError = (problem) => {
        setFieldError(problem);
        const field = document.getElementById(problem.id);
        field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        field?.focus({ preventScroll: true });
    };

    const showError = (message) => {
        setSubmitError(message);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleSubmit = async () => {
        setSubmitError('');
        const untitled = works.find((w) => hasContent(w) && !w.title.trim());
        const problem = !form.title.trim() ? { id: 'tf-title', message: t('talent.form.titleRequired') }
            : !form.category ? { id: 'tf-category', message: t('talent.form.categoryRequired') }
                : workTypes.length === 0 ? { id: 'tf-worktypes', message: t('talent.form.workTypesRequired') }
                    : untitled ? { id: `tf-${untitled.key}-title`, message: t('talent.form.workTitleRequired') }
                        : null;
        if (problem) {
            showFieldError(problem);
            return;
        }
        setSubmitting(true);
        try {
            const payload = buildPayload();
            const talent = editMode ? await talentApi.update(id, payload) : await talentApi.create(payload);
            // Back never reopens this form: a new talent takes the form's place;
            // an edited one returns to where the form was opened from (its page,
            // or the profile), or opens its page when the form was opened directly.
            if (editMode && window.history.state?.idx > 0) navigate(-1);
            else navigate(`/talents/${talent.id}`, { replace: true });
        } catch (err) {
            const reason = err?.data?.reason;
            if (objectionableMessage(t, err)) showError(objectionableMessage(t, err));
            else if (reason === 'too_many') showError(t('talent.form.tooMany', { max: err.data.max || MAX_TALENTS }));
            else if (reason === 'not_your_photo') showError(t('talent.form.notYourPhoto'));
            else if (err.data?.details) showError(`${err.message}: ${err.data.details.map((d) => `${d.field}: ${d.message}`).join(', ')}`);
            else showError(err.message || t('talent.form.saveFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async () => {
        setDeleting(true);
        setSubmitError('');
        try {
            await talentApi.delete(id);
            navigate('/talents', { replace: true });
        } catch (err) {
            setDeleting(false);
            setConfirmDelete(false);
            showError(err.message || t('talent.form.deleteFailed'));
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
                    <h2>{atLimit ? t('talent.form.atLimitTitle') : t('talent.notFound')}</h2>
                    <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0', lineHeight: 1.5 }}>
                        {atLimit ? t('talent.form.tooMany', { max: MAX_TALENTS }) : loadError}
                    </p>
                    <Link to="/talents" style={{ marginTop: '1.5rem', display: 'inline-flex', textDecoration: 'none', fontWeight: 600, color: 'var(--color-primary)' }}>
                        {t('talent.back')}
                    </Link>
                </div>
            </div>
        );
    }

    const fieldErrorFor = (fieldId) => (fieldError?.id === fieldId
        ? <p className="tf-field-error" id={`${fieldId}-error`}>{fieldError.message}</p>
        : null);
    const invalid = (fieldId) => ({
        'aria-invalid': fieldError?.id === fieldId || undefined,
        'aria-describedby': fieldError?.id === fieldId ? `${fieldId}-error` : undefined,
    });

    return (
        <div className="talent-form-page">
            <div className="container">
                <div className="tf-content">
                    <div className="tf-header">
                        <div className="back-head">
                            <BackButton fallback="/talents" />
                            <h1 className="tf-title">
                                <Briefcase size={24} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
                                {editMode ? t('talent.form.editTitle') : t('talent.form.createTitle')}
                            </h1>
                        </div>
                        {!editMode && <p className="tf-subtitle">{t('talent.form.subtitle')}</p>}
                    </div>

                    {submitError && (
                        <div className="tf-error-banner" role="alert"><AlertCircle size={16} /> {submitError}</div>
                    )}

                    {/* What you offer */}
                    <div className="tf-card">
                        <h3 className="tf-card-heading">{t('talent.form.offerHeading')}</h3>

                        <div className="tf-group">
                            <label className="tf-label" htmlFor="tf-title">{t('talent.form.titleLabel')} *</label>
                            <input
                                id="tf-title"
                                type="text"
                                name="title"
                                value={form.title}
                                onChange={handleChange}
                                className="tf-input"
                                maxLength={80}
                                placeholder={t('talent.form.titlePlaceholder')}
                                required
                                {...invalid('tf-title')}
                            />
                            {fieldErrorFor('tf-title')}
                        </div>

                        <div className="tf-group">
                            <label className="tf-label" htmlFor="tf-category">{t('talent.form.categoryLabel')} *</label>
                            <select
                                id="tf-category"
                                name="category"
                                value={form.category}
                                onChange={handleChange}
                                className="tf-input"
                                required
                                {...invalid('tf-category')}
                            >
                                <option value="">{t('talent.form.chooseCategory')}</option>
                                {TALENT_CATEGORIES.map((c) => (
                                    <option key={c} value={c}>{t(`talent.categories.${c}`)}</option>
                                ))}
                            </select>
                            {fieldErrorFor('tf-category')}
                        </div>

                        <div className="tf-group">
                            <label className="tf-label" htmlFor="tf-skills">{t('talent.form.skillsLabel')}</label>
                            <TagInput
                                id="tf-skills"
                                tags={skills}
                                onChange={(list) => setSkills(list.slice(0, MAX_SKILLS).map((skill) => skill.slice(0, MAX_SKILL_LENGTH)))}
                                placeholder={t('talent.form.skillsPlaceholder')}
                            />
                            <p className="tf-hint">{t('talent.form.skillsHint')}</p>
                        </div>

                        <div className="tf-group" style={{ marginBottom: 0 }}>
                            <label className="tf-label" htmlFor="tf-about">{t('talent.form.aboutLabel')}</label>
                            <textarea
                                id="tf-about"
                                name="about"
                                value={form.about}
                                onChange={handleChange}
                                className="tf-input"
                                rows={5}
                                maxLength={3000}
                                placeholder={t('talent.form.aboutPlaceholder')}
                            />
                        </div>
                    </div>

                    {/* The work they take on */}
                    <div className="tf-card">
                        <h3 className="tf-card-heading">{t('talent.form.workHeading')}</h3>

                        <div className="tf-group" role="group" aria-labelledby="tf-worktypes-label">
                            <span className="tf-label" id="tf-worktypes-label">{t('talent.form.workTypesLabel')} *</span>
                            <div className="tf-worktypes">
                                {WORK_TYPES.map((w, i) => (
                                    <label key={w} className={`tf-worktype${workTypes.includes(w) ? ' active' : ''}`}>
                                        <input
                                            id={i === 0 ? 'tf-worktypes' : undefined}
                                            type="checkbox"
                                            checked={workTypes.includes(w)}
                                            onChange={() => toggleWorkType(w)}
                                            {...(i === 0 ? invalid('tf-worktypes') : {})}
                                        />
                                        <span className="tf-worktype-name">{t(`talent.workTypes.${w}`)}</span>
                                        <span className="tf-worktype-hint">{t(`talent.workTypeHints.${w}`)}</span>
                                    </label>
                                ))}
                            </div>
                            {fieldErrorFor('tf-worktypes')}
                        </div>

                        <label className="tf-check">
                            <input type="checkbox" name="available" checked={form.available} onChange={handleChange} />
                            <span>{t('talent.form.availableLabel')}</span>
                        </label>
                        <p className="tf-hint tf-check-hint">{t('talent.form.availableHint')}</p>

                        <label className="tf-check">
                            <input type="checkbox" name="remote" checked={form.remote} onChange={handleChange} />
                            <span>{t('talent.form.remoteLabel')}</span>
                        </label>

                        <div className="tf-row">
                            <div className="tf-group">
                                <label className="tf-label" htmlFor="tf-location">{t('talent.form.locationLabel')}</label>
                                <input
                                    id="tf-location" type="text" name="location" value={form.location} onChange={handleChange}
                                    className="tf-input" maxLength={120} placeholder={t('talent.form.locationPlaceholder')}
                                />
                            </div>
                            <div className="tf-group">
                                <label className="tf-label" htmlFor="tf-rate">{t('talent.form.rateLabel')}</label>
                                <input
                                    id="tf-rate" type="text" name="rate" value={form.rate} onChange={handleChange}
                                    className="tf-input" maxLength={120} placeholder={t('talent.form.ratePlaceholder')}
                                />
                            </div>
                        </div>

                        <div className="tf-group">
                            <label className="tf-label" htmlFor="tf-languages">{t('talent.form.languagesLabel')}</label>
                            <TagInput
                                id="tf-languages"
                                tags={languages}
                                onChange={(list) => setLanguages(list.slice(0, MAX_LANGUAGES).map((language) => language.slice(0, MAX_LANGUAGE_LENGTH)))}
                                placeholder="English, Español…"
                            />
                        </div>

                        <label className="tf-check" style={{ marginBottom: 0 }}>
                            <input type="checkbox" name="btcAccepted" checked={form.btcAccepted} onChange={handleChange} />
                            <Bitcoin size={17} style={{ color: '#f7931a' }} />
                            <span>{t('talent.form.btcLabel')}</span>
                        </label>
                    </div>

                    {/* Proof of work */}
                    <div className="tf-card">
                        <h3 className="tf-card-heading">{t('talent.proofOfWork')}</h3>
                        <p className="tf-hint" style={{ marginTop: 0, marginBottom: '1rem' }}>{t('talent.form.proofHint', { max: MAX_WORKS })}</p>

                        {works.map((work, index) => {
                            const n = index + 1;
                            const titleId = `tf-${work.key}-title`;
                            return (
                                <div key={work.key} className="tf-work" role="group" aria-labelledby={`${work.key}-heading`}>
                                    <div className="tf-work-head">
                                        <span className="tf-work-name" id={`${work.key}-heading`}>{t('talent.form.workN', { n })}</span>
                                        <div className="tf-work-tools">
                                            {index > 0 && (
                                                <button type="button" className="tf-icon-btn" onClick={() => moveWorkUp(index)} aria-label={t('talent.form.moveUp', { n })} disabled={isBusy}>
                                                    <ArrowUp size={16} />
                                                </button>
                                            )}
                                            <button type="button" className="tf-icon-btn danger" onClick={() => removeWork(work.key)} aria-label={t('talent.form.removeWork', { n })} disabled={isBusy}>
                                                <Trash2 size={16} />
                                            </button>
                                        </div>
                                    </div>

                                    <div className="tf-photo-grid">
                                        {work.media.map((item) => {
                                            const video = isVideo(item.url);
                                            const picture = pictureOf(item);
                                            return (
                                                <div key={item.url} className="tf-photo-thumb">
                                                    {picture ? <img src={getAssetUrl(picture)} alt="" /> : <span className="tf-thumb-blank" />}
                                                    {video && (
                                                        <span className="tf-thumb-play" role="img" aria-label={t('talent.video')}>
                                                            <Play size={14} fill="currentColor" aria-hidden="true" />
                                                        </span>
                                                    )}
                                                    <button type="button" className="tf-photo-remove" onClick={() => removeWorkMedia(work.key, item.url)} aria-label={t(video ? 'talent.form.removeVideo' : 'talent.form.removePhoto')} disabled={isBusy}>
                                                        <X size={14} />
                                                    </button>
                                                </div>
                                            );
                                        })}
                                        {work.media.length < MAX_WORK_MEDIA && (
                                            <label className="tf-photo-add" style={{ cursor: uploading ? 'not-allowed' : 'pointer' }}>
                                                {uploading === work.key
                                                    ? <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
                                                    : <ImagePlus size={22} />}
                                                <span>{t(uploading === work.key && uploadingVideo ? 'talent.form.uploadingVideo' : 'talent.form.addMedia')}</span>
                                                <input type="file" accept="image/*,video/*" multiple onChange={(e) => handleWorkMedia(e, work.key)} className="tf-file-input" disabled={!!uploading} />
                                            </label>
                                        )}
                                    </div>
                                    {uploading === work.key && uploadingVideo && (
                                        <p className="tf-hint" role="status" style={{ marginTop: '-0.4rem' }}>{t('talent.form.videoWait')}</p>
                                    )}
                                    {mediaError?.key === work.key && (
                                        <p className="tf-field-error" role="alert" style={{ marginTop: '-0.4rem', marginBottom: '0.8rem' }}>{mediaError.message}</p>
                                    )}

                                    <div className="tf-group">
                                        <label className="tf-label" htmlFor={titleId}>{t('talent.form.workTitleLabel')} *</label>
                                        <input
                                            id={titleId}
                                            type="text"
                                            value={work.title}
                                            onChange={(e) => updateWork(work.key, 'title', e.target.value)}
                                            className="tf-input"
                                            maxLength={100}
                                            placeholder={t('talent.form.workTitlePlaceholder')}
                                            {...invalid(titleId)}
                                        />
                                        {fieldErrorFor(titleId)}
                                    </div>
                                    <div className="tf-group">
                                        <label className="tf-label" htmlFor={`tf-${work.key}-details`}>{t('talent.form.workDetailsLabel')}</label>
                                        <textarea
                                            id={`tf-${work.key}-details`}
                                            value={work.details}
                                            onChange={(e) => updateWork(work.key, 'details', e.target.value)}
                                            className="tf-input"
                                            rows={3}
                                            maxLength={1000}
                                            placeholder={t('talent.form.workDetailsPlaceholder')}
                                        />
                                    </div>
                                    <div className="tf-row tf-row-link">
                                        <div className="tf-group" style={{ marginBottom: 0 }}>
                                            <label className="tf-label" htmlFor={`tf-${work.key}-link`}>{t('talent.form.workLinkLabel')}</label>
                                            <input
                                                id={`tf-${work.key}-link`}
                                                type="url"
                                                value={work.link}
                                                onChange={(e) => updateWork(work.key, 'link', e.target.value)}
                                                className="tf-input"
                                                maxLength={300}
                                                placeholder="https://…"
                                            />
                                        </div>
                                        <div className="tf-group" style={{ marginBottom: 0 }}>
                                            <label className="tf-label" htmlFor={`tf-${work.key}-year`}>{t('talent.form.workYearLabel')}</label>
                                            <input
                                                id={`tf-${work.key}-year`}
                                                type="text"
                                                inputMode="numeric"
                                                value={work.year}
                                                onChange={(e) => updateWork(work.key, 'year', e.target.value)}
                                                className="tf-input"
                                                maxLength={20}
                                                placeholder={String(new Date().getFullYear())}
                                            />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}

                        {works.length < MAX_WORKS && (
                            <button type="button" className="tf-add-btn" onClick={addWork} disabled={isBusy}>
                                <Plus size={16} /> {works.length ? t('talent.form.addAnotherWork') : t('talent.form.addWork')}
                            </button>
                        )}
                    </div>

                    {/* Cover photo */}
                    <div className="tf-card">
                        <h3 className="tf-card-heading">{t('talent.form.coverHeading')}</h3>
                        <p className="tf-hint" style={{ marginTop: 0, marginBottom: '0.9rem' }}>{t('talent.form.coverHint')}</p>
                        <div className="tf-cover" style={{ backgroundImage: form.photo ? `url(${getAssetUrl(form.photo)})` : 'none' }}>
                            {uploading === 'photo' && (
                                <div className="tf-upload-overlay">
                                    <Loader2 size={28} style={{ animation: 'spin 1s linear infinite', color: 'white' }} />
                                </div>
                            )}
                            <div className="tf-cover-actions">
                                <label className="tf-cover-btn" style={{ cursor: uploading ? 'not-allowed' : 'pointer' }}>
                                    <Camera size={15} />
                                    {form.photo ? t('talent.form.changeCover') : t('talent.form.addCover')}
                                    <input type="file" accept="image/*" onChange={handleCoverSelect} className="tf-file-input" disabled={!!uploading} />
                                </label>
                                {form.photo && !uploading && (
                                    <button
                                        type="button"
                                        className="tf-cover-btn danger"
                                        onClick={() => setForm((p) => ({ ...p, photo: '' }))}
                                        aria-label={t('talent.form.removeCover')}
                                    >
                                        <X size={15} />
                                    </button>
                                )}
                            </div>
                        </div>
                        {mediaError?.key === 'cover' && <p className="tf-field-error" role="alert">{mediaError.message}</p>}
                    </div>

                    {/* How members reach them */}
                    <div className="tf-card">
                        <h3 className="tf-card-heading">{t('talent.form.contactHeading')}</h3>
                        <p className="tf-hint" style={{ marginTop: 0, marginBottom: '1rem' }}>{t('talent.form.contactHint')}</p>
                        <div className="tf-row">
                            <div className="tf-group">
                                <label className="tf-label" htmlFor="tf-whatsapp">{t('talent.form.whatsappLabel')}</label>
                                <input type="tel" id="tf-whatsapp" name="whatsapp" value={form.whatsapp} onChange={handleChange} className="tf-input" maxLength={30} placeholder="+503 6123 4567" />
                            </div>
                            <div className="tf-group">
                                <label className="tf-label" htmlFor="tf-email">{t('talent.form.emailLabel')}</label>
                                <input type="email" id="tf-email" name="email" value={form.email} onChange={handleChange} className="tf-input" maxLength={254} />
                            </div>
                        </div>
                        <div className="tf-group" style={{ marginBottom: 0 }}>
                            <label className="tf-label" htmlFor="tf-website">{t('talent.form.websiteLabel')}</label>
                            <input type="text" id="tf-website" name="website" value={form.website} onChange={handleChange} className="tf-input" maxLength={300} placeholder="https://…" />
                        </div>
                    </div>

                    <div className="tf-actions">
                        <button type="button" onClick={() => navigate(-1)} className="btn btn-outline" disabled={submitting || deleting}>
                            {t('common.cancel')}
                        </button>
                        <button type="button" onClick={handleSubmit} disabled={isBusy} className="btn btn-primary">
                            {submitting && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: '-3px' }} />}
                            {editMode ? t('talent.form.save') : t('talent.form.submit')}
                        </button>
                    </div>

                    {editMode && (
                        <div className="tf-delete">
                            {confirmDelete ? (
                                <div className="tf-delete-confirm" role="alert" ref={deleteRef}>
                                    <p>{t('talent.form.deleteConfirm')}</p>
                                    <div className="tf-delete-buttons">
                                        <button type="button" className="btn btn-outline" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                                            {t('common.cancel')}
                                        </button>
                                        <button type="button" className="tf-danger-btn" onClick={handleDelete} disabled={deleting}>
                                            {deleting && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />}
                                            {t('talent.form.deleteYes')}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button type="button" className="tf-delete-link" onClick={() => setConfirmDelete(true)} disabled={isBusy}>
                                    <Trash2 size={15} /> {t('talent.form.delete')}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {cropImage && (
                <ImageCropModal
                    imageSrc={cropImage.src}
                    aspect={16 / 9}
                    shape="rect"
                    onCrop={handleCropConfirm}
                    onCancel={handleCropCancel}
                />
            )}

            <style jsx>{`
                .talent-form-page {
                    padding-top: var(--page-top, 1.5rem);
                    padding-bottom: 4rem;
                }
                .tf-content {
                    max-width: 760px;
                    margin: 0 auto;
                }
                .tf-header {
                    margin-bottom: 1.25rem;
                }
                .tf-title {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    font-size: 1.6rem;
                    font-weight: 700;
                    margin: 0 0 0.25rem;
                    color: var(--color-gray-900);
                }
                .tf-subtitle {
                    color: var(--color-gray-500);
                    font-size: 0.9rem;
                    line-height: 1.5;
                    margin: 0;
                }
                .tf-error-banner {
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
                .tf-card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    padding: 1.5rem;
                    margin-bottom: 1.25rem;
                }
                .tf-card-heading {
                    font-size: 1.05rem;
                    font-weight: 700;
                    margin: 0 0 1.25rem;
                    padding-bottom: 0.75rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }
                .tf-group {
                    margin-bottom: 1.1rem;
                    position: relative;
                    min-width: 0;
                }
                .tf-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.75rem;
                }
                .tf-row-link {
                    grid-template-columns: 1fr 110px;
                }
                .tf-label {
                    display: block;
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    margin-bottom: 0.4rem;
                }
                .tf-input {
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
                .tf-input:focus {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 82, 204, 0.1);
                }
                textarea.tf-input { resize: vertical; }
                select.tf-input { appearance: auto; cursor: pointer; }
                .tf-hint {
                    margin: 0.4rem 0 0;
                    font-size: 0.78rem;
                    line-height: 1.45;
                    color: var(--color-gray-500);
                }
                .talent-form-page :global(.tf-field-error) {
                    margin: 0.4rem 0 0;
                    font-size: 0.82rem;
                    font-weight: 600;
                    color: #b91c1c;
                }
                .tf-input[aria-invalid="true"] {
                    border-color: #b91c1c;
                }

                .tf-worktypes {
                    display: grid;
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                    gap: 0.6rem;
                }
                .tf-worktype {
                    position: relative;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    padding: 0.75rem 0.9rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: 12px;
                    cursor: pointer;
                    color: var(--color-gray-700);
                }
                .tf-worktype.active {
                    border-color: var(--color-primary);
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                }
                .tf-worktype:focus-within {
                    outline: 2px solid var(--color-primary);
                    outline-offset: 2px;
                }
                .tf-worktype input {
                    position: absolute;
                    opacity: 0;
                    pointer-events: none;
                }
                .tf-worktype-name {
                    font-size: 0.92rem;
                    font-weight: 700;
                }
                .tf-worktype-hint {
                    font-size: 0.78rem;
                    line-height: 1.35;
                    color: var(--color-gray-500);
                }

                .tf-check {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-size: 0.92rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    cursor: pointer;
                    margin-bottom: 1rem;
                }
                .tf-check input[type='checkbox'] {
                    width: 18px;
                    height: 18px;
                    margin: 0;
                    accent-color: var(--color-primary);
                    cursor: pointer;
                    flex-shrink: 0;
                }
                .tf-check-hint {
                    margin: -0.7rem 0 1rem 26px;
                }

                .tf-work {
                    border: 1px solid var(--color-gray-200);
                    border-radius: 12px;
                    padding: 1rem;
                    margin-bottom: 1rem;
                    background: var(--color-gray-50);
                }
                .tf-work-head {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 0.5rem;
                    margin-bottom: 0.75rem;
                }
                .tf-work-name {
                    font-size: 0.92rem;
                    font-weight: 700;
                    color: var(--color-gray-800);
                }
                .tf-work-tools {
                    display: flex;
                    gap: 4px;
                }
                .tf-icon-btn {
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
                .tf-icon-btn.danger:hover { color: var(--color-error, #ef4444); background: var(--color-red-tint); }
                .tf-photo-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
                    gap: 0.5rem;
                    margin-bottom: 0.9rem;
                }
                .tf-photo-thumb {
                    position: relative;
                    aspect-ratio: 4 / 3;
                    border-radius: 10px;
                    overflow: hidden;
                    background: var(--color-gray-100);
                }
                .tf-photo-thumb img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .tf-thumb-blank {
                    display: block;
                    width: 100%;
                    height: 100%;
                    background: var(--color-gray-800);
                }
                /* A video: a play mark on its poster. */
                .tf-thumb-play {
                    position: absolute;
                    left: 6px;
                    bottom: 6px;
                    width: 26px;
                    height: 26px;
                    border-radius: 50%;
                    background: rgba(0, 0, 0, 0.6);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding-left: 2px;
                }
                .tf-photo-remove {
                    position: absolute;
                    top: 4px;
                    right: 4px;
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
                .tf-photo-add {
                    position: relative;
                    aspect-ratio: 4 / 3;
                    border: 1.5px dashed var(--color-gray-300);
                    border-radius: 10px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                    color: var(--color-gray-500);
                    background: var(--color-surface);
                    font-size: 0.75rem;
                    font-weight: 600;
                    text-align: center;
                    padding: 0.25rem;
                }
                .tf-photo-add:hover { border-color: var(--color-primary); color: var(--color-primary); }
                .tf-add-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    padding: 0.6rem 1rem;
                    border-radius: var(--radius-md);
                    border: 1px dashed var(--color-gray-300);
                    background: none;
                    color: var(--color-primary);
                    font-weight: 600;
                    font-size: 0.88rem;
                    cursor: pointer;
                }
                .tf-add-btn:hover { border-color: var(--color-primary); background: var(--color-blue-tint); }

                .tf-cover {
                    position: relative;
                    height: 170px;
                    border-radius: var(--radius-lg);
                    background-color: var(--color-blue-tint);
                    background-size: cover;
                    background-position: center;
                    display: flex;
                    align-items: flex-end;
                    justify-content: flex-end;
                    padding: 0.75rem;
                }
                .tf-upload-overlay {
                    position: absolute;
                    inset: 0;
                    border-radius: var(--radius-lg);
                    background: rgba(0, 0, 0, 0.45);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 3;
                }
                .tf-cover-actions {
                    display: flex;
                    gap: 0.5rem;
                    position: relative;
                    z-index: 4;
                }
                .tf-cover-btn {
                    position: relative;
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    background: var(--color-surface);
                    color: var(--color-gray-900);
                    border-radius: var(--radius-md);
                    height: 34px;
                    padding: 0 12px;
                    font-weight: 600;
                    font-size: 0.8rem;
                    border: none;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
                    white-space: nowrap;
                }
                .tf-cover-btn.danger { color: var(--color-error, #ef4444); cursor: pointer; padding: 0 10px; }
                /* File inputs stay focusable (keyboard, screen readers) but unseen;
                   their label shows the focus instead. */
                .tf-file-input {
                    position: absolute;
                    width: 1px;
                    height: 1px;
                    opacity: 0;
                    overflow: hidden;
                    clip: rect(0 0 0 0);
                }
                .tf-cover-btn:focus-within,
                .tf-photo-add:focus-within {
                    outline: 3px solid var(--color-primary);
                    outline-offset: 2px;
                }

                .tf-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 0.75rem;
                    margin-top: 1.5rem;
                }
                .tf-delete {
                    margin-top: 2rem;
                    padding-top: 1.25rem;
                    border-top: 1px solid var(--color-gray-200);
                }
                .tf-delete-link {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    padding: 0.5rem 0;
                    border: none;
                    background: none;
                    color: var(--color-error, #b91c1c);
                    font-weight: 600;
                    font-size: 0.9rem;
                    cursor: pointer;
                }
                .tf-delete-confirm {
                    padding: 1rem;
                    border-radius: var(--radius-lg);
                    background: var(--color-red-tint);
                }
                .tf-delete-confirm p {
                    margin: 0 0 0.85rem;
                    color: var(--color-gray-800);
                    font-weight: 600;
                    line-height: 1.5;
                }
                .tf-delete-buttons {
                    display: flex;
                    gap: 0.75rem;
                    justify-content: flex-end;
                }
                .tf-danger-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    padding: 0.6rem 1.3rem;
                    border-radius: var(--radius-full);
                    border: none;
                    background: #dc2626;
                    color: white;
                    font-weight: 600;
                    cursor: pointer;
                }

                @media (max-width: 600px) {
                    .tf-card {
                        padding: 1.15rem;
                    }
                    .tf-row {
                        grid-template-columns: 1fr;
                        gap: 0;
                    }
                    .tf-row-link {
                        grid-template-columns: 1fr 96px;
                        gap: 0.75rem;
                    }
                    .tf-worktypes {
                        grid-template-columns: 1fr;
                    }
                    .tf-actions {
                        flex-direction: column-reverse;
                    }
                    .tf-actions button {
                        width: 100%;
                    }
                }
            `}</style>
        </div>
    );
};

export default TalentForm;
