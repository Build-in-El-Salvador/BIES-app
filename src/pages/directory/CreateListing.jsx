import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { objectionableMessage } from '../../components/moderation/objectionable';
import {
    Loader2, AlertCircle, Camera, X, Plus, Trash2,
    CheckCircle, Bitcoin, Leaf, Building2, ImagePlus, ThumbsUp, Store, ChevronDown, ChevronUp,
} from 'lucide-react';
import { directoryApi, uploadApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { DIRECTORY_CATEGORIES } from '../../components/directory/categories';
import { nostrService } from '../../services/nostrService';
import { nostrSigner } from '../../services/nostrSigner';
import TagInput from '../../components/TagInput';
import MemberSearchSelect from '../../components/MemberSearchSelect';
import ImageCropModal from '../../components/ImageCropModal';
import { getAssetUrl } from '../../utils/assets';
import { PRODUCE_ICON_KEYS, getProduceIcon } from './produceIcons';
import BackButton from '../../components/BackButton';

const FARM_PRACTICES = [
    { id: 'regenerative', tKey: 'directory.practices.regenerative' },
    { id: 'rotational-grazing', tKey: 'directory.practices.rotationalGrazing' },
    { id: 'no-gmo-feed', tKey: 'directory.practices.noGmoFeed' },
    { id: 'animal-welfare', tKey: 'directory.practices.animalWelfare' },
];

const MAX_PRODUCTS = 20;
const MAX_PHOTOS = 10;
// The poster's review is their vouch (server: the listing's first endorsement).
const REVIEW_MIN = 20;

const emptyForm = {
    name: '',
    about: '',
    location: '',
    phone: '',
    whatsapp: '',
    email: '',
    website: '',
    instagram: '',
    btcAccepted: false,
    photo: '',
    logo: '',
    bestFor: '',
    pricing: '',
    category: '',
    hours: '',
    mapUrl: '',
    review: '',
};

/**
 * Directory listing create/edit form (farms + providers), following the
 * CreateEvent.jsx conventions: card sections, input-field styles, upload
 * via uploadApi.media with the ImageCropModal pattern (photo: wide crop,
 * logo: square/round crop), error banner, submitting states.
 *
 * @param {'FARM'|'PROVIDER'} [type] - the directory a new listing goes in (/farms/new, /trusted/new)
 * @param {boolean} editMode - true when mounted at /farms/:id/edit or /trusted/:id/edit
 */
const CreateListing = ({ type: typeProp, editMode = false }) => {
    const { t } = useTranslation();
    const { user, isStaff, isAdmin } = useAuth();
    const navigate = useNavigate();
    const { id } = useParams();
    const [searchParams] = useSearchParams();

    const initialType = typeProp || (searchParams.get('type') === 'provider' ? 'PROVIDER' : 'FARM');
    const [type, setType] = useState(initialType);
    // Whose listing it is: a customer recommending it (their review is their
    // vouch) or the business or farm itself.
    const [isOwnBusiness, setIsOwnBusiness] = useState(false);
    const [photos, setPhotos] = useState([]); // gallery, up to MAX_PHOTOS
    const [form, setForm] = useState(emptyForm);
    const [languages, setLanguages] = useState([]);
    const [products, setProducts] = useState([]); // FARM: [{ label, icon }]
    const [practices, setPractices] = useState([]); // FARM
    const [skills, setSkills] = useState([]); // PROVIDER
    const [memberLink, setMemberLink] = useState([]); // PROVIDER: 0..1 linked BIES account

    const [loading, setLoading] = useState(editMode);
    const [loadError, setLoadError] = useState(null);
    const [notYours, setNotYours] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
    // A field the member must fix: shown beside it, and it gets the focus.
    const [fieldError, setFieldError] = useState(null); // { id, message }
    const [uploading, setUploading] = useState(null); // 'photo' | 'logo' | 'gallery' | null
    const [cropImage, setCropImage] = useState(null); // { src, target }
    const [submitted, setSubmitted] = useState(false);
    // Listings already on BIES with a name like this one: recommend one of
    // those instead of adding it twice (Nextdoor starts by finding the place).
    const [matches, setMatches] = useState([]);
    useEffect(() => {
        const name = form.name.trim();
        if (editMode || name.length < 3) { setMatches([]); return; }
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const result = await directoryApi.list({ type, search: name, limit: 4 });
                if (!cancelled) setMatches((result?.data || []).slice(0, 4));
            } catch {
                if (!cancelled) setMatches([]);
            }
        }, 350);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [form.name, type, editMode]);

    // Photos, about, hours, contact and the rest: folded away when adding,
    // open when editing.
    const [showDetails, setShowDetails] = useState(editMode);

    const isFarm = type === 'FARM';
    const isBusy = submitting || uploading !== null;

    // ─── Edit mode: load listing (owner/admin enforced by the API) ───────────
    useEffect(() => {
        if (!editMode) return;
        let cancelled = false;
        (async () => {
            try {
                const result = await directoryApi.get(id);
                const listing = result?.data || result;
                if (cancelled) return;
                // The API only saves the creator's or an admin's changes.
                if (!isAdmin && listing.ownerId !== user?.id) {
                    setNotYours(true);
                    setLoadError(t('directory.notYoursToEdit'));
                    return;
                }
                setType(listing.type === 'PROVIDER' ? 'PROVIDER' : 'FARM');
                setForm({
                    name: listing.name || '',
                    about: listing.about || '',
                    location: listing.location || '',
                    phone: listing.phone || '',
                    whatsapp: listing.whatsapp || '',
                    email: listing.email || '',
                    website: listing.website || '',
                    instagram: listing.instagram || '',
                    btcAccepted: !!listing.btcAccepted,
                    photo: listing.photo || '',
                    logo: listing.logo || '',
                    bestFor: listing.bestFor || '',
                    pricing: listing.pricing || '',
                    category: listing.category || '',
                    hours: listing.hours || '',
                    mapUrl: listing.mapUrl || '',
                    review: '',
                });
                setIsOwnBusiness(!!listing.isOwnBusiness);
                setPhotos(Array.isArray(listing.photos) ? listing.photos.filter(Boolean) : []);
                setLanguages(Array.isArray(listing.languages) ? listing.languages : []);
                setProducts(Array.isArray(listing.products) ? listing.products.filter((p) => p?.label != null) : []);
                setPractices(Array.isArray(listing.practices) ? listing.practices : []);
                setSkills(Array.isArray(listing.skills) ? listing.skills : []);
                setMemberLink(listing.memberUser ? [{
                    userId: listing.memberUser.id,
                    name: listing.memberUser.profile?.name || 'Member',
                    avatar: listing.memberUser.profile?.avatar || '',
                }] : []);
            } catch (err) {
                if (!cancelled) setLoadError(err.message || t('directory.notFound'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [editMode, id]);  

    const handleChange = (e) => {
        const { name, value, type: inputType, checked } = e.target;
        if (fieldError?.id === `dir-${name}`) setFieldError(null);
        setForm((prev) => ({ ...prev, [name]: inputType === 'checkbox' ? checked : value }));
    };

    // ─── Uploads: select → crop → uploadApi.media ─────────────────────────────
    const handleImageSelect = (e, target) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setCropImage({ src: URL.createObjectURL(file), target });
        e.target.value = ''; // allow re-selecting the same file
    };

    const handleCropConfirm = async (croppedFile) => {
        const target = cropImage.target;
        URL.revokeObjectURL(cropImage.src);
        setCropImage(null);
        setUploading(target);
        setSubmitError('');
        try {
            const result = await uploadApi.media(croppedFile);
            setForm((prev) => ({ ...prev, [target]: result.url }));
        } catch (err) {
            setSubmitError(err.message || 'Failed to upload image.');
        } finally {
            setUploading(null);
        }
    };

    const handleCropCancel = () => {
        if (cropImage) URL.revokeObjectURL(cropImage.src);
        setCropImage(null);
    };

    // Gallery photos upload as they are, several at a time.
    const handleGallerySelect = async (e) => {
        const files = Array.from(e.target.files || []).slice(0, MAX_PHOTOS - photos.length);
        e.target.value = '';
        if (!files.length) return;
        setUploading('gallery');
        setSubmitError('');
        try {
            for (const file of files) {
                const result = await uploadApi.media(file);
                setPhotos((prev) => (prev.length < MAX_PHOTOS ? [...prev, result.url] : prev));
            }
        } catch (err) {
            setSubmitError(err.message || 'Failed to upload image.');
        } finally {
            setUploading(null);
        }
    };
    const removePhoto = (url) => setPhotos((prev) => prev.filter((p) => p !== url));

    // ─── Products editor (FARM) ───────────────────────────────────────────────
    const addProduct = () => {
        if (products.length >= MAX_PRODUCTS) return;
        setProducts((prev) => [...prev, { label: '', icon: '' }]);
    };
    const updateProduct = (index, field, value) =>
        setProducts((prev) => prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
    const removeProduct = (index) =>
        setProducts((prev) => prev.filter((_, i) => i !== index));

    const togglePractice = (practiceId) =>
        setPractices((prev) =>
            prev.includes(practiceId) ? prev.filter((p) => p !== practiceId) : [...prev, practiceId]
        );

    // ─── Submit ───────────────────────────────────────────────────────────────
    const buildPayload = () => {
        const website = form.website.trim();
        const shared = {
            type,
            name: form.name.trim(),
            about: form.about.trim(),
            photo: form.photo || '',
            logo: form.logo || '',
            location: form.location.trim(),
            phone: form.phone.trim(),
            whatsapp: form.whatsapp.trim(),
            email: form.email.trim(),
            website: website && !/^https?:\/\//i.test(website) ? `https://${website}` : website,
            instagram: form.instagram.trim(),
            languages,
            btcAccepted: form.btcAccepted,
            photos,
            hours: form.hours.trim(),
            mapUrl: form.mapUrl.trim(),
            isOwnBusiness,
            ...(!editMode && !isOwnBusiness ? { review: form.review.trim() } : {}),
        };
        if (isFarm) {
            return {
                ...shared,
                products: products
                    .map((p) => ({ label: (p.label || '').trim(), ...(p.icon ? { icon: p.icon } : {}) }))
                    .filter((p) => p.label),
                practices,
            };
        }
        return {
            ...shared,
            category: form.category,
            skills,
            bestFor: form.bestFor.trim(),
            pricing: form.pricing.trim(),
            // Staff only: the server ignores it from anyone else.
            ...(isStaff ? { memberUserId: memberLink[0]?.userId || '' } : {}), // '' clears the link on update
        };
    };

    const detailPath = (listing) =>
        listing.type === 'PROVIDER' ? `/trusted/${listing.id}` : `/farms/${listing.id}`;

    // Best-effort Nostr mirror for members who sign on their own device: the
    // server only signs for hosted keys, so a live listing it couldn't mirror
    // (no stored event id) is mirrored from here.
    const mirrorFromDevice = (listing) => {
        if (listing.status !== 'active' || listing.nostrListingEventId || !nostrSigner.signsOnDevice) return;
        try {
            nostrService.publishDirectoryListing({
                id: listing.id,
                type: listing.type,
                name: listing.name,
                about: listing.about,
                photo: listing.photo,
                location: listing.location,
                products: listing.products,
                skills: listing.skills,
            }).catch(() => {});
        } catch { /* non-blocking */ }
    };

    const handleSubmit = async () => {
        setSubmitError('');
        const problem = !form.name.trim() ? { id: 'dir-name', message: t('directory.nameRequired') }
            : !isFarm && !form.category ? { id: 'dir-category', message: t('directory.categoryRequired') }
                : !editMode && !isOwnBusiness && form.review.trim().length < REVIEW_MIN
                    ? { id: 'dir-review', message: t('directory.reviewRequired', { min: REVIEW_MIN }) }
                    : null;
        setFieldError(problem);
        if (problem) {
            const field = document.getElementById(problem.id);
            field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            field?.focus({ preventScroll: true });
            return;
        }
        setSubmitting(true);
        try {
            const payload = buildPayload();
            if (editMode) {
                const result = await directoryApi.update(id, payload);
                const listing = result?.data || result;
                mirrorFromDevice(listing);
                navigate(detailPath(listing));
            } else {
                const result = await directoryApi.create(payload);
                const listing = result?.data || result;
                if (listing.status === 'active') {
                    // Live at once (unless the server holds members' listings for approval)
                    mirrorFromDevice(listing);
                    navigate(detailPath(listing));
                } else {
                    setSubmitted(true);
                    window.scrollTo(0, 0);
                }
            }
        } catch (err) {
            if (objectionableMessage(t, err)) {
                setSubmitError(objectionableMessage(t, err));
            } else if (err.data?.details) {
                setSubmitError(`${err.message}: ${err.data.details.map((d) => `${d.field}: ${d.message}`).join(', ')}`);
            } else {
                setSubmitError(err.message || 'Failed to save listing');
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } finally {
            setSubmitting(false);
        }
    };

    // ─── Confirmation screen (submitted for review) ───────────────────────────
    if (submitted) {
        return (
            <div className="listing-form-page">
                <div className="container">
                    <div className="dir-form-content" style={{ textAlign: 'center', paddingTop: '4rem' }}>
                        <CheckCircle size={52} style={{ color: 'var(--color-success, #16a34a)', marginBottom: '1rem' }} />
                        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                            {t('directory.submittedTitle')}
                        </h1>
                        <p style={{ color: 'var(--color-gray-600)', lineHeight: 1.6, marginBottom: '2rem' }}>
                            {t('directory.submittedForReview')}
                        </p>
                        <Link to={isFarm ? '/farms' : '/trusted'} className="btn btn-primary">
                            {t('directory.backToDirectory')}
                        </Link>
                    </div>
                </div>
                <style jsx>{`
                    .listing-form-page { padding-bottom: 4rem; }
                    .dir-form-content { max-width: 560px; margin: 0 auto; }
                `}</style>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto', color: 'var(--color-gray-500)' }} />
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="container">
                <div style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <h2>{notYours ? t('directory.editTitle') : t('directory.notFound')}</h2>
                    <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0' }}>{loadError}</p>
                    <Link
                        to={isFarm ? '/farms' : '/trusted'}
                        style={{ marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', fontWeight: 500, color: 'var(--color-primary)' }}
                    >
                        {t('directory.backToDirectory')}
                    </Link>
                </div>
            </div>
        );
    }

    const pageTitle = editMode
        ? t('directory.editTitle')
        : isFarm ? t('directory.createTitleFarm') : t('directory.createTitleProvider');

    return (
        <div className="listing-form-page">
            <div className="container">
                <div className="dir-form-content">

                    {/* Header */}
                    <div className="dir-form-header">
                        <div className="back-head">
                            <BackButton fallback={isFarm ? '/farms' : '/trusted'} />
                            <h1 className="dir-form-title">
                                {isFarm
                                    ? <Leaf size={24} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
                                    : <Building2 size={24} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />}
                                {pageTitle}
                            </h1>
                        </div>
                        {!editMode && <p className="dir-form-subtitle">{t('directory.createSubtitle')}</p>}
                    </div>

                    {submitError && (
                        <div className="dir-error-banner"><AlertCircle size={16} /> {submitError}</div>
                    )}

                    {/* Whose listing this is */}
                    <div className="dir-form-card">
                        <h3 className="dir-card-heading">{t('directory.connectionLabel', { context: isFarm ? 'farm' : undefined })}</h3>
                        <div className="dir-connection" role="radiogroup" aria-label={t('directory.connectionLabel', { context: isFarm ? 'farm' : undefined })}>
                            <label className={`dir-connection-option${!isOwnBusiness ? ' active' : ''}`}>
                                <input type="radio" name="connection" checked={!isOwnBusiness} onChange={() => setIsOwnBusiness(false)} />
                                <ThumbsUp size={18} />
                                <span>{t('directory.connectionCustomer', { context: isFarm ? 'farm' : undefined })}</span>
                            </label>
                            <label className={`dir-connection-option${isOwnBusiness ? ' active' : ''}`}>
                                <input type="radio" name="connection" checked={isOwnBusiness} onChange={() => setIsOwnBusiness(true)} />
                                <Store size={18} />
                                <span>{t('directory.connectionOwner', { context: isFarm ? 'farm' : undefined })}</span>
                            </label>
                        </div>
                        {isOwnBusiness && <p className="dir-field-hint" style={{ marginBottom: 0 }}>{t('directory.connectionOwnerHint')}</p>}
                    </div>

                    {/* The basics: what Google "Add a place" and Nextdoor "Recommend" ask first */}
                    <div className="dir-form-card">
                        <h3 className="dir-card-heading">{t('directory.basicInfo')}</h3>

                        <div className="dir-form-group">
                            <label className="dir-label" htmlFor="dir-name">{t('directory.nameLabel')} *</label>
                            <input
                                id="dir-name"
                                type="text"
                                name="name"
                                aria-invalid={fieldError?.id === 'dir-name' || undefined}
                                aria-describedby={fieldError?.id === 'dir-name' ? 'dir-name-error' : undefined}
                                value={form.name}
                                onChange={handleChange}
                                className="dir-input"
                                maxLength={120}
                                required
                            />
                            {fieldError?.id === 'dir-name' && <p className="dir-field-error" id="dir-name-error">{fieldError.message}</p>}
                            {matches.length > 0 && (
                                <div className="dir-matches" role="region" aria-label={t('directory.alreadyListed')}>
                                    <p className="dir-matches-title">{t('directory.alreadyListed')}</p>
                                    {matches.map((m) => (
                                        <Link
                                            key={m.id}
                                            to={`${isFarm ? '/farms' : '/trusted'}/${m.id}${isOwnBusiness ? '' : '?recommend=1'}`}
                                            className="dir-match"
                                        >
                                            <span className="dir-match-name">{m.name}</span>
                                            {m.location && <span className="dir-match-place">{m.location}</span>}
                                            <span className="dir-match-cta">{isOwnBusiness ? t('directory.viewListing') : t('directory.recommendThisOne')}</span>
                                        </Link>
                                    ))}
                                </div>
                            )}
                        </div>

                        {!isFarm && (
                            <div className="dir-form-group">
                                <label className="dir-label" htmlFor="dir-category">{t('directory.category')} *</label>
                                <select
                                    id="dir-category" name="category" value={form.category} onChange={handleChange} className="dir-input" required
                                    aria-invalid={fieldError?.id === 'dir-category' || undefined}
                                    aria-describedby={fieldError?.id === 'dir-category' ? 'dir-category-error' : undefined}
                                >
                                    <option value="">{t('directory.chooseCategory')}</option>
                                    {DIRECTORY_CATEGORIES.map((c) => (
                                        <option key={c} value={c}>{t(`directory.categories.${c}`)}</option>
                                    ))}
                                </select>
                                {fieldError?.id === 'dir-category' && <p className="dir-field-error" id="dir-category-error">{fieldError.message}</p>}
                            </div>
                        )}

                        {isFarm && (
                                <div className="dir-form-group">
                                    <span className="dir-label" id="dir-products-label">{t('directory.productsLabel')}</span>
                                    {products.map((product, idx) => {
                                        const RowIcon = getProduceIcon(product);
                                        return (
                                            <div key={idx} className="dir-product-row" role="group" aria-labelledby="dir-products-label">
                                                <span className="dir-product-icon"><RowIcon size={16} /></span>
                                                <input
                                                    type="text"
                                                    value={product.label}
                                                    onChange={(e) => updateProduct(idx, 'label', e.target.value)}
                                                    className="dir-input"
                                                    maxLength={60}
                                                    placeholder={t('directory.productPlaceholder')}
                                                    aria-label={t('directory.productName', { n: idx + 1 })}
                                                    style={{ flex: 1, minWidth: 0 }}
                                                />
                                                <select
                                                    value={product.icon || ''}
                                                    onChange={(e) => updateProduct(idx, 'icon', e.target.value)}
                                                    aria-label={t('directory.productIcon', { n: idx + 1 })}
                                                    className="dir-input dir-icon-select"
                                                >
                                                    <option value="">{t('directory.iconAuto')}</option>
                                                    {PRODUCE_ICON_KEYS.map((key) => (
                                                        <option key={key} value={key}>
                                                            {t(`directory.produce.${key}`)}
                                                        </option>
                                                    ))}
                                                </select>
                                                <button type="button" className="dir-row-remove" onClick={() => removeProduct(idx)} aria-label={t('directory.removeProduct', { n: idx + 1 })}>
                                                    <Trash2 size={15} />
                                                </button>
                                            </div>
                                        );
                                    })}
                                    {products.length < MAX_PRODUCTS && (
                                        <button type="button" className="dir-add-row-btn" onClick={addProduct}>
                                            <Plus size={14} /> {t('directory.addProduct')}
                                        </button>
                                    )}
                                </div>
                        )}

                        <div className="dir-form-group">
                            <label className="dir-label" htmlFor="dir-location">{t('directory.locationLabel')}</label>
                            <input
                                id="dir-location"
                                type="text"
                                name="location"
                                value={form.location}
                                onChange={handleChange}
                                className="dir-input"
                                maxLength={200}
                                placeholder="El Zonte, La Libertad"
                            />
                        </div>
                    </div>

                    {/* The poster's review: their vouch */}
                    {!editMode && !isOwnBusiness && (
                        <div className="dir-form-card">
                            <h3 className="dir-card-heading">{t('directory.yourReview')} *</h3>
                            <p className="dir-field-hint" id="dir-review-hint" style={{ marginTop: 0 }}>{t('directory.yourReviewHint', { context: isFarm ? 'farm' : undefined })}</p>
                            <div className="dir-form-group" style={{ marginBottom: '0.9rem' }}>
                                <textarea
                                    id="dir-review"
                                    name="review"
                                    aria-label={t('directory.yourReview')}
                                    aria-required="true"
                                    aria-invalid={fieldError?.id === 'dir-review' || undefined}
                                    aria-describedby={`dir-review-hint dir-review-count${fieldError?.id === 'dir-review' ? ' dir-review-error' : ''}`}
                                    value={form.review}
                                    onChange={handleChange}
                                    className="dir-input"
                                    rows={4}
                                    maxLength={1000}
                                    placeholder={t('directory.yourReviewPlaceholder', { context: isFarm ? 'farm' : undefined })}
                                />
                                <span className="dir-char-count" id="dir-review-count">
                                    {form.review.trim().length < REVIEW_MIN
                                        ? t('directory.reviewMinCount', { count: form.review.trim().length, min: REVIEW_MIN })
                                        : `${form.review.trim().length}/1000`}
                                </span>
                            </div>
                            {fieldError?.id === 'dir-review' && <p className="dir-field-error" id="dir-review-error">{fieldError.message}</p>}
                        </div>
                    )}

                    {/* Everything else, folded away until they want it ("More details") */}
                    <button
                        type="button"
                        className="dir-more-toggle"
                        aria-expanded={showDetails}
                        onClick={() => setShowDetails((v) => !v)}
                    >
                        <span className="dir-more-title">
                            {showDetails ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                            {t('directory.moreDetails')}
                        </span>
                        <span className="dir-more-hint">{t('directory.moreDetailsHint')}</span>
                    </button>
                    {showDetails && (
                        <>
                            {/* Photo + logo — mirrors the detail page layout */}
                            <div className="dir-form-card" style={{ padding: 0, overflow: 'visible' }}>
                                <div
                                    className="dir-form-cover"
                                    style={{ backgroundImage: form.photo ? `url(${getAssetUrl(form.photo)})` : 'none' }}
                                >
                                    {uploading === 'photo' && (
                                        <div className="dir-upload-overlay">
                                            <Loader2 size={28} style={{ animation: 'spin 1s linear infinite', color: 'white' }} />
                                        </div>
                                    )}
                                    <div className="dir-cover-actions">
                                        <label className="dir-banner-btn" style={{ cursor: uploading ? 'not-allowed' : 'pointer' }}>
                                            <Camera size={15} />
                                            {t('directory.coverPhoto')}
                                            <input
                                                type="file"
                                                accept="image/*"
                                                onChange={(e) => handleImageSelect(e, 'photo')}
                                                className="dir-file-input"
                                                disabled={!!uploading}
                                            />
                                        </label>
                                        {form.photo && !uploading && (
                                            <button
                                                type="button"
                                                className="dir-banner-btn danger"
                                                onClick={() => setForm((p) => ({ ...p, photo: '' }))}
                                                aria-label={t('directory.removeCover')}
                                            >
                                                <X size={15} />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div className="dir-logo-row">
                                    <label className="dir-logo-circle" style={{ cursor: uploading ? 'not-allowed' : 'pointer' }} title={t('directory.logoLabel')}>
                                        {uploading === 'logo' ? (
                                            <Loader2 size={22} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-gray-400)' }} />
                                        ) : form.logo ? (
                                            <img src={getAssetUrl(form.logo)} alt={t('directory.logoLabel')} />
                                        ) : (
                                            <Camera size={22} style={{ color: 'var(--color-gray-400)' }} />
                                        )}
                                        <input
                                            type="file"
                                            accept="image/*"
                                            onChange={(e) => handleImageSelect(e, 'logo')}
                                            aria-label={t('directory.logoLabel')}
                                            className="dir-file-input"
                                            disabled={!!uploading}
                                        />
                                    </label>
                                    <span className="dir-logo-hint">{t('directory.logoLabel')}</span>
                                    {form.logo && !uploading && (
                                        <button
                                            type="button"
                                            className="dir-logo-remove"
                                            onClick={() => setForm((p) => ({ ...p, logo: '' }))}
                                            aria-label={t('directory.removeLogo')}
                                        >
                                            <X size={14} />
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Gallery */}
                            <div className="dir-form-card">
                                <h3 className="dir-card-heading">{t('directory.photosLabel')}</h3>
                                <p className="dir-field-hint" style={{ marginTop: 0 }}>{t('directory.photosHint', { max: MAX_PHOTOS })}</p>
                                <div className="dir-gallery-grid">
                                    {photos.map((url) => (
                                        <div key={url} className="dir-gallery-thumb">
                                            <img src={getAssetUrl(url)} alt="" />
                                            <button type="button" className="dir-gallery-remove" onClick={() => removePhoto(url)} aria-label={t('directory.removePhoto')} disabled={isBusy}>
                                                <X size={14} />
                                            </button>
                                        </div>
                                    ))}
                                    {photos.length < MAX_PHOTOS && (
                                        <label className="dir-gallery-add" style={{ cursor: uploading ? 'not-allowed' : 'pointer' }}>
                                            {uploading === 'gallery'
                                                ? <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
                                                : <ImagePlus size={22} />}
                                            <span>{t('directory.addPhotos')}</span>
                                            <input type="file" accept="image/*" multiple onChange={handleGallerySelect} className="dir-file-input" disabled={!!uploading} />
                                        </label>
                                    )}
                                </div>
                            </div>

                            {/* About and hours */}
                            <div className="dir-form-card">
                                <h3 className="dir-card-heading">{t('directory.aboutHeading')}</h3>

                                <div className="dir-form-group">
                                    <label className="dir-label" htmlFor="dir-about">{t('directory.aboutLabel')}</label>
                                    <textarea
                                        id="dir-about"
                                        name="about"
                                        value={form.about}
                                        onChange={handleChange}
                                        className="dir-input"
                                        rows={5}
                                        maxLength={5000}
                                    />
                                </div>

                                <div className="dir-form-group" style={{ marginBottom: 0 }}>
                                    <label className="dir-label" htmlFor="dir-hours">{t('directory.hoursLabel')}</label>
                                    <input
                                        id="dir-hours"
                                        type="text"
                                        name="hours"
                                        value={form.hours}
                                        onChange={handleChange}
                                        className="dir-input"
                                        maxLength={200}
                                        placeholder={t('directory.hoursPlaceholder')}
                                    />
                                </div>
                                <div className="dir-form-group" style={{ marginBottom: 0, marginTop: '1rem' }}>
                                    <label className="dir-label" htmlFor="dir-map-url">{t('directory.mapUrlLabel')}</label>
                                    <input
                                        id="dir-map-url"
                                        type="url"
                                        name="mapUrl"
                                        value={form.mapUrl}
                                        onChange={handleChange}
                                        className="dir-input"
                                        maxLength={500}
                                        placeholder="https://maps.app.goo.gl/…"
                                        aria-describedby="dir-map-url-hint"
                                    />
                                    <p className="dir-field-hint" id="dir-map-url-hint">{t('directory.mapUrlHint')}</p>
                                </div>
                            </div>

                            {/* Contact */}
                            <div className="dir-form-card">
                                <h3 className="dir-card-heading">{t('directory.contactInfo')}</h3>

                                <div className="dir-form-row">
                                    <div className="dir-form-group">
                                        <label className="dir-label" htmlFor="dir-phone">{t('directory.phoneLabel')}</label>
                                        <input type="tel" id="dir-phone" name="phone" value={form.phone} onChange={handleChange} className="dir-input" maxLength={30} placeholder="+503 6123 4567" />
                                    </div>
                                    <div className="dir-form-group">
                                        <label className="dir-label" htmlFor="dir-whatsapp">{t('directory.whatsappLabel')}</label>
                                        <input type="tel" id="dir-whatsapp" name="whatsapp" value={form.whatsapp} onChange={handleChange} className="dir-input" maxLength={30} placeholder="+503 6123 4567" />
                                    </div>
                                </div>

                                <div className="dir-form-group">
                                    <label className="dir-label" htmlFor="dir-email">{t('directory.emailLabel')}</label>
                                    <input type="email" id="dir-email" name="email" value={form.email} onChange={handleChange} className="dir-input" />
                                </div>

                                <div className="dir-form-group">
                                    <label className="dir-label" htmlFor="dir-website">{t('directory.websiteLabel')}</label>
                                    <input type="text" id="dir-website" name="website" value={form.website} onChange={handleChange} className="dir-input" placeholder="https://…" />
                                </div>

                                <div className="dir-form-group">
                                    <label className="dir-label" htmlFor="dir-instagram">{t('directory.instagramLabel')}</label>
                                    <input type="text" id="dir-instagram" name="instagram" value={form.instagram} onChange={handleChange} className="dir-input" placeholder="@yourfarm" />
                                </div>

                                <div className="dir-form-group">
                                    <label className="dir-label" htmlFor="dir-languages">{t('directory.languages')}</label>
                                    <TagInput id="dir-languages" tags={languages} onChange={setLanguages} placeholder="Español, English…" />
                                </div>

                                <label className="dir-btc-toggle" style={{ marginBottom: 0 }}>
                                    <input
                                        type="checkbox"
                                        name="btcAccepted"
                                        checked={form.btcAccepted}
                                        onChange={handleChange}
                                    />
                                    <Bitcoin size={17} style={{ color: '#f7931a' }} />
                                    <span>{t('directory.btcAccepted')}</span>
                                </label>
                            </div>

                            {isFarm ? (
                                <div className="dir-form-card">
                                    <h3 className="dir-card-heading">{t('directory.farmDetails')}</h3>

                                    <div className="dir-form-group" style={{ marginBottom: 0 }}>
                                        <span className="dir-label" id="dir-practices-label">{t('directory.practicesLabel')}</span>
                                        <div className="dir-practices-checks" role="group" aria-labelledby="dir-practices-label">
                                            {FARM_PRACTICES.map((p) => (
                                                <label key={p.id} className="dir-check-label">
                                                    <input
                                                        type="checkbox"
                                                        checked={practices.includes(p.id)}
                                                        onChange={() => togglePractice(p.id)}
                                                    />
                                                    {t(p.tKey)}
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="dir-form-card">
                                    <h3 className="dir-card-heading">{t('directory.providerDetails')}</h3>

                                    <div className="dir-form-group">
                                        <label className="dir-label" htmlFor="dir-skills">{t('directory.skillsLabel')}</label>
                                        <TagInput id="dir-skills" tags={skills} onChange={setSkills} placeholder="Solar, Permaculture…" />
                                    </div>

                                    <div className="dir-form-group">
                                        <label className="dir-label" htmlFor="dir-best-for">{t('directory.bestFor')}</label>
                                        <input type="text" id="dir-best-for" name="bestFor" value={form.bestFor} onChange={handleChange} className="dir-input" maxLength={200} />
                                    </div>

                                    <div className="dir-form-group">
                                        <label className="dir-label" htmlFor="dir-pricing">{t('directory.pricing')}</label>
                                        <input type="text" id="dir-pricing" name="pricing" value={form.pricing} onChange={handleChange} className="dir-input" maxLength={200} />
                                    </div>

                                    {/* Staff only: link the business's own BIES account (zaps) */}
                                    {isStaff && (
                                        <div className="dir-form-group dir-member-link" style={{ marginBottom: 0 }}>
                                            <label className="dir-label">{t('directory.linkMember')}</label>
                                            <MemberSearchSelect
                                                value={memberLink}
                                                onChange={(list) => setMemberLink(list.slice(-1))}
                                                placeholder={t('directory.linkMemberPlaceholder')}
                                            />
                                            <p className="dir-field-hint">{t('directory.linkMemberHint')}</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    {/* Actions */}
                    <div className="dir-form-actions">
                        <button type="button" onClick={() => navigate(-1)} className="btn btn-outline" disabled={submitting}>
                            {t('common.cancel')}
                        </button>
                        <button type="button" onClick={handleSubmit} disabled={isBusy} className="btn btn-primary">
                            {submitting && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: '-3px' }} />}
                            {editMode ? t('directory.saveChanges')
                                : isOwnBusiness ? t(isFarm ? 'directory.addMyFarm' : 'directory.addMyBusiness')
                                    : t('directory.postRecommendation')}
                        </button>
                    </div>
                </div>
            </div>

            {cropImage && (
                <ImageCropModal
                    imageSrc={cropImage.src}
                    aspect={cropImage.target === 'logo' ? 1 : 16 / 9}
                    shape={cropImage.target === 'logo' ? 'round' : 'rect'}
                    onCrop={handleCropConfirm}
                    onCancel={handleCropCancel}
                />
            )}

            <style jsx>{`
                .listing-form-page {
                    padding-top: var(--page-top, 1.5rem);
                    padding-bottom: 4rem;
                }

                .dir-form-content {
                    max-width: 760px;
                    margin: 0 auto;
                }

                .dir-form-header {
                    margin-bottom: 1.25rem;
                }


                .dir-form-title {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    font-size: 1.6rem;
                    font-weight: 700;
                    margin: 0 0 0.25rem;
                    color: var(--color-gray-900);
                }
                .dir-form-subtitle {
                    color: var(--color-gray-500);
                    font-size: 0.9rem;
                    margin: 0;
                }

                .dir-error-banner {
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

                .dir-connection {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.6rem;
                }
                .dir-connection-option {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    padding: 0.8rem 0.9rem;
                    border: 1px solid var(--color-gray-200);
                    border-radius: 12px;
                    font-size: 0.9rem;
                    font-weight: 500;
                    cursor: pointer;
                    color: var(--color-gray-700);
                }
                .dir-connection-option.active {
                    border-color: var(--color-primary);
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-weight: 600;
                }
                .dir-connection-option:focus-within {
                    outline: 2px solid var(--color-primary);
                    outline-offset: 2px;
                }
                .dir-connection-option input {
                    position: absolute;
                    opacity: 0;
                    pointer-events: none;
                }
                @media (max-width: 480px) {
                    .dir-connection { grid-template-columns: 1fr; }
                }
                .dir-gallery-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
                    gap: 0.6rem;
                }
                .dir-gallery-thumb {
                    position: relative;
                    aspect-ratio: 4 / 3;
                    border-radius: 10px;
                    overflow: hidden;
                    background: var(--color-gray-100);
                }
                .dir-gallery-thumb img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .dir-gallery-remove {
                    position: absolute;
                    top: 4px;
                    right: 4px;
                    width: 32px;
                    height: 32px;
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
                .dir-gallery-add {
                    aspect-ratio: 4 / 3;
                    border: 1.5px dashed var(--color-gray-300);
                    border-radius: 10px;
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
                .dir-gallery-add:hover { border-color: var(--color-primary); color: var(--color-primary); }
                .dir-form-card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    padding: 1.5rem;
                    margin-bottom: 1.25rem;
                }

                .dir-card-heading {
                    font-size: 1.05rem;
                    font-weight: 700;
                    margin: 0 0 1.25rem;
                    padding-bottom: 0.75rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }

                .dir-form-cover {
                    position: relative;
                    height: 180px;
                    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
                    background-color: var(--color-blue-tint);
                    background-size: cover;
                    background-position: center;
                    display: flex;
                    align-items: flex-end;
                    justify-content: flex-end;
                    padding: 0.75rem;
                }

                .dir-upload-overlay {
                    position: absolute;
                    inset: 0;
                    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
                    background: rgba(0, 0, 0, 0.45);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 3;
                }

                .dir-cover-actions {
                    display: flex;
                    gap: 0.5rem;
                    position: relative;
                    z-index: 4;
                }

                .dir-banner-btn {
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
                .dir-banner-btn.danger { color: var(--color-error, #ef4444); cursor: pointer; padding: 0 10px; }

                .dir-logo-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0 1.25rem 1rem;
                }

                .dir-logo-circle {
                    width: 72px;
                    height: 72px;
                    border-radius: 50%;
                    border: 3px solid var(--color-surface);
                    background: var(--color-gray-100);
                    box-shadow: var(--shadow-sm);
                    margin-top: -36px;
                    position: relative;
                    z-index: 5;
                    overflow: hidden;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }
                .dir-logo-circle img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .dir-logo-hint {
                    font-size: 0.82rem;
                    font-weight: 600;
                    color: var(--color-gray-500);
                }

                .dir-logo-remove {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    border: none;
                    background: var(--color-gray-100);
                    color: var(--color-gray-500);
                    cursor: pointer;
                }
                .dir-logo-remove:hover { color: var(--color-error, #ef4444); }

                .dir-form-group {
                    margin-bottom: 1.1rem;
                    position: relative;
                }

                .dir-form-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.75rem;
                }

                .dir-label {
                    display: block;
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    margin-bottom: 0.4rem;
                }

                .dir-input {
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
                .dir-input:focus {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 82, 204, 0.1);
                }
                textarea.dir-input { resize: vertical; }
                select.dir-input { appearance: auto; cursor: pointer; }

                .dir-matches {
                    margin-top: 0.6rem;
                    padding: 0.75rem;
                    border-radius: var(--radius-md);
                    background: var(--color-blue-tint);
                }
                .dir-matches-title {
                    margin: 0 0 0.4rem;
                    font-size: 0.82rem;
                    font-weight: 700;
                    color: var(--color-primary);
                }
                .dir-matches :global(.dir-match) {
                    display: grid;
                    grid-template-columns: 1fr auto;
                    align-items: center;
                    column-gap: 8px;
                    min-height: 44px;
                    padding: 0.4rem 0.6rem;
                    margin-top: 4px;
                    border-radius: var(--radius-sm);
                    background: var(--color-surface);
                    text-decoration: none;
                    color: inherit;
                }
                .dir-matches :global(.dir-match-name) { font-weight: 600; font-size: 0.9rem; }
                .dir-matches :global(.dir-match-place) { grid-column: 1; font-size: 0.78rem; color: var(--color-gray-500); }
                .dir-matches :global(.dir-match-cta) {
                    grid-column: 2;
                    grid-row: 1 / span 2;
                    font-size: 0.8rem;
                    font-weight: 700;
                    color: var(--color-primary);
                    white-space: nowrap;
                }
                .dir-more-toggle {
                    width: 100%;
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 4px;
                    min-height: 56px;
                    margin-bottom: 1.25rem;
                    padding: 0.9rem 1.1rem;
                    border: 1px dashed var(--color-gray-300);
                    border-radius: var(--radius-lg);
                    background: var(--color-surface);
                    text-align: left;
                    cursor: pointer;
                }
                .dir-more-title {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 0.98rem;
                    font-weight: 700;
                    color: var(--color-primary);
                }
                .dir-more-hint {
                    font-size: 0.82rem;
                    color: var(--color-gray-500);
                    padding-left: 26px;
                }
                /* File inputs stay focusable (keyboard, screen readers) but unseen;
                   their label shows the focus instead. */
                .dir-file-input {
                    position: absolute;
                    width: 1px;
                    height: 1px;
                    opacity: 0;
                    overflow: hidden;
                    clip: rect(0 0 0 0);
                }
                .dir-banner-btn:focus-within,
                .dir-logo-circle:focus-within,
                .dir-gallery-add:focus-within {
                    outline: 3px solid var(--color-primary);
                    outline-offset: 2px;
                }
                .dir-field-error {
                    margin: 0.4rem 0 0;
                    font-size: 0.82rem;
                    font-weight: 600;
                    color: #b91c1c;
                }
                .dir-char-count {
                    position: absolute;
                    right: 4px;
                    bottom: -18px;
                    font-size: 0.72rem;
                    color: var(--color-gray-400);
                }

                .dir-field-hint {
                    margin: 0.4rem 0 0;
                    font-size: 0.78rem;
                    line-height: 1.45;
                    color: var(--color-gray-500);
                }

                .dir-btc-toggle {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-size: 0.9rem;
                    font-weight: 600;
                    color: var(--color-gray-700);
                    cursor: pointer;
                }
                .dir-btc-toggle input[type='checkbox'] {
                    width: 17px;
                    height: 17px;
                    margin: 0;
                    accent-color: var(--color-primary);
                    cursor: pointer;
                }

                .dir-product-row {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    margin-bottom: 0.5rem;
                }

                .dir-product-icon {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 34px;
                    height: 34px;
                    border-radius: 50%;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    flex-shrink: 0;
                }

                .dir-icon-select {
                    width: 130px;
                    flex-shrink: 0;
                    padding: 0.55rem 0.5rem;
                    font-size: 0.85rem;
                }

                .dir-row-remove {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: none;
                    border: none;
                    cursor: pointer;
                    padding: 0.35rem;
                    color: var(--color-gray-400);
                    border-radius: var(--radius-md);
                    flex-shrink: 0;
                }
                .dir-row-remove:hover { color: var(--color-error, #ef4444); background: var(--color-red-tint); }

                .dir-add-row-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.35rem;
                    padding: 0.45rem 0.9rem;
                    border-radius: var(--radius-md);
                    border: 1px dashed var(--color-gray-300);
                    background: none;
                    color: var(--color-primary);
                    font-weight: 600;
                    font-size: 0.82rem;
                    cursor: pointer;
                    margin-top: 0.25rem;
                    transition: all 0.15s;
                }
                .dir-add-row-btn:hover { border-color: var(--color-primary); background: var(--color-blue-tint); }

                .dir-practices-checks {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.6rem;
                }

                .dir-check-label {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 0.9rem;
                    font-weight: 500;
                    color: var(--color-gray-700);
                    cursor: pointer;
                    margin: 0;
                }
                .dir-check-label input[type='checkbox'] {
                    width: 16px;
                    height: 16px;
                    margin: 0;
                    accent-color: var(--color-primary);
                    cursor: pointer;
                }

                .dir-form-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 0.75rem;
                    margin-top: 1.5rem;
                }

                @media (max-width: 600px) {
                    .dir-form-row {
                        grid-template-columns: 1fr;
                        gap: 0;
                    }
                    .dir-practices-checks {
                        grid-template-columns: 1fr;
                    }
                    .dir-icon-select {
                        width: 104px;
                    }
                    .dir-form-actions {
                        flex-direction: column-reverse;
                    }
                    .dir-form-actions button {
                        width: 100%;
                    }
                }
            `}</style>
        </div>
    );
};

export default CreateListing;
