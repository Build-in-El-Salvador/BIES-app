import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Save, Loader2, Camera, Link2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { coursesApi, uploadApi } from '../../services/api';
import ImageCropModal from '../../components/ImageCropModal';
import { getAssetUrl } from '../../utils/assets';
import BackButton from '../../components/BackButton';

const CATEGORIES = [
  { value: 'BITCOIN', label: 'Bitcoin' },
  { value: 'LIGHTNING', label: 'Lightning' },
  { value: 'NOSTR', label: 'Nostr' },
  { value: 'FINTECH', label: 'Fintech' },
  { value: 'BUSINESS', label: 'Business' },
  { value: 'TECHNOLOGY', label: 'Technology' },
  { value: 'OTHER', label: 'Other' },
];

const FORMATS = [
  { value: 'SELF_PACED', label: 'Self-paced' },
  { value: 'VIDEO', label: 'Video' },
  { value: 'LIVE', label: 'Live' },
  { value: 'TEXT', label: 'Text' },
  { value: 'WORKSHOP', label: 'Workshop' },
];

const LEVELS = [
  { value: 'BEGINNER', label: 'Beginner' },
  { value: 'INTERMEDIATE', label: 'Intermediate' },
  { value: 'ADVANCED', label: 'Advanced' },
];

const fieldStyle = {
  width: '100%',
  padding: '0.65rem 0.875rem',
  border: '1px solid var(--color-gray-300)',
  borderRadius: 'var(--radius-md)',
  fontSize: '0.95rem',
  background: 'var(--color-surface)',
  color: 'var(--color-gray-800)',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s',
};

const labelStyle = {
  display: 'block',
  fontSize: '0.875rem',
  fontWeight: 600,
  color: 'var(--color-gray-700)',
  marginBottom: '0.4rem',
};

const FormField = ({ label, required, children }) => (
  <div style={{ marginBottom: '1.5rem' }}>
    <label style={labelStyle}>
      {label}
      {required && <span style={{ color: '#ef4444', marginLeft: '3px' }}>*</span>}
    </label>
    {children}
  </div>
);

