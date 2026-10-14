import React, { useState, useEffect } from 'react';
import { Hammer, Search, Loader2, User } from 'lucide-react';
import { Link } from 'react-router-dom';
import { profilesApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import ZapButton from '../components/ZapButton';
import FollowIconButton from '../components/FollowIconButton';
import { getAssetUrl } from '../utils/assets';
import { stripHtml } from '../utils/text';

const Builders = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [followingIds, setFollowingIds] = useState(new Set());

    useEffect(() => {
        const fetchBuilders = async () => {
            setLoading(true);
            try {
                const params = { role: 'BUILDER', page, limit: 12 };
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
                console.error('Fetch builders error:', err);
                setProfiles([]);
            } finally {
                setLoading(false);
            }
        };
        const debounce = setTimeout(fetchBuilders, 300);
        return () => clearTimeout(debounce);
    }, [search, page, user?.id]);

    return (
        <div className="container py-12">
            <div className="flex flex-col items-center text-center mb-12">
                <div className="icon-wrapper mb-4">
                    <Hammer size={48} className="text-primary" />
                </div>
                <h1 className="page-header">{t('builders.title')}</h1>
                <p className="text-lg text-gray-500 max-w-2xl mt-4">
                    {t('builders.subtitle')}
                </p>

                <div className="search-bar mt-8">
                    <Search size={20} className="text-gray-400" />
                    <input type="text" placeholder={t('builders.searchPlaceholder')} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
                </div>
            </div>

            {loading ? (
                <div style={{ textAlign: 'center', padding: '3rem' }}>
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                </div>
            ) : profiles.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--color-gray-500)' }}>
                    {search ? t('builders.noBuildersSearch', { query: search }) : t('builders.noBuilders')}.
                </div>
            ) : (
                <div className="builders-grid">
                    {profiles.map((builder) => {
                        const targetUserId = builder.user?.id || builder.userId;
                        return (
                            <Link to={`/builder/${builder.id}`} key={builder.id} className="card-link">
                                <div className="card">
                                    <div className="h-48 bg-gray-100 relative">
                                        {builder.avatar || builder.image ? (
                                            <img src={builder.avatar || builder.image} alt={builder.name} className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="w-full h-full" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <User size={48} style={{ color: 'var(--color-gray-300)' }} />
                                            </div>
                                        )}
                                    </div>
                                    <div className="p-5 flex-1 flex flex-col">
                                        <h3 className="font-semibold text-xl mb-1">{builder.name}</h3>
                                        {builder.company && <p className="text-primary font-medium text-sm mb-2">{builder.company}</p>}
                                        <p className="text-sm text-gray-500 line-clamp-2 mb-4">{stripHtml(builder.bio || '')}</p>

                                        {(builder.skills || builder.tags || []).length > 0 && (
                                            <div className="flex flex-wrap gap-2 mb-4">
                                                {(builder.skills || builder.tags).map((tag, i) => (
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
                                            {builder.user?.nostrPubkey && (
                                                <ZapButton
                                                    recipients={[{ pubkey: builder.user.nostrPubkey, name: builder.name, avatar: builder.avatar, lud16: builder.lightningAddress, bolt12Offer: builder.bolt12Offer }]}
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
                .builders-grid {
                    display: grid;
                    gap: 2rem;
                    grid-template-columns: repeat(1, 1fr);
                }

                @media (min-width: 640px) {
                    .builders-grid { grid-template-columns: repeat(2, 1fr); }
                }

                @media (min-width: 1024px) {
                    .builders-grid { grid-template-columns: repeat(3, 1fr); }
                }

                @media (min-width: 1280px) {
                    .builders-grid { grid-template-columns: repeat(4, 1fr); }
                }

                .h-48 { height: 12rem; }
                .bg-gray-100 { background: var(--color-gray-100); }
                .text-gray-400 { color: var(--color-gray-400); }
                .object-cover { object-fit: cover; }
                .inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
                .bg-black { background-color: black; }
                .bg-opacity-10 { background-color: rgba(0,0,0,0.1); }

                .icon-wrapper {
                    padding: 1.5rem;
                    background: rgba(0, 71, 171, 0.1);
                    border-radius: 50%;
                    width: fit-content;
                }
                
                .search-bar {
                    display: flex;
                    align-items: center;
                    flex: 1;
                    background: var(--color-gray-100);
                    padding: 0.5rem;
                    border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-300);
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

                .filters {
                    width: 250px;
                    background: var(--color-gray-100);
                    padding: 1.5rem;
                    border-radius: var(--radius-lg);
                    border: 1px solid var(--color-gray-200);
                    overflow: hidden;
                    transition: transform 0.2s, box-shadow 0.2s;
                    height: 100%;
                    display: flex;
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

                @media (max-width: 768px) {
                    .page-header { display: none !important; }
                }
            `}</style>
        </div>
    );
};

export default Builders;
