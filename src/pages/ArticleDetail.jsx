import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Calendar, User, Loader2 } from 'lucide-react';
import DOMPurify from 'dompurify';
import { contentApi } from '../services/api';
import { useTranslation } from 'react-i18next';
import ZapButton from '../components/ZapButton';
import BackButton from '../components/BackButton';

const ArticleDetail = () => {
    const { t } = useTranslation();
    const { slug } = useParams();
    const [article, setArticle] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchArticle = async () => {
            setLoading(true);
            try {
                const result = await contentApi.article(slug);
                setArticle(result);
            } catch (err) {
                setError(err.message || 'Article not found');
            } finally {
                setLoading(false);
            }
        };
        fetchArticle();
    }, [slug]);

    const formatDate = (dateStr) => {
        if (!dateStr) return '';
        try {
            return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        } catch { return dateStr; }
    };

    if (loading) {
        return (
            <div className="article-page">
                <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                </div>
            </div>
        );
    }

    if (error || !article) {
        return (
            <div className="article-page">
                <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                    <h2>{t('articleDetail.articleNotFound')}</h2>
                    <p style={{ color: '#64748b', marginTop: '0.5rem' }}>{error || t('articleDetail.articleRemovedDesc')}</p>
                    <Link to="/news" style={{ marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: '#64748b' }}>
                        {t('articleDetail.backToNews')}
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="article-page">
            <div className="container">
                <div className="back-head">
                    <BackButton fallback="/news" label={t('articleDetail.backToNews')} />
                </div>

                {(article.image || article.coverImage) && (
                    <div className="hero-image">
                        <img src={article.image || article.coverImage} alt={article.title} />
                    </div>
                )}

                <article className="article-content">
                    {article.category && <span className="category-label">{article.category}</span>}
                    <h1>{article.title}</h1>

                    <div className="article-meta">
                        {article.author && (
                            <span className="meta-item">
                                <User size={14} /> {article.author.name || article.author}
                            </span>
                        )}
                        <span className="meta-item">
                            <Calendar size={14} /> {formatDate(article.date || article.createdAt)}
                        </span>
                        {article.author?.nostrPubkey && (
                            <ZapButton
                                recipients={[{ pubkey: article.author.nostrPubkey, name: article.author.name || article.author, avatar: '', lud16: article.author?.profile?.lightningAddress, bolt12Offer: article.author?.profile?.bolt12Offer }]}
                                size="sm"
                            />
                        )}
                    </div>

                    <div className="article-body" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(article.content || article.body || '') }} />

                    {(article.tags || []).length > 0 && (
                        <div className="article-tags">
                            {article.tags.map(tag => (
                                <span key={tag} className="tag">{tag}</span>
                            ))}
                        </div>
                    )}
                </article>
            </div>

            <style jsx>{`
                .article-page {
                    background: var(--color-gray-50);
                    min-height: 100vh;
                    padding-bottom: 4rem;
                }
                .container {
                    max-width: 800px;
                    margin: 0 auto;
                    padding: 0 1rem;
                }


                .hero-image {
                    width: 100%;
                    height: 400px;
                    border-radius: 16px;
                    overflow: hidden;
                    margin-bottom: 2rem;
                }
                .hero-image img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }

                .article-content {
                    background: white;
                    border-radius: 16px;
                    padding: 3rem;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                    border: 1px solid var(--color-gray-200);
                }

                .category-label {
                    display: inline-block;
                    font-size: 0.75rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--color-primary);
                    margin-bottom: 0.75rem;
                }

                .article-content h1 {
                    font-size: 2.25rem;
                    font-weight: 800;
                    line-height: 1.2;
                    margin-bottom: 1rem;
                    color: #0f172a;
                }

                .article-meta {
                    display: flex;
                    gap: 1.5rem;
                    margin-bottom: 2rem;
                    padding-bottom: 1.5rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }

                .meta-item {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    font-size: 0.9rem;
                    color: #64748b;
                }

                .article-body {
                    font-size: 1.05rem;
                    line-height: 1.8;
                    color: #334155;
                }
                .article-body p { margin-bottom: 1.25rem; }
                .article-body h2 { font-size: 1.5rem; margin: 2rem 0 1rem; color: #0f172a; }
                .article-body h3 { font-size: 1.25rem; margin: 1.5rem 0 0.75rem; color: #0f172a; }
                .article-body a { color: var(--color-primary); text-decoration: underline; }
                .article-body img { max-width: 100%; border-radius: 8px; margin: 1.5rem 0; }
                .article-body blockquote {
                    border-left: 3px solid var(--color-primary);
                    padding-left: 1rem;
                    margin: 1.5rem 0;
                    color: #64748b;
                    font-style: italic;
                }

                .article-tags {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                    margin-top: 2rem;
                    padding-top: 1.5rem;
                    border-top: 1px solid var(--color-gray-200);
                }

                .tag {
                    padding: 0.3rem 0.75rem;
                    background: var(--color-gray-100);
                    color: var(--color-gray-600);
                    border-radius: 99px;
                    font-size: 0.8rem;
                    font-weight: 500;
                }

                @media (max-width: 640px) {
                    .article-content { padding: 1.5rem; }
                    .article-content h1 { font-size: 1.5rem; }
                    .hero-image { height: 250px; }
                }
            `}</style>
        </div>
    );
};

export default ArticleDetail;
