import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    BookOpen, Play, FileText, ListChecks, CheckCircle, Lock,
    Loader2, Users, Award, Settings,
} from 'lucide-react';
import { coursesApi } from '../../services/api';
import { getAssetUrl } from '../../utils/assets';
import { useAuth } from '../../context/AuthContext';
import MarkdownView from '../../components/courses/MarkdownView';
import CertificateCard from '../../components/courses/CertificateCard';
import CourseUnlockModal from '../../components/courses/CourseUnlockModal';
import BackButton from '../../components/BackButton';

const titleCase = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '');

const LESSON_TYPE_ICONS = {
    VIDEO: Play,
    TEXT: FileText,
    QUIZ: ListChecks,
};

const formatDuration = (durationSec) => {
    if (!durationSec) return null;
    return `${Math.max(1, Math.round(durationSec / 60))}m`;
};

const CourseDetail = () => {
    const { id } = useParams();
    const { t } = useTranslation();
    const { user } = useAuth();

    const [course, setCourse] = useState(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [enrolling, setEnrolling] = useState(false);
    const [enrollError, setEnrollError] = useState(null);
    const [justEnrolled, setJustEnrolled] = useState(false);
    const [unlockInfo, setUnlockInfo] = useState(null); // purchaseStatus payload while modal open
    const [unlockLoading, setUnlockLoading] = useState(false);

    const fetchCourse = useCallback(async () => {
        try {
            const result = await coursesApi.get(id);
            setCourse(result);
            setNotFound(false);
        } catch (err) {
            if (err?.status === 404) setNotFound(true);
            else setCourse(null);
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        setLoading(true);
        setJustEnrolled(false);
        fetchCourse();
    }, [fetchCourse]);

    const handleEnroll = async () => {
        setEnrolling(true);
        setEnrollError(null);
        try {
            await coursesApi.enroll(id);
            setJustEnrolled(true);
            await fetchCourse();
        } catch (err) {
            setEnrollError(err?.data?.error || err?.message || 'Error');
        } finally {
            setEnrolling(false);
        }
    };

    const openUnlock = async () => {
        setUnlockLoading(true);
        setEnrollError(null);
        try {
            const info = await coursesApi.purchaseStatus(id);
            if (info?.purchased) {
                // Already paid (e.g. auto-claimed) — enroll and refresh
                await coursesApi.enroll(id).catch(() => {});
                await fetchCourse();
            } else {
                setUnlockInfo(info);
            }
        } catch (err) {
            setEnrollError(err?.data?.error || err?.message || 'Error');
        } finally {
            setUnlockLoading(false);
        }
    };

    const handleUnlocked = async () => {
        await coursesApi.enroll(id).catch(() => {});
        await fetchCourse();
    };

    if (loading) {
        return (
            <div className="course-detail-page">
                <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                </div>
                <style jsx>{`
                    @keyframes spin { to { transform: rotate(360deg); } }
                `}</style>
            </div>
        );
    }

    if (notFound || !course) {
        return (
            <div className="course-detail-page">
                <div className="container" style={{ textAlign: 'center', padding: '4rem 1rem' }}>
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

    const isOwner = !!user?.id && user.id === course.author?.id;
    const isPaid = (course.priceSats || 0) > 0;
    const enrolled = !!course.enrolled;
    const purchased = !!course.purchased;
    const completedIds = course.myEnrollment?.completedLessonIds || [];
    const lessons = [...(course.lessons || [])].sort((a, b) => a.position - b.position);
    const lessonCount = course.lessonCount ?? lessons.length;
    const isCompleted = !!course.myEnrollment?.completedAt;

    const isLessonLocked = (lesson) =>
        isPaid && !purchased && !lesson.isFreePreview && !isOwner;
    const isLessonAccessible = (lesson) =>
        !isLessonLocked(lesson) && (isOwner || enrolled || purchased || lesson.isFreePreview);

    const firstIncomplete = lessons.find((l) => !completedIds.includes(l.id)) || lessons[0];
    const progressPct = lessonCount > 0
        ? Math.round((completedIds.length / lessonCount) * 100)
        : 0;

    const renderCta = () => {
        // Authors manage their course from the builder — no learner CTA.
        if (isOwner) return null;

        if (isCompleted) {
            return (
                <div className="cta-block">
                    <div className="complete-banner">
                        <Award size={18} />
                        {t('dashboard.courseComplete')}
                    </div>
                    <CertificateCard
                        courseTitle={course.title}
                        coverImage={course.coverImage}
                        issuedAt={course.myEnrollment.completedAt}
                        certificateEventId={course.myEnrollment.certificateEventId}
                    />
                </div>
            );
        }

        if (enrolled) {
            return (
                <div className="cta-block">
                    <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                    </div>
                    <p className="progress-text">
                        {t('dashboard.lessonsComplete', { completed: completedIds.length, total: lessonCount })}
                    </p>
                    {justEnrolled && <p className="enroll-success">{t('courses.enrollSuccess')}</p>}
                    {firstIncomplete && (
                        <Link to={`/courses/${course.id}/lesson/${firstIncomplete.id}`} className="cta-btn">
                            <Play size={16} /> {t('courses.continueCourse')}
                        </Link>
                    )}
                </div>
            );
        }

        if (isPaid && !purchased) {
            const hasLightning = !!course.author?.profile?.lightningAddress;
            return (
                <div className="cta-block">
                    <button
                        className="cta-btn"
                        onClick={openUnlock}
                        disabled={unlockLoading || !hasLightning}
                        title={hasLightning ? t('courses.unlock.body') : t('courses.unlock.noLightning')}
                    >
                        {unlockLoading
                            ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                            : <>⚡ {t('courses.unlockFor', { n: course.priceSats })}</>}
                    </button>
                    <p className="unlock-hint">
                        {hasLightning ? t('courses.unlock.body') : t('courses.unlock.noLightning')}
                    </p>
                    {enrollError && <p className="enroll-error">{enrollError}</p>}
                </div>
            );
        }

        // Free course, not enrolled
        if (!user) {
            return (
                <div className="cta-block">
                    <Link to="/login" className="cta-btn">
                        {t('dashboard.enrollNow')}
                    </Link>
                </div>
            );
        }
        return (
            <div className="cta-block">
                <button className="cta-btn" onClick={handleEnroll} disabled={enrolling}>
                    {enrolling
                        ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                        : t('dashboard.enrollNow')}
                </button>
                {enrollError && <p className="enroll-error">{enrollError}</p>}
            </div>
        );
    };

    return (
        <div className="course-detail-page">
            <div className="container">
                {/* Cover header */}
                <div className="hero-image">
                    {course.coverImage ? (
                        <img src={getAssetUrl(course.coverImage)} alt={course.title} />
                    ) : (
                        <div className="hero-fallback">
                            <BookOpen size={48} />
                        </div>
                    )}
                    <BackButton to="/courses" overlay />
                </div>

                <div className="detail-grid">
                    <div className="main-content">
                        <div className="title-row">
                            <h1>{course.title}</h1>
                            <span className={`price-badge ${isPaid ? 'paid' : 'free'}`}>
                                {isPaid
                                    ? `⚡ ${t('courses.priceSats', { n: course.priceSats })}`
                                    : t('courses.free')}
                            </span>
                        </div>
                        <div className="meta-chips">
                            {course.category && <span className="meta-chip">{titleCase(course.category)}</span>}
                            {course.level && <span className="meta-chip level">{titleCase(course.level)}</span>}
                            <span className="meta-plain">
                                {t('courses.lessonsCount', { n: lessonCount })}
                                {' · '}
                                {t('courses.studentsCount', { n: course.studentCount ?? 0 })}
                            </span>
                        </div>

                        {isOwner && (
                            <Link to={`/dashboard/builder/course/${course.id}`} className="builder-link">
                                <Settings size={15} /> {t('courses.builder.title')}
                            </Link>
                        )}

                        {renderCta()}

                        {/* About */}
                        {course.description && (
                            <section className="section-card">
                                <h2>{t('courses.aboutCourse')}</h2>
                                <MarkdownView markdown={course.description} />
                            </section>
                        )}

                        {/* Curriculum */}
                        <section className="section-card">
                            <h2>{t('courses.curriculum')}</h2>
                            <ol className="lesson-list">
                                {lessons.map((lesson) => {
                                    const TypeIcon = LESSON_TYPE_ICONS[lesson.type] || FileText;
                                    const locked = isLessonLocked(lesson);
                                    const accessible = isLessonAccessible(lesson);
                                    const done = completedIds.includes(lesson.id);
                                    const duration = formatDuration(lesson.durationSec);
                                    const rowInner = (
                                        <>
                                            <span className="lesson-type-icon">
                                                <TypeIcon size={16} />
                                            </span>
                                            <span className="lesson-title">{lesson.title}</span>
                                            {lesson.isFreePreview && (
                                                <span className="preview-chip">{t('courses.freePreview')}</span>
                                            )}
                                            {duration && <span className="lesson-duration">{duration}</span>}
                                            <span className="lesson-state">
                                                {done ? (
                                                    <CheckCircle size={17} className="state-done" />
                                                ) : locked ? (
                                                    <Lock size={15} className="state-locked" />
                                                ) : null}
                                            </span>
                                        </>
                                    );
                                    return (
                                        <li key={lesson.id}>
                                            {accessible ? (
                                                <Link
                                                    to={`/courses/${course.id}/lesson/${lesson.id}`}
                                                    className="lesson-row clickable"
                                                >
                                                    {rowInner}
                                                </Link>
                                            ) : (
                                                <div className="lesson-row">{rowInner}</div>
                                            )}
                                        </li>
                                    );
                                })}
                            </ol>
                        </section>
                    </div>

                    <div className="detail-sidebar">
                        {/* Instructor card */}
                        <div className="info-card">
                            <h3>{t('courses.instructor')}</h3>
                            <div className="instructor-row">
                                <div className="instructor-avatar">
                                    {course.author?.profile?.avatar ? (
                                        <img src={getAssetUrl(course.author.profile.avatar)} alt="" />
                                    ) : (
                                        <span>{(course.author?.profile?.name || '?').charAt(0)}</span>
                                    )}
                                </div>
                                <div className="instructor-name">
                                    {course.author?.profile?.name || ''}
                                </div>
                            </div>
                            <div className="info-row">
                                <Users size={16} />
                                <span>{t('courses.studentsCount', { n: course.studentCount ?? 0 })}</span>
                            </div>
                            <div className="info-row">
                                <BookOpen size={16} />
                                <span>{t('courses.lessonsCount', { n: lessonCount })}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {unlockInfo && (
                <CourseUnlockModal
                    course={course}
                    purchaseInfo={unlockInfo}
                    instructorName={course.author?.profile?.name}
                    instructorAvatar={course.author?.profile?.avatar ? getAssetUrl(course.author.profile.avatar) : undefined}
                    onClose={() => setUnlockInfo(null)}
                    onUnlocked={handleUnlocked}
                />
            )}

            <style jsx>{`
                .course-detail-page {
                    background: var(--color-gray-50);
                    min-height: 100vh;
                    padding-bottom: 4rem;
                }
                .container {
                    max-width: 1100px;
                    margin: 0 auto;
                    padding: 2rem 1rem 0;
                }

                .hero-image {
                    width: 100%;
                    height: 320px;
                    border-radius: 16px;
                    overflow: hidden;
                    position: relative;
                    margin-bottom: 1.75rem;
                    background: linear-gradient(135deg, #0052cc 0%, #0a192f 100%);
                }
                .hero-image img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    position: absolute;
                    inset: 0;
                }
                .hero-fallback {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: rgba(255, 255, 255, 0.7);
                }

                .detail-grid {
                    display: grid;
                    grid-template-columns: 1fr 320px;
                    gap: 2rem;
                    align-items: start;
                }

                .title-row {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 1rem;
                    flex-wrap: wrap;
                }
                .title-row h1 {
                    font-size: 1.85rem;
                    font-weight: 800;
                    margin: 0;
                    color: var(--color-gray-900);
                }
                .price-badge {
                    padding: 0.35rem 0.9rem;
                    border-radius: 9999px;
                    font-size: 0.85rem;
                    font-weight: 700;
                    white-space: nowrap;
                    flex-shrink: 0;
                }
                .price-badge.free {
                    background: var(--color-green-tint, rgba(16, 185, 129, 0.12));
                    color: var(--color-success, #10b981);
                }
                .price-badge.paid {
                    background: rgba(249, 115, 22, 0.12);
                    color: #ea580c;
                }

                .meta-chips {
                    display: flex;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                    margin-top: 0.75rem;
                }
                .meta-chip {
                    padding: 0.25rem 0.75rem;
                    border-radius: 9999px;
                    background: var(--color-gray-200);
                    color: var(--color-gray-600);
                    font-size: 0.75rem;
                    font-weight: 600;
                }
                .meta-chip.level {
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                }
                .meta-plain {
                    font-size: 0.85rem;
                    color: var(--color-gray-500);
                }

                .builder-link {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    margin-top: 1rem;
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-primary);
                    text-decoration: none;
                }
                .builder-link:hover { text-decoration: underline; }

                .cta-block {
                    margin-top: 1.25rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.6rem;
                    max-width: 420px;
                }
                .cta-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    width: 100%;
                    padding: 0.85rem 1.25rem;
                    background: var(--color-primary);
                    color: white;
                    border: none;
                    border-radius: 10px;
                    font-size: 0.95rem;
                    font-weight: 700;
                    cursor: pointer;
                    text-decoration: none;
                    transition: all 0.2s;
                    box-sizing: border-box;
                }
                .cta-btn:hover:not(:disabled) { opacity: 0.9; }
                .cta-btn:disabled { opacity: 0.55; cursor: not-allowed; }

                .unlock-hint {
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                    margin: 0;
                }
                .enroll-error {
                    font-size: 0.8rem;
                    color: var(--color-error, #ef4444);
                    margin: 0;
                }
                .enroll-success {
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-success, #10b981);
                    margin: 0;
                }

                .complete-banner {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.75rem 1rem;
                    border-radius: 10px;
                    background: var(--color-green-tint, rgba(16, 185, 129, 0.12));
                    color: var(--color-success, #10b981);
                    font-size: 0.9rem;
                    font-weight: 700;
                }

                .progress-track {
                    width: 100%;
                    height: 8px;
                    border-radius: 9999px;
                    background: var(--color-gray-200);
                    overflow: hidden;
                }
                .progress-fill {
                    height: 100%;
                    border-radius: 9999px;
                    background: var(--color-primary);
                    transition: width 0.3s ease;
                }
                .progress-text {
                    font-size: 0.85rem;
                    color: var(--color-gray-600);
                    margin: 0;
                }

                .section-card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 16px;
                    padding: 1.75rem;
                    margin-top: 1.75rem;
                    box-shadow: var(--shadow-sm);
                }
                .section-card h2 {
                    font-size: 1.2rem;
                    font-weight: 700;
                    margin: 0 0 1rem;
                    color: var(--color-gray-900);
                }

                .lesson-list {
                    list-style: none;
                    margin: 0;
                    padding: 0;
                    display: flex;
                    flex-direction: column;
                }
                .lesson-list li + li .lesson-row {
                    border-top: 1px solid var(--color-gray-100);
                }
                .lesson-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0.8rem 0.5rem;
                    color: inherit;
                    text-decoration: none;
                    border-radius: 8px;
                }
                .lesson-row.clickable {
                    cursor: pointer;
                    transition: background 0.15s;
                }
                .lesson-row.clickable:hover {
                    background: var(--color-gray-50);
                }
                .lesson-type-icon {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 32px;
                    height: 32px;
                    border-radius: 8px;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    flex-shrink: 0;
                }
                .lesson-title {
                    flex: 1;
                    min-width: 0;
                    font-size: 0.92rem;
                    font-weight: 600;
                    color: var(--color-gray-800);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .preview-chip {
                    padding: 0.12rem 0.55rem;
                    border-radius: 9999px;
                    background: var(--color-green-tint, rgba(16, 185, 129, 0.12));
                    color: var(--color-success, #10b981);
                    font-size: 0.68rem;
                    font-weight: 700;
                    flex-shrink: 0;
                    white-space: nowrap;
                }
                .lesson-duration {
                    font-size: 0.78rem;
                    color: var(--color-gray-400);
                    flex-shrink: 0;
                }
                .lesson-state {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 20px;
                    flex-shrink: 0;
                }
                .lesson-state :global(.state-done) {
                    color: var(--color-success, #10b981);
                }
                .lesson-state :global(.state-locked) {
                    color: var(--color-gray-400);
                }

                .info-card {
                    background: var(--color-surface);
                    border-radius: var(--radius-xl);
                    padding: 1.5rem;
                    box-shadow: var(--shadow-md);
                    border: 1px solid var(--color-gray-200);
                }
                .info-card h3 {
                    font-size: 1rem;
                    font-weight: 700;
                    margin: 0 0 1rem;
                    color: var(--color-gray-900);
                }
                .instructor-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    margin-bottom: 1.25rem;
                }
                .instructor-avatar {
                    width: 44px;
                    height: 44px;
                    border-radius: 50%;
                    overflow: hidden;
                    background: var(--color-gray-200);
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 700;
                    font-size: 1rem;
                    color: var(--color-gray-500);
                }
                .instructor-avatar img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }
                .instructor-name {
                    font-weight: 700;
                    font-size: 0.95rem;
                    color: var(--color-gray-900);
                }
                .info-row {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    margin-bottom: 0.65rem;
                    font-size: 0.85rem;
                    color: var(--color-gray-600);
                }
                .info-row:last-child { margin-bottom: 0; }

                @keyframes spin { to { transform: rotate(360deg); } }

                @media (max-width: 768px) {
                    .hero-image { height: 200px; }
                    .detail-grid { grid-template-columns: 1fr; }
                    .title-row h1 { font-size: 1.4rem; }
                }
            `}</style>
        </div>
    );
};

export default CourseDetail;
