import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MapPin, Users, ArrowLeft, Share2, MessageSquare, Loader2, Heart, AlertTriangle, ExternalLink, FileText, Globe, Briefcase, TrendingUp, Target, Layers, ChevronLeft, ChevronRight } from 'lucide-react';
import { projectsApi, analyticsApi, watchlistApi } from '../services/api';
import DeckRequestButton from '../components/DeckRequestButton';
import ZapButton from '../components/ZapButton';
import ZappableTag from '../components/ZappableTag';
import DOMPurify from 'dompurify';
import TranslatableText from '../components/TranslatableText';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Label } from 'recharts';
import { useAuth } from '../context/AuthContext';
import { useUserMode } from '../context/UserModeContext';
import { useLightbox } from '../context/LightboxContext';

const ProjectDetails = () => {
    const { id } = useParams();
    const { t } = useTranslation();
    const { user } = useAuth();
    const lightbox = useLightbox();
    const { mode } = useUserMode();
    const [project, setProject] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [isWatchlisted, setIsWatchlisted] = useState(false);
    const [shareTooltip, setShareTooltip] = useState(false);
    const [showInterestModal, setShowInterestModal] = useState(false);
    const [expressingInterest, setExpressingInterest] = useState(false);
    const [showSuccessAnimation, setShowSuccessAnimation] = useState(false);

    useEffect(() => {
        const fetchProject = async () => {
            try {
                const data = await projectsApi.get(id);
                setProject(data);
                analyticsApi.recordView(id).catch(() => { });
                watchlistApi.check(id).then(res => {
                    setIsWatchlisted(res?.watched || res?.isWatchlisted || false);
                }).catch(() => { });
            } catch (err) {
                setError('Project not found');
            } finally {
                setLoading(false);
            }
        };
        fetchProject();
    }, [id]);

    const handleExpressInterestClick = () => {
        if ((mode === 'investor' || user?.role === 'INVESTOR') && !isWatchlisted) {
            setShowInterestModal(true);
            setShowSuccessAnimation(false);
        } else {
            toggleWatchlist();
        }
    };

    const confirmExpressInterest = async () => {
        setExpressingInterest(true);
        try {
            await projectsApi.expressInterest(id);
            setIsWatchlisted(true);
            setShowSuccessAnimation(true);
            setTimeout(() => {
                setShowInterestModal(false);
                setShowSuccessAnimation(false);
            }, 2000);
        } catch (err) {
            alert('Failed to express interest. Please try again.');
        } finally {
            setExpressingInterest(false);
        }
    };

    const toggleWatchlist = async () => {
        try {
            if (isWatchlisted) {
                await watchlistApi.remove(id);
            } else {
                await watchlistApi.add(id);
            }
            setIsWatchlisted(!isWatchlisted);
        } catch { /* ignore */ }
    };

    const handleShare = () => {
        navigator.clipboard.writeText(window.location.href);
        setShareTooltip(true);
        setTimeout(() => setShareTooltip(false), 2000);
    };

    const formatCurrency = (val) => {
        if (!val) return '—';
        if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
        if (val >= 1000) return `$${(val / 1000).toFixed(0)}k`;
        return `$${val}`;
    };

    const stageLabel = (s) => {
        const map = { IDEA: 'Ideation', MVP: 'MVP / Prototype', GROWTH: 'Growth', SCALING: 'Scaling' };
        return map[s] || s || '—';
    };

    const categoryLabel = (c) => {
        if (!c) return '—';
        return c.split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
    };

    if (loading) {
        return (
            <div className="pd-loading">
                <Loader2 size={36} className="pd-spin" />
                <p>{t('projectDetails.loadingProject', 'Loading project...')}</p>
            </div>
        );
    }

    if (error || !project) {
        return (
            <div className="pd-error">
                <AlertTriangle size={48} />
                <p>{error || t('projectDetails.projectNotFound', 'Project not found')}</p>
                <Link to="/discover" className="pd-error-link">{t('projectDetails.backToDiscover', 'Back to Discover')}</Link>
            </div>
        );
    }

    const title = project.title || project.name || 'Untitled';
    const description = project.description || '';
    const ownerName = project.owner?.profile?.name || 'Builder';
    const ownerCompany = project.owner?.profile?.company || '';
    const ownerRole = project.ownerRole || '';
    const ownerAvatar = project.owner?.profile?.avatar || '';
    const ownerBio = project.owner?.profile?.bio || '';
    const coverImage = project.thumbnail || project.coverImage || '';
    const website = project.websiteUrl || project.website || '';
    const demoUrl = project.demoUrl || '';
    const raised = project.raisedAmount || project.raised || 0;
    const goal = project.fundingGoal || 0;
    const progressPct = goal > 0 ? Math.round((raised / goal) * 100) : 0;
    const tags = project.tags || [];
    const teamMembers = project.teamMembers || [];
    const teamInfo = project.teamInfo || [];
    const hasDeck = !!project.deckKey;
    const stage = project.stage || 'IDEA';
    const category = project.category || 'OTHER';
    const followerCount = project._count?.watchlisted || 0;
    const viewCount = project._count?.views || project.viewCount || 0;
    const customSections = project.customSections || [];
    const useOfFunds = project.useOfFunds || [];

    // Pie chart colors
    const pieColors = ['#F97316', '#0052cc', '#22c55e', '#8b5cf6', '#ef4444', '#06b6d4', '#eab308', '#ec4899', '#14b8a6', '#f59e0b'];

    return (
        <div className="pd-container">
            <Link to="/discover" className="pd-back">
                <ArrowLeft size={16} /> {t('projectDetails.backToDiscover', 'Back to Discover')}
            </Link>

            {/* ─── Header ─────────────────────────────── */}
            <header className="pd-header">
                <div className="pd-header-left">
                    <h1 className="pd-title">{title}</h1>
                    {tags.length > 0 && (
                        <p className="pd-tagline">{tags.slice(0, 3).join(' · ')}</p>
                    )}
                    <div className="pd-meta">
                        <span className="pd-meta-item"><MapPin size={15} /> El Salvador</span>
                        <Link to={`/builder/${project.ownerId || project.owner?.id}`} className="pd-meta-item pd-meta-link">
                            <Users size={15} /> {t('projectDetails.builtBy', 'Built by {{name}}', { name: ownerName })}
                        </Link>
                    </div>
                </div>
                <div className="pd-header-actions">
                    <button className="pd-btn pd-btn-outline" onClick={handleShare}>
                        <Share2 size={16} />
                        {shareTooltip ? t('projectDetails.copied', 'Copied!') : t('projectDetails.share', 'Share')}
                    </button>
                    <button className="pd-btn pd-btn-primary" onClick={() => window.open(`/messages?to=${project.ownerId || project.owner?.id}`, '_self')}>
                        <MessageSquare size={16} /> {t('projectDetails.contactFounder', 'Contact Founder')}
                    </button>
                </div>
            </header>

            {/* ─── Main Layout ────────────────────────── */}
            <div className="pd-layout">
                {/* ─── Left Column ─────────────────── */}
                <main className="pd-main">
                    {/* Cover Image */}
                    {coverImage && (
                        <div className="pd-cover" onClick={() => lightbox.open(coverImage)} style={{ cursor: 'pointer' }}>
                            <img src={coverImage} alt={title} />
                        </div>
                    )}

                    {/* About */}
                    <section className="pd-card pd-about">
                        <TranslatableText
                            title={t('projectDetails.aboutProject', 'About the Project')}
                            text={description}
                            isHtml={true}
                            className="pd-description pd-rich-text rich-text-content"
                        />
                    </section>

                    {/* Custom Sections (Left) */}
                    {customSections
                        .filter(s => s.placement === 'LEFT' || !s.placement)
                        .map((section, i) => (
                            <ProjectSection key={`left-${i}`} section={section} pieColors={pieColors} />
                        ))
                    }

                    {/* Tags */}
                    {tags.length > 0 && (
                        <section className="pd-card">
                            <h2>{t('projectDetails.tags', 'Tags')}</h2>
                            <div className="pd-tags">
                                {tags.map((tag, i) => (
                                    <ZappableTag key={i} tag={tag} mode="project" projectId={id} />
                                ))}
                            </div>
                        </section>
                    )}
                </main>

                {/* ─── Sidebar ─────────────────────── */}
                <aside className="pd-sidebar">
                    {/* Funding Status */}
                    <div className="pd-card pd-funding">
                        <h3>{t('projectDetails.fundingStatus', 'Funding Status')}</h3>
                        <div className="pd-funding-stage">
                            <span className="pd-label">{t('projectDetails.stage', 'Stage')}:</span>
                            <span className="pd-value">{stageLabel(stage)}</span>
                        </div>
                        {goal > 0 && (
                            <>
                                <div className="pd-progress-info">
                                    <span>{formatCurrency(raised)}</span>
                                    <span className="pd-muted">/ {formatCurrency(goal)}</span>
                                </div>
                                <div className="pd-progress-bar">
                                    <div className="pd-progress-fill" style={{ width: `${Math.min(progressPct, 100)}%` }} />
                                </div>
                                <p className="pd-progress-pct">{t('projectDetails.funded', '{{pct}}% funded', { pct: progressPct })}</p>
                            </>
                        )}
                        {useOfFunds.length > 0 && (
                            <div className="pd-use-of-funds">
                                <h4 className="pd-uof-title">{t('projectDetails.useOfFunds', 'Use of Funds')}</h4>
                                <div className="pd-pie-container">
                                    <svg viewBox="0 0 100 100" className="pd-pie-chart">
                                        {(() => {
                                            let cumulative = 0;
                                            return useOfFunds.map((item, i) => {
                                                const pct = parseFloat(item.percentage) || 0;
                                                const startAngle = (cumulative / 100) * 360;
                                                cumulative += pct;
                                                const endAngle = (cumulative / 100) * 360;
                                                const largeArc = pct > 50 ? 1 : 0;
                                                const startRad = ((startAngle - 90) * Math.PI) / 180;
                                                const endRad = ((endAngle - 90) * Math.PI) / 180;
                                                const x1 = 50 + 40 * Math.cos(startRad);
                                                const y1 = 50 + 40 * Math.sin(startRad);
                                                const x2 = 50 + 40 * Math.cos(endRad);
                                                const y2 = 50 + 40 * Math.sin(endRad);
                                                if (pct === 0) return null;
                                                if (pct >= 100) return <circle key={i} cx="50" cy="50" r="40" fill={pieColors[i % pieColors.length]} />;
                                                return (
                                                    <path
                                                        key={i}
                                                        d={`M 50 50 L ${x1} ${y1} A 40 40 0 ${largeArc} 1 ${x2} ${y2} Z`}
                                                        fill={pieColors[i % pieColors.length]}
                                                    />
                                                );
                                            });
                                        })()}
                                    </svg>
                                </div>
                                <div className="pd-uof-legend">
                                    {useOfFunds.map((item, i) => (
                                        <div key={i} className="pd-uof-legend-item">
                                            <span className="pd-uof-dot" style={{ background: pieColors[i % pieColors.length] }} />
                                            <span className="pd-uof-label">{item.label}</span>
                                            <span className="pd-uof-pct">{item.percentage}%</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="pd-funding-actions">
                            <DeckRequestButton projectId={id} />
                            <button
                                className={`pd-btn pd-btn-express ${isWatchlisted ? 'active' : ''}`}
                                onClick={handleExpressInterestClick}
                            >
                                <Heart size={16} fill={isWatchlisted ? 'currentColor' : 'none'} />
                                {isWatchlisted ? t('projectDetails.following', 'Following') : t('projectDetails.expressInterest', 'Express Interest')}
                            </button>
                        </div>
                    </div>

                    {/* Core Team */}
                    <div className="pd-card pd-team">
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                            <h3 style={{ margin: 0 }}>{t('projectDetails.coreTeam', 'Core Team')}</h3>
                            <ZapButton
                                recipients={[
                                    ...(project.owner?.nostrPubkey ? [{ pubkey: project.owner.nostrPubkey, name: ownerName, avatar: ownerAvatar, lud16: project.owner?.profile?.lightningAddress, bolt12Offer: project.owner?.profile?.bolt12Offer }] : []),
                                    ...teamMembers.filter(tm => tm.user?.nostrPubkey).map(tm => ({
                                        pubkey: tm.user.nostrPubkey,
                                        name: tm.user?.profile?.name || t('projectDetails.teamMember', 'Team Member'),
                                        avatar: tm.user?.profile?.avatar || '',
                                        lud16: tm.user?.profile?.lightningAddress,
                                        bolt12Offer: tm.user?.profile?.bolt12Offer,
                                    })),
                                ]}
                                label={teamMembers.filter(tm => tm.user?.nostrPubkey).length > 0 ? t('projectDetails.zapTeam', 'Zap Team') : 'Zap'}
                                size="sm"
                            />
                        </div>
                        <div className="pd-team-founder">
                            <div className="pd-avatar">
                                {ownerAvatar ? (
                                    <img src={ownerAvatar} alt={ownerName} />
                                ) : (
                                    <span>{ownerName[0]?.toUpperCase()}</span>
                                )}
                            </div>
                            <div>
                                <div className="pd-team-name">{ownerName}</div>
                                {ownerRole ? (
                                    <div className="pd-team-role">{ownerRole}</div>
                                ) : ownerCompany ? (
                                    <div className="pd-team-role">{ownerCompany}</div>
                                ) : null}
                            </div>
                        </div>

                        {teamMembers.length > 0 && (
                            <div className="pd-team-list">
                                {teamMembers.map((tm, i) => {
                                    const name = tm.user?.profile?.name || t('projectDetails.teamMember', 'Team Member');
                                    const avatar = tm.user?.profile?.avatar || '';
                                    const role = tm.title || tm.role || t('projectDetails.member', 'Member');
                                    return (
                                        <div key={i} className="pd-team-member">
                                            <div className="pd-avatar sm">
                                                {avatar ? <img src={avatar} alt={name} /> : <span>{name[0]}</span>}
                                            </div>
                                            <div>
                                                <div className="pd-team-name sm">{name}</div>
                                                <div className="pd-team-role">{role}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Manually added team members */}
                        {teamInfo.length > 0 && (
                            <div className="pd-team-list">
                                {teamInfo.map((tm, i) => (
                                    <div key={`ti-${i}`} className="pd-team-member">
                                        <div className="pd-avatar sm">
                                            {tm.avatar ? <img src={tm.avatar} alt={tm.name} /> : <span>{(tm.name || '?')[0]?.toUpperCase()}</span>}
                                        </div>
                                        <div>
                                            <div className="pd-team-name sm">{tm.name}</div>
                                            {tm.position && <div className="pd-team-role">{tm.position}</div>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Links */}
                        <div className="pd-team-links">
                            {website && (
                                <a href={website} target="_blank" rel="noopener noreferrer" className="pd-doc-link">
                                    <Globe size={16} /> {website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                                    <ExternalLink size={13} className="pd-link-ext" />
                                </a>
                            )}
                            {demoUrl && (
                                <a href={demoUrl} target="_blank" rel="noopener noreferrer" className="pd-doc-link">
                                    <ExternalLink size={16} /> {t('projectDetails.demo', 'Demo')}
                                    <ExternalLink size={13} className="pd-link-ext" />
                                </a>
                            )}
                            {hasDeck && (
                                <div className="pd-doc-link pd-doc-available">
                                    <FileText size={16} /> {t('projectDetails.pitchDeckAvailable', 'Pitch Deck Available')}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Custom Sections (Right) */}
                    {customSections
                        .filter(s => s.placement === 'RIGHT')
                        .map((section, i) => (
                            <ProjectSection key={`right-${i}`} section={section} pieColors={pieColors} isSidebar={true} />
                        ))
                    }

                    {/* Quick Info (Moved from main area) */}
                    <div className="pd-card pd-info-sidebar">
                        <h3>{t('projectDetails.projectInfo', 'Project Info')}</h3>
                        <div className="pd-info-list">
                            <div className="pd-info-row">
                                <Target size={18} className="pd-info-icon-sm" />
                                <div>
                                    <h4>{t('projectDetails.stage', 'Stage')}</h4>
                                    <p>{stageLabel(stage)}</p>
                                </div>
                            </div>
                            <div className="pd-info-row">
                                <Layers size={18} className="pd-info-icon-sm" />
                                <div>
                                    <h4>{t('projectDetails.categoryLabel', 'Category')}</h4>
                                    <p>{categoryLabel(category)}</p>
                                </div>
                            </div>
                            {goal > 0 && (
                                <div className="pd-info-row">
                                    <TrendingUp size={18} className="pd-info-icon-sm" />
                                    <div>
                                        <h4>{t('projectDetails.fundraising', 'Fundraising')}</h4>
                                        <p>{formatCurrency(raised)} / {formatCurrency(goal)}</p>
                                    </div>
                                </div>
                            )}
                            <div className="pd-info-row">
                                <Briefcase size={18} className="pd-info-icon-sm" />
                                <div>
                                    <h4>{t('projectDetails.traction', 'Traction')}</h4>
                                    <p>{viewCount} {t('projectDetails.views', 'views')} · {followerCount} {t('projectDetails.followers', 'followers')}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </aside>
            </div>

            {/* Interest Modal */}
            {showInterestModal && (
                <div className="modal-backdrop">
                    <div className="modal-content">
                        {showSuccessAnimation ? (
                            <div className="success-animation-container">
                                <svg className="checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
                                    <circle className="checkmark-circle" cx="26" cy="26" r="25" fill="none" />
                                    <path className="checkmark-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8" />
                                </svg>
                                <h3>{t('projectDetails.interestSent', 'Interest Sent!')}</h3>
                                <p>{t('projectDetails.builderNotified', 'The builder has been notified.')}</p>
                            </div>
                        ) : (
                            <>
                                <div className="modal-header">
                                    <h2 className="modal-title">{t('projectDetails.expressInterest', 'Express Interest')}</h2>
                                </div>
                                <div className="modal-body">
                                    <p style={{ margin: 0, color: 'var(--color-gray-600)', lineHeight: '1.5' }}>
                                        {t('projectDetails.expressInterestQuestion', 'Let the Builder know you are interested in their project?')}
                                        {' '}{t('projectDetails.expressInterestDesc', 'This will add the project to your Watchlist and send them a notification.')}
                                    </p>
                                </div>
                                <div className="modal-footer" style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', justifyContent: 'flex-end' }}>
                                    <button
                                        className="btn btn-outline"
                                        onClick={() => setShowInterestModal(false)}
                                        disabled={expressingInterest}
                                    >
                                        {t('common.cancel', 'Cancel')}
                                    </button>
                                    <button
                                        className="btn btn-primary"
                                        onClick={confirmExpressInterest}
                                        disabled={expressingInterest}
                                    >
                                        {expressingInterest ? <Loader2 size={16} className="spin" /> : t('projectDetails.yesExpressInterest', 'Yes, Express Interest')}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* ─── Styles ─────────────────────────────── */}
            <style>{`
                .pd-container {
                    max-width: 1200px;
                    margin: 0 auto;
                    padding: 2rem 2rem 4rem;
                }

                /* Loading & Error */
                .pd-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 6rem 2rem; color: var(--color-gray-500); gap: 1rem; }
                .pd-spin { animation: spin 1s linear infinite; }
                @keyframes spin { to { transform: rotate(360deg); } }
                .pd-error { text-align: center; padding: 6rem 2rem; color: var(--color-gray-500); }
                .pd-error svg { color: var(--color-gray-300); margin-bottom: 1rem; }
                .pd-error-link { color: var(--color-primary); margin-top: 1rem; display: inline-block; }

                /* Back Link */
                .pd-back {
                    display: inline-flex; align-items: center; gap: 0.5rem;
                    color: var(--color-gray-500); font-weight: 500; font-size: 0.9rem;
                    margin-bottom: 1.5rem; transition: color 0.15s;
                    text-decoration: none;
                }
                .pd-back:hover { color: var(--color-primary); }

                /* Header */
                .pd-header {
                    display: flex; justify-content: space-between; align-items: flex-start;
                    padding-bottom: 1.5rem; margin-bottom: 2rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }
                .pd-title {
                    font-size: 2.25rem; font-weight: 800; letter-spacing: -0.025em;
                    color: var(--color-gray-900); margin: 0 0 0.25rem;
                    line-height: 1.2;
                }
                .pd-tagline { color: var(--color-gray-500); font-size: 1rem; font-style: italic; margin: 0 0 0.75rem; }
                .pd-meta { display: flex; flex-wrap: wrap; gap: 1.25rem; color: var(--color-gray-500); font-size: 0.88rem; }
                .pd-meta-item { display: flex; align-items: center; gap: 5px; }
                .pd-meta-link { text-decoration: none; color: var(--color-gray-500); transition: color 0.15s; }
                .pd-meta-link:hover { color: var(--color-primary); }
                .pd-header-actions { display: flex; gap: 0.75rem; flex-shrink: 0; }

                /* Buttons */
                .pd-btn {
                    display: inline-flex; align-items: center; gap: 0.4rem;
                    padding: 0.6rem 1.2rem; border-radius: 99px;
                    font-size: 0.88rem; font-weight: 600;
                    cursor: pointer; border: 2px solid transparent;
                    transition: all 0.15s; white-space: nowrap;
                }
                .pd-btn-outline {
                    background: var(--color-surface-raised); border-color: var(--color-gray-300); color: var(--color-gray-600);
                }
                .pd-btn-outline:hover { border-color: var(--color-gray-400); background: var(--color-surface-overlay); }
                .pd-btn-primary {
                    background: var(--color-secondary, #F97316); color: white; border-color: var(--color-secondary, #F97316);
                }
                .pd-btn-primary:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(249,115,22,0.3); }
                 .pd-btn-express {
                    width: 100%; justify-content: center;
                    background: var(--color-surface-raised); border: 2px solid var(--color-gray-300); color: var(--color-gray-600);
                    border-radius: 8px; padding: 0.65rem;
                }
                .pd-btn-express:hover { border-color: var(--color-primary); color: var(--color-primary); }
                .pd-btn-express.active { background: var(--color-primary); color: white; border-color: var(--color-primary); }

                /* Layout */
                .pd-layout {
                    display: grid;
                    grid-template-columns: 1fr 360px;
                    gap: 2rem;
                    align-items: start;
                }

                /* Cover Image */
                .pd-cover {
                    border-radius: 12px; overflow: hidden;
                    margin-bottom: 2rem;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.08);
                }
                .pd-cover img {
                    width: 100%; height: 360px; object-fit: cover;
                    display: block;
                }

                /* Cards */
                .pd-card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 12px;
                    padding: 1.75rem;
                    margin-bottom: 1.75rem;
                }
                .pd-card h2 {
                    font-size: 1.35rem; font-weight: 700; color: var(--color-gray-900);
                    margin: 0 0 1.25rem; letter-spacing: -0.01em;
                }
                .pd-card h3 {
                    font-size: 1.1rem; font-weight: 700; color: var(--color-gray-900);
                    margin: 0 0 1.25rem;
                }

                /* About */
                .pd-description p {
                    line-height: 1.75; color: var(--color-gray-600);
                    margin: 0 0 1rem; font-size: 0.95rem;
                }
                .pd-description p:last-child { margin-bottom: 0; }
                
                /* Rich Text Overrides */
                .pd-rich-text { color: var(--color-gray-600); font-size: 0.95rem; line-height: 1.75; }
                .pd-rich-text p, .pd-rich-text div { margin-bottom: 0.5rem; }
                .pd-rich-text p:last-child, .pd-rich-text div:last-child { margin-bottom: 0; }
                .pd-rich-text b, .pd-rich-text strong { font-weight: 700 !important; color: var(--color-gray-900); }
                .pd-rich-text i, .pd-rich-text em { font-style: italic !important; }
                .pd-rich-text u { text-decoration: underline !important; }
                .pd-rich-text ul { list-style: disc; padding-left: 1.5rem; margin-bottom: 0.5rem; }
                .pd-rich-text ol { list-style: decimal; padding-left: 1.5rem; margin-bottom: 0.5rem; }

                /* Sidebar Info Cards */
                .pd-info-sidebar { margin-top: 1.75rem; }
                .pd-info-list { display: flex; flex-direction: column; gap: 1.25rem; }
                .pd-info-row { display: flex; align-items: flex-start; gap: 1rem; }
                .pd-info-icon-sm { color: var(--color-primary); margin-top: 0.15rem; flex-shrink: 0; }
                .pd-info-row h4 { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-gray-400); margin: 0 0 0.25rem; }
                .pd-info-row p { font-size: 0.95rem; font-weight: 600; color: var(--color-gray-900); margin: 0; }


                /* Tags */
                .pd-tags { display: flex; flex-wrap: wrap; gap: 0.5rem; }
                 .pd-tag {
                    padding: 4px 12px; border-radius: 99px;
                    font-size: 0.8rem; font-weight: 500;
                    background: var(--color-surface-raised); color: var(--color-gray-600);
                    border: 1px solid var(--color-gray-200);
                }

                /* Sidebar Funding */
                .pd-funding { border-top: 4px solid var(--color-secondary, #F97316); }
                .pd-funding-stage { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
                .pd-label { font-size: 0.88rem; color: var(--color-gray-500); font-weight: 500; }
                .pd-value { font-size: 0.88rem; font-weight: 700; color: var(--color-gray-900); }
                .pd-muted { color: var(--color-gray-400); font-weight: 400; }

                .pd-progress-info {
                    display: flex; justify-content: space-between; align-items: baseline;
                    font-size: 1rem; font-weight: 700; color: var(--color-gray-900);
                    margin-bottom: 0.5rem;
                }
                .pd-progress-bar {
                    height: 8px; background: var(--color-gray-200); border-radius: 99px;
                    overflow: hidden; margin-bottom: 0.4rem;
                }
                .pd-progress-fill {
                    height: 100%; border-radius: 99px;
                    background: linear-gradient(90deg, var(--color-primary) 0%, var(--color-success, #22c55e) 100%);
                    transition: width 0.6s ease;
                }
                .pd-progress-pct { font-size: 0.78rem; color: var(--color-gray-500); margin: 0; }

                .pd-funding-actions {
                    display: flex; flex-direction: column; gap: 0.6rem;
                    margin-top: 1.5rem;
                }

                /* Use of Funds */
                .pd-use-of-funds {
                    margin-top: 1.25rem; padding-top: 1.25rem;
                    border-top: 1px solid var(--color-gray-100);
                }
                .pd-uof-title {
                    font-size: 0.88rem; font-weight: 700; color: var(--color-gray-900);
                    margin: 0 0 1rem;
                }
                .pd-pie-container {
                    display: flex; justify-content: center; margin-bottom: 1rem;
                }
                .pd-pie-chart {
                    width: 140px; height: 140px;
                }
                .pd-uof-legend {
                    display: flex; flex-direction: column; gap: 0.4rem;
                }
                .pd-uof-legend-item {
                    display: flex; align-items: center; gap: 0.5rem;
                    font-size: 0.82rem;
                }
                .pd-uof-dot {
                    width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
                }
                .pd-uof-label {
                    flex: 1; color: var(--color-gray-600);
                }
                .pd-uof-pct {
                    font-weight: 600; color: var(--color-gray-900);
                }

                /* Core Team */
                .pd-team-founder { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
                .pd-avatar {
                    width: 48px; height: 48px; border-radius: 50%;
                    background: linear-gradient(135deg, var(--color-primary), var(--color-secondary, #F97316));
                    display: flex; align-items: center; justify-content: center;
                    overflow: hidden; flex-shrink: 0;
                }
                .pd-avatar span { color: white; font-weight: 700; font-size: 1.1rem; }
                .pd-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .pd-avatar.sm { width: 36px; height: 36px; }
                .pd-avatar.sm span { font-size: 0.85rem; }
                .pd-team-name { font-weight: 700; color: var(--color-gray-900); font-size: 0.95rem; }
                .pd-team-name.sm { font-size: 0.88rem; }
                .pd-team-role { font-size: 0.82rem; color: var(--color-gray-500); }
                .pd-team-bio { font-size: 0.85rem; line-height: 1.6; color: var(--color-gray-500); margin: 0.5rem 0 0; }
                .pd-team-list {
                    display: flex; flex-direction: column; gap: 0.75rem;
                    padding-top: 0.75rem; margin-top: 0.75rem;
                    border-top: 1px solid var(--color-gray-100);
                }
                .pd-team-member { display: flex; align-items: center; gap: 0.6rem; }

                /* Document Links */
                .pd-team-links {
                    margin-top: 1.25rem; padding-top: 1.25rem;
                    border-top: 1px solid var(--color-gray-100);
                    display: flex; flex-direction: column; gap: 0.5rem;
                }
                 .pd-doc-link {
                    display: flex; align-items: center; gap: 0.5rem;
                    padding: 0.5rem 0.75rem; border-radius: 8px;
                    font-size: 0.85rem; font-weight: 500; color: var(--color-primary);
                    background: var(--color-surface-raised); border: 1px solid var(--color-gray-200);
                    text-decoration: none; cursor: pointer;
                    transition: all 0.15s;
                }
                .pd-doc-link:hover { background: var(--color-blue-tint); border-color: var(--color-primary); }
                .pd-link-ext { margin-left: auto; opacity: 0.5; }
                .pd-doc-available { color: #059669; background: var(--color-green-tint); border-color: #a7f3d0; cursor: default; }

                /* Modal & Animations */
                .modal-backdrop {
                    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                    background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
                    display: flex; align-items: center; justify-content: center; z-index: 9999;
                    animation: fadeIn 0.2s ease-out;
                }
                .modal-content {
                    background: var(--color-surface); border-radius: 16px; padding: 2rem;
                    width: 90%; max-width: 440px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04);
                    animation: scaleUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                }
                .modal-header { margin-bottom: 1rem; }
                .modal-title { font-size: 1.25rem; font-weight: 700; color: var(--color-gray-900); margin: 0; }
                .success-animation-container {
                    display: flex; flex-direction: column; align-items: center; justify-content: center;
                    text-align: center; padding: 1rem 0;
                }
                .success-animation-container h3 { margin: 1rem 0 0.5rem; font-size: 1.25rem; color: var(--color-gray-900); }
                .success-animation-container p { margin: 0; color: var(--color-gray-500); font-size: 0.95rem; }

                /* Checkmark SVG Animation */
                .checkmark { width: 56px; height: 56px; border-radius: 50%; display: block; stroke-width: 2; stroke: #fff; stroke-miterlimit: 10; margin: 0 auto; box-shadow: inset 0px 0px 0px var(--color-success, #22c55e); animation: fill .4s ease-in-out .4s forwards, scale .3s ease-in-out .9s both; }
                .checkmark-circle { stroke-dasharray: 166; stroke-dashoffset: 166; stroke-width: 2; stroke-miterlimit: 10; stroke: var(--color-success, #22c55e); fill: none; animation: stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards; }
                .checkmark-check { transform-origin: 50% 50%; stroke-dasharray: 48; stroke-dashoffset: 48; animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.8s forwards; }
                
                @keyframes stroke { 100% { stroke-dashoffset: 0; } }
                @keyframes scale { 0%, 100% { transform: none; } 50% { transform: scale3d(1.1, 1.1, 1); } }
                @keyframes fill { 100% { box-shadow: inset 0px 0px 0px 30px var(--color-success, #22c55e); } }
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes scaleUp { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }

                /* Responsive */
                @media (max-width: 900px) {
                    .pd-layout { grid-template-columns: 1fr; }
                    .pd-header { flex-direction: column; gap: 1rem; }
                    .pd-header-actions { width: 100%; }
                    .pd-cover img { height: 240px; }
                    .pd-title { font-size: 1.75rem; }
                    .pd-sidebar-section { padding: 1.5rem !important; margin-bottom: 1rem; border-radius: 12px; }
                    .pd-sidebar-section h3 { font-size: 1.1rem; margin-bottom: 1rem; font-weight: 700; color: var(--color-gray-900); }
                    .pd-sidebar-section .pd-description { font-size: 0.9rem; }
                    .pd-sidebar-section .pd-graph-section { height: 260px !important; }
                }
            `}</style>
        </div>
    );
};

export default ProjectDetails;

// ─── Subcomponents ──────────────────────────────────────────────────────────

const ProjectSection = ({ section, pieColors, isSidebar }) => {
    const lightbox = useLightbox();
    const stype = section.type || 'TEXT';
    return (
        <section className={`pd-card ${isSidebar ? 'pd-sidebar-section' : 'pd-about'}`}>
            {stype === 'TEXT' ? (
                <TranslatableText
                    title={section.title}
                    titleTag={isSidebar ? 'h3' : 'h2'}
                    text={section.body}
                    isHtml={true}
                    className="pd-description pd-rich-text rich-text-content"
                />
            ) : (
                <>
                    {section.title && (isSidebar ? <h3>{section.title}</h3> : <h2>{section.title}</h2>)}
                </>
            )}

            {stype === 'PHOTO' && section.imageUrl && (
                <div className="pd-photo-section" onClick={() => lightbox.open(section.imageUrl)} style={{ cursor: 'pointer' }}>
                    <img src={section.imageUrl} alt={section.title || 'Project Image'} style={{ width: '100%', borderRadius: '12px', objectFit: 'cover' }} />
                </div>
            )}

            {stype === 'CAROUSEL' && section.images?.length > 0 && (
                <CarouselViewer images={section.images} onImageClick={(img, imgs) => lightbox.open(img, imgs)} />
            )}

            {stype === 'GRAPH' && section.dataPoints?.length > 0 && (
                <div className="pd-graph-section" style={{ width: '100%', height: isSidebar ? '250px' : '350px', marginTop: '1rem' }}>
                    <ResponsiveContainer width="100%" height="100%">
                        {section.graphType === 'BAR' ? (
                            <BarChart data={section.dataPoints} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-gray-200)" />
                                <XAxis dataKey="label" tick={{ fill: 'var(--color-gray-500)', fontSize: 12 }} axisLine={false} tickLine={false}>
                                    {section.xAxisLabel && <Label value={section.xAxisLabel} offset={-10} position="insideBottom" fill="var(--color-gray-600)" fontSize={13} fontWeight={600} />}
                                </XAxis>
                                <YAxis tick={{ fill: 'var(--color-gray-500)', fontSize: 12 }} axisLine={false} tickLine={false}>
                                    {section.yAxisLabel && <Label value={section.yAxisLabel} angle={-90} position="insideLeft" style={{ textAnchor: 'middle' }} fill="var(--color-gray-600)" fontSize={13} fontWeight={600} />}
                                </YAxis>
                                <Tooltip cursor={{ fill: 'var(--color-gray-100)' }} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }} />
                                <Bar dataKey="value" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        ) : section.graphType === 'LINE' ? (
                            <LineChart data={section.dataPoints} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-gray-200)" />
                                <XAxis dataKey="label" tick={{ fill: 'var(--color-gray-500)', fontSize: 12 }} axisLine={false} tickLine={false}>
                                    {section.xAxisLabel && <Label value={section.xAxisLabel} offset={-10} position="insideBottom" fill="var(--color-gray-600)" fontSize={13} fontWeight={600} />}
                                </XAxis>
                                <YAxis tick={{ fill: 'var(--color-gray-500)', fontSize: 12 }} axisLine={false} tickLine={false}>
                                    {section.yAxisLabel && <Label value={section.yAxisLabel} angle={-90} position="insideLeft" style={{ textAnchor: 'middle' }} fill="var(--color-gray-600)" fontSize={13} fontWeight={600} />}
                                </YAxis>
                                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }} />
                                <Line type="monotone" dataKey="value" stroke="var(--color-primary)" strokeWidth={3} dot={{ fill: 'var(--color-primary)', strokeWidth: 2, r: 4 }} activeDot={{ r: 6 }} />
                            </LineChart>
                        ) : (
                            <PieChart>
                                <Pie data={section.dataPoints} dataKey="value" nameKey="label" cx="50%" cy="50%" outerRadius={isSidebar ? 80 : 120} label>
                                    {section.dataPoints.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={pieColors[index % pieColors.length]} />
                                    ))}
                                </Pie>
                                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }} />
                                <Legend />
                            </PieChart>
                        )}
                    </ResponsiveContainer>
                </div>
            )}
        </section>
    );
};


// ─── Subcomponents ──────────────────────────────────────────────────────────

const CarouselViewer = ({ images, onImageClick }) => {
    const [currentIndex, setCurrentIndex] = useState(0);

    if (!images || images.length === 0) return null;

    const nextSlide = () => {
        setCurrentIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
    };

    const prevSlide = () => {
        setCurrentIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
    };

    return (
        <div className="pd-carousel-wrapper" style={{ position: 'relative', width: '100%', borderRadius: '12px', overflow: 'hidden', backgroundColor: 'var(--color-gray-100)' }}>
            <div
                className="pd-carousel-track"
                style={{
                    display: 'flex',
                    transition: 'transform 0.4s cubic-bezier(0.25, 0.8, 0.25, 1)',
                    transform: `translateX(-${currentIndex * 100}%)`,
                    width: '100%',
                    height: '400px'
                }}
            >
                {images.map((img, idx) => (
                    <img
                        key={idx}
                        src={img}
                        alt={`Slide ${idx + 1}`}
                        onClick={() => onImageClick && onImageClick(img, images)}
                        style={{ width: '100%', height: '100%', objectFit: 'contain', flexShrink: 0, display: 'block', cursor: 'pointer' }}
                    />
                ))}
            </div>

            {images.length > 1 && (
                <>
                    <button
                        onClick={prevSlide}
                        style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,0.8)', border: 'none', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}
                    >
                        <ChevronLeft size={24} color="var(--color-gray-600)" />
                    </button>
                    <button
                        onClick={nextSlide}
                        style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,0.8)', border: 'none', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}
                    >
                        <ChevronRight size={24} color="var(--color-gray-600)" />
                    </button>
                    <div style={{ position: 'absolute', bottom: '10px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '6px' }}>
                        {images.map((_, idx) => (
                            <div
                                key={idx}
                                style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: idx === currentIndex ? 'var(--color-primary)' : 'rgba(255,255,255,0.6)', cursor: 'pointer' }}
                                onClick={() => setCurrentIndex(idx)}
                            />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
};
