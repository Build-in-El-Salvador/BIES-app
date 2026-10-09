import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft, ChevronUp, ChevronDown, Pencil, Trash2, Plus, Send, Loader2,
  CheckCircle, Video, FileText, HelpCircle, BookOpen, AlertCircle, X,
} from 'lucide-react';
import { coursesApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { nostrService } from '../../services/nostrService';
import { nostrSigner } from '../../services/nostrSigner';

const STATUS_CFG = {
  'draft': { tKey: 'courses.status.draft', color: 'var(--badge-draft-text)', bg: 'var(--badge-draft-bg)' },
  'pending-review': { tKey: 'courses.status.pendingReview', color: 'var(--badge-warning-text)', bg: 'var(--badge-warning-bg)' },
  'active': { tKey: 'courses.status.active', color: 'var(--badge-success-text)', bg: 'var(--badge-success-bg)' },
  'rejected': { tKey: 'courses.status.rejected', color: 'var(--badge-error-text)', bg: 'var(--badge-error-bg)' },
};

const TYPE_CFG = {
  VIDEO: { tKey: 'courses.types.video', Icon: Video },
  TEXT: { tKey: 'courses.types.text', Icon: FileText },
  QUIZ: { tKey: 'courses.types.quiz', Icon: HelpCircle },
};

const StatusChip = ({ status }) => {
  const { t } = useTranslation();
  const cfg = STATUS_CFG[status] || STATUS_CFG.draft;
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 99,
      fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase',
      color: cfg.color, background: cfg.bg, whiteSpace: 'nowrap',
    }}>
      {t(cfg.tKey)}
    </span>
  );
};

