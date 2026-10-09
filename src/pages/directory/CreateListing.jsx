import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    ArrowLeft, Loader2, AlertCircle, Camera, X, Plus, Trash2,
    CheckCircle, Bitcoin, Leaf, ShieldCheck,
} from 'lucide-react';
import { directoryApi, uploadApi } from '../../services/api';
import { nostrService } from '../../services/nostrService';
import { nostrSigner } from '../../services/nostrSigner';
import TagInput from '../../components/TagInput';
import MemberSearchSelect from '../../components/MemberSearchSelect';
import ImageCropModal from '../../components/ImageCropModal';
import { getAssetUrl } from '../../utils/assets';
import { PRODUCE_ICON_KEYS, getProduceIcon } from './produceIcons';

const FARM_PRACTICES = [
    { id: 'regenerative', tKey: 'directory.practices.regenerative' },
    { id: 'rotational-grazing', tKey: 'directory.practices.rotationalGrazing' },
    { id: 'no-gmo-feed', tKey: 'directory.practices.noGmoFeed' },
    { id: 'animal-welfare', tKey: 'directory.practices.animalWelfare' },
];

const MAX_PRODUCTS = 20;

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
    comment: '',
};

/**
 * Directory listing create/edit form (farms + providers), following the
 * CreateEvent.jsx conventions: card sections, input-field styles, upload
 * via uploadApi.media with the ImageCropModal pattern (photo: wide crop,
 * logo: square/round crop), error banner, submitting states.
 *
 * @param {boolean} editMode - true when mounted at /discover/directory/:id/edit
 */
