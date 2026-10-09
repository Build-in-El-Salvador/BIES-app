import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { adminApi } from '../../services/api';
import {
    AlertCircle, Check, CheckCircle, ChevronDown, ChevronUp,
    Link as LinkIcon, Loader2, Plus, ShieldOff, X,
} from 'lucide-react';

/**
 * AdminVouchers — create and manage relay-access / onboarding vouchers.
 * Structure and utility classes modeled on AdminInvestorVetting.jsx.
 */
const AdminVouchers = () => {
    const { t } = useTranslation();

    const [vouchers, setVouchers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [creating, setCreating] = useState(false);
    const [form, setForm] = useState({
        type: 'RELAY_ACCESS', label: '', priceSats: '', maxUses: '', expiresAt: '', code: '', notes: '',
    });
    const [copiedId, setCopiedId] = useState(null);
    const [expandedId, setExpandedId] = useState(null);
    const [redemptionsById, setRedemptionsById] = useState({});
    const [redemptionsLoading, setRedemptionsLoading] = useState(false);
    // { kind: 'voucher' | 'redemption', id } — pending revoke awaiting confirm
    const [revokeTarget, setRevokeTarget] = useState(null);
    const [revokeAccess, setRevokeAccess] = useState(false);
    const [revoking, setRevoking] = useState(false);

    useEffect(() => {
        fetchVouchers();
    }, []);

    const fetchVouchers = async () => {
        setLoading(true);
        try {
            const res = await adminApi.listVouchers();
            setVouchers(Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []);
        } catch (err) {
            setError(err.message || 'Failed to fetch vouchers');
        } finally {
            setLoading(false);
        }
    };

    const setField = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

    const handleCreate = async (e) => {
        e.preventDefault();
        setError('');
        setCreating(true);
        try {
            const payload = { type: form.type };
            if (form.label.trim()) payload.label = form.label.trim();
            if (form.type === 'RELAY_ACCESS' && form.priceSats !== '') payload.priceSats = Number(form.priceSats);
            if (form.maxUses !== '') payload.maxUses = Number(form.maxUses);
            if (form.expiresAt) payload.expiresAt = new Date(form.expiresAt).toISOString();
            if (form.code.trim()) payload.code = form.code.trim();
            if (form.notes.trim()) payload.notes = form.notes.trim();
            await adminApi.createVoucher(payload);
            setForm({ type: 'RELAY_ACCESS', label: '', priceSats: '', maxUses: '', expiresAt: '', code: '', notes: '' });
            await fetchVouchers();
        } catch (err) {
            setError(err.message || 'Failed to create voucher');
        } finally {
            setCreating(false);
        }
    };

    const voucherLink = (v) =>
        `${window.location.origin}${v.type === 'ONBOARDING' ? '/join/' : '/access/'}${v.code}`;

    const copyLink = (v) => {
        navigator.clipboard.writeText(voucherLink(v));
        setCopiedId(v.id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const toggleExpand = async (id) => {
        if (expandedId === id) {
            setExpandedId(null);
            return;
        }
        setExpandedId(id);
        setRevokeTarget(null);
        if (!redemptionsById[id]) {
            setRedemptionsLoading(true);
            try {
                const res = await adminApi.voucherRedemptions(id);
                const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
                setRedemptionsById((prev) => ({ ...prev, [id]: list }));
            } catch (err) {
                setError(err.message || 'Failed to fetch redemptions');
            } finally {
                setRedemptionsLoading(false);
            }
        }
    };

    const startRevoke = (kind, id) => {
        setRevokeTarget({ kind, id });
        setRevokeAccess(false);
    };

    const confirmRevoke = async () => {
        if (!revokeTarget) return;
        setRevoking(true);
        setError('');
        try {
            if (revokeTarget.kind === 'voucher') {
                await adminApi.revokeVoucher(revokeTarget.id, revokeAccess);
                await fetchVouchers();
            } else {
                await adminApi.revokeRedemption(revokeTarget.id, revokeAccess);
                // Refresh the expanded voucher's redemption list
                if (expandedId) {
                    const res = await adminApi.voucherRedemptions(expandedId);
                    const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
                    setRedemptionsById((prev) => ({ ...prev, [expandedId]: list }));
                }
            }
            setRevokeTarget(null);
        } catch (err) {
            setError(err.message || 'Failed to revoke');
        } finally {
            setRevoking(false);
        }
    };

    const isRevoked = (v) => v.status === 'REVOKED' || !!v.revokedAt;
    const getUseCount = (v) => v.useCount ?? v._count?.redemptions ?? v.redemptionCount ?? 0;
    const truncate = (s, n = 16) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

    const renderRevokeConfirm = () => (
        <div className="revoke-confirm">
            <span className="text-sm font-medium">{t('admin.vouchers.revokeConfirm')}</span>
            <label className="revoke-access-label">
                <input
                    type="checkbox"
                    checked={revokeAccess}
                    onChange={(e) => setRevokeAccess(e.target.checked)}
                />
                {t('admin.vouchers.revokeAccess')}
            </label>
            <div className="flex items-center gap-2">
                <button
                    onClick={confirmRevoke}
                    disabled={revoking}
                    className="p-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded-lg transition-colors disabled:opacity-50"
                    title={t('admin.vouchers.revoke')}
                >
                    {revoking ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                </button>
                <button
                    onClick={() => setRevokeTarget(null)}
                    disabled={revoking}
                    className="p-1.5 bg-gray-50 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                    title="Cancel"
                >
                    <X size={16} />
                </button>
            </div>
        </div>
    );

    if (loading) {
        return (
            <div className="flex justify-center items-center h-64">
                <Loader2 size={32} className="animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="admin-view vouchers-page">
            <h1 className="text-2xl font-bold mb-6">{t('admin.vouchers.title')}</h1>

            {error && (
                <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-6 flex items-center gap-2">
                    <AlertCircle size={20} /> {error}
                </div>
            )}

            {/* Create form */}
            <form onSubmit={handleCreate} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-6">
                <div className="create-grid">
                    <label className="create-field">
                        <span className="create-label">{t('admin.vouchers.type')}</span>
                        <select value={form.type} onChange={setField('type')} className="create-input">
                            <option value="RELAY_ACCESS">{t('admin.vouchers.typeRelay')}</option>
                            <option value="ONBOARDING">{t('admin.vouchers.typeOnboarding')}</option>
                        </select>
                    </label>
                    <label className="create-field">
                        <span className="create-label">{t('admin.vouchers.label')}</span>
                        <input type="text" value={form.label} onChange={setField('label')} className="create-input" maxLength={80} />
                    </label>
                    <label className="create-field">
                        <span className="create-label">{t('admin.vouchers.price')}</span>
                        <input
                            type="number"
                            min="0"
                            value={form.type === 'ONBOARDING' ? '' : form.priceSats}
                            onChange={setField('priceSats')}
                            disabled={form.type === 'ONBOARDING'}
                            className="create-input"
                        />
                    </label>
                    <label className="create-field">
                        <span className="create-label">{t('admin.vouchers.maxUses')} (0 = {t('admin.vouchers.unlimited')})</span>
                        <input
                            type="number"
                            min="0"
                            value={form.maxUses}
                            onChange={setField('maxUses')}
                            placeholder={form.type === 'ONBOARDING' ? t('admin.vouchers.unlimited') : '1'}
                            className="create-input"
                        />
                    </label>
                    <label className="create-field">
                        <span className="create-label">{t('admin.vouchers.expiry')}</span>
                        <input type="datetime-local" value={form.expiresAt} onChange={setField('expiresAt')} className="create-input" />
                    </label>
                    <label className="create-field">
                        <span className="create-label">{t('admin.vouchers.customCode')}</span>
                        <input type="text" value={form.code} onChange={setField('code')} className="create-input" maxLength={64} />
                    </label>
                    <label className="create-field create-field-wide">
                        <span className="create-label">{t('admin.vouchers.notes')}</span>
                        <input type="text" value={form.notes} onChange={setField('notes')} className="create-input" maxLength={300} />
                    </label>
                </div>
                <button
                    type="submit"
                    disabled={creating}
                    className="create-submit"
                >
                    {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                    {t('admin.vouchers.create')}
                </button>
            </form>

            {/* Voucher table */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                {vouchers.length === 0 ? (
                    <div className="p-8 text-center text-gray-500">
                        {t('admin.vouchers.empty')}
                    </div>
                ) : (
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-gray-50 border-b border-gray-200">
                                <th className="p-4 font-semibold text-gray-700">{t('admin.vouchers.code')}</th>
                                <th className="p-4 font-semibold text-gray-700">{t('admin.vouchers.type')}</th>
                                <th className="p-4 font-semibold text-gray-700">{t('admin.vouchers.label')}</th>
                                <th className="p-4 font-semibold text-gray-700">{t('admin.vouchers.price')}</th>
                                <th className="p-4 font-semibold text-gray-700">{t('admin.vouchers.uses')}</th>
                                <th className="p-4 font-semibold text-gray-700">{t('admin.vouchers.status')}</th>
                                <th className="p-4 font-semibold text-gray-700">{t('admin.vouchers.created')}</th>
                                <th className="p-4 font-semibold text-gray-700 text-right">{t('admin.vouchers.actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {vouchers.map((v) => (
                                <React.Fragment key={v.id}>
                                    <tr className="voucher-row border-b border-gray-100 last:border-0 hover:bg-gray-50/50">
                                        <td className="p-4 voucher-code-cell">
                                            <span className="font-mono text-sm">{truncate(v.code, 20)}</span>
                                        </td>
                                        <td className="p-4 voucher-cell" data-label={t('admin.vouchers.type')}>
                                            <span className="text-sm">
                                                {v.type === 'ONBOARDING' ? t('admin.vouchers.typeOnboarding') : t('admin.vouchers.typeRelay')}
                                            </span>
                                        </td>
                                        <td className="p-4 voucher-cell" data-label={t('admin.vouchers.label')}>
                                            <span className="text-sm text-gray-600">{v.label || '—'}</span>
                                        </td>
                                        <td className="p-4 voucher-cell" data-label={t('admin.vouchers.price')}>
                                            <span className="text-sm whitespace-nowrap">
                                                {v.priceSats > 0 ? `${Number(v.priceSats).toLocaleString()} sats` : '—'}
                                            </span>
                                        </td>
                                        <td className="p-4 voucher-cell" data-label={t('admin.vouchers.uses')}>
                                            <span className="text-sm whitespace-nowrap">
                                                {getUseCount(v)} / {!v.maxUses ? t('admin.vouchers.unlimited') : v.maxUses}
                                            </span>
                                        </td>
                                        <td className="p-4 voucher-cell" data-label={t('admin.vouchers.status')}>
                                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                                                ${isRevoked(v) ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}`}
                                            >
                                                {isRevoked(v) ? t('admin.vouchers.statusRevoked') : t('admin.vouchers.statusActive')}
                                            </span>
                                        </td>
                                        <td className="p-4 voucher-cell" data-label={t('admin.vouchers.created')}>
                                            <span className="text-sm whitespace-nowrap">
                                                {v.createdAt ? new Date(v.createdAt).toLocaleDateString() : '—'}
                                            </span>
                                        </td>
                                        <td className="p-4 text-right voucher-actions">
                                            {revokeTarget?.kind === 'voucher' && revokeTarget.id === v.id ? (
                                                renderRevokeConfirm()
                                            ) : (
                                                <div className="flex items-center justify-end gap-2">
                                                    <button
                                                        onClick={() => copyLink(v)}
                                                        className="p-1.5 bg-gray-50 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                                        title={copiedId === v.id ? t('admin.vouchers.linkCopied') : t('admin.vouchers.copyLink')}
                                                    >
                                                        {copiedId === v.id ? <CheckCircle size={18} /> : <LinkIcon size={18} />}
                                                    </button>
                                                    <button
                                                        onClick={() => toggleExpand(v.id)}
                                                        className="p-1.5 bg-gray-50 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                                        title={t('admin.vouchers.redemptions')}
                                                    >
                                                        {expandedId === v.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                                                    </button>
                                                    {!isRevoked(v) && (
                                                        <button
                                                            onClick={() => startRevoke('voucher', v.id)}
                                                            className="p-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded-lg transition-colors"
                                                            title={t('admin.vouchers.revoke')}
                                                        >
                                                            <ShieldOff size={18} />
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                    {expandedId === v.id && (
                                        <tr className="redemptions-row border-b border-gray-100 last:border-0">
                                            <td className="p-4 bg-gray-50" colSpan={8}>
                                                <div className="text-sm font-semibold text-gray-700 mb-2">
                                                    {t('admin.vouchers.redemptions')}
                                                </div>
                                                {redemptionsLoading && !redemptionsById[v.id] ? (
                                                    <Loader2 size={18} className="animate-spin text-gray-500" />
                                                ) : (redemptionsById[v.id] || []).length === 0 ? (
                                                    <div className="text-sm text-gray-500">—</div>
                                                ) : (
                                                    <div className="redemption-list">
                                                        {redemptionsById[v.id].map((r) => (
                                                            <div key={r.id} className="redemption-item">
                                                                <span className="font-mono text-xs redemption-pubkey">
                                                                    {r.user?.profile?.name || truncate(r.pubkey, 24) || t('admin.vouchers.anonymousSignup')}
                                                                </span>
                                                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                                                                    ${r.status === 'COMPLETED' ? 'bg-green-100 text-green-800' :
                                                                      r.status === 'REVOKED' ? 'bg-red-100 text-red-800' :
                                                                      'bg-yellow-100 text-yellow-800'}`}
                                                                >
                                                                    {r.status}
                                                                </span>
                                                                <span className="text-xs text-gray-500 whitespace-nowrap">
                                                                    {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}
                                                                </span>
                                                                {revokeTarget?.kind === 'redemption' && revokeTarget.id === r.id ? (
                                                                    renderRevokeConfirm()
                                                                ) : r.status === 'COMPLETED' ? (
                                                                    <button
                                                                        onClick={() => startRevoke('redemption', r.id)}
                                                                        className="p-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded-lg transition-colors"
                                                                        title={t('admin.vouchers.revoke')}
                                                                    >
                                                                        <ShieldOff size={16} />
                                                                    </button>
                                                                ) : null}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/*
              Rows and the confirm widget come from .map / helper closures,
              which the styled-jsx babel plugin does not scope — so all rules
              are written as `.vouchers-page :global(...)` (see Leaderboard.jsx).
            */}
            <style jsx>{`
              .vouchers-page :global(.w-full) { width: 100%; }
              .vouchers-page :global(.text-left) { text-align: left; }
              .vouchers-page :global(.border-collapse) { border-collapse: collapse; }
              .vouchers-page :global(.bg-gray-50) { background-color: var(--color-gray-50); }
              .vouchers-page :global(.border) { border-width: 1px; border-style: solid; }
              .vouchers-page :global(.border-b) { border-bottom-width: 1px; border-bottom-style: solid; }
              .vouchers-page :global(.border-gray-200) { border-color: var(--color-gray-200); }
              .vouchers-page :global(.border-gray-100) { border-color: var(--color-gray-100); }
              .vouchers-page :global(.p-4) { padding: 1rem; }
              .vouchers-page :global(.p-8) { padding: 2rem; }
              .vouchers-page :global(.font-semibold) { font-weight: 600; }
              .vouchers-page :global(.text-gray-700) { color: var(--color-gray-700); }
              .vouchers-page :global(.text-right) { text-align: right; }
              .vouchers-page :global(.text-center) { text-align: center; }
              .vouchers-page :global(.hover\\:bg-gray-50\\/50:hover) { background-color: var(--color-gray-100); }
              .vouchers-page :global(.font-medium) { font-weight: 500; }
              .vouchers-page :global(.text-xs) { font-size: 0.75rem; }
              .vouchers-page :global(.text-sm) { font-size: 0.875rem; }
              .vouchers-page :global(.text-gray-500) { color: var(--color-gray-500); }
              .vouchers-page :global(.text-gray-600) { color: var(--color-gray-600); }
              .vouchers-page :global(.font-mono) { font-family: monospace; }
              .vouchers-page :global(.mb-2) { margin-bottom: 0.5rem; }
              .vouchers-page :global(.mb-6) { margin-bottom: 1.5rem; }
              .vouchers-page :global(.whitespace-nowrap) { white-space: nowrap; }
              .vouchers-page :global(.inline-flex) { display: inline-flex; }
              .vouchers-page :global(.items-center) { align-items: center; }
              .vouchers-page :global(.justify-center) { justify-content: center; }
              .vouchers-page :global(.justify-end) { justify-content: flex-end; }
              .vouchers-page :global(.px-2\\.5) { padding-left: 0.625rem; padding-right: 0.625rem; }
              .vouchers-page :global(.py-0\\.5) { padding-top: 0.125rem; padding-bottom: 0.125rem; }
              .vouchers-page :global(.rounded-full) { border-radius: 9999px; }
              .vouchers-page :global(.rounded-lg) { border-radius: 0.5rem; }
              .vouchers-page :global(.rounded-xl) { border-radius: 0.75rem; }
              .vouchers-page :global(.bg-green-100) { background-color: var(--badge-success-bg); }
              .vouchers-page :global(.text-green-800) { color: var(--badge-success-text); }
              .vouchers-page :global(.bg-red-100) { background-color: var(--badge-error-bg); }
              .vouchers-page :global(.text-red-800) { color: var(--badge-error-text); }
              .vouchers-page :global(.bg-yellow-100) { background-color: var(--badge-warning-bg); }
              .vouchers-page :global(.text-yellow-800) { color: var(--badge-warning-text); }
              .vouchers-page :global(.bg-red-50) { background-color: var(--color-red-tint); }
              .vouchers-page :global(.text-red-600) { color: var(--badge-error-text); }
              .vouchers-page :global(.hover\\:bg-red-100:hover) { background-color: var(--badge-error-bg); }
              .vouchers-page :global(.hover\\:bg-gray-100:hover) { background-color: var(--color-gray-100); }
              .vouchers-page :global(.transition-colors) { transition-property: color, background-color, border-color; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms; }
              .vouchers-page :global(.flex) { display: flex; }
              .vouchers-page :global(.gap-2) { gap: 0.5rem; }
              .vouchers-page :global(.p-1\\.5) { padding: 0.375rem; border: none; cursor: pointer; }
              .vouchers-page :global(.disabled\\:opacity-50:disabled) { opacity: 0.5; }
              .vouchers-page :global(.bg-white) { background-color: var(--color-surface); }
              .vouchers-page :global(.overflow-hidden) { overflow: hidden; }
              .vouchers-page :global(.shadow-sm) { box-shadow: var(--shadow-sm); }
              .vouchers-page :global(.text-2xl) { font-size: 1.5rem; line-height: 2rem; }
              .vouchers-page :global(.font-bold) { font-weight: 700; }
              .vouchers-page :global(.h-64) { height: 16rem; }
              .vouchers-page :global(.animate-spin) { animation: av-spin 1s linear infinite; }
              @keyframes av-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

              /* Create form */
              .vouchers-page :global(.create-grid) {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 0.75rem;
                margin-bottom: 0.75rem;
              }
              .vouchers-page :global(.create-field) {
                display: flex;
                flex-direction: column;
                gap: 0.25rem;
                min-width: 0;
              }
              .vouchers-page :global(.create-field-wide) { grid-column: 1 / -1; }
              .vouchers-page :global(.create-label) {
                font-size: 0.75rem;
                font-weight: 600;
                color: var(--color-gray-500);
                text-transform: uppercase;
                letter-spacing: 0.03em;
              }
              .vouchers-page :global(.create-input) {
                width: 100%;
                box-sizing: border-box;
                padding: 0.5rem 0.75rem;
                border: 1px solid var(--color-gray-200);
                border-radius: 0.5rem;
                font-size: 0.875rem;
                background: var(--color-surface);
                color: var(--color-text, inherit);
                outline: none;
                transition: border-color 0.2s;
              }
              .vouchers-page :global(.create-input:focus) { border-color: var(--color-primary); }
              .vouchers-page :global(.create-input:disabled) { opacity: 0.5; background: var(--color-gray-50); }
              .vouchers-page :global(.create-submit) {
                display: inline-flex;
                align-items: center;
                gap: 0.4rem;
                background: var(--color-primary);
                color: white;
                border: none;
                border-radius: 9999px;
                padding: 0.55rem 1.25rem;
                font-size: 0.875rem;
                font-weight: 600;
                cursor: pointer;
                transition: opacity 0.2s;
              }
              .vouchers-page :global(.create-submit:hover) { opacity: 0.9; }
              .vouchers-page :global(.create-submit:disabled) { opacity: 0.5; cursor: not-allowed; }

              /* Revoke confirm */
              .vouchers-page :global(.revoke-confirm) {
                display: inline-flex;
                align-items: center;
                justify-content: flex-end;
                gap: 0.6rem;
                flex-wrap: wrap;
                background: var(--color-red-tint);
                border: 1px solid var(--badge-error-bg);
                border-radius: 0.5rem;
                padding: 0.4rem 0.6rem;
              }
              .vouchers-page :global(.revoke-access-label) {
                display: inline-flex;
                align-items: center;
                gap: 0.3rem;
                font-size: 0.75rem;
                color: var(--color-gray-600);
                cursor: pointer;
                white-space: nowrap;
              }

              /* Redemptions */
              .vouchers-page :global(.redemption-list) {
                display: flex;
                flex-direction: column;
                gap: 0.4rem;
              }
              .vouchers-page :global(.redemption-item) {
                display: flex;
                align-items: center;
                gap: 0.75rem;
                flex-wrap: wrap;
              }
              .vouchers-page :global(.redemption-pubkey) {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
              }

              @media (max-width: 768px) {
                .vouchers-page :global(.text-2xl) { font-size: 1.25rem; }
                .vouchers-page :global(.create-grid) { grid-template-columns: 1fr; }
                .vouchers-page :global(table),
                .vouchers-page :global(tbody),
                .vouchers-page :global(tr),
                .vouchers-page :global(th),
                .vouchers-page :global(td) { display: block; }
                .vouchers-page :global(thead) { display: none; }
                .vouchers-page :global(.voucher-row) {
                  background: var(--color-surface);
                  border: 1px solid var(--color-gray-200);
                  border-radius: var(--radius-lg, 0.75rem);
                  padding: 1rem;
                  margin-bottom: 0.75rem;
                }
                .vouchers-page :global(.voucher-code-cell) {
                  padding: 0 0 0.5rem 0;
                  margin-bottom: 0.25rem;
                  border-bottom: 1px solid var(--color-gray-100);
                }
                .vouchers-page :global(.voucher-cell) {
                  display: flex;
                  align-items: flex-start;
                  padding: 0.3rem 0;
                  gap: 0.5rem;
                }
                .vouchers-page :global(.voucher-cell::before) {
                  content: attr(data-label);
                  font-weight: 600;
                  font-size: 0.7rem;
                  color: var(--color-gray-400);
                  text-transform: uppercase;
                  letter-spacing: 0.05em;
                  min-width: 68px;
                  flex-shrink: 0;
                  padding-top: 0.1rem;
                }
                .vouchers-page :global(.voucher-actions) {
                  padding: 0.5rem 0 0 0;
                  margin-top: 0.25rem;
                  border-top: 1px solid var(--color-gray-100);
                  text-align: left;
                }
                .vouchers-page :global(.voucher-actions .justify-end) { justify-content: flex-start; }
                .vouchers-page :global(.redemptions-row) {
                  margin: -0.5rem 0 0.75rem;
                }
                .vouchers-page :global(.redemptions-row td) {
                  border: 1px solid var(--color-gray-200);
                  border-radius: var(--radius-lg, 0.75rem);
                }
              }
            `}</style>
        </div>
    );
};

export default AdminVouchers;
