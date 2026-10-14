import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, BookOpen, Loader2 } from 'lucide-react';
import { coursesApi } from '../../services/api';
import { getAssetUrl } from '../../utils/assets';

const CATEGORIES = ['BITCOIN', 'LIGHTNING', 'NOSTR', 'FINTECH', 'BUSINESS', 'TECHNOLOGY', 'OTHER'];
const LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'];
const PAGE_SIZE = 12;

// Enum values have no i18n keys by design — display them title-cased.
const titleCase = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '');

const CourseCatalog = () => {
    const { t } = useTranslation();

    const [search, setSearch] = useState('');
    const [category, setCategory] = useState('');
    const [level, setLevel] = useState('');
    const [priced, setPriced] = useState(''); // '' | 'free' | 'paid'
    const [page, setPage] = useState(1);

    const [courses, setCourses] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading, setLoading] = useState(true);

    // Fetch with the same 300ms debounce pattern as DirectoryList
    useEffect(() => {
        const fetchCourses = async () => {
            setLoading(true);
            try {
                const params = { page, limit: PAGE_SIZE };
                if (search) params.search = search;
                if (category) params.category = category;
                if (level) params.level = level;
                if (priced) params.priced = priced;
                const result = await coursesApi.list(params);
                const list = Array.isArray(result?.data) ? result.data : [];
                setCourses((prev) => (page > 1 ? [...prev, ...list] : list));
                setPagination(result?.pagination || null);
            } catch {
                if (page === 1) {
                    setCourses([]);
                    setPagination(null);
                }
            } finally {
                setLoading(false);
            }
        };
        const debounce = setTimeout(fetchCourses, page === 1 ? 300 : 0);
        return () => clearTimeout(debounce);
    }, [search, category, level, priced, page]);

    const applyFilter = (setter, value) => {
        setter(value);
        setPage(1);
    };

    const hasMore = pagination && pagination.page < pagination.totalPages;
    const initialLoading = loading && page === 1;

    return (
        <div className="courses-catalog container">
            <div className="catalog-header">
                <h1>{t('courses.catalogTitle')}</h1>
                <p>{t('courses.catalogSubtitle')}</p>
            </div>

            {/* Search */}
            <div className="catalog-search-bar">
                <Search size={20} className="catalog-search-icon" />
                <input
                    type="text"
                    className="catalog-search-input"
                    placeholder={t('courses.searchPlaceholder')}
                    value={search}
                    onChange={(e) => applyFilter(setSearch, e.target.value)}
                />
            </div>

            {/* Filter chips */}
            <div className="chip-rows">
                <div className="chip-row">
                    <button
                        className={`chip ${category === '' ? 'active' : ''}`}
                        onClick={() => applyFilter(setCategory, '')}
                    >
                        {t('courses.allCategories')}
                    </button>
                    {CATEGORIES.map((c) => (
                        <button
                            key={c}
                            className={`chip ${category === c ? 'active' : ''}`}
                            onClick={() => applyFilter(setCategory, category === c ? '' : c)}
                        >
                            {titleCase(c)}
                        </button>
                    ))}
                </div>
                <div className="chip-row">
                    <button
                        className={`chip ${level === '' ? 'active' : ''}`}
                        onClick={() => applyFilter(setLevel, '')}
                    >
                        {t('courses.allLevels')}
                    </button>
                    {LEVELS.map((l) => (
                        <button
                            key={l}
                            className={`chip ${level === l ? 'active' : ''}`}
                            onClick={() => applyFilter(setLevel, level === l ? '' : l)}
                        >
                            {titleCase(l)}
                        </button>
                    ))}
                    <span className="chip-divider" aria-hidden="true" />
                    <button
                        className={`chip ${priced === 'free' ? 'active' : ''}`}
                        onClick={() => applyFilter(setPriced, priced === 'free' ? '' : 'free')}
                    >
                        {t('courses.free')}
                    </button>
                    <button
                        className={`chip ${priced === 'paid' ? 'active' : ''}`}
                        onClick={() => applyFilter(setPriced, priced === 'paid' ? '' : 'paid')}
                    >
                        {t('courses.paid')}
                    </button>
                </div>
            </div>

            {/* Grid */}
            {initialLoading ? (
                <div className="catalog-loading">
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                </div>
            ) : courses.length > 0 ? (
                <>
                    <div className="course-grid">
                        {courses.map((course) => (
                            <Link key={course.id} to={`/courses/${course.id}`} className="course-card">
                                <div className="card-cover">
                                    {course.coverImage ? (
                                        <img src={getAssetUrl(course.coverImage)} alt={course.title} loading="lazy" />
                                    ) : (
                                        <div className="cover-fallback">
                                            <BookOpen size={36} />
                                        </div>
                                    )}
                                    <span className={`price-badge ${course.priceSats > 0 ? 'paid' : 'free'}`}>
                                        {course.priceSats > 0
                                            ? `⚡ ${t('courses.priceSats', { n: course.priceSats })}`
                                            : t('courses.free')}
                                    </span>
                                </div>
                                <div className="card-body">
                                    <h3 className="card-title">{course.title}</h3>
                                    <div className="card-author">
                                        <div className="author-avatar">
                                            {course.author?.profile?.avatar ? (
                                                <img src={getAssetUrl(course.author.profile.avatar)} alt="" />
                                            ) : (
                                                <span>{(course.author?.profile?.name || '?').charAt(0)}</span>
                                            )}
                                        </div>
                                        <span className="author-name">{course.author?.profile?.name || ''}</span>
                                        {course.level && (
                                            <span className="level-chip">{titleCase(course.level)}</span>
                                        )}
                                    </div>
                                    <div className="card-meta">
                                        {t('courses.lessonsCount', { n: course.lessonCount ?? 0 })}
                                        {' · '}
                                        {t('courses.studentsCount', { n: course.studentCount ?? 0 })}
                                    </div>
                                </div>
                            </Link>
                        ))}
                    </div>
                    {hasMore && (
                        <div className="load-more-wrap">
                            <button
                                className="load-more-btn"
                                onClick={() => setPage((p) => p + 1)}
                                disabled={loading}
                            >
                                {loading
                                    ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                                    : t('common.loadMore', 'Load more')}
                            </button>
                        </div>
                    )}
                </>
            ) : (
                <div className="catalog-empty">{t('courses.noCourses')}</div>
            )}

            <style jsx>{`
                .courses-catalog {
                    padding-top: var(--page-top, 2rem);
                    padding-bottom: 4rem;
                    max-width: 1100px;
                    margin: 0 auto;
                    box-sizing: border-box;
                }

                .catalog-header {
                    text-align: center;
                    margin-bottom: 1.5rem;
                }
                .catalog-header h1 {
                    font-size: 1.75rem;
                    font-weight: 800;
                    margin: 0 0 0.35rem;
                    color: var(--color-gray-900);
                }
                .catalog-header p {
                    color: var(--color-gray-500);
                    font-size: 0.95rem;
                    margin: 0;
                }

                .catalog-search-bar {
                    display: flex;
                    align-items: center;
                    max-width: 560px;
                    margin: 0 auto 1.25rem;
                    background: var(--color-surface-raised);
                    padding: 0.5rem;
                    border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-200);
                    box-shadow: var(--shadow-sm);
                    transition: all 0.2s;
                }
                .catalog-search-bar:focus-within {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1);
                }
                .catalog-search-icon {
                    margin-left: 0.75rem;
                    color: var(--color-gray-400);
                    flex-shrink: 0;
                }
                .catalog-search-input {
                    flex: 1;
                    min-width: 0;
                    border: none;
                    background: none;
                    padding: 0.5rem 0.75rem;
                    outline: none;
                    font-size: 1rem;
                    color: inherit;
                }

                .chip-rows {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    margin-bottom: 1.75rem;
                }
                .chip-row {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                    justify-content: center;
                    align-items: center;
                }
                .chip {
                    padding: 0.35rem 0.9rem;
                    border-radius: 9999px;
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: var(--color-gray-600);
                    font-size: 0.8rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.15s;
                    white-space: nowrap;
                }
                .chip:hover {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }
                .chip.active {
                    background: var(--color-primary);
                    border-color: var(--color-primary);
                    color: white;
                }
                .chip-divider {
                    width: 1px;
                    height: 20px;
                    background: var(--color-gray-300);
                    margin: 0 0.25rem;
                }

                .course-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
                    gap: 1.25rem;
                }

                .course-card {
                    display: flex;
                    flex-direction: column;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    overflow: hidden;
                    text-decoration: none;
                    color: inherit;
                    box-shadow: var(--shadow-sm);
                    transition: all 0.2s;
                }
                .course-card:hover {
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-md);
                    border-color: var(--color-primary);
                }

                .card-cover {
                    position: relative;
                    height: 150px;
                    background: linear-gradient(135deg, #0052cc 0%, #0a192f 100%);
                }
                .card-cover img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .cover-fallback {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: rgba(255, 255, 255, 0.7);
                }
                .price-badge {
                    position: absolute;
                    top: 0.6rem;
                    right: 0.6rem;
                    padding: 0.25rem 0.7rem;
                    border-radius: 9999px;
                    font-size: 0.75rem;
                    font-weight: 700;
                    backdrop-filter: blur(4px);
                }
                .price-badge.free {
                    background: rgba(16, 185, 129, 0.92);
                    color: white;
                }
                .price-badge.paid {
                    background: rgba(249, 115, 22, 0.92);
                    color: white;
                }

                .card-body {
                    padding: 0.9rem 1rem 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.6rem;
                    flex: 1;
                }
                .card-title {
                    font-size: 1rem;
                    font-weight: 700;
                    margin: 0;
                    color: var(--color-gray-900);
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }
                .card-author {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    min-width: 0;
                }
                .author-avatar {
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    overflow: hidden;
                    background: var(--color-gray-200);
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                    font-size: 0.7rem;
                    color: var(--color-gray-500);
                }
                .author-avatar img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }
                .author-name {
                    font-size: 0.8rem;
                    color: var(--color-gray-600);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    flex: 1;
                    min-width: 0;
                }
                .level-chip {
                    padding: 0.15rem 0.55rem;
                    border-radius: 9999px;
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 0.68rem;
                    font-weight: 700;
                    flex-shrink: 0;
                }
                .card-meta {
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                    margin-top: auto;
                }

                .load-more-wrap {
                    display: flex;
                    justify-content: center;
                    margin-top: 2rem;
                }
                .load-more-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.5rem;
                    padding: 0.6rem 1.75rem;
                    border-radius: 9999px;
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: var(--color-primary);
                    font-size: 0.9rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.15s;
                }
                .load-more-btn:hover:not(:disabled) {
                    border-color: var(--color-primary);
                    background: var(--color-blue-tint);
                }
                .load-more-btn:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }

                .catalog-loading {
                    display: flex;
                    justify-content: center;
                    padding: 3rem;
                    color: var(--color-gray-500);
                }
                .catalog-empty {
                    text-align: center;
                    padding: 3rem 1rem;
                    color: var(--color-gray-500);
                }

                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
};

export default CourseCatalog;
