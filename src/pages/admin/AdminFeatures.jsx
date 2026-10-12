import React, { useState, useEffect } from 'react';
import { Loader2, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { flagsApi, adminApi } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import { FEATURE_SLUGS, DEFAULT_FLAGS } from '../../config/featureSlugs';

/**
 * Admin > Features — runtime feature toggles. Each row is instant-save with
 * optimistic UI (reverted on error). Only true admins (`isAdmin`) can flip
 * toggles — the API rejects MODs, so the switches render disabled for them.
 */
const AdminFeatures = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const { refresh: refreshGlobalFlags } = useFeatureFlags();
    const isAdmin = Boolean(user?.isAdmin);

    const [flags, setFlags] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState({}); // slug -> true while a save is in flight
    const [status, setStatus] = useState(null);

    useEffect(() => {
        flagsApi.get()
            .then((res) => setFlags({ ...DEFAULT_FLAGS, ...(res || {}) }))
            .catch(() => setFlags({ ...DEFAULT_FLAGS }))
            .finally(() => setLoading(false));
    }, []);

    const toggle = async (slug) => {
        if (!isAdmin || !flags || saving[slug]) return;
        const next = !(flags[slug] !== false);

        // Optimistic update…
        setFlags((prev) => ({ ...prev, [slug]: next }));
        setSaving((prev) => ({ ...prev, [slug]: true }));
        setStatus(null);
        try {
            const updated = await adminApi.updateFlags({ [slug]: next });
            if (updated && typeof updated === 'object') {
                setFlags({ ...DEFAULT_FLAGS, ...updated });
            }
            // Refresh the app-wide context so the admin sees the change
            // immediately (nav/routes react without a reload).
            refreshGlobalFlags();
        } catch {
            // …revert on error.
            setFlags((prev) => ({ ...prev, [slug]: !next }));
            setStatus({
                type: 'error',
                message: t('features.saveError', { name: t(`features.slugs.${slug}.name`) }),
            });
        } finally {
            setSaving((prev) => ({ ...prev, [slug]: false }));
        }
    };

    if (loading || !flags) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
        );
    }

    return (
        <>
            <div className="header">
                <div>
                    <h1>{t('features.title')}</h1>
                    <p className="subtitle">{t('features.subtitle')}</p>
                </div>
            </div>

            <div className="propagation-note">
                <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{t('features.propagationNote')}</span>
            </div>
            <div className="propagation-note">
                <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{t('features.appNote')}</span>
            </div>

            {!isAdmin && (
                <div className="status-msg error">{t('features.adminOnly')}</div>
            )}
            {status && (
                <div className={`status-msg ${status.type}`}>{status.message}</div>
            )}

            <div className="settings-card">
                {FEATURE_SLUGS.map((slug) => {
                    const enabled = flags[slug] !== false;
                    return (
                        <div key={slug} className="feature-row" data-testid={`feature-row-${slug}`}>
                            <div className="feature-info">
                                <span className="feature-name">{t(`features.slugs.${slug}.name`)}</span>
                                <span className="feature-desc">{t(`features.slugs.${slug}.description`)}</span>
                            </div>
                            <label className={`switch ${!isAdmin || saving[slug] ? 'switch-disabled' : ''}`}>
                                <input
                                    type="checkbox"
                                    role="switch"
                                    checked={enabled}
                                    disabled={!isAdmin || Boolean(saving[slug])}
                                    onChange={() => toggle(slug)}
                                    aria-label={t(`features.slugs.${slug}.name`)}
                                    data-testid={`feature-toggle-${slug}`}
                                />
                                <span className="switch-track"><span className="switch-thumb" /></span>
                                <span className={`switch-state ${enabled ? 'on' : 'off'}`}>
                                    {enabled ? t('features.enabled') : t('features.disabled')}
                                </span>
                            </label>
                        </div>
                    );
                })}
            </div>

            <style jsx>{`
                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 1.25rem;
                }
                .header h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
                .subtitle { color: var(--color-gray-500); font-size: 0.9rem; }

                .propagation-note {
                    display: flex;
                    gap: 0.6rem;
                    align-items: flex-start;
                    padding: 0.75rem 1rem;
                    border-radius: var(--radius-md);
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                    font-size: 0.85rem;
                    margin-bottom: 1.5rem;
                }

                .status-msg {
                    padding: 0.75rem 1rem;
                    border-radius: var(--radius-md);
                    margin-bottom: 1.5rem;
                    font-size: 0.9rem;
                }
                .status-msg.error { background: var(--color-red-tint); color: var(--badge-error-text); border: 1px solid var(--badge-error-bg); }

                .settings-card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    padding: 0.5rem 1.5rem;
                }

                .feature-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 1rem;
                    padding: 1rem 0;
                    border-bottom: 1px solid var(--color-gray-100);
                }
                .feature-row:last-child { border-bottom: none; }

                .feature-info {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    min-width: 0;
                }
                .feature-name { font-weight: 600; font-size: 0.95rem; }
                .feature-desc { color: var(--color-gray-500); font-size: 0.82rem; }

                .switch {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.6rem;
                    cursor: pointer;
                    flex-shrink: 0;
                }
                .switch-disabled { cursor: not-allowed; opacity: 0.55; }

                .switch input {
                    position: absolute;
                    opacity: 0;
                    width: 0;
                    height: 0;
                }

                .switch-track {
                    display: inline-flex;
                    align-items: center;
                    width: 42px;
                    height: 24px;
                    border-radius: 999px;
                    background: var(--color-gray-300);
                    padding: 3px;
                    transition: background 0.2s;
                }
                .switch input:checked + .switch-track {
                    background: var(--color-success, #16a34a);
                }
                .switch input:focus-visible + .switch-track {
                    outline: 2px solid var(--color-primary);
                    outline-offset: 2px;
                }

                .switch-thumb {
                    width: 18px;
                    height: 18px;
                    border-radius: 50%;
                    background: white;
                    box-shadow: var(--shadow-sm);
                    transition: transform 0.2s;
                }
                .switch input:checked + .switch-track .switch-thumb {
                    transform: translateX(18px);
                }

                .switch-state {
                    font-size: 0.8rem;
                    font-weight: 600;
                    min-width: 62px;
                }
                .switch-state.on { color: var(--color-success, #16a34a); }
                .switch-state.off { color: var(--color-gray-500); }

                @media (max-width: 768px) {
                    .header h1 { font-size: 1.25rem; }
                    .settings-card { padding: 0.25rem 1rem; }
                    .switch-state { display: none; }
                }
            `}</style>
        </>
    );
};

export default AdminFeatures;