const NewCourse = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const editId = searchParams.get('edit');

  const [initialLoading, setInitialLoading] = useState(!!editId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editStatus, setEditStatus] = useState(null);

  // Cover image upload state
  const [cropImage, setCropImage] = useState(null); // object URL of the selected file
  const [uploading, setUploading] = useState(false);
  const [urlMode, setUrlMode] = useState(false);

  const [form, setForm] = useState({
    title: '',
    shortDescription: '',
    fullDescription: '',
    category: '',
    format: '',
    level: '',
    price: '',
    coverImage: '',
    tags: '',
  });

  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await coursesApi.get(editId);
        const course = result?.data || result;
        if (cancelled) return;
        setForm({
          title: course.title || '',
          shortDescription: course.summary || '',
          fullDescription: course.description || '',
          category: course.category || '',
          format: course.format || '',
          level: course.level || '',
          price: course.priceSats != null ? String(course.priceSats) : '',
          coverImage: course.coverImage || '',
          tags: Array.isArray(course.tags) ? course.tags.join(', ') : '',
        });
        setEditStatus(course.status || null);
      } catch (err) {
        if (!cancelled) setError(err.message || t('courses.notFound'));
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editId, t]);

  const handleChange = (field) => (e) => {
    setForm(prev => ({ ...prev, [field]: e.target.value }));
    if (error) setError('');
  };

  // ─── Cover image: select → crop (16:9) → uploadApi.media ──────────────────
  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCropImage(URL.createObjectURL(file));
    e.target.value = ''; // allow re-selecting the same file
  };

  const handleCropConfirm = async (croppedFile) => {
    URL.revokeObjectURL(cropImage);
    setCropImage(null);
    setUploading(true);
    setError('');
    try {
      const result = await uploadApi.media(croppedFile);
      setForm(prev => ({ ...prev, coverImage: result.url }));
    } catch (err) {
      setError(err.message || t('dashboard.failedToUploadImage'));
    } finally {
      setUploading(false);
    }
  };

  const handleCropCancel = () => {
    if (cropImage) URL.revokeObjectURL(cropImage);
    setCropImage(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) {
      setError(t('dashboard.courseTitleRequired'));
      return;
    }
    setLoading(true);
    setError('');

    const payload = {
      title: form.title.trim(),
      summary: form.shortDescription.trim(),
      description: form.fullDescription.trim(),
      coverImage: form.coverImage,
      tags: form.tags.split(',').map(s => s.trim()).filter(Boolean),
      priceSats: parseInt(form.price, 10) || 0,
    };
    if (form.category) payload.category = form.category;
    if (form.level) payload.level = form.level;
    if (form.format) payload.format = form.format;

    try {
      if (editId) {
        await coursesApi.update(editId, payload);
        navigate(`/dashboard/builder/course/${editId}`);
      } else {
        const result = await coursesApi.create(payload);
        const course = result?.data || result;
        navigate(`/dashboard/builder/course/${course.id}`);
      }
    } catch (err) {
      if (err.data?.details) {
        setError(`${err.message}: ${err.data.details.map((d) => `${d.field}: ${d.message}`).join(', ')}`);
      } else {
        setError(err.message || t('dashboard.failedToSaveProject'));
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setLoading(false);
    }
  };

  const inputFocusHandlers = {
    onFocus: (e) => { e.target.style.borderColor = 'var(--color-primary)'; },
    onBlur: (e) => { e.target.style.borderColor = 'var(--color-gray-300)'; },
  };

  if (initialLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  const priceNum = parseInt(form.price, 10) || 0;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem' }}>
        <BackButton fallback="/dashboard/courses" />
        <div>
          <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700, color: 'var(--color-gray-800)' }}>
            {editId ? t('dashboard.editCourse') : t('dashboard.newCourseTitle')}
          </h1>
          <p style={{ margin: '0.2rem 0 0', color: 'var(--color-gray-500)', fontSize: '0.9rem' }}>
            {editId ? t('dashboard.updateCourseDetails') : t('dashboard.createNewCourse')}
          </p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          padding: '0.875rem 1.25rem',
          background: 'var(--badge-error-bg)',
          color: 'var(--badge-error-text)',
          borderRadius: 'var(--radius-md)',
          marginBottom: '1.5rem',
          fontWeight: 500,
          fontSize: '0.9rem',
        }}>
          {error}
        </div>
      )}

      {/* Editing an active course resets it to review (server behavior) */}
      {editId && editStatus === 'active' && (
        <div style={{
          padding: '0.875rem 1.25rem',
          background: 'var(--badge-warning-bg)',
          color: 'var(--badge-warning-text)',
          borderRadius: 'var(--radius-md)',
          marginBottom: '1.5rem',
          fontWeight: 500,
          fontSize: '0.9rem',
        }}>
          {t('courses.builder.resubmitHint')}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 340px',
          gap: '1.5rem',
          alignItems: 'start',
        }}>

          {/* Left column — main fields */}
          <div style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-gray-200)',
            borderRadius: 'var(--radius-lg)',
            padding: '2rem',
            boxShadow: 'var(--shadow-sm)',
          }}>
            <FormField label={t('dashboard.courseTitle')} required>
              <input
                type="text"
                placeholder={t('admin.courseTitlePlaceholder')}
                value={form.title}
                onChange={handleChange('title')}
                required
                style={fieldStyle}
                {...inputFocusHandlers}
              />
            </FormField>

            <FormField label={t('dashboard.shortDescription')}>
              <textarea
                placeholder={t('admin.shortDescPlaceholder')}
                value={form.shortDescription}
                onChange={handleChange('shortDescription')}
                rows={3}
                style={{ ...fieldStyle, resize: 'vertical' }}
                {...inputFocusHandlers}
              />
            </FormField>

            <FormField label={t('dashboard.fullDescription')}>
              <textarea
                placeholder={t('admin.fullDescPlaceholder')}
                value={form.fullDescription}
                onChange={handleChange('fullDescription')}
                rows={8}
                style={{ ...fieldStyle, resize: 'vertical' }}
                {...inputFocusHandlers}
              />
            </FormField>

            <FormField label={t('dashboard.tags')}>
              <input
                type="text"
                placeholder={t('admin.tagPlaceholder')}
                value={form.tags}
                onChange={handleChange('tags')}
                style={fieldStyle}
                {...inputFocusHandlers}
              />
              <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--color-gray-400)' }}>
                {t('dashboard.separateTags')}
              </p>
            </FormField>
          </div>

          {/* Right column — metadata */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

            {/* Course Settings card */}
            <div style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-gray-200)',
              borderRadius: 'var(--radius-lg)',
              padding: '1.5rem',
              boxShadow: 'var(--shadow-sm)',
            }}>
              <h3 style={{ margin: '0 0 1.25rem', fontSize: '0.95rem', fontWeight: 700, color: 'var(--color-gray-700)' }}>
                {t('dashboard.courseSettings')}
              </h3>

              <FormField label={t('dashboard.category')}>
                <select
                  value={form.category}
                  onChange={handleChange('category')}
                  style={fieldStyle}
                  {...inputFocusHandlers}
                >
                  <option value="">{t('admin.selectCategory')}</option>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </FormField>

              <FormField label={t('dashboard.format')}>
                <select
                  value={form.format}
                  onChange={handleChange('format')}
                  style={fieldStyle}
                  {...inputFocusHandlers}
                >
                  <option value="">{t('admin.selectFormat')}</option>
                  {FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </FormField>

              <FormField label={t('dashboard.level')}>
                <select
                  value={form.level}
                  onChange={handleChange('level')}
                  style={fieldStyle}
                  {...inputFocusHandlers}
                >
                  <option value="">{t('admin.selectLevel')}</option>
                  {LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </FormField>

              <FormField label={t('dashboard.price')}>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="0"
                  value={form.price}
                  onChange={handleChange('price')}
                  style={fieldStyle}
                  {...inputFocusHandlers}
                />
                <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--color-gray-400)' }}>
                  {priceNum > 0 ? t('courses.priceSats', { n: priceNum }) : `${t('courses.free')} — 0 sats`}
                </p>
              </FormField>
            </div>

            {/* Cover image card */}
            <div style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-gray-200)',
              borderRadius: 'var(--radius-lg)',
              padding: '1.5rem',
              boxShadow: 'var(--shadow-sm)',
            }}>
              <h3 style={{ margin: '0 0 1.25rem', fontSize: '0.95rem', fontWeight: 700, color: 'var(--color-gray-700)' }}>
                {t('dashboard.coverImage')}
              </h3>

              {form.coverImage && (
                <div style={{ position: 'relative', marginBottom: '0.875rem' }}>
                  <img
                    src={getAssetUrl(form.coverImage)}
                    alt={t('admin.coverPreview')}
                    style={{ width: '100%', height: '140px', objectFit: 'cover', borderRadius: '8px', display: 'block' }}
                  />
                  {!uploading && (
                    <button
                      type="button"
                      onClick={() => setForm(prev => ({ ...prev, coverImage: '' }))}
                      title={t('dashboard.removeBtn')}
                      style={{
                        position: 'absolute', top: 8, right: 8,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 28, height: 28, borderRadius: '50%', border: 'none',
                        background: 'rgba(0,0,0,0.55)', color: 'white', cursor: 'pointer',
                      }}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <label style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '0.55rem 0.9rem',
                  border: '1px solid var(--color-gray-300)',
                  borderRadius: 'var(--radius-md)',
                  background: 'none',
                  color: 'var(--color-gray-700)',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: uploading ? 'not-allowed' : 'pointer',
                  flex: 1,
                  justifyContent: 'center',
                }}>
                  {uploading ? (
                    <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> {t('dashboard.uploadingText')}</>
                  ) : (
                    <><Camera size={15} /> {t('dashboard.uploadImage')}</>
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageSelect}
                    style={{ display: 'none' }}
                    disabled={uploading}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setUrlMode(v => !v)}
                  title={t('admin.coverImageUrl')}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 38, height: 38, flexShrink: 0,
                    border: `1px solid ${urlMode ? 'var(--color-primary)' : 'var(--color-gray-300)'}`,
                    borderRadius: 'var(--radius-md)',
                    background: 'none',
                    color: urlMode ? 'var(--color-primary)' : 'var(--color-gray-500)',
                    cursor: 'pointer',
                  }}
                >
                  <Link2 size={16} />
                </button>
              </div>

              {urlMode && (
                <div style={{ marginTop: '0.875rem' }}>
                  <input
                    type="text"
                    placeholder="https://example.com/cover.jpg"
                    value={form.coverImage}
                    onChange={handleChange('coverImage')}
                    style={fieldStyle}
                    {...inputFocusHandlers}
                  />
                  <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--color-gray-400)' }}>
                    {t('admin.coverImageUrl')}
                  </p>
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <button
                type="submit"
                disabled={loading || uploading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  padding: '0.75rem 1.5rem',
                  background: loading || uploading ? 'var(--color-gray-300)' : 'var(--color-primary)',
                  color: 'white',
                  border: 'none',
                  borderRadius: 'var(--radius-md)',
                  fontWeight: 700,
                  fontSize: '0.95rem',
                  cursor: loading || uploading ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s',
                  width: '100%',
                }}
              >
                {loading ? (
                  <><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> {t('common.saving')}</>
                ) : (
                  <><Save size={18} /> {editId ? t('dashboard.updateCourse') : t('dashboard.saveCourse')}</>
                )}
              </button>
              <button
                type="button"
                onClick={() => navigate('/dashboard/courses')}
                style={{
                  padding: '0.7rem 1.5rem',
                  border: '1px solid var(--color-gray-300)',
                  borderRadius: 'var(--radius-md)',
                  background: 'none',
                  color: 'var(--color-gray-600)',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                {t('dashboard.cancel')}
              </button>
            </div>
          </div>
        </div>
      </form>

      {cropImage && (
        <ImageCropModal
          imageSrc={cropImage}
          aspect={16 / 9}
          shape="rect"
          onCrop={handleCropConfirm}
          onCancel={handleCropCancel}
        />
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        @media (max-width: 900px) {
          form > div {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
};

export default NewCourse;
