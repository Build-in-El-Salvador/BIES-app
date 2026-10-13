import React, { useState, useEffect, useRef } from 'react';
import { Search, SlidersHorizontal, Loader2, User } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { profilesApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import ZapButton from '../components/ZapButton';
import FollowIconButton from '../components/FollowIconButton';

const INTEREST_TAGS = [
    { id: 'Bitcoin', label: 'Bitcoin' },
    { id: 'Lightning', label: 'Lightning' },
    { id: 'Nostr', label: 'Nostr' },
    { id: 'DeFi', label: 'DeFi' },
    { id: 'Web3', label: 'Web3' },
    { id: 'Fintech', label: 'Fintech' },
    { id: 'SaaS', label: 'SaaS' },
    { id: 'Infrastructure', label: 'Infrastructure' },
    { id: 'Real Estate', label: 'Real Estate' },
    { id: 'Agriculture', label: 'Agriculture' },
    { id: 'Energy', label: 'Energy' },
    { id: 'Tourism', label: 'Tourism' },
    { id: 'Education', label: 'Education' },
    { id: 'Health', label: 'Health / Wellness' },
    { id: 'Logistics', label: 'Logistics' },
    { id: 'E-Commerce', label: 'E-Commerce' },
];

const MOCK_MEMBERS = [
    { id: 'm1', name: 'Carlos Mendez', role: 'BUILDER', company: 'BitStack Labs', bio: 'Building Lightning infrastructure for the next billion users in Latin America.', skills: ['Bitcoin', 'Lightning', 'Infrastructure'], avatar: 'https://i.pravatar.cc/300?img=11', user: {} },
    { id: 'm2', name: 'Sofia Reyes', role: 'INVESTOR', company: 'Orange Fund', bio: 'Angel investor focused on Bitcoin-native startups and financial inclusion projects.', skills: ['Fintech', 'Bitcoin', 'DeFi'], avatar: 'https://i.pravatar.cc/300?img=47', user: {} },
    { id: 'm3', name: 'Alejandro Vega', role: 'BUILDER', company: 'NostrConnect', bio: 'Decentralized social protocol developer. Building the censorship-resistant web.', skills: ['Nostr', 'Web3', 'SaaS'], avatar: 'https://i.pravatar.cc/300?img=12', user: {} },
    { id: 'm4', name: 'Isabela Santos', role: 'INVESTOR', company: 'Salv Capital', bio: 'VC partner investing in El Salvador tech ecosystem and Bitcoin economy builders.', skills: ['Real Estate', 'Tourism', 'Bitcoin'], avatar: 'https://i.pravatar.cc/300?img=44', user: {} },
    { id: 'm5', name: 'Diego Flores', role: 'BUILDER', company: 'Chivo Pay', bio: 'Payment solutions engineer making Bitcoin payments seamless for everyday commerce.', skills: ['Lightning', 'Fintech', 'E-Commerce'], avatar: 'https://i.pravatar.cc/300?img=15', user: {} },
    { id: 'm6', name: 'Valentina Cruz', role: 'BUILDER', company: 'AgroChain', bio: 'Using blockchain to modernize agricultural supply chains across Central America.', skills: ['Agriculture', 'Logistics', 'Bitcoin'], avatar: 'https://i.pravatar.cc/300?img=49', user: {} },
    { id: 'm7', name: 'Marco Hernandez', role: 'INVESTOR', company: 'Libre Ventures', bio: 'Seed-stage investor backing founders building on open protocols and Bitcoin.', skills: ['Bitcoin', 'Infrastructure', 'SaaS'], avatar: 'https://i.pravatar.cc/300?img=8', user: {} },
    { id: 'm8', name: 'Lucia Morales', role: 'BUILDER', company: 'SolarStack', bio: 'Renewable energy meets Bitcoin mining — building sustainable power infrastructure.', skills: ['Energy', 'Infrastructure', 'Bitcoin'], avatar: 'https://i.pravatar.cc/300?img=48', user: {} },
    { id: 'm9', name: 'Rafael Torres', role: 'BUILDER', company: 'EduSats', bio: 'Micro-payment based education platform using Lightning to reward student progress.', skills: ['Education', 'Lightning', 'SaaS'], avatar: 'https://i.pravatar.cc/300?img=3', user: {} },
    { id: 'm10', name: 'Camila Ortiz', role: 'INVESTOR', company: 'Pacific Angels', bio: 'Impact investor focused on health tech and financial inclusion in emerging markets.', skills: ['Health', 'Fintech', 'DeFi'], avatar: 'https://i.pravatar.cc/300?img=45', user: {} },
    { id: 'm11', name: 'Andres Jimenez', role: 'BUILDER', company: 'BlockHost', bio: 'Decentralized hosting and CDN services for the sovereign web. No KYC, pay with Bitcoin.', skills: ['Infrastructure', 'Bitcoin', 'Web3'], avatar: 'https://i.pravatar.cc/300?img=6', user: {} },
    { id: 'm12', name: 'Natalia Vargas', role: 'INVESTOR', company: 'Satoshi Seed', bio: 'Early-stage fund backing Bitcoin entrepreneurs from El Salvador to Southeast Asia.', skills: ['Bitcoin', 'Nostr', 'SaaS'], avatar: 'https://i.pravatar.cc/300?img=46', user: {} },
    { id: 'm13', name: 'Elena Rios', role: 'EDUCATOR', company: 'Bitcoin Academy SV', bio: 'Teaching Bitcoin fundamentals and Lightning Network to entrepreneurs across Central America.', skills: ['Bitcoin', 'Education', 'Lightning'], avatar: 'https://i.pravatar.cc/300?img=43', user: {} },
    { id: 'm14', name: 'Samuel Katz', role: 'EDUCATOR', company: 'Open Source Finance', bio: 'Developer educator focused on Nostr protocol and decentralized identity for builders.', skills: ['Nostr', 'Web3', 'Education'], avatar: 'https://i.pravatar.cc/300?img=7', user: {} },
    { id: 'm15', name: 'Tomas Rivera', role: 'MEMBER', company: '', bio: 'Curious about Bitcoin and the El Salvador ecosystem. Here to learn, connect, and grow.', skills: ['Bitcoin', 'Fintech'], avatar: 'https://i.pravatar.cc/300?img=5', user: {} },
    { id: 'm16', name: 'Priya Nair', role: 'MEMBER', company: '', bio: 'Digital nomad exploring opportunities in the Bitcoin economy. Passionate about financial freedom.', skills: ['Tourism', 'E-Commerce'], avatar: 'https://i.pravatar.cc/300?img=50', user: {} },
];

const Members = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const [allProfiles, setAllProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [selectedRoles, setSelectedRoles] = useState([]);
    const [selectedTags, setSelectedTags] = useState([]);
    const [visibleCount, setVisibleCount] = useState(12);
    const [followingIds, setFollowingIds] = useState(new Set());
    const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
    const sentinelRef = useRef(null);

    // Fetch once on mount
    useEffect(() => {
        const fetchMembers = async () => {
            setLoading(true);
            try {
                const [result, followingRes] = await Promise.all([
                    profilesApi.list({ limit: 200 }),
                    user?.id ? profilesApi.getFollowing(user.id, { limit: 100 }).catch(() => null) : Promise.resolve(null)
                ]);

                const list = result?.data || result || [];
                const fetched = Array.isArray(list) ? list : [];
                setAllProfiles(fetched.length > 0 ? fetched : MOCK_MEMBERS);

                if (followingRes) {
                    const fList = Array.isArray(followingRes?.data) ? followingRes.data : Array.isArray(followingRes) ? followingRes : [];
                    setFollowingIds(new Set(fList.map(u => u.id)));
                }
            } catch (err) {
                console.error('Fetch members error:', err);
                setAllProfiles(MOCK_MEMBERS);
            } finally {
                setLoading(false);
            }
        };
        fetchMembers();
    }, [user?.id]);

    const handleRoleChange = (role) => {
        setSelectedRoles(prev =>
            prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
        );
        setVisibleCount(12);
    };

    const handleTagChange = (tag) => {
        setSelectedTags(prev =>
            prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
        );
        setVisibleCount(12);
    };

    // Reset visible count when search changes
    useEffect(() => { setVisibleCount(12); }, [search]);

    // Client-side filtering
    const filteredProfiles = allProfiles.filter(p => {
        const role = (p.role || p.user?.role || '').toUpperCase();
        const tags = p.skills || p.tags || [];
        const text = `${p.name || ''} ${p.bio || ''} ${p.company || ''} ${tags.join(' ')}`.toLowerCase();

        if (selectedRoles.length > 0 && !selectedRoles.includes(role)) return false;
        if (selectedTags.length > 0 && !selectedTags.some(t => tags.some(pt => pt.toLowerCase().includes(t.toLowerCase())))) return false;
        if (search && !text.includes(search.toLowerCase())) return false;
        return true;
    });

    const visibleProfiles = filteredProfiles.slice(0, visibleCount);
    const hasMore = visibleCount < filteredProfiles.length;

    // Infinite scroll — observe sentinel element
    useEffect(() => {
        if (!sentinelRef.current) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore) {
                    setVisibleCount(prev => prev + 12);
                }
            },
            { threshold: 0.1 }
        );
        observer.observe(sentinelRef.current);
        return () => observer.disconnect();
    }, [hasMore]);

    return (
        <div className="members-page container">
            <h1 className="page-header" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>{t('members.title')}</h1>

            <div className="search-row">
                <div className="search-left-column" />
                <div style={{ display: 'flex', flex: 1, gap: '0.75rem', alignItems: 'center' }}>
                    <div className="search-bar">
                        <Search size={20} className="search-icon" />
                        <input
                            type="text"
                            placeholder={t('members.searchPlaceholder')}
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            className="search-input"
                        />
                        <button className="mobile-filter-toggle" onClick={() => setMobileFiltersOpen(!mobileFiltersOpen)}>
                            <SlidersHorizontal size={20} />
                            {(selectedRoles.length + selectedTags.length) > 0 && (
                                <span className="filter-badge">{selectedRoles.length + selectedTags.length}</span>
                            )}
                        </button>
                    </div>
                </div>
            </div>

            <div className="content-layout">
                {/* Filters Sidebar */}
                <div className={`filters-column ${mobileFiltersOpen ? 'mobile-open' : ''}`}>
                    <aside className="filters">
                        <div className="filter-header">
                            <SlidersHorizontal size={18} />
                            <span>{t('common.filters')}</span>
                        </div>

                        <div className="filter-group">
                            <label>{t('members.role')}</label>
                            <div className="checkbox-list">
                                {[{ id: 'BUILDER', label: t('members.roles.builder') }, { id: 'INVESTOR', label: t('members.roles.investor') }, { id: 'EDUCATOR', label: t('members.roles.educator') }, { id: 'MEMBER', label: t('members.roles.member') }].map(role => (
                                    <label key={role.id}>
                                        <input
                                            type="checkbox"
                                            checked={selectedRoles.includes(role.id)}
                                            onChange={() => handleRoleChange(role.id)}
                                        />
                                        {role.label}
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div className="filter-group">
                            <label>{t('members.interests')}</label>
                            <div className="checkbox-list">
                                {INTEREST_TAGS.map(tag => (
                                    <label key={tag.id}>
                                        <input
                                            type="checkbox"
                                            checked={selectedTags.includes(tag.id)}
                                            onChange={() => handleTagChange(tag.id)}
                                        />
                                        {tag.label}
                                    </label>
                                ))}
                            </div>
                        </div>
                    </aside>
                </div>

                {/* Members Grid + Pagination */}
                <div className="cards-area">
                <div className="members-grid">
                    {loading ? (
                        <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '3rem' }}>
                            <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
                        </div>
                    ) : visibleProfiles.length > 0 ? (
                        visibleProfiles.map(member => {
                            const targetUserId = member.user?.id || member.userId;
                            const roleUpper = (member.role || member.user?.role || '').toUpperCase();
                            const isBuilder = roleUpper === 'BUILDER';
                            const isEducator = roleUpper === 'EDUCATOR';
                            const isMember = roleUpper === 'MEMBER';
                            const profilePath = isBuilder || isEducator || isMember ? `/builder/${member.id}` : `/investor/${member.id}`;
                            const badgeClass = isBuilder ? 'builder' : isEducator ? 'educator' : isMember ? 'member' : 'investor';
                            const badgeLabel = isBuilder ? t('members.roles.builder') : isEducator ? t('members.roles.educator') : isMember ? t('members.roles.member') : t('members.roles.investor');
                            return (
                                <div key={member.id} className="member-card">
                                    <Link to={profilePath} className="card-image-link">
                                        <div className="card-image">
                                            {member.avatar || member.image ? (
                                                <img src={member.avatar || member.image} alt={member.name} className="avatar-img" />
                                            ) : (
                                                <div className="avatar-placeholder">
                                                    <User size={48} style={{ color: 'var(--color-gray-300)' }} />
                                                </div>
                                            )}
                                            <span className={`role-badge ${badgeClass}`}>
                                                {badgeLabel}
                                            </span>
                                        </div>
                                    </Link>
                                    <div className="card-body">
                                        <Link to={profilePath} className="card-title-link">
                                            <h3>{member.name}</h3>
                                        </Link>
                                        {member.company && <p className="member-company">{member.company}</p>}
                                        <p className="description">{member.bio || ''}</p>

                                        {(member.skills || member.tags || []).length > 0 && (
                                            <div className="tag-row">
                                                {(member.skills || member.tags).slice(0, 3).map((tag, i) => (
                                                    <span key={i} className="tag">{tag}</span>
                                                ))}
                                            </div>
                                        )}

                                        <div className="actions">
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
                                            {member.user?.nostrPubkey && (
                                                <ZapButton
                                                    recipients={[{ pubkey: member.user.nostrPubkey, name: member.name, avatar: member.avatar, lud16: member.lightningAddress, bolt12Offer: member.bolt12Offer }]}
                                                    size="sm"
                                                />
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    ) : (
                        <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '3rem', color: 'var(--color-gray-500)' }}>
                            {search ? t('members.noMembersSearch', { query: search }) : (selectedRoles.length > 0 || selectedTags.length > 0) ? t('members.noMembersFilters') : t('members.noMembers')}
                        </div>
                    )}
                </div>

                <div ref={sentinelRef} style={{ height: 40 }} />
                {hasMore && (
                    <div style={{ textAlign: 'center', padding: '1rem' }}>
                        <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-gray-400)' }} />
                    </div>
                )}
                </div>
            </div>

            <style jsx>{`
                .members-page {
                    padding-top: var(--page-top, 2rem);
                    padding-bottom: 4rem;
                }

                .search-row {
                    display: flex;
                    align-items: center;
                    gap: 2rem;
                    margin-bottom: 2rem;
                }

                .search-left-column {
                    width: 250px;
                    flex-shrink: 0;
                }

                .filters-column {
                    width: 250px;
                    display: flex;
                    flex-direction: column;
                    flex-shrink: 0;
                }

                .search-bar {
                    display: flex;
                    align-items: center;
                    flex: 1;
                    background: var(--color-surface-raised);
                    padding: 0.5rem;
                    border-radius: var(--radius-full);
                    border: 1px solid var(--color-gray-200);
                    box-shadow: var(--shadow-sm);
                    transition: all 0.2s;
                }
                .search-bar:focus-within {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 71, 171, 0.1);
                    background: var(--color-surface-raised);
                }

                .search-icon {
                    margin-left: 1rem;
                    color: var(--color-gray-400);
                }

                input {
                    flex: 1;
                    border: none;
                    padding: 0.5rem 1rem;
                    outline: none;
                    font-size: 1rem;
                }
                .search-input:focus { outline: none; }

                .content-layout {
                    display: flex;
                    gap: 2rem;
                    align-items: flex-start;
                }

                .filters {
                    width: 250px;
                    background: var(--color-surface);
                    padding: 1.5rem;
                    border-radius: var(--radius-lg);
                    height: fit-content;
                    border: 1px solid var(--color-gray-200);
                    display: flex;
                    flex-direction: column;
                }

                .filter-header {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-weight: 600;
                    margin-bottom: 1.5rem;
                    padding-bottom: 1rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }

                .filter-group { margin-bottom: 1.5rem; }
                .filter-group label {
                    display: block;
                    font-size: 0.9rem;
                    font-weight: 600;
                    margin-bottom: 0.75rem;
                }

                .checkbox-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    align-items: flex-start;
                }

                .checkbox-list label {
                    font-weight: normal;
                    font-size: 0.9rem;
                    color: var(--color-gray-600);
                    display: flex;
                    align-items: center;
                    justify-content: flex-start;
                    cursor: pointer;
                    width: auto;
                    padding: 2px 0;
                    margin: 0;
                    gap: 8px;
                }

                .checkbox-list input[type="checkbox"] {
                    margin: 0;
                    padding: 0;
                    display: block;
                    width: 16px !important;
                    min-width: 16px;
                    max-width: 16px;
                    height: 16px !important;
                    min-height: 16px;
                    max-height: 16px;
                    accent-color: var(--color-primary);
                    flex: 0 0 16px;
                    cursor: pointer;
                    appearance: none;
                    -webkit-appearance: none;
                    background: var(--color-surface-raised);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 3px;
                    position: relative;
                    box-sizing: content-box;
                }
                .checkbox-list input[type="checkbox"]:checked {
                    background: var(--color-primary);
                }
                .checkbox-list input[type="checkbox"]:checked::after {
                    content: '✓';
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    color: white;
                    font-size: 11px;
                    font-weight: 700;
                }

                .cards-area {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                }

                /* Members Grid */
                .members-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 1.5rem;
                    align-content: flex-start;
                }

                @media (max-width: 1024px) {
                    .members-grid { grid-template-columns: repeat(2, 1fr); }
                }

                /* Member Card */
                .member-card {
                    background: var(--color-surface);
                    border-radius: var(--radius-lg);
                    overflow: hidden;
                    border: 1px solid var(--color-gray-200);
                    transition: transform 0.2s, box-shadow 0.2s;
                    display: flex;
                    flex-direction: column;
                }
                .member-card:hover {
                    transform: translateY(-4px);
                    box-shadow: var(--shadow-md);
                }

                .card-image-link {
                    text-decoration: none;
                    display: block;
                }

                .card-image {
                    height: 160px;
                    position: relative;
                    background: var(--color-gray-100);
                    overflow: hidden;
                }

                .avatar-img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }

                .avatar-placeholder {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .role-badge {
                    position: absolute;
                    top: 1rem;
                    left: 1rem;
                    font-size: 0.75rem;
                    font-weight: 600;
                    padding: 4px 8px;
                    border-radius: 4px;
                    color: white;
                }
                .role-badge.builder { background: rgba(0, 71, 171, 0.85); }
                .role-badge.investor { background: rgba(247, 147, 26, 0.9); }
                .role-badge.educator { background: rgba(22, 163, 74, 0.9); }
                .role-badge.member { background: rgba(124, 58, 237, 0.85); }

                .card-body { padding: 1.5rem; flex: 1; display: flex; flex-direction: column; overflow: hidden; }

                .card-title-link { text-decoration: none; color: inherit; }
                .card-title-link:hover h3 { color: var(--color-primary); }

                h3 { font-size: 1.1rem; margin-bottom: 0.25rem; }

                .member-company {
                    color: var(--color-primary);
                    font-size: 0.85rem;
                    font-weight: 600;
                    margin-bottom: 0.35rem;
                }

                .description {
                    font-size: 0.9rem;
                    color: var(--color-gray-500);
                    margin-bottom: 0.75rem;
                    line-height: 1.4;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }

                .tag-row {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.35rem;
                    margin-bottom: 0.75rem;
                }

                .tag {
                    font-size: 0.75rem;
                    padding: 2px 8px;
                    background: var(--color-gray-200);
                    border-radius: 99px;
                    color: var(--color-gray-600);
                    font-weight: 500;
                }

                .actions {
                    display: flex;
                    gap: 0.5rem;
                    align-items: center;
                    justify-content: flex-end;
                    margin-top: auto;
                }

.mobile-filter-toggle {
                    display: none;
                    align-items: center;
                    justify-content: center;
                    width: 40px;
                    height: 40px;
                    border-radius: 50%;
                    border: none;
                    background: none;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    flex-shrink: 0;
                    position: relative;
                }
                .filter-badge {
                    position: absolute;
                    top: 2px;
                    right: 2px;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    background: var(--color-secondary);
                    color: white;
                    font-size: 0.65rem;
                    font-weight: 700;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                @media (max-width: 768px) {
                    .search-left-column { display: none !important; }
                    .page-header { display: none !important; }
                }

                @media (max-width: 768px) {
                    .search-row { flex-direction: column; align-items: stretch; gap: 1rem; }
                    .search-left-column { display: none !important; }
                    .content-layout { flex-direction: column; }
                    .filters-column {
                        width: 100%;
                        display: none;
                    }
                    .filters-column.mobile-open {
                        display: flex;
                    }
                    .filters { width: 100%; }
                    .members-grid { grid-template-columns: 1fr; }
                    .mobile-filter-toggle { display: flex; }
                    .search-btn-desktop { display: none; }
                }
            `}</style>
        </div>
    );
};

export default Members;
