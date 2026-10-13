import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    Play, FileText, ListChecks, CheckCircle, Lock, Loader2,
    ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Award, X,
} from 'lucide-react';
import { coursesApi } from '../../services/api';
import MarkdownView from '../../components/courses/MarkdownView';
import VideoEmbed from '../../components/courses/VideoEmbed';
import QuizRunner from '../../components/courses/QuizRunner';
import CertificateCard from '../../components/courses/CertificateCard';
import BackButton from '../../components/BackButton';

const LESSON_TYPE_ICONS = {
    VIDEO: Play,
    TEXT: FileText,
    QUIZ: ListChecks,
};

const LessonPlayer = () => {
    const { id, lessonId } = useParams();
    const { t } = useTranslation();
    const navigate = useNavigate();

    const [course, setCourse] = useState(null);
    const [lesson, setLesson] = useState(null);
    const [loading, setLoading] = useState(true);
    const [lessonLoading, setLessonLoading] = useState(true);
    const [locked, setLocked] = useState(false);
    const [error, setError] = useState(false);
    const [completedIds, setCompletedIds] = useState([]);
    const [progressInfo, setProgressInfo] = useState(null); // {completedAt, certificateEventId}
    const [completing, setCompleting] = useState(false);
    const [showOverlay, setShowOverlay] = useState(false);
    const [overlayCertId, setOverlayCertId] = useState(null);
    const [curriculumOpen, setCurriculumOpen] = useState(false);

    const refreshProgress = useCallback(async () => {
        try {
            const prog = await coursesApi.progress(id);
            setCompletedIds((prog?.lessons || []).map((l) => l.lessonId));
            setProgressInfo({
                completedAt: prog?.completedAt || null,
                certificateEventId: prog?.certificateEventId || null,
            });
        } catch {
            // Not enrolled (author preview) — no progress to show
            setCompletedIds([]);
            setProgressInfo(null);
        }
    }, [id]);

    // Course + progress on mount / course change
    useEffect(() => {
        let cancelled = false;
        const fetchCourse = async () => {
            setLoading(true);
            setError(false);
            try {
                const result = await coursesApi.get(id);
                if (!cancelled) setCourse(result);
            } catch {
                if (!cancelled) setError(true);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        fetchCourse();
        refreshProgress();
        return () => { cancelled = true; };
    }, [id, refreshProgress]);

    // Lesson content on lesson change
    useEffect(() => {
        let cancelled = false;
        const fetchLesson = async () => {
            setLessonLoading(true);
            setLocked(false);
            setLesson(null);
            try {
                const result = await coursesApi.getLesson(id, lessonId);
                if (!cancelled) setLesson(result);
            } catch (err) {
                if (cancelled) return;
                if (err?.status === 402) setLocked(true);
                else setError(true);
            } finally {
                if (!cancelled) setLessonLoading(false);
            }
        };
        fetchLesson();
        setCurriculumOpen(false);
        window.scrollTo(0, 0);
        return () => { cancelled = true; };
    }, [id, lessonId]);

    const lessons = [...(course?.lessons || [])].sort((a, b) => a.position - b.position);
    const currentIndex = lessons.findIndex((l) => l.id === lessonId);
    const prevLesson = currentIndex > 0 ? lessons[currentIndex - 1] : null;
    const nextLesson = currentIndex >= 0 && currentIndex < lessons.length - 1
        ? lessons[currentIndex + 1]
        : null;
    const isCurrentComplete = completedIds.includes(lessonId);

    const openCelebration = async (certificateEventId) => {
        let certId = certificateEventId || null;
        try {
            const prog = await coursesApi.progress(id);
            setCompletedIds((prog?.lessons || []).map((l) => l.lessonId));
            setProgressInfo({
                completedAt: prog?.completedAt || null,
                certificateEventId: prog?.certificateEventId || null,
            });
            if (!certId) certId = prog?.certificateEventId || null;
        } catch {
            // keep whatever we have
        }
        setOverlayCertId(certId);
        setShowOverlay(true);
    };

    const handleMarkComplete = async () => {
        if (completing || isCurrentComplete) return;
        setCompleting(true);
        // Optimistic tick
        setCompletedIds((prev) => (prev.includes(lessonId) ? prev : [...prev, lessonId]));
        try {
            const result = await coursesApi.completeLesson(id, lessonId);
            if (result?.justCompleted) {
                await openCelebration(result.certificateEventId);
            } else {
                refreshProgress();
            }
        } catch {
            // Revert optimistic tick
            setCompletedIds((prev) => prev.filter((lid) => lid !== lessonId));
        } finally {
            setCompleting(false);
        }
    };

    const handleQuizResult = (result) => {
        if (result?.passed) {
            setCompletedIds((prev) => (prev.includes(lessonId) ? prev : [...prev, lessonId]));
        }
        if (result?.justCompleted) {
            openCelebration(null);
        } else if (result?.passed) {
            refreshProgress();
        }
    };

    if (loading) {
        return (
            <div className="lesson-player-page">
                <div className="lp-container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                </div>
                <style jsx>{`
                    @keyframes spin { to { transform: rotate(360deg); } }
                `}</style>
            </div>
        );
    }

    if (error || !course) {
        return (
            <div className="lesson-player-page">
                <div className="lp-container" style={{ textAlign: 'center', padding: '4rem 1rem' }}>
                    <h2>{t('courses.notFound')}</h2>
                    <Link
                        to="/courses"
                        style={{
                            marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: '8px',
                            textDecoration: 'none', fontWeight: 500, color: 'var(--color-primary)',
                        }}
                    >
                        {t('courses.catalogTitle')}
                    </Link>
                </div>
            </div>
        );
    }

    const currentMeta = lessons.find((l) => l.id === lessonId);
    const TypeIcon = LESSON_TYPE_ICONS[currentMeta?.type] || FileText;

    const renderCurriculum = () => (
        <nav className="curriculum-list">
            {lessons.map((l) => {
                const Icon = LESSON_TYPE_ICONS[l.type] || FileText;
                const done = completedIds.includes(l.id);
                const current = l.id === lessonId;
                return (
                    <button
                        key={l.id}
                        className={`curriculum-row ${current ? 'current' : ''}`}
                        onClick={() => navigate(`/courses/${id}/lesson/${l.id}`)}
                    >
                        <Icon size={14} className="curr-type" />
                        <span className="curr-title">{l.title}</span>
                        {done && <CheckCircle size={15} className="curr-done" />}
                    </button>
                );
            })}
        </nav>
    );

    const renderContent = () => {
        if (lessonLoading) {
            return (
                <div className="content-loading">
                    <Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} />
                </div>
            );
        }
        if (locked) {
            return (
                <div className="locked-screen">
                    <div className="locked-icon">
                        <Lock size={32} />
                    </div>
                    <h2>{t('courses.locked')}</h2>
                    <p>{t('courses.lockedHint')}</p>
                    <Link to={`/courses/${id}`} className="locked-back-btn">
                        {t('common.back')}
                    </Link>
                </div>
            );
        }
        if (!lesson) return null;
        const content = lesson.content || {};
        if (lesson.type === 'VIDEO') {
            return <VideoEmbed url={content.videoUrl} caption={content.caption} />;
        }
        if (lesson.type === 'TEXT') {
            return <MarkdownView markdown={content.markdown} />;
        }
        if (lesson.type === 'QUIZ') {
            return (
                <QuizRunner
                    courseId={id}
                    lessonId={lessonId}
                    quiz={content}
                    onResult={handleQuizResult}
                />
            );
        }
        return null;
    };

    return (
        <div className="lesson-player-page">
            <div className="lp-container">
                {/* Header */}
                <div className="lp-header">
                    <BackButton to={`/courses/${id}`} />
                    <div className="lp-header-text">
                        <span className="lp-course-title">{course.title}</span>
                        <h1 className="lp-lesson-title">
                            <TypeIcon size={18} />
                            {currentMeta?.title || lesson?.title || ''}
                        </h1>
                    </div>
                </div>

                {/* Mobile curriculum toggle */}
                <div className="mobile-curriculum">
                    <button
                        className="mobile-curriculum-toggle"
                        onClick={() => setCurriculumOpen((o) => !o)}
                    >
                        <span>{t('courses.curriculum')}</span>
                        {curriculumOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                    {curriculumOpen && renderCurriculum()}
                </div>

                <div className="lp-grid">
                    {/* Desktop sidebar */}
                    <aside className="lp-sidebar">
                        <h3>{t('courses.curriculum')}</h3>
                        {renderCurriculum()}
                    </aside>

                    {/* Main content */}
                    <div className="lp-main">
                        <div className="lp-content">
                            {renderContent()}
                        </div>

                        {/* Footer bar */}
                        {!locked && !lessonLoading && (
                            <div className="lp-footer">
                                <button
                                    className="nav-btn"
                                    disabled={!prevLesson}
                                    onClick={() => prevLesson && navigate(`/courses/${id}/lesson/${prevLesson.id}`)}
                                >
                                    <ChevronLeft size={16} /> {t('courses.previousLesson')}
                                </button>

                                {lesson && lesson.type !== 'QUIZ' && (
                                    isCurrentComplete ? (
                                        <span className="completed-pill">
                                            <CheckCircle size={16} /> {t('courses.completedLesson')}
                                        </span>
                                    ) : (
                                        <button
                                            className="complete-btn"
                                            onClick={handleMarkComplete}
                                            disabled={completing}
                                        >
                                            {completing
                                                ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                                                : <CheckCircle size={16} />}
                                            {t('courses.markComplete')}
                                        </button>
                                    )
                                )}

                                <button
                                    className="nav-btn"
                                    disabled={!nextLesson}
                                    onClick={() => nextLesson && navigate(`/courses/${id}/lesson/${nextLesson.id}`)}
                                >
                                    {t('courses.nextLesson')} <ChevronRight size={16} />
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Course-completion celebration overlay */}
            {showOverlay && (
                <div className="celebrate-overlay">
                    <div className="celebrate-card">
                        <button
                            className="celebrate-close"
                            onClick={() => setShowOverlay(false)}
                            aria-label={t('common.back')}
                        >
                            <X size={18} />
                        </button>
                        <div className="celebrate-icon">
                            <Award size={36} />
                        </div>
                        <h2>{t('courses.certificate.earned')}</h2>
                        <CertificateCard
                            courseTitle={course.title}
                            coverImage={course.coverImage}
                            issuedAt={progressInfo?.completedAt || new Date().toISOString()}
                            certificateEventId={overlayCertId || progressInfo?.certificateEventId}
                        />
                        <p className="celebrate-sub">{t('dashboard.courseComplete')}</p>
                        <Link to={`/courses/${id}`} className="celebrate-back-btn">
                            {t('common.back')}
                        </Link>
                    </div>
                </div>
            )}

            <style jsx>{`
                .lesson-player-page {
                    background: var(--color-gray-50);
                    min-height: 100vh;
                    padding-bottom: 3rem;
                }
                .lp-container {
                    max-width: 1100px;
                    margin: 0 auto;
                    padding: 1.5rem 1rem 0;
                }

                .lp-header {
                    display: flex;
                    align-items: center;
                    gap: 0.85rem;
                    margin-bottom: 1.25rem;
                }
                .lp-header-text {
                    min-width: 0;
                }
                .lp-course-title {
                    display: block;
                    font-size: 0.78rem;
                    font-weight: 600;
                    color: var(--color-gray-500);
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .lp-lesson-title {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-size: 1.25rem;
                    font-weight: 800;
                    color: var(--color-gray-900);
                    margin: 0.15rem 0 0;
                }

                .lp-grid {
                    display: grid;
                    grid-template-columns: 280px 1fr;
                    gap: 1.5rem;
                    align-items: start;
                }

                .lp-sidebar {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 14px;
                    padding: 1rem;
                    box-shadow: var(--shadow-sm);
                    position: sticky;
                    top: 1rem;
                }
                .lp-sidebar h3 {
                    font-size: 0.9rem;
                    font-weight: 700;
                    margin: 0 0 0.75rem;
                    color: var(--color-gray-900);
                    padding: 0 0.4rem;
                }

                .curriculum-list {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }
                .curriculum-row {
                    display: flex;
                    align-items: center;
                    gap: 0.55rem;
                    width: 100%;
                    padding: 0.55rem 0.6rem;
                    border: none;
                    border-radius: 8px;
                    background: none;
                    cursor: pointer;
                    text-align: left;
                    font-size: 0.85rem;
                    color: var(--color-gray-700);
                    transition: background 0.15s;
                }
                .curriculum-row:hover {
                    background: var(--color-gray-50);
                }
                .curriculum-row.current {
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-weight: 700;
                }
                .curriculum-row :global(.curr-type) {
                    flex-shrink: 0;
                    color: var(--color-gray-400);
                }
                .curriculum-row.current :global(.curr-type) {
                    color: var(--color-primary);
                }
                .curr-title {
                    flex: 1;
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .curriculum-row :global(.curr-done) {
                    flex-shrink: 0;
                    color: var(--color-success, #10b981);
                }

                .mobile-curriculum {
                    display: none;
                    margin-bottom: 1rem;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 12px;
                    padding: 0.5rem;
                }
                .mobile-curriculum-toggle {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    width: 100%;
                    padding: 0.5rem 0.6rem;
                    background: none;
                    border: none;
                    cursor: pointer;
                    font-size: 0.9rem;
                    font-weight: 700;
                    color: var(--color-gray-800);
                }

                .lp-main {
                    min-width: 0;
                }
                .lp-content {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 16px;
                    padding: 1.5rem;
                    box-shadow: var(--shadow-sm);
                }
                .content-loading {
                    display: flex;
                    justify-content: center;
                    padding: 3rem;
                    color: var(--color-gray-500);
                }

                .locked-screen {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    text-align: center;
                    padding: 2.5rem 1rem;
                    gap: 0.5rem;
                }
                .locked-icon {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 64px;
                    height: 64px;
                    border-radius: 50%;
                    background: var(--color-gray-100);
                    color: var(--color-gray-500);
                    margin-bottom: 0.5rem;
                }
                .locked-screen h2 {
                    font-size: 1.25rem;
                    font-weight: 800;
                    margin: 0;
                    color: var(--color-gray-900);
                }
                .locked-screen p {
                    color: var(--color-gray-500);
                    font-size: 0.9rem;
                    margin: 0 0 1rem;
                }
                .locked-back-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.65rem 1.5rem;
                    border-radius: 10px;
                    background: var(--color-primary);
                    color: white;
                    font-size: 0.9rem;
                    font-weight: 600;
                    text-decoration: none;
                }

                .lp-footer {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 0.75rem;
                    margin-top: 1.25rem;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 14px;
                    padding: 0.75rem 1rem;
                    box-shadow: var(--shadow-sm);
                    flex-wrap: wrap;
                }
                .nav-btn {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    padding: 0.55rem 0.9rem;
                    border-radius: 9px;
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: var(--color-gray-700);
                    font-size: 0.82rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.15s;
                }
                .nav-btn:hover:not(:disabled) {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }
                .nav-btn:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                }
                .complete-btn {
                    display: flex;
                    align-items: center;
                    gap: 0.45rem;
                    padding: 0.6rem 1.2rem;
                    border-radius: 9px;
                    border: none;
                    background: var(--color-primary);
                    color: white;
                    font-size: 0.85rem;
                    font-weight: 700;
                    cursor: pointer;
                    transition: opacity 0.15s;
                }
                .complete-btn:hover:not(:disabled) { opacity: 0.9; }
                .complete-btn:disabled { opacity: 0.6; cursor: not-allowed; }
                .completed-pill {
                    display: flex;
                    align-items: center;
                    gap: 0.45rem;
                    padding: 0.6rem 1.2rem;
                    border-radius: 9999px;
                    background: var(--color-green-tint, rgba(16, 185, 129, 0.12));
                    color: var(--color-success, #10b981);
                    font-size: 0.85rem;
                    font-weight: 700;
                }

                .celebrate-overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.6);
                    z-index: 300;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 1rem;
                    animation: fadeIn 0.2s ease-out;
                }
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                .celebrate-card {
                    position: relative;
                    width: 100%;
                    max-width: 440px;
                    max-height: 85vh;
                    overflow-y: auto;
                    background: var(--color-surface);
                    border-radius: 18px;
                    border: 1px solid var(--color-gray-200);
                    box-shadow: var(--shadow-lg);
                    padding: 2rem 1.5rem 1.5rem;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 1rem;
                    text-align: center;
                }
                .celebrate-close {
                    position: absolute;
                    top: 0.85rem;
                    right: 0.85rem;
                    background: none;
                    border: none;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    padding: 4px;
                    border-radius: 6px;
                }
                .celebrate-close:hover {
                    background: var(--color-gray-100);
                }
                .celebrate-icon {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 72px;
                    height: 72px;
                    border-radius: 50%;
                    background: var(--color-green-tint, rgba(16, 185, 129, 0.12));
                    color: var(--color-success, #10b981);
                }
                .celebrate-card h2 {
                    font-size: 1.3rem;
                    font-weight: 800;
                    margin: 0;
                    color: var(--color-gray-900);
                }
                .celebrate-sub {
                    font-size: 0.88rem;
                    color: var(--color-gray-600);
                    margin: 0;
                }
                .celebrate-back-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    width: 100%;
                    padding: 0.8rem 1.25rem;
                    border-radius: 10px;
                    background: var(--color-primary);
                    color: white;
                    font-size: 0.9rem;
                    font-weight: 700;
                    text-decoration: none;
                    box-sizing: border-box;
                }

                @keyframes spin { to { transform: rotate(360deg); } }

                @media (max-width: 768px) {
                    .lesson-player-page {
                        padding-bottom: calc(90px + env(safe-area-inset-bottom));
                    }
                    .lp-grid {
                        grid-template-columns: 1fr;
                    }
                    .lp-sidebar {
                        display: none;
                    }
                    .mobile-curriculum {
                        display: block;
                    }
                    .lp-lesson-title {
                        font-size: 1.05rem;
                    }
                    .lp-content {
                        padding: 1rem;
                    }
                    .lp-footer {
                        justify-content: center;
                    }
                }
            `}</style>
        </div>
    );
};

export default LessonPlayer;
