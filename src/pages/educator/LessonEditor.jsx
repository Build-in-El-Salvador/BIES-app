import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Save, Loader2, Plus, Trash2, X, Video, FileText, HelpCircle,
} from 'lucide-react';
import { coursesApi } from '../../services/api';
import VideoEmbed from '../../components/courses/VideoEmbed';
import MarkdownEditor from '../../components/courses/MarkdownEditor';
import BackButton from '../../components/BackButton';

const VALID_TYPES = ['VIDEO', 'TEXT', 'QUIZ'];
const MAX_QUESTIONS = 50;
const MAX_OPTIONS = 6;
const MIN_OPTIONS = 2;

const TYPE_CFG = {
  VIDEO: { tKey: 'courses.types.video', Icon: Video },
  TEXT: { tKey: 'courses.types.text', Icon: FileText },
  QUIZ: { tKey: 'courses.types.quiz', Icon: HelpCircle },
};

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

const cardStyle = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-gray-200)',
  borderRadius: 'var(--radius-lg)',
  padding: '2rem',
  boxShadow: 'var(--shadow-sm)',
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

const emptyQuestion = () => ({ prompt: '', options: ['', ''], correctIndex: 0 });

const LessonEditor = () => {
  const { t } = useTranslation();
  const { courseId, lessonId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const isEdit = !!lessonId && lessonId !== 'new';
  const paramType = (searchParams.get('type') || '').toUpperCase();
  const initialType = VALID_TYPES.includes(paramType) ? paramType : 'TEXT';

  const [type, setType] = useState(initialType);
  const [initialLoading, setInitialLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Common fields
  const [title, setTitle] = useState('');
  const [durationMin, setDurationMin] = useState('');
  const [isFreePreview, setIsFreePreview] = useState(false);

  // VIDEO
  const [videoUrl, setVideoUrl] = useState('');
  const [caption, setCaption] = useState('');

  // TEXT
  const [markdown, setMarkdown] = useState('');

  // QUIZ
  const [passPct, setPassPct] = useState('70');
  const [questions, setQuestions] = useState([emptyQuestion()]);

  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await coursesApi.getLesson(courseId, lessonId);
        const lesson = result?.data || result;
        if (cancelled) return;
        const lessonType = VALID_TYPES.includes(lesson.type) ? lesson.type : 'TEXT';
        setType(lessonType);
        setTitle(lesson.title || '');
        setDurationMin(lesson.durationSec ? String(Math.round(lesson.durationSec / 60)) : '');
        setIsFreePreview(!!lesson.isFreePreview);
        const content = lesson.content || {};
        if (lessonType === 'VIDEO') {
          setVideoUrl(content.videoUrl || '');
          setCaption(content.caption || '');
        } else if (lessonType === 'TEXT') {
          setMarkdown(content.markdown || '');
        } else if (lessonType === 'QUIZ') {
          setPassPct(content.passPct != null ? String(content.passPct) : '70');
          const answerKey = lesson.answerKey || {};
          const loaded = (content.questions || []).map((q, i) => {
            const key = q.id || `q${i}`;
            const correct = answerKey[key];
            return {
              prompt: q.prompt || '',
              options: Array.isArray(q.options) && q.options.length >= MIN_OPTIONS ? [...q.options] : ['', ''],
              correctIndex: Number.isInteger(correct) ? correct : 0,
            };
          });
          setQuestions(loaded.length > 0 ? loaded : [emptyQuestion()]);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err.message || t('courses.notFound'));
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isEdit, courseId, lessonId, t]);

  // ─── Quiz question editing ─────────────────────────────────────────────────
  const updateQuestion = (qi, patch) =>
    setQuestions(prev => prev.map((q, i) => (i === qi ? { ...q, ...patch } : q)));

  const addQuestion = () => {
    if (questions.length >= MAX_QUESTIONS) return;
    setQuestions(prev => [...prev, emptyQuestion()]);
  };

  const removeQuestion = (qi) => {
    if (questions.length <= 1) return;
    setQuestions(prev => prev.filter((_, i) => i !== qi));
  };

  const updateOption = (qi, oi, value) =>
    setQuestions(prev => prev.map((q, i) =>
      i === qi ? { ...q, options: q.options.map((o, j) => (j === oi ? value : o)) } : q
    ));

  const addOption = (qi) =>
    setQuestions(prev => prev.map((q, i) =>
      i === qi && q.options.length < MAX_OPTIONS ? { ...q, options: [...q.options, ''] } : q
    ));

  const removeOption = (qi, oi) =>
    setQuestions(prev => prev.map((q, i) => {
      if (i !== qi || q.options.length <= MIN_OPTIONS) return q;
      let correctIndex = q.correctIndex;
      if (oi === correctIndex) correctIndex = 0;
      else if (oi < correctIndex) correctIndex -= 1;
      return { ...q, options: q.options.filter((_, j) => j !== oi), correctIndex };
    }));

  // ─── Save ──────────────────────────────────────────────────────────────────
  const buildPayload = () => {
    const base = { title: title.trim(), isFreePreview };
    const min = parseInt(durationMin, 10);
    if (min > 0) base.durationSec = min * 60;

    if (type === 'VIDEO') {
      return { type: 'VIDEO', ...base, videoUrl: videoUrl.trim(), caption: caption.trim() };
    }
    if (type === 'TEXT') {
      return { type: 'TEXT', ...base, markdown };
    }
    return {
      type: 'QUIZ',
      ...base,
      passPct: parseInt(passPct, 10) || 0,
      questions: questions.map(q => ({
        prompt: q.prompt.trim(),
        options: q.options.map(o => o.trim()),
        correctIndex: q.correctIndex,
      })),
    };
  };

  const handleSave = async () => {
    setError('');
    if (!title.trim()) {
      setError(`${t('courses.builder.lessonTitle')} *`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      if (isEdit) {
        await coursesApi.updateLesson(courseId, lessonId, payload);
      } else {
        await coursesApi.createLesson(courseId, payload);
      }
      navigate(`/dashboard/builder/course/${courseId}`);
    } catch (err) {
      if (err.data?.details) {
        setError(`${err.message}: ${err.data.details.map((d) => `${d.field}: ${d.message}`).join(', ')}`);
      } else {
        setError(err.message || 'Failed to save lesson');
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setSaving(false);
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

  if (loadError) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem' }}>
        <h2 style={{ color: 'var(--color-gray-700)' }}>{t('courses.notFound')}</h2>
        <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0 1.5rem' }}>{loadError}</p>
        <button
          className="btn btn-primary"
          onClick={() => navigate(`/dashboard/builder/course/${courseId}`)}
        >
          {t('dashboard.back')}
        </button>
      </div>
    );
  }

  const typeCfg = TYPE_CFG[type];
  const TypeIcon = typeCfg.Icon;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
        <BackButton to={`/dashboard/builder/course/${courseId}`} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700, color: 'var(--color-gray-800)' }}>
            {isEdit ? t('courses.builder.editLesson') : t('courses.builder.addLesson')}
          </h1>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 10px', borderRadius: 99,
            fontSize: '0.75rem', fontWeight: 700,
            background: 'var(--color-blue-tint)', color: 'var(--color-primary)',
            whiteSpace: 'nowrap',
          }}>
            <TypeIcon size={13} /> {t(typeCfg.tKey)}
          </span>
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

      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 340px',
        gap: '1.5rem',
        alignItems: 'start',
      }} className="lesson-editor-grid">

        {/* Left column — content */}
        <div style={cardStyle}>
          <FormField label={t('courses.builder.lessonTitle')} required>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              style={fieldStyle}
              {...inputFocusHandlers}
            />
          </FormField>

          {type === 'VIDEO' && (
            <>
              <FormField label={t('courses.builder.videoUrl')} required>
                <input
                  type="text"
                  placeholder="https://youtube.com/watch?v=…"
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  style={fieldStyle}
                  {...inputFocusHandlers}
                />
                <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: 'var(--color-gray-400)' }}>
                  {t('courses.builder.videoUrlHint')}
                </p>
              </FormField>

              {videoUrl.trim() && (
                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={labelStyle}>{t('courses.builder.preview')}</label>
                  <VideoEmbed url={videoUrl.trim()} />
                </div>
              )}

              <FormField label="Caption">
                <textarea
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  rows={2}
                  style={{ ...fieldStyle, resize: 'vertical' }}
                  {...inputFocusHandlers}
                />
              </FormField>
            </>
          )}

          {type === 'TEXT' && (
            <MarkdownEditor value={markdown} onChange={(e) => setMarkdown(e.target.value)} rows={16} />
          )}

          {type === 'QUIZ' && (
            <div>
              <label style={labelStyle}>{t('courses.builder.questions')}</label>

              {questions.map((q, qi) => (
                <div
                  key={qi}
                  style={{
                    border: '1px solid var(--color-gray-200)',
                    borderRadius: 'var(--radius-md)',
                    padding: '1.25rem',
                    marginBottom: '1rem',
                    background: 'var(--color-gray-50)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.875rem' }}>
                    <span style={{
                      fontSize: '0.8rem', fontWeight: 700, color: 'var(--color-gray-500)',
                      flexShrink: 0,
                    }}>
                      {qi + 1}.
                    </span>
                    <input
                      type="text"
                      value={q.prompt}
                      onChange={(e) => updateQuestion(qi, { prompt: e.target.value })}
                      style={{ ...fieldStyle, flex: 1 }}
                      {...inputFocusHandlers}
                    />
                    <button
                      type="button"
                      onClick={() => removeQuestion(qi)}
                      disabled={questions.length <= 1}
                      title={t('common.delete')}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 32, height: 32, flexShrink: 0,
                        border: 'none', borderRadius: 6, background: 'none',
                        color: questions.length <= 1 ? 'var(--color-gray-300)' : 'var(--color-gray-400)',
                        cursor: questions.length <= 1 ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>

                  <p style={{ margin: '0 0 0.5rem', fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-gray-500)' }}>
                    {t('courses.builder.correctAnswer')}
                  </p>

                  {q.options.map((opt, oi) => (
                    <div key={oi} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem' }}>
                      <input
                        type="radio"
                        name={`correct-${qi}`}
                        checked={q.correctIndex === oi}
                        onChange={() => updateQuestion(qi, { correctIndex: oi })}
                        title={t('courses.builder.correctAnswer')}
                        style={{ width: 16, height: 16, margin: 0, accentColor: 'var(--color-primary)', cursor: 'pointer', flexShrink: 0 }}
                      />
                      <input
                        type="text"
                        value={opt}
                        onChange={(e) => updateOption(qi, oi, e.target.value)}
                        style={{ ...fieldStyle, flex: 1 }}
                        {...inputFocusHandlers}
                      />
                      <button
                        type="button"
                        onClick={() => removeOption(qi, oi)}
                        disabled={q.options.length <= MIN_OPTIONS}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          width: 28, height: 28, flexShrink: 0,
                          border: 'none', borderRadius: 6, background: 'none',
                          color: q.options.length <= MIN_OPTIONS ? 'var(--color-gray-300)' : 'var(--color-gray-400)',
                          cursor: q.options.length <= MIN_OPTIONS ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}

                  {q.options.length < MAX_OPTIONS && (
                    <button
                      type="button"
                      onClick={() => addOption(qi)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        padding: '0.4rem 0.8rem', marginTop: '0.25rem',
                        border: '1px dashed var(--color-gray-300)',
                        borderRadius: 'var(--radius-md)',
                        background: 'none',
                        color: 'var(--color-primary)',
                        fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
                      }}
                    >
                      <Plus size={13} /> {t('courses.builder.addOption')}
                    </button>
                  )}
                </div>
              ))}

              {questions.length < MAX_QUESTIONS && (
                <button
                  type="button"
                  onClick={addQuestion}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '0.55rem 1rem',
                    border: '1px dashed var(--color-gray-300)',
                    borderRadius: 'var(--radius-md)',
                    background: 'none',
                    color: 'var(--color-primary)',
                    fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
                  }}
                >
                  <Plus size={15} /> {t('courses.builder.addQuestion')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right column — settings + actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div style={{ ...cardStyle, padding: '1.5rem' }}>
            <h3 style={{ margin: '0 0 1.25rem', fontSize: '0.95rem', fontWeight: 700, color: 'var(--color-gray-700)' }}>
              {t('dashboard.courseSettings')}
            </h3>

            <FormField label={t('courses.builder.durationMin')}>
              <input
                type="number"
                min="0"
                step="1"
                value={durationMin}
                onChange={(e) => setDurationMin(e.target.value)}
                style={fieldStyle}
                {...inputFocusHandlers}
              />
            </FormField>

            {type === 'QUIZ' && (
              <FormField label={t('courses.builder.passPct')}>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={passPct}
                  onChange={(e) => setPassPct(e.target.value)}
                  style={fieldStyle}
                  {...inputFocusHandlers}
                />
              </FormField>
            )}

            <label style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-gray-700)',
              cursor: 'pointer', marginBottom: 0,
            }}>
              <input
                type="checkbox"
                checked={isFreePreview}
                onChange={(e) => setIsFreePreview(e.target.checked)}
                style={{ width: 17, height: 17, margin: 0, accentColor: 'var(--color-primary)', cursor: 'pointer' }}
              />
              {t('courses.builder.freePreviewToggle')}
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '0.75rem 1.5rem',
                background: saving ? 'var(--color-gray-300)' : 'var(--color-primary)',
                color: 'white',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                fontWeight: 700,
                fontSize: '0.95rem',
                cursor: saving ? 'not-allowed' : 'pointer',
                transition: 'background 0.15s',
                width: '100%',
              }}
            >
              {saving ? (
                <><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> {t('common.saving')}</>
              ) : (
                <><Save size={18} /> {t('common.save')}</>
              )}
            </button>
            <button
              type="button"
              onClick={() => navigate(`/dashboard/builder/course/${courseId}`)}
              disabled={saving}
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
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        @media (max-width: 900px) {
          .lesson-editor-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
};

export default LessonEditor;