const CreateListing = ({ editMode = false }) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { id } = useParams();
    const [searchParams] = useSearchParams();

    const [type, setType] = useState(searchParams.get('type') === 'provider' ? 'PROVIDER' : 'FARM');
    const [form, setForm] = useState(emptyForm);
    const [languages, setLanguages] = useState([]);
    const [products, setProducts] = useState([]); // FARM: [{ label, icon }]
    const [practices, setPractices] = useState([]); // FARM
    const [skills, setSkills] = useState([]); // PROVIDER
    const [memberLink, setMemberLink] = useState([]); // PROVIDER: 0..1 linked BIES account

    const [loading, setLoading] = useState(editMode);
    const [loadError, setLoadError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
    const [uploading, setUploading] = useState(null); // 'photo' | 'logo' | null
    const [cropImage, setCropImage] = useState(null); // { src, target }
    const [submitted, setSubmitted] = useState(false);

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
                    comment: listing.comment || '',
                });
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
            skills,
            bestFor: form.bestFor.trim(),
            pricing: form.pricing.trim(),
            comment: form.comment.trim(),
            memberUserId: memberLink[0]?.userId || '', // '' clears the link on update
        };
    };

    const detailPath = (listing) =>
        listing.type === 'PROVIDER' ? `/discover/certified/${listing.id}` : `/discover/farms/${listing.id}`;

    const handleSubmit = async () => {
        setSubmitError('');
        if (!form.name.trim()) {
            setSubmitError(t('directory.nameRequired'));
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        setSubmitting(true);
        try {
            const payload = buildPayload();
            if (editMode) {
                const result = await directoryApi.update(id, payload);
                const listing = result?.data || result;
                // Best-effort client-side Nostr mirror for Nostr-native owners:
                // the server only signs for custodial users, so an active listing
                // without a stored event id gets mirrored from the client.
                if (listing.status === 'active' && !listing.nostrListingEventId && nostrSigner._mode) {
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
                }
                navigate(detailPath(listing));
            } else {
                const result = await directoryApi.create(payload);
                const listing = result?.data || result;
                if (listing.status === 'active') {
                    // MOD/admin listings go live immediately — skip the review screen
                    navigate(detailPath(listing));
                } else {
                    setSubmitted(true);
                    window.scrollTo(0, 0);
                }
            }
        } catch (err) {
            if (err.data?.details) {
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
                        <Link to={isFarm ? '/discover/farms' : '/discover/certified'} className="btn btn-primary">
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
                    <h2>{t('directory.notFound')}</h2>
                    <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0' }}>{loadError}</p>
                    <Link
                        to={isFarm ? '/discover/farms' : '/discover/certified'}
                        style={{ marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', fontWeight: 500, color: 'var(--color-primary)' }}
                    >
                        <ArrowLeft size={16} /> {t('directory.backToDirectory')}
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
                        <button onClick={() => navigate(-1)} className="dir-back-link" type="button">
                            <ArrowLeft size={18} /> {t('common.back')}
                        </button>
                        <h1 className="dir-form-title">
                            {isFarm
                                ? <Leaf size={24} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
                                : <ShieldCheck size={24} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />}
                            {pageTitle}
                        </h1>
                        {!editMode && <p className="dir-form-subtitle">{t('directory.createSubtitle')}</p>}
                    </div>

                    {submitError && (
                        <div className="dir-error-banner"><AlertCircle size={16} /> {submitError}</div>
                    )}

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
                                        style={{ display: 'none' }}
                                        disabled={!!uploading}
                                    />
                                </label>
                                {form.photo && !uploading && (
                                    <button
                                        type="button"
                                        className="dir-banner-btn danger"
                                        onClick={() => setForm((p) => ({ ...p, photo: '' }))}
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
                                    style={{ display: 'none' }}
                                    disabled={!!uploading}
                                />
                            </label>
                            <span className="dir-logo-hint">{t('directory.logoLabel')}</span>
                            {form.logo && !uploading && (
                                <button
                                    type="button"
                                    className="dir-logo-remove"
                                    onClick={() => setForm((p) => ({ ...p, logo: '' }))}
                                >
                                    <X size={14} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Basic info */}
                    <div className="dir-form-card">
                        <h3 className="dir-card-heading">{t('directory.basicInfo')}</h3>

                        <div className="dir-form-group">
                            <label className="dir-label">{t('directory.nameLabel')} *</label>
                            <input
                                type="text"
                                name="name"
                                value={form.name}
                                onChange={handleChange}
                                className="dir-input"
                                maxLength={120}
                                required
                            />
                        </div>

                        <div className="dir-form-group">
                            <label className="dir-label">{t('directory.aboutLabel')}</label>
                            <textarea
                                name="about"
                                value={form.about}
                                onChange={handleChange}
                                className="dir-input"
                                rows={5}
                                maxLength={5000}
                            />
                        </div>

                        <div className="dir-form-group" style={{ marginBottom: 0 }}>
                            <label className="dir-label">{t('directory.locationLabel')}</label>
                            <input
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

                    {/* Contact */}
                    <div className="dir-form-card">
                        <h3 className="dir-card-heading">{t('directory.contactInfo')}</h3>

                        <div className="dir-form-row">
                            <div className="dir-form-group">
                                <label className="dir-label">{t('directory.phoneLabel')}</label>
                                <input type="tel" name="phone" value={form.phone} onChange={handleChange} className="dir-input" maxLength={30} placeholder="+503 6123 4567" />
                            </div>
                            <div className="dir-form-group">
                                <label className="dir-label">{t('directory.whatsappLabel')}</label>
                                <input type="tel" name="whatsapp" value={form.whatsapp} onChange={handleChange} className="dir-input" maxLength={30} placeholder="+503 6123 4567" />
                            </div>
                        </div>

                        <div className="dir-form-group">
                            <label className="dir-label">{t('directory.emailLabel')}</label>
                            <input type="email" name="email" value={form.email} onChange={handleChange} className="dir-input" />
                        </div>

                        <div className="dir-form-group">
                            <label className="dir-label">{t('directory.websiteLabel')}</label>
                            <input type="text" name="website" value={form.website} onChange={handleChange} className="dir-input" placeholder="https://…" />
                        </div>

                        <div className="dir-form-group">
                            <label className="dir-label">{t('directory.instagramLabel')}</label>
                            <input type="text" name="instagram" value={form.instagram} onChange={handleChange} className="dir-input" placeholder="@yourfarm" />
                        </div>

                        <div className="dir-form-group">
                            <label className="dir-label">{t('directory.languages')}</label>
                            <TagInput tags={languages} onChange={setLanguages} placeholder="Español, English…" />
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

                    {/* Type-specific sections */}
                    {isFarm ? (
                        <div className="dir-form-card">
                            <h3 className="dir-card-heading">{t('directory.farmDetails')}</h3>

                            <div className="dir-form-group">
                                <label className="dir-label">{t('directory.productsLabel')}</label>
                                {products.map((product, idx) => {
                                    const RowIcon = getProduceIcon(product);
                                    return (
                                        <div key={idx} className="dir-product-row">
                                            <span className="dir-product-icon"><RowIcon size={16} /></span>
                                            <input
                                                type="text"
                                                value={product.label}
                                                onChange={(e) => updateProduct(idx, 'label', e.target.value)}
                                                className="dir-input"
                                                maxLength={60}
                                                placeholder={t('directory.productPlaceholder')}
                                                style={{ flex: 1, minWidth: 0 }}
                                            />
                                            <select
                                                value={product.icon || ''}
                                                onChange={(e) => updateProduct(idx, 'icon', e.target.value)}
                                                className="dir-input dir-icon-select"
                                            >
                                                <option value="">{t('directory.iconAuto')}</option>
                                                {PRODUCE_ICON_KEYS.map((key) => (
                                                    <option key={key} value={key}>
                                                        {key.charAt(0).toUpperCase() + key.slice(1)}
                                                    </option>
                                                ))}
                                            </select>
                                            <button type="button" className="dir-row-remove" onClick={() => removeProduct(idx)}>
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

                            <div className="dir-form-group" style={{ marginBottom: 0 }}>
                                <label className="dir-label">{t('directory.practicesLabel')}</label>
                                <div className="dir-practices-checks">
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
                                <label className="dir-label">{t('directory.skillsLabel')}</label>
                                <TagInput tags={skills} onChange={setSkills} placeholder="Solar, Permaculture…" />
                            </div>

                            <div className="dir-form-group">
                                <label className="dir-label">{t('directory.bestFor')}</label>
                                <input type="text" name="bestFor" value={form.bestFor} onChange={handleChange} className="dir-input" maxLength={200} />
                            </div>

                            <div className="dir-form-group">
                                <label className="dir-label">{t('directory.pricing')}</label>
                                <input type="text" name="pricing" value={form.pricing} onChange={handleChange} className="dir-input" maxLength={200} />
                            </div>

                            <div className="dir-form-group" style={{ marginBottom: '1.6rem' }}>
                                <label className="dir-label">{t('directory.commentLabel')}</label>
                                <textarea
                                    name="comment"
                                    value={form.comment}
                                    onChange={handleChange}
                                    className="dir-input"
                                    rows={3}
                                    maxLength={500}
                                />
                                <span className="dir-char-count">{form.comment.length}/500</span>
                            </div>

                            {/* Optional link to the provider's BIES account (zaps + reputation signals) */}
                            <div className="dir-form-group dir-member-link" style={{ marginBottom: 0 }}>
                                <label className="dir-label">{t('directory.linkMember')}</label>
                                <MemberSearchSelect
                                    value={memberLink}
                                    onChange={(list) => setMemberLink(list.slice(-1))}
                                    placeholder={t('directory.linkMemberPlaceholder')}
                                />
                                <p className="dir-field-hint">{t('directory.linkMemberHint')}</p>
                            </div>
                        </div>
                    )}

                    {/* Actions */}
                    <div className="dir-form-actions">
                        <button type="button" onClick={() => navigate(-1)} className="btn btn-outline" disabled={submitting}>
                            {t('common.cancel')}
                        </button>
                        <button type="button" onClick={handleSubmit} disabled={isBusy} className="btn btn-primary">
                            {submitting && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: '-3px' }} />}
                            {editMode ? t('directory.saveChanges') : t('directory.submitListing')}
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
                    padding-top: 1.5rem;
                    padding-bottom: 4rem;
                }

                .dir-form-content {
                    max-width: 760px;
                    margin: 0 auto;
                }

                .dir-form-header {
                    margin-bottom: 1.25rem;
                }

                .dir-back-link {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.25rem;
                    color: var(--color-gray-500);
                    font-weight: 500;
                    font-size: 0.9rem;
                    background: none;
                    border: none;
                    cursor: pointer;
                    padding: 0;
                    margin-bottom: 0.75rem;
                }
                .dir-back-link:hover { color: var(--color-primary); }

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
