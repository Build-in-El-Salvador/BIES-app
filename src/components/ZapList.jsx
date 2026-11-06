import React, { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { zapsApi } from '../services/api';
import InitialAvatar from './InitialAvatar';

const ZapList = ({ projectId, pubkey, limit = 5 }) => {
    const [zaps, setZaps] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        const fetchZaps = async () => {
            try {
                let result;
                if (projectId) {
                    result = await zapsApi.projectZaps(projectId, { limit });
                } else if (pubkey) {
                    result = await zapsApi.userZaps(pubkey, { limit });
                } else {
                    setLoading(false);
                    return;
                }
                if (!cancelled) {
                    setZaps(result?.data || result || []);
                }
            } catch {
                // silently fail
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        fetchZaps();
        return () => { cancelled = true; };
    }, [projectId, pubkey, limit]);

    if (loading || zaps.length === 0) return null;

    const formatTimeAgo = (dateStr) => {
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    };

    const formatSats = (val) => {
        if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
        if (val >= 1000) return `${(val / 1000).toFixed(1)}k`;
        return String(val);
    };

    return (
        <div className="zap-list-card">
            <div className="zap-list-header">
                <Zap size={16} style={{ color: '#f7931a' }} />
                <span>Recent Zaps</span>
            </div>
            <div className="zap-list-items">
                {zaps.map((zap, i) => (
                    <div key={zap.id || i} className="zap-list-item">
                        <div className="zap-list-avatar">
                            {zap.senderAvatar ? (
                                <img src={zap.senderAvatar} alt="" />
                            ) : (
                                <InitialAvatar name={zap.senderName} />
                            )}
                        </div>
                        <div className="zap-list-info">
                            <span className="zap-list-name">{zap.senderName || 'Anonymous'}</span>
                            {zap.comment && <span className="zap-list-comment">{zap.comment}</span>}
                        </div>
                        <div className="zap-list-right">
                            <span className="zap-list-amount">{formatSats(zap.amountSats || 0)} sats</span>
                            {zap.createdAt && <span className="zap-list-time">{formatTimeAgo(zap.createdAt)}</span>}
                        </div>
                    </div>
                ))}
            </div>

            <style>{`
                .zap-list-card {
                    background: white;
                    border-radius: var(--radius-lg, 12px);
                    box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.08));
                    overflow: hidden;
                }
                .zap-list-header {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 1rem 1.25rem;
                    font-weight: 600;
                    font-size: 0.95rem;
                    border-bottom: 1px solid var(--color-gray-100, #f3f4f6);
                }
                .zap-list-items {
                    padding: 0.5rem 0;
                }
                .zap-list-item {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0.6rem 1.25rem;
                }
                .zap-list-item:hover {
                    background: var(--color-gray-50, #f9fafb);
                }
                .zap-list-avatar {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    background: #fff7ed;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                    overflow: hidden;
                }
                .zap-list-avatar img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }
                .zap-list-info {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                }
                .zap-list-name {
                    font-weight: 600;
                    font-size: 0.85rem;
                    color: var(--color-gray-800, #1f2937);
                }
                .zap-list-comment {
                    font-size: 0.8rem;
                    color: var(--color-gray-500, #6b7280);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .zap-list-right {
                    text-align: right;
                    flex-shrink: 0;
                }
                .zap-list-amount {
                    display: block;
                    font-weight: 700;
                    font-size: 0.85rem;
                    color: #f7931a;
                }
                .zap-list-time {
                    display: block;
                    font-size: 0.75rem;
                    color: var(--color-gray-400, #9ca3af);
                }
            `}</style>
        </div>
    );
};

export default ZapList;