const CourseBuilder = () => {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, isStaff } = useAuth();

  const [course, setCourse] = useState(null);
  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [showTypePicker, setShowTypePicker] = useState(false);

  const fetchCourse = useCallback(async () => {
    try {
      const result = await coursesApi.get(id);
      const data = result?.data || result;
      setCourse(data);
      setLessons([...(data.lessons || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
      setError('');
    } catch (err) {
      setError(err.message || t('courses.notFound'));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => { fetchCourse(); }, [fetchCourse]);

  // Guard: only the author or staff may manage the course
  useEffect(() => {
    if (loading || !course) return;
    const isAuthor = user?.id && course.author?.id && user.id === course.author.id;
    if (!isAuthor && !isStaff) {
      navigate('/dashboard/courses', { replace: true });
    }
  }, [loading, course, user, isStaff, navigate]);

  // Nostr-native authors mirror client-side once the course is approved
  // (custodial authors are mirrored by the server on approval). Best-effort:
  // publish each non-quiz lesson (30023 free / 30402 paid teaser) then the
  // kind-30004 curation set, and report ids back so zap matching works.
  const mirroredRef = useRef(false);
  useEffect(() => {
    if (loading || !course || mirroredRef.current) return;
    const isAuthor = user?.id && course.author?.id && user.id === course.author.id;
    if (!isAuthor || course.status !== 'active' || course.nostrEventId) return;
    if (!nostrSigner.signsOnDevice || course.nostrPublish === 'none') return;
    mirroredRef.current = true;

    (async () => {
      try {
        const target = course.nostrPublish || 'bies';
        const ordered = [...(course.lessons || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const lessonRefs = [];
        for (const meta of ordered) {
          if (meta.type === 'QUIZ') continue;
          // Author fetch returns full content (needed for free 30023 bodies)
          const full = await coursesApi.getLesson(course.id, meta.id);
          const eventId = await nostrService.publishCourseLesson(course, full, target);
          if (eventId) lessonRefs.push({ lessonId: meta.id, eventId });
        }
        const courseEventId = await nostrService.publishCourse(course, ordered, target);
        if (courseEventId || lessonRefs.length > 0) {
          await coursesApi.setNostrRefs(course.id, {
            ...(courseEventId ? { courseEventId } : {}),
            ...(lessonRefs.length > 0 ? { lessons: lessonRefs } : {}),
          });
        }
      } catch (err) {
        console.warn('[Courses] Client Nostr mirror failed:', err?.message || err);
      }
    })();
  }, [loading, course, user]);

  const handleSubmitForReview = async () => {
    setSubmitting(true);
    setActionError('');
    try {
      await coursesApi.submit(id);
      setSubmitted(true);
      window.scrollTo(0, 0);
    } catch (err) {
      setActionError(err.message || t('dashboard.failedToSubmitProject'));
    } finally {
      setSubmitting(false);
    }
  };

  const moveLesson = async (index, dir) => {
    const target = index + dir;
    if (reordering || target < 0 || target >= lessons.length) return;
    const prev = lessons;
    const next = [...lessons];
    [next[index], next[target]] = [next[target], next[index]];
    setLessons(next); // optimistic
    setReordering(true);
    setActionError('');
    try {
      await coursesApi.reorderLessons(id, next.map(l => l.id));
    } catch (err) {
      setLessons(prev); // revert
      setActionError(err.message || 'Reorder failed');
    } finally {
      setReordering(false);
    }
  };

  const handleDeleteLesson = async (lessonId) => {
    if (!window.confirm(t('courses.builder.deleteLessonConfirm'))) return;
    setDeletingId(lessonId);
    setActionError('');
    try {
      await coursesApi.deleteLesson(id, lessonId);
      await fetchCourse();
    } catch (err) {
      setActionError(err.message || 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  };

  const pickType = (type) => {
    setShowTypePicker(false);
    navigate(`/dashboard/builder/course/${id}/lesson/new?type=${type}`);
  };

  const formatDuration = (sec) => {
    if (!sec || sec <= 0) return null;
    return `${Math.max(1, Math.round(sec / 60))}m`;
  };

  // ─── Submitted confirmation screen ─────────────────────────────────────────
  if (submitted) {
    return (
      <div style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center', paddingTop: '4rem', paddingBottom: '4rem' }}>
        <CheckCircle size={52} style={{ color: 'var(--color-success, #16a34a)', marginBottom: '1rem' }} />
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--color-gray-800)' }}>
          {t('courses.builder.submittedTitle')}
        </h1>
        <p style={{ color: 'var(--color-gray-600)', lineHeight: 1.6, marginBottom: '2rem' }}>
          {t('courses.builder.submittedBody')}
        </p>
        <Link to="/dashboard/courses" className="btn btn-primary" style={{ textDecoration: 'none' }}>
          {t('dashboard.myCourses')}
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  if (error || !course) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem' }}>
        <h2 style={{ color: 'var(--color-gray-700)' }}>{t('courses.notFound')}</h2>
        {error && <p style={{ color: 'var(--color-gray-500)', margin: '0.5rem 0 1.5rem' }}>{error}</p>}
        <Link to="/dashboard/courses" className="btn btn-primary" style={{ textDecoration: 'none' }}>
          {t('dashboard.myCourses')}
        </Link>
      </div>
    );
  }

  const status = course.status || 'draft';
  const canSubmit = status === 'draft' || status === 'rejected';

  return (
    <div>
      {/* Header */}
      <div className="cb-header">
        <button onClick={() => navigate('/dashboard/courses')} className="cb-back-btn">
          <ChevronLeft size={16} /> {t('dashboard.back')}
        </button>
        <div className="cb-header-main">
          <div className="cb-title-row">
            <h1 className="cb-title">{course.title}</h1>
            <StatusChip status={status} />
          </div>
          <Link to={`/dashboard/builder/new-course?edit=${id}`} className="cb-edit-details">
            <Pencil size={13} /> {t('courses.builder.editDetails')}
          </Link>
        </div>
        {canSubmit && (
          <button
            className="cb-submit-btn"
            onClick={handleSubmitForReview}
            disabled={submitting}
          >
            {submitting
              ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
              : <Send size={16} />}
            {t('courses.builder.submitForReview')}
          </button>
        )}
      </div>

      {/* Status banners */}
      {status === 'pending-review' && (
        <div className="cb-banner cb-banner-warning">
          <AlertCircle size={16} /> {t('courses.status.pendingReview')}
        </div>
      )}
      {status === 'active' && (
        <div className="cb-banner cb-banner-muted">
          <AlertCircle size={16} /> {t('courses.builder.resubmitHint')}
        </div>
      )}
      {status === 'rejected' && (
        <div className="cb-banner cb-banner-error">
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>{t('courses.status.rejected')}</strong>
            {course.reviewNote && (
              <div style={{ marginTop: 4, fontWeight: 400 }}>
                {t('courses.builder.reviewNote')}: {course.reviewNote}
              </div>
            )}
          </div>
        </div>
      )}
      {actionError && (
        <div className="cb-banner cb-banner-error">
          <AlertCircle size={16} /> {actionError}
        </div>
      )}

      {/* Lessons card */}
      <div className="cb-card">
        <div className="cb-card-header">
          <h3 className="cb-card-heading">
            <BookOpen size={16} /> {t('dashboard.lessons')}
            <span className="cb-count">{lessons.length}</span>
          </h3>
          <div style={{ position: 'relative' }}>
            <button className="cb-add-btn" onClick={() => setShowTypePicker(v => !v)}>
              {showTypePicker ? <X size={15} /> : <Plus size={15} />} {t('courses.builder.addLesson')}
            </button>
            {showTypePicker && (
              <div className="cb-type-picker">
                {Object.entries(TYPE_CFG).map(([type, cfg]) => {
                  const { Icon } = cfg;
                  return (
                    <button key={type} className="cb-type-option" onClick={() => pickType(type)}>
                      <Icon size={16} /> {t(cfg.tKey)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {lessons.length === 0 ? (
          <div className="cb-empty">
            <BookOpen size={40} style={{ color: 'var(--color-gray-300)', marginBottom: '0.75rem' }} />
            <p style={{ margin: 0 }}>{t('courses.builder.noLessons')}</p>
          </div>
        ) : (
          <ul className="cb-lesson-list">
            {lessons.map((lesson, idx) => {
              const typeCfg = TYPE_CFG[lesson.type] || TYPE_CFG.TEXT;
              const TypeIcon = typeCfg.Icon;
              const duration = formatDuration(lesson.durationSec);
              const busy = reordering || deletingId === lesson.id;
              return (
                <li key={lesson.id} className="cb-lesson-row" style={{ opacity: busy ? 0.55 : 1 }}>
                  <div className="cb-reorder">
                    <button
                      className="cb-icon-btn"
                      onClick={() => moveLesson(idx, -1)}
                      disabled={reordering || idx === 0}
                      title={t('courses.builder.moveUp')}
                    >
                      <ChevronUp size={16} />
                    </button>
                    <button
                      className="cb-icon-btn"
                      onClick={() => moveLesson(idx, 1)}
                      disabled={reordering || idx === lessons.length - 1}
                      title={t('courses.builder.moveDown')}
                    >
                      <ChevronDown size={16} />
                    </button>
                  </div>

                  <span className="cb-type-chip">
                    <TypeIcon size={13} /> {t(typeCfg.tKey)}
                  </span>

                  <span className="cb-lesson-title">{lesson.title}</span>

                  <div className="cb-lesson-meta">
                    {duration && <span className="cb-duration">{duration}</span>}
                    {lesson.isFreePreview && (
                      <span className="cb-preview-chip">{t('courses.freePreview')}</span>
                    )}
                  </div>

                  <div className="cb-lesson-actions">
                    <button
                      className="cb-icon-btn"
                      onClick={() => navigate(`/dashboard/builder/course/${id}/lesson/${lesson.id}`)}
                      title={t('courses.builder.editLesson')}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="cb-icon-btn cb-danger"
                      onClick={() => handleDeleteLesson(lesson.id)}
                      disabled={busy}
                      title={t('common.delete')}
                    >
                      {deletingId === lesson.id
                        ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                        : <Trash2 size={15} />}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <style jsx>{`
        .cb-header {
          display: flex;
          align-items: flex-start;
          gap: 1rem;
          margin-bottom: 1.5rem;
          flex-wrap: wrap;
        }

        .cb-back-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0.5rem 0.875rem;
          border: 1px solid var(--color-gray-200);
          border-radius: var(--radius-md);
          background: none;
          color: var(--color-gray-600);
          cursor: pointer;
          font-size: 0.875rem;
          font-weight: 500;
          flex-shrink: 0;
          white-space: nowrap;
        }

        .cb-header-main { flex: 1; min-width: 200px; }

        .cb-title-row {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          flex-wrap: wrap;
        }

        .cb-title {
          margin: 0;
          font-size: 1.4rem;
          font-weight: 700;
          color: var(--color-gray-800);
        }

        .cb-edit-details {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin-top: 0.35rem;
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--color-primary);
          text-decoration: none;
        }
        .cb-edit-details:hover { text-decoration: underline; }

        .cb-submit-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0.65rem 1.25rem;
          background: var(--color-primary);
          color: white;
          border: none;
          border-radius: var(--radius-md);
          font-weight: 700;
          font-size: 0.9rem;
          cursor: pointer;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .cb-submit-btn:disabled { background: var(--color-gray-300); cursor: not-allowed; }

        .cb-banner {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          padding: 0.875rem 1.25rem;
          border-radius: var(--radius-md);
          margin-bottom: 1.25rem;
          font-weight: 600;
          font-size: 0.9rem;
        }
        .cb-banner-warning { background: var(--badge-warning-bg); color: var(--badge-warning-text); }
        .cb-banner-error { background: var(--badge-error-bg); color: var(--badge-error-text); align-items: flex-start; }
        .cb-banner-muted { background: var(--color-gray-100); color: var(--color-gray-600); font-weight: 500; }

        .cb-card {
          background: var(--color-surface);
          border: 1px solid var(--color-gray-200);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-sm);
          overflow: visible;
        }

        .cb-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1rem 1.25rem;
          border-bottom: 1px solid var(--color-gray-200);
          gap: 0.75rem;
        }

        .cb-card-heading {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin: 0;
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--color-gray-700);
        }

        .cb-count {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 22px;
          height: 22px;
          padding: 0 6px;
          border-radius: 99px;
          font-size: 0.72rem;
          font-weight: 700;
          background: var(--color-gray-100);
          color: var(--color-gray-600);
        }

        .cb-add-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0.5rem 1rem;
          background: var(--color-primary);
          color: white;
          border: none;
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: 0.85rem;
          cursor: pointer;
          white-space: nowrap;
        }

        .cb-type-picker {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          min-width: 170px;
          background: var(--color-surface);
          border: 1px solid var(--color-gray-200);
          border-radius: 10px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.06);
          padding: 4px 0;
          z-index: 50;
        }

        .cb-type-option {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          width: 100%;
          padding: 0.55rem 0.9rem;
          font-size: 0.85rem;
          font-weight: 500;
          color: var(--color-gray-600);
          background: none;
          border: none;
          cursor: pointer;
          text-align: left;
          white-space: nowrap;
        }
        .cb-type-option:hover { background: var(--color-gray-100); }

        .cb-empty {
          padding: 3rem 2rem;
          text-align: center;
          color: var(--color-gray-500);
          font-size: 0.95rem;
        }

        .cb-lesson-list { list-style: none; margin: 0; padding: 0; }

        .cb-lesson-row {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.75rem 1.25rem;
          border-bottom: 1px solid var(--color-gray-100);
          transition: opacity 0.15s;
        }
        .cb-lesson-row:last-child { border-bottom: none; }

        .cb-reorder { display: flex; flex-direction: column; gap: 2px; flex-shrink: 0; }

        .cb-icon-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: 6px;
          border: 1px solid transparent;
          background: none;
          color: var(--color-gray-500);
          cursor: pointer;
          transition: all 0.12s;
          padding: 0;
        }
        .cb-icon-btn:hover:not(:disabled) {
          background: var(--color-gray-100);
          border-color: var(--color-gray-200);
          color: var(--color-gray-700);
        }
        .cb-icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .cb-danger:hover:not(:disabled) { color: #ef4444; background: var(--color-red-tint); }

        .cb-type-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 8px;
          border-radius: 99px;
          font-size: 0.72rem;
          font-weight: 700;
          background: var(--color-blue-tint);
          color: var(--color-primary);
          flex-shrink: 0;
          white-space: nowrap;
        }

        .cb-lesson-title {
          flex: 1;
          min-width: 0;
          font-size: 0.92rem;
          font-weight: 600;
          color: var(--color-gray-800);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .cb-lesson-meta {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-shrink: 0;
        }

        .cb-duration {
          font-size: 0.8rem;
          color: var(--color-gray-500);
          white-space: nowrap;
        }

        .cb-preview-chip {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 99px;
          font-size: 0.7rem;
          font-weight: 700;
          background: var(--badge-success-bg);
          color: var(--badge-success-text);
          white-space: nowrap;
        }

        .cb-lesson-actions { display: flex; gap: 4px; flex-shrink: 0; }

        @media (max-width: 640px) {
          .cb-lesson-row { flex-wrap: wrap; }
          .cb-lesson-title { flex-basis: 100%; order: -1; margin-left: 0; }
        }
      `}</style>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

export default CourseBuilder;
