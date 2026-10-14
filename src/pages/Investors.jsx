import React, { useState, useEffect } from 'react';
import { TrendingUp, Search, Loader2, User } from 'lucide-react';
import { Link } from 'react-router-dom';
import { profilesApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import ZapButton from '../components/ZapButton';
import FollowIconButton from '../components/FollowIconButton';
import { getAssetUrl } from '../utils/assets';
import { stripHtml } from '../utils/text';

const Investors = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [followingIds, setFollowingIds] = useState(new Set());

    useEffect(() => {
        const fetchInvestors = async () => {
            setLoading(true);
            try {
                const params = { role: 'INVESTOR', page, limit: 12 };
                if (search) params.search = search;

                const [result, followingRes] = await Promise.all([
                    profilesApi.list(params),
                    user?.id ? profilesApi.getFollowing(user.id, { limit: 100 }).catch(() => null) : Promise.resolve(null)
                ]);

                const list = result?.data || result || [];
                setProfiles(Array.isArray(list) ? list : []);
                setTotalPages(result?.pagination?.totalPages || 1);

                if (followingRes) {
                    const fList = Array.isArray(followingRes?.data) ? followingRes.data : Array.isArray(followingRes) ? followingRes : [];
                    setFollowingIds(new Set(fList.map(u => u.id)));
                }
            } catch (err) {
                console.error('Fetch investors error:', err);
                setProfiles([]);
            } finally {
                setLoading(false);
            }
        };
        const debounce = setTimeout(fetchInvestors, 300);
        return () => clearTimeout(debounce);
    }, [search, page, user?.id]);

    return (
        <div className="container py-12">
            <div className="flex flex-col items-center text-center mb-12">
                <div className="icon-wrapper mb-4">
                    <TrendingUp size={48} className="text-secondary" />
                </div>
                <h1 className="page-header">{t('investors.title')}</h1>
                <p className="text-lg text-gray-500 max-w-2xl mt-4">
                    {t('investors.subtitle')}
                </p>

                <div className="search-bar mt-8">
                    <Search size={20} className="text-gray-400" />
                    <input type="text" placeholder={t('investors.searchPlaceholder')} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
                </div>
            </div>

            {loading ? (
                <div style={{ textAlign: 'center', padding: '3rem' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                </div>
            ) : profiles.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--color-gray-500)' }}>
                    {search ? t('investors.noInvestorsSearch', { query: search }) : t('investors.noInvestors')}.
                </div>
            ) : (
                <div className="investors-grid">
                    {profiles.map((investor) => {
                        const targetUserId = investor.user?.id || investor.userId;
                        return (
                            <Link to={`/investor/${investor.id}`} key={investor.id} className="card-link">
                                <div className="card">
                                    <div className="h-48 bg-gray-100 relative">
                                        {investor.avatar || investor.image ? (
                                            <img src={investor.avatar || investor.image} alt={investor.name} className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="w-full h-full" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <User size={48} style={{ color: 'var(--color-gray-300)' }} />
                                            </div>
                                        )}
                                    </div>
                                    <div className="p-5 flex-1 flex flex-col">
                                        <h3 className="font-semibold text-xl mb-1">{investor.name}</h3>
                                        {investor.company && <p className="text-secondary font-medium text-sm mb-2">{investor.company}</p>}
                                        <p className="text-sm text-gray-500 line-clamp-2 mb-4">{stripHtml(investor.bio || '')}</p>

                                        {(investor.tags || investor.interests || []).length > 0 && (
                                            <div className="flex flex-wrap gap-2 mb-4">
                                                {(investor.tags || investor.interests).map((tag, i) => (
                                                    <span key={i} className="tag">{tag}</span>
                                                ))}
                                            </div>
                                        )}

                                        <div className="actions mt-auto">
                                            {user && targetUserId && user.id !== targetUserId && (
                                                <FollowIconButton
                                                    targetUserId={targetUserId}
                                                    isFollowing={followingIds.has(targetUserId)}
                                                    onToggle={(isFollowing) => {
                                                        const newSet = new Set(followingIds);
                                                        if (isFollowing) newSet.add(targetUserId);
                                                        else newSet.delete(targetUserId);
                                                        setFollowingIds(newSet);
                                                    }}
                                                />
                                            )}
                                            {investor.user?.nostrPubkey && (
                                                <ZapButton
                                                    recipients={[{ pubkey: investor.user.nostrPubkey, name: investor.name, avatar: investor.avatar, lud16: investor.lightningAddress, bolt12Offer: investor.bolt12Offer }]}
                                                    size="sm"
                                                />
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </Link>
                        );
                    })}
                </div>
            )}

            {totalPages > 1 && (
                <div className="pagination">
                    <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('common.previous')}</button>
                    <span>{t('common.page', { current: page, total: totalPages })}</span>
                    <button className="btn btn-outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>{t('common.next')}</button>
                </div>
            )}

            <style jsx>{`
                .investors-grid {
                    display: grid;
                    gap: 2rem;
                    grid-template-columns: repeat(1, 1fr);
                }

                @media (min-width: 640px) {
                    .investors-grid { grid-template-columns: repeat(2, 1fr); }
                }

                @media (min-width: 1024px) {
                    .investors-grid { grid-template-columns: repeat(3, 1fr); }
                }

                @media (min-width: 1280px) {
                    .investors-grid { grid-template-columns: repeat(4, 1fr); }
                }

                .h-48 { height: 12rem; }
                .bg-gray-100 { background: var(--color-gray-100); }
                .text-gray-400 { color: var(--color-gray-400); }
                .object-cover { object-fit: cover; }
                .w-full { width: 100%; }
                .h-full { height: 100%; }
                .relative { position: relative; }

                .icon-wrapper {
                    padding: 1.5rem;
                    background: var(--color-gray-100);
                    color: var(--color-secondary);
                    border-radius: 50%;
                    width: fit-content;
                }

                .search-bar {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.75rem 1rem;
                    background: var(--color-gray-100);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-full);
                    width: 100%;
                    max-width: 400px;
                    box-shadow: var(--shadow-sm);
                }
                .search-bar input {
                    border: none;
                    outline: none;
                    width: 100%;
                    font-size: 1rem;
                }

                .card {
                    background: var(--color-gray-100);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    overflow: hidden;
                    transition: transform 0.2s, box-shadow 0.2s;
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                }
                .card:hover { transform: translateY(-4px); box-shadow: var(--shadow-md); }
                .card-link { display: block; text-decoration: none; color: inherit; height: 100%; }

                .tag {
                    font-size: 0.75rem;
                    padding: 2px 10px;
                    background: var(--color-gray-100);
                    border-radius: 99px;
                    color: var(--color-gray-600);
                    font-weight: 500;
                }

                .line-clamp-2 {
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }

                .actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 0.75rem;
                    align-items: center;
                    margin-top: auto;
                }

                .pagination {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 1rem;
                    margin-top: 3rem;
                }

                @media (max-width: 768px) {
                    .page-header { display: none !important; }
                }
            `}</style>
        </div>
    );
};

export default Investors;
