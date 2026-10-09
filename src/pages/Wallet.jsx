import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    Wallet as WalletIcon, Zap, RefreshCw, Unplug, Copy, Check, Loader2,
    ArrowDownLeft, ArrowUpRight, AlertCircle,
} from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { useAuth } from '../context/AuthContext';
import { COINOS_ENABLED } from '../config/featureFlags';
import WalletConnect from '../components/WalletConnect';
import ReceiveModal from '../components/wallet/ReceiveModal';
import SendModal from '../components/wallet/SendModal';

const txTimeFmt = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function formatTxTime(iso) {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return txTimeFmt.format(d);
    } catch {
        return '';
    }
}

/**
 * /wallet — the built-in wallet page.
 *
 * Not connected: "Create your BIES wallet" (instant Coinos custodial wallet,
 * shown only while COINOS_ENABLED) + "Connect your own wallet" (embeds the
 * existing WalletConnect component — full reuse, no forked logic).
 *
 * Connected: balance card (+ lightning address chip), Receive/Send modals and
 * a recent-transactions list that hides itself when the backend can't list.
 */
const Wallet = () => {
    const { t } = useTranslation();
    const { user } = useAuth();
    const {
        connected, walletType, balance,
        createCoinos, disconnect, refreshBalance,
        listTransactions, receiveCapabilities,
    } = useWallet();

    const caps = receiveCapabilities
        || { canMakeInvoice: false, canListTransactions: false, lightningAddress: null };
    const coinosUsername = user?.profile?.coinosUsername || null;
    const blinkUsername = user?.profile?.blinkUsername || null;

    // ── STATE A: let useWallet's restore effect settle before deciding ──────
    const [settled, setSettled] = useState(false);
    useEffect(() => {
        const id = requestAnimationFrame(() => setSettled(true));
        return () => cancelAnimationFrame(id);
    }, []);

    // ── Create-wallet card (local busy/error, never the shared store) ───────
    const suggestedUsername = (user?.profile?.nip05Name || user?.name || '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toLowerCase()
        .slice(0, 24);
    const [username, setUsername] = useState(suggestedUsername);
    const [createBusy, setCreateBusy] = useState(false);
    const [createError, setCreateError] = useState(null);

    const handleCreate = async () => {
        const name = username.trim();
        if (!/^[a-zA-Z0-9]{2,24}$/.test(name)) {
            setCreateError(t('wallet.create.invalidUsername', 'Pick a username of 2-24 letters or numbers'));
            return;
        }
        setCreateBusy(true);
        setCreateError(null);
        try {
            await createCoinos(name);
            // Store flips to connected — the page switches to STATE C on its own.
        } catch (err) {
            setCreateError(err?.status === 409
                ? t('wallet.create.taken', 'That username is already taken')
                : (err?.message || t('wallet.create.failed', 'Could not create the wallet — please try again')));
        } finally {
            setCreateBusy(false);
        }
    };

    // ── Lightning address chip (copy with flash) ────────────────────────────
    const [addressCopied, setAddressCopied] = useState(false);
    const copyAddress = async () => {
        if (!caps.lightningAddress) return;
        try {
            await navigator.clipboard.writeText(caps.lightningAddress);
            setAddressCopied(true);
            setTimeout(() => setAddressCopied(false), 2000);
        } catch { /* clipboard unavailable — nothing to do */ }
    };

    // ── Modals ──────────────────────────────────────────────────────────────
    const [showReceive, setShowReceive] = useState(false);
    const [showSend, setShowSend] = useState(false);

    // ── Transactions (hidden gracefully only when genuinely unsupported) ────
    const [txStatus, setTxStatus] = useState('idle'); // idle | loading | ready | hidden | error
    const [txItems, setTxItems] = useState([]);
    // Server wallet credential expired (Coinos JWT / revoked Blink API key) —
    // the wallet needs to be reconnected.
    const [sessionExpired, setSessionExpired] = useState(false);

    const fetchTxs = useCallback(async () => {
        if (!connected || typeof listTransactions !== 'function') {
            setTxStatus('hidden');
            setTxItems([]);
            return;
        }
        setTxStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'));
        try {
            const { transactions, supported } = await listTransactions({ limit: 20 });
            if (supported === false) {
                setTxStatus('hidden');
                setTxItems([]);
            } else {
                setTxItems(Array.isArray(transactions) ? transactions : []);
                setTxStatus('ready');
            }
        } catch (err) {
            if (err?.message === 'wallet_token_expired') setSessionExpired(true);
            // Keep an already-visible list on a failed refresh (transient
            // relay hiccup) — only fall to 'error' when nothing loaded yet.
            setTxStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
        }
    }, [connected, listTransactions]);

    useEffect(() => {
        setSessionExpired(false);
        if (!connected) {
            setTxStatus('idle');
            setTxItems([]);
            return;
        }
        fetchTxs();
    }, [connected, walletType]);  

    const handleRefresh = () => {
        refreshBalance();
        fetchTxs();
    };

    const handlePaid = useCallback(() => {
        fetchTxs();
    }, [fetchTxs]);

    const handleDisconnect = () => {
        if (window.confirm(t('wallet.disconnectConfirm', 'Disconnect this wallet?'))) {
            disconnect();
        }
    };

    // Only the restore effect matters here — the store's `loading` flag is set
    // by connect/create actions, and folding it in would unmount the connect
    // UI (and its typed-in state) mid-connect.
    const restoring = !connected && !settled;
    const showReceiveBtn = caps.canMakeInvoice || !!caps.lightningAddress;
    const showTxSection = txStatus === 'loading' || txStatus === 'ready' || txStatus === 'error';

    return (
        <div className="wallet-page" data-testid="wallet-page">
            {/* Header */}
            <div className="w-header">
                <WalletIcon size={26} className="w-title-icon" />
                <h1>{t('wallet.title', 'Wallet')}</h1>
            </div>

            {restoring ? (
                <div className="w-loading" data-testid="wallet-loading">
                    <Loader2 size={28} className="w-spin" />
                </div>
            ) : !connected ? (
                <>
                    {/* STATE B.1 — instant custodial wallet */}
                    {COINOS_ENABLED && (
                        <div className="w-card" data-testid="wallet-create-card">
                            <h2 className="w-card-title">{t('wallet.create.title', 'Create your BIES wallet')}</h2>
                            <p className="w-card-sub">
                                {t('wallet.create.subtitle', 'Get an instant custodial Lightning wallet hosted at Coinos — pick a username and you can receive sats right away.')}
                            </p>
                            <div className="w-create-row">
                                <div className="w-username-wrap">
                                    <input
                                        type="text"
                                        className="w-input"
                                        data-testid="wallet-create-username"
                                        placeholder={t('wallet.create.usernamePlaceholder', 'username')}
                                        value={username}
                                        maxLength={24}
                                        disabled={createBusy}
                                        onChange={(e) => setUsername(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                                    />
                                    <span className="w-username-suffix">@coinos.io</span>
                                </div>
                                <button
                                    className="w-btn-primary"
                                    data-testid="wallet-create-btn"
                                    disabled={createBusy}
                                    onClick={handleCreate}
                                >
                                    {createBusy
                                        ? <><Loader2 size={15} className="w-spin" /> {t('wallet.create.creating', 'Creating...')}</>
                                        : <><Zap size={15} /> {t('wallet.create.submit', 'Create wallet')}</>}
                                </button>
                            </div>
                            <p className="w-hint">
                                {t('wallet.create.hint', '2-24 letters or numbers — this becomes your Lightning address.')}
                            </p>
                            {createError && (
                                <p className="w-error"><AlertCircle size={14} /> {createError}</p>
                            )}
                        </div>
                    )}

                    {/* STATE B.2 — bring your own wallet (full WalletConnect reuse) */}
                    <div className="w-card" data-testid="wallet-connect-card">
                        <h2 className="w-card-title">{t('wallet.connectOwn.title', 'Connect your own wallet')}</h2>
                        <p className="w-card-sub">
                            {t('wallet.connectOwn.subtitle', 'Link a Lightning wallet you already use — via Nostr Wallet Connect, an existing Coinos account, or a Blink API key.')}
                        </p>
                        <WalletConnect />
                    </div>
                </>
            ) : (
                <>
                    {/* Server wallet credential expired — balance/txs can't load until reconnect */}
                    {sessionExpired && (
                        <div className="w-card w-session-expired" data-testid="wallet-session-expired">
                            <AlertCircle size={18} />
                            <span>
                                {walletType === 'blink'
                                    ? t('wallet.sessionExpiredBannerBlink', 'Your Blink API key no longer works — reconnect your Blink wallet to keep using it.')
                                    : t('wallet.sessionExpiredBanner', 'Wallet session expired — reconnect your Coinos wallet to keep using it.')}
                            </span>
                            <Link to="/settings" className="w-reconnect-link">
                                {t('wallet.reconnect', 'Reconnect')}
                            </Link>
                        </div>
                    )}

                    {/* STATE C — balance card */}
                    <div className="w-card w-balance-card">
                        <div className="w-balance-top">
                            <div className="w-balance-info">
                                <p className="w-balance-figure" data-testid="wallet-balance">
                                    {balance != null
                                        ? `${Math.floor(balance / 1000).toLocaleString()} ${t('wallet.sats', 'sats')}`
                                        : '—'}
                                </p>
                                <p className="w-balance-sub">
                                    {walletType === 'coinos'
                                        ? `${t('wallet.biesWallet', 'BIES wallet')}${coinosUsername ? ` · @${coinosUsername}` : ''}`
                                        : walletType === 'blink'
                                            ? `${t('wallet.blinkWallet', 'Blink wallet')}${blinkUsername ? ` · @${blinkUsername}` : ''}`
                                            : t('wallet.nwcConnected', 'Connected via NWC')}
                                </p>
                            </div>
                            <button
                                className="w-icon-btn"
                                data-testid="wallet-refresh-btn"
                                title={t('wallet.refresh', 'Refresh')}
                                onClick={handleRefresh}
                            >
                                <RefreshCw size={16} />
                            </button>
                        </div>

                        {caps.lightningAddress && (
                            <button
                                className="w-address-chip"
                                data-testid="wallet-lightning-address"
                                title={t('wallet.copyAddress', 'Copy Lightning address')}
                                onClick={copyAddress}
                            >
                                <Zap size={13} />
                                <span className="w-address-text">{caps.lightningAddress}</span>
                                {addressCopied ? <Check size={13} /> : <Copy size={13} />}
                                {addressCopied && (
                                    <span className="w-address-flash">{t('wallet.copied', 'Copied')}</span>
                                )}
                                {/* blink only sets the address when it was empty, so a custom
                                    (non-wallet) address can sit under a blink connection too */}
                                {(walletType === 'nwc'
                                    || (walletType === 'blink'
                                        && !!blinkUsername
                                        && caps.lightningAddress !== `${blinkUsername}@blink.sv`)) && (
                                    <span className="w-address-note">{t('wallet.profileAddressNote', 'from your profile')}</span>
                                )}
                            </button>
                        )}

                        <button
                            className="w-disconnect"
                            data-testid="wallet-disconnect-btn"
                            onClick={handleDisconnect}
                        >
                            <Unplug size={13} /> {t('wallet.disconnect', 'Disconnect')}
                        </button>
                    </div>

                    {/* Action row */}
                    <div className="w-actions">
                        {showReceiveBtn && (
                            <button
                                className="w-action-btn w-action-receive"
                                data-testid="wallet-receive-btn"
                                onClick={() => setShowReceive(true)}
                            >
                                <ArrowDownLeft size={20} />
                                {t('wallet.receive.button', 'Receive')}
                            </button>
                        )}
                        <button
                            className="w-action-btn w-action-send"
                            data-testid="wallet-send-btn"
                            onClick={() => setShowSend(true)}
                        >
                            <ArrowUpRight size={20} />
                            {t('wallet.send.button', 'Send')}
                        </button>
                    </div>

                    {/* Transactions — hidden entirely only when unsupported */}
                    {showTxSection && (
                        <div className="w-card w-tx-section">
                            <h2 className="w-card-title">{t('wallet.tx.title', 'Transactions')}</h2>

                            {txStatus === 'error' && (
                                <div className="w-tx-error" data-testid="wallet-tx-error">
                                    <AlertCircle size={15} />
                                    <span>{t('wallet.tx.error', 'Could not load transactions')}</span>
                                    <button className="w-tx-retry" onClick={fetchTxs}>
                                        {t('wallet.tx.retry', 'Retry')}
                                    </button>
                                </div>
                            )}

                            {txStatus === 'loading' && (
                                <div className="w-tx-skeleton" data-testid="wallet-tx-loading">
                                    <div className="w-tx-skeleton-row" />
                                    <div className="w-tx-skeleton-row" />
                                    <div className="w-tx-skeleton-row" />
                                </div>
                            )}

                            {txStatus === 'ready' && txItems.length === 0 && (
                                <p className="w-tx-empty" data-testid="wallet-tx-empty">
                                    {t('wallet.tx.empty', 'No transactions yet')}
                                </p>
                            )}

                            {txStatus === 'ready' && txItems.length > 0 && (
                                <ul className="w-tx-list" data-testid="wallet-tx-list">
                                    {txItems.map((tx, i) => (
                                        <li
                                            key={tx.hash || `${tx.createdAt}-${i}`}
                                            className="w-tx-item"
                                            data-testid="wallet-tx-item"
                                        >
                                            <span className={`w-tx-icon ${tx.type === 'incoming' ? 'incoming' : 'outgoing'}`}>
                                                {tx.type === 'incoming'
                                                    ? <ArrowDownLeft size={16} />
                                                    : <ArrowUpRight size={16} />}
                                            </span>
                                            <div className="w-tx-main">
                                                <span className="w-tx-amount">
                                                    {tx.type === 'incoming' ? '+' : '-'}
                                                    {Number(tx.amountSats || 0).toLocaleString()} {t('wallet.sats', 'sats')}
                                                </span>
                                                {tx.memo && <span className="w-tx-memo">{tx.memo}</span>}
                                            </div>
                                            <span className="w-tx-time">{formatTxTime(tx.createdAt)}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </>
            )}

            <ReceiveModal
                open={showReceive}
                onClose={() => setShowReceive(false)}
                onPaid={handlePaid}
            />
            <SendModal
                open={showSend}
                onClose={() => setShowSend(false)}
                onPaid={handlePaid}
            />

            <style jsx>{`
                .wallet-page {
                    max-width: 720px;
                    width: 100%;
                    margin: 0 auto;
                    padding: 2rem 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 1.25rem;
                }

                .w-header {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                }

                .w-header h1 {
                    margin: 0;
                    font-size: 1.6rem;
                }

                .w-header :global(.w-title-icon) {
                    color: var(--color-secondary);
                    flex-shrink: 0;
                }

                .w-loading {
                    display: flex;
                    justify-content: center;
                    padding: 2.5rem 0;
                    color: var(--color-primary);
                }

                :global(.w-spin) {
                    animation: w-spin 1s linear infinite;
                }

                @keyframes w-spin {
                    to { transform: rotate(360deg); }
                }

                .w-card {
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    padding: 1.25rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.6rem;
                }

                .w-card-title {
                    margin: 0;
                    font-size: 1.05rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                }

                .w-card-sub {
                    margin: 0;
                    font-size: 0.85rem;
                    line-height: 1.5;
                    color: var(--color-gray-500);
                }

                /* ── Create card ────────────────────────────────────────── */
                .w-create-row {
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                    margin-top: 0.25rem;
                }

                .w-username-wrap {
                    flex: 1;
                    min-width: 220px;
                    display: flex;
                    align-items: center;
                    border: 1.5px solid var(--color-gray-300);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    padding-right: 0.6rem;
                    transition: border-color 0.15s;
                }

                .w-username-wrap:focus-within {
                    border-color: var(--color-primary);
                }

                .w-input {
                    flex: 1;
                    min-width: 0;
                    padding: 0.55rem 0.2rem 0.55rem 0.75rem;
                    border: none;
                    background: none;
                    outline: none;
                    font-size: 0.9rem;
                    font-family: monospace;
                    color: var(--color-gray-900);
                }

                .w-input::placeholder { color: var(--color-gray-400); }

                .w-username-suffix {
                    font-size: 0.85rem;
                    font-family: monospace;
                    color: var(--color-gray-400);
                    flex-shrink: 0;
                }

                .w-btn-primary {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.4rem;
                    padding: 0.55rem 1rem;
                    border: none;
                    border-radius: var(--radius-md);
                    background: var(--color-secondary);
                    color: white;
                    font-size: 0.88rem;
                    font-weight: 600;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: background 0.15s;
                }

                .w-btn-primary:hover:not(:disabled) {
                    background: var(--color-secondary-dark, #CC4A00);
                }

                .w-btn-primary:disabled { opacity: 0.6; cursor: wait; }

                .w-hint {
                    margin: 0;
                    font-size: 0.78rem;
                    color: var(--color-gray-400);
                }

                .w-error {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    margin: 0;
                    font-size: 0.82rem;
                    color: var(--color-error, #EF4444);
                }

                /* ── Session-expired banner ─────────────────────────────── */
                .w-session-expired {
                    flex-direction: row;
                    align-items: center;
                    gap: 0.6rem;
                    border-color: var(--color-warning, #f59e0b);
                    font-size: 0.85rem;
                    color: var(--color-gray-900);
                }

                .w-session-expired :global(svg) {
                    color: var(--color-warning, #f59e0b);
                    flex-shrink: 0;
                }

                .w-session-expired span { flex: 1; min-width: 0; }

                .w-session-expired :global(.w-reconnect-link) {
                    font-weight: 700;
                    color: var(--color-primary);
                    white-space: nowrap;
                }

                /* ── Balance card ───────────────────────────────────────── */
                .w-balance-top {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 0.75rem;
                }

                .w-balance-info {
                    display: flex;
                    flex-direction: column;
                    gap: 0.2rem;
                    min-width: 0;
                }

                .w-balance-figure {
                    margin: 0;
                    font-size: 2rem;
                    font-weight: 800;
                    line-height: 1.15;
                    color: var(--color-gray-900);
                }

                .w-balance-sub {
                    margin: 0;
                    font-size: 0.82rem;
                    color: var(--color-gray-500);
                }

                .w-icon-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0.45rem;
                    border: 1.5px solid var(--color-gray-300);
                    border-radius: var(--radius-full);
                    background: var(--color-surface);
                    color: var(--color-gray-500);
                    cursor: pointer;
                    flex-shrink: 0;
                    transition: all 0.15s;
                }

                .w-icon-btn:hover {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }

                .w-address-chip {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    align-self: flex-start;
                    max-width: 100%;
                    padding: 0.4rem 0.75rem;
                    border: 1.5px solid var(--color-gray-200);
                    border-radius: var(--radius-full);
                    background: var(--color-gray-100);
                    font-size: 0.8rem;
                    font-family: monospace;
                    color: var(--color-gray-600, var(--color-gray-500));
                    cursor: pointer;
                    transition: border-color 0.15s;
                }

                .w-address-chip:hover { border-color: var(--color-primary); }

                .w-address-chip :global(svg:first-child) { color: #f59e0b; flex-shrink: 0; }

                .w-address-text {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .w-address-flash {
                    font-family: inherit;
                    font-size: 0.72rem;
                    font-weight: 700;
                    color: var(--color-success, #22c55e);
                    flex-shrink: 0;
                }

                .w-address-note {
                    font-family: inherit;
                    font-size: 0.72rem;
                    color: var(--color-gray-400);
                    flex-shrink: 0;
                }

                .w-disconnect {
                    display: flex;
                    align-items: center;
                    gap: 0.3rem;
                    align-self: flex-start;
                    padding: 0;
                    border: none;
                    background: none;
                    font-size: 0.78rem;
                    font-weight: 600;
                    color: var(--color-gray-400);
                    cursor: pointer;
                }

                .w-disconnect:hover { color: var(--color-error, #EF4444); }

                /* ── Action row ─────────────────────────────────────────── */
                .w-actions {
                    display: flex;
                    gap: 0.75rem;
                }

                .w-action-btn {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.45rem;
                    padding: 0.9rem 1rem;
                    border: none;
                    border-radius: var(--radius-lg);
                    font-size: 1rem;
                    font-weight: 700;
                    color: white;
                    cursor: pointer;
                    transition: filter 0.15s;
                }

                .w-action-btn:hover { filter: brightness(0.92); }

                .w-action-receive { background: var(--color-success, #22c55e); }
                .w-action-send { background: var(--color-secondary); }

                /* ── Transactions ───────────────────────────────────────── */
                .w-tx-section { gap: 0.75rem; }

                .w-tx-skeleton {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                }

                .w-tx-skeleton-row {
                    height: 2.4rem;
                    border-radius: var(--radius-md);
                    background: var(--color-gray-100);
                    animation: w-pulse 1.4s ease-in-out infinite;
                }

                @keyframes w-pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.45; }
                }

                .w-tx-error {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.4rem 0;
                    font-size: 0.85rem;
                    color: var(--color-gray-500);
                }

                .w-tx-error :global(svg) {
                    color: var(--color-warning, #f59e0b);
                    flex-shrink: 0;
                }

                .w-tx-error span { flex: 1; min-width: 0; }

                .w-tx-retry {
                    padding: 0.35rem 0.75rem;
                    border: 1.5px solid var(--color-gray-300);
                    border-radius: var(--radius-full);
                    background: none;
                    font-size: 0.8rem;
                    font-weight: 600;
                    font-family: inherit;
                    color: var(--color-primary);
                    cursor: pointer;
                    flex-shrink: 0;
                }

                .w-tx-retry:hover { border-color: var(--color-primary); }

                .w-tx-empty {
                    margin: 0;
                    padding: 0.75rem 0;
                    font-size: 0.88rem;
                    color: var(--color-gray-500);
                    text-align: center;
                }

                .w-tx-list {
                    list-style: none;
                    margin: 0;
                    padding: 0;
                    display: flex;
                    flex-direction: column;
                }

                .w-tx-item {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0.6rem 0;
                    border-bottom: 1px solid var(--color-gray-100);
                }

                .w-tx-item:last-child { border-bottom: none; }

                .w-tx-icon {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 30px;
                    height: 30px;
                    border-radius: var(--radius-full);
                    background: var(--color-gray-100);
                    flex-shrink: 0;
                }

                .w-tx-icon.incoming { color: var(--color-success, #22c55e); }
                .w-tx-icon.outgoing { color: var(--color-secondary); }

                .w-tx-main {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 0.1rem;
                }

                .w-tx-amount {
                    font-size: 0.9rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                }

                .w-tx-memo {
                    font-size: 0.78rem;
                    color: var(--color-gray-500);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .w-tx-time {
                    font-size: 0.75rem;
                    color: var(--color-gray-400);
                    flex-shrink: 0;
                }

                @media (max-width: 768px) {
                    .wallet-page {
                        padding-bottom: calc(90px + env(safe-area-inset-bottom));
                    }
                }
            `}</style>
        </div>
    );
};

export default Wallet;
