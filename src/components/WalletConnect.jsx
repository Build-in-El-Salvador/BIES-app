/**
 * WalletConnect — Settings component for wallet management.
 *
 * Supports two wallet types:
 *  1. NWC (NIP-47 Nostr Wallet Connect) — paste URI from Alby Hub, Coinos,
 *     Primal, Zeus, or any NWC-compatible wallet.
 *  2. Coinos — connect existing account or view auto-provisioned wallet.
 *
 * Blink was removed after its custodial accounts were breached (Sept 2026).
 */

import { useState } from 'react';
import {
    Wallet, Unplug, Zap, RefreshCw, CheckCircle, AlertCircle,
    ClipboardPaste, ExternalLink, Loader2, ShieldCheck,
} from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { COINOS_ENABLED } from '../config/featureFlags';

// Per-wallet "where do I find my NWC string?" guides
const WALLET_GUIDES = [
    {
        id: 'alby',
        name: 'Alby Hub',
        hint: 'Open Alby Hub, go to Connections → Add connection, and copy the connection secret.',
        url: 'https://hub.getalby.com',
    },
    {
        id: 'coinos',
        name: 'Coinos',
        hint: 'Log in at coinos.io, then open Settings → Nostr Wallet Connect and copy the string.',
        url: 'https://coinos.io',
    },
    {
        id: 'primal',
        name: 'Primal',
        hint: 'In the Primal app, open Wallet → Settings → Connected apps and create an NWC connection.',
        url: 'https://primal.net',
    },
    {
        id: 'zeus',
        name: 'Zeus',
        hint: 'In Zeus, open Settings → Nostr Wallet Connect and create a new connection.',
        url: 'https://zeusln.com',
    },
];

const WalletConnect = () => {
    const {
        connected, walletType, balance, loading, error,
        connect, connectCoinos, disconnect, refreshBalance,
    } = useWallet();
    const [uri, setUri] = useState('');
    const [localError, setLocalError] = useState(null);
    const [mode, setMode] = useState('nwc'); // 'nwc' | 'coinos'
    const [selectedGuide, setSelectedGuide] = useState(null);
    const [coinosUser, setCoinosUser] = useState('');
    const [coinosPass, setCoinosPass] = useState('');

    const handleConnectNwc = async () => {
        setLocalError(null);
        if (!uri.trim()) {
            setLocalError('Please paste an NWC connection string');
            return;
        }
        try {
            await connect(uri.trim());
            setUri('');
        } catch (err) {
            setLocalError(err.message);
        }
    };

    const handlePasteFromClipboard = async () => {
        setLocalError(null);
        try {
            if (!navigator.clipboard?.readText) {
                throw new Error('unsupported');
            }
            const text = (await navigator.clipboard.readText()).trim();
            if (!text) {
                setLocalError('Clipboard is empty — copy your NWC string first');
                return;
            }
            setUri(text);
        } catch {
            setLocalError('Could not read the clipboard — please paste the string manually');
        }
    };

    const handleConnectCoinos = async () => {
        setLocalError(null);
        if (!coinosUser.trim() || !coinosPass) {
            setLocalError('Username and password are required');
            return;
        }
        try {
            await connectCoinos(coinosUser.trim(), coinosPass);
            setCoinosUser('');
            setCoinosPass('');
        } catch (err) {
            setLocalError(err.message);
        }
    };

    const handleDisconnect = async () => {
        await disconnect();
        setLocalError(null);
    };

    const formatBalance = (msats) => {
        if (msats == null) return null;
        const sats = Math.floor(msats / 1000);
        return sats.toLocaleString();
    };

    const displayError = localError || error;
    const activeGuide = WALLET_GUIDES.find(g => g.id === selectedGuide) || null;

    return (
        <div className="wallet-connect">
            {connected ? (
                <div className="wallet-connected">
                    <div className="wallet-status">
                        <div className="wallet-status-icon">
                            <CheckCircle size={20} />
                        </div>
                        <div className="wallet-status-info">
                            <p className="wallet-status-label">
                                {walletType === 'coinos' ? 'Coinos Wallet' : 'Wallet Connected'}
                            </p>
                            {balance != null && (
                                <p className="wallet-balance">
                                    <Zap size={14} />
                                    {formatBalance(balance)} sats
                                    <button
                                        className="refresh-btn"
                                        onClick={refreshBalance}
                                        title="Refresh balance"
                                    >
                                        <RefreshCw size={12} />
                                    </button>
                                </p>
                            )}
                        </div>
                    </div>
                    <button
                        className="btn btn-outline btn-sm wallet-disconnect-btn"
                        onClick={handleDisconnect}
                    >
                        <Unplug size={16} />
                        Disconnect
                    </button>
                </div>
            ) : (
                <div className="wallet-setup">
                    <div className="wallet-mode-tabs">
                        <button
                            className={`wallet-tab ${mode === 'nwc' ? 'active' : ''}`}
                            onClick={() => { setMode('nwc'); setLocalError(null); }}
                        >
                            <Wallet size={14} /> NWC
                        </button>
                        {COINOS_ENABLED && (
                            <button
                                className={`wallet-tab ${mode === 'coinos' ? 'active' : ''}`}
                                onClick={() => { setMode('coinos'); setLocalError(null); }}
                            >
                                <Zap size={14} /> Coinos
                            </button>
                        )}
                    </div>

                    {mode === 'nwc' ? (
                        <>
                            <p className="wallet-instructions">
                                Connect your Lightning wallet using Nostr Wallet Connect (NWC).
                                Pick your wallet below to see where to find your connection string.
                            </p>

                            <div className="wallet-picker">
                                {WALLET_GUIDES.map(guide => (
                                    <button
                                        key={guide.id}
                                        className={`wallet-picker-chip ${selectedGuide === guide.id ? 'active' : ''}`}
                                        onClick={() => setSelectedGuide(selectedGuide === guide.id ? null : guide.id)}
                                        disabled={loading}
                                    >
                                        {guide.name}
                                    </button>
                                ))}
                            </div>

                            {activeGuide && (
                                <div className="wallet-guide">
                                    <span className="wallet-guide-text">{activeGuide.hint}</span>
                                    <a
                                        className="wallet-guide-link"
                                        href={activeGuide.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        Open {activeGuide.name} <ExternalLink size={12} />
                                    </a>
                                </div>
                            )}

                            <div className="wallet-input-row">
                                <input
                                    type="password"
                                    className="wallet-input"
                                    placeholder="nostr+walletconnect://..."
                                    value={uri}
                                    onChange={(e) => setUri(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleConnectNwc()}
                                    disabled={loading}
                                />
                                <button
                                    className="btn btn-outline btn-sm wallet-paste-btn"
                                    onClick={handlePasteFromClipboard}
                                    disabled={loading}
                                    title="Paste from clipboard"
                                >
                                    <ClipboardPaste size={16} />
                                    Paste
                                </button>
                                <button
                                    className="btn btn-primary btn-sm"
                                    onClick={handleConnectNwc}
                                    disabled={loading}
                                >
                                    {loading ? 'Connecting...' : 'Connect'}
                                </button>
                            </div>

                            {loading && (
                                <div className="wallet-progress">
                                    <Loader2 size={14} className="wallet-spin" />
                                    Contacting wallet... this can take a few seconds.
                                </div>
                            )}

                            <p className="wallet-budget-note">
                                <ShieldCheck size={14} />
                                Tip: create a budget-limited NWC connection in your wallet, so this
                                app can only spend the amount you allow.
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="wallet-instructions">
                                Connect your existing Coinos account to send and receive Lightning payments.
                            </p>
                            <div className="wallet-coinos-form">
                                <input
                                    type="text"
                                    className="wallet-input"
                                    placeholder="Coinos username"
                                    value={coinosUser}
                                    onChange={(e) => setCoinosUser(e.target.value)}
                                    disabled={loading}
                                />
                                <input
                                    type="password"
                                    className="wallet-input"
                                    placeholder="Password"
                                    value={coinosPass}
                                    onChange={(e) => setCoinosPass(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleConnectCoinos()}
                                    disabled={loading}
                                />
                                <button
                                    className="btn btn-primary btn-sm wallet-coinos-btn"
                                    onClick={handleConnectCoinos}
                                    disabled={loading}
                                >
                                    {loading ? 'Connecting...' : 'Connect Coinos'}
                                </button>
                            </div>
                        </>
                    )}

                    {displayError && (
                        <div className="wallet-error">
                            <AlertCircle size={14} />
                            {displayError}
                        </div>
                    )}
                </div>
            )}

            <style jsx>{`
                .wallet-connect {
                    width: 100%;
                }

                .wallet-connected {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 1rem;
                }

                .wallet-status {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                }

                .wallet-status-icon {
                    color: #22c55e;
                    display: flex;
                    align-items: center;
                }

                .wallet-status-info {
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                }

                .wallet-status-label {
                    font-weight: 600;
                    font-size: 0.9rem;
                }

                .wallet-balance {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    font-size: 0.85rem;
                    color: var(--color-gray-600);
                }

                .wallet-balance :global(svg:first-child) {
                    color: #f59e0b;
                }

                .refresh-btn {
                    background: none;
                    border: none;
                    color: var(--color-gray-400);
                    cursor: pointer;
                    padding: 2px;
                    display: flex;
                    align-items: center;
                    border-radius: 4px;
                }
                .refresh-btn:hover {
                    color: var(--color-gray-600);
                    background: var(--color-gray-100);
                }

                .wallet-disconnect-btn {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    color: var(--color-gray-500);
                    white-space: nowrap;
                }

                .wallet-mode-tabs {
                    display: flex;
                    gap: 0.25rem;
                    margin-bottom: 0.75rem;
                    background: var(--color-gray-100);
                    border-radius: 8px;
                    padding: 3px;
                }

                .wallet-tab {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.35rem;
                    padding: 0.4rem 0.75rem;
                    border: none;
                    border-radius: 6px;
                    background: transparent;
                    font-size: 0.8rem;
                    font-weight: 600;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    transition: all 0.15s;
                }
                .wallet-tab.active {
                    background: var(--color-surface);
                    color: var(--color-gray-900);
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                }

                .wallet-instructions {
                    font-size: 0.85rem;
                    color: var(--color-gray-500);
                    margin-bottom: 0.75rem;
                    line-height: 1.5;
                }

                .wallet-picker {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.4rem;
                    margin-bottom: 0.75rem;
                }

                .wallet-picker-chip {
                    padding: 0.35rem 0.75rem;
                    border: 1.5px solid var(--color-gray-200);
                    border-radius: 20px;
                    background: var(--color-surface);
                    font-size: 0.8rem;
                    font-weight: 500;
                    color: var(--color-gray-600);
                    cursor: pointer;
                    transition: all 0.15s;
                }
                .wallet-picker-chip:hover {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }
                .wallet-picker-chip.active {
                    background: var(--color-primary);
                    border-color: var(--color-primary);
                    color: white;
                }
                .wallet-picker-chip:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .wallet-guide {
                    display: flex;
                    flex-direction: column;
                    gap: 0.35rem;
                    padding: 0.6rem 0.75rem;
                    margin-bottom: 0.75rem;
                    background: var(--color-gray-100);
                    border-radius: 8px;
                    font-size: 0.8rem;
                    color: var(--color-gray-600);
                    line-height: 1.5;
                }

                .wallet-guide-link {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.25rem;
                    color: var(--color-primary);
                    font-weight: 600;
                    text-decoration: none;
                    align-self: flex-start;
                }
                .wallet-guide-link:hover {
                    text-decoration: underline;
                }

                .wallet-input-row {
                    display: flex;
                    gap: 0.5rem;
                }

                .wallet-paste-btn {
                    display: flex;
                    align-items: center;
                    gap: 0.3rem;
                    white-space: nowrap;
                }

                .wallet-progress {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    margin-top: 0.6rem;
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                }

                .wallet-progress :global(.wallet-spin) {
                    animation: wallet-spin 1s linear infinite;
                    color: var(--color-primary);
                }

                @keyframes wallet-spin {
                    to { transform: rotate(360deg); }
                }

                .wallet-budget-note {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.4rem;
                    margin-top: 0.75rem;
                    font-size: 0.78rem;
                    color: var(--color-gray-500);
                    line-height: 1.4;
                }

                .wallet-budget-note :global(svg) {
                    flex-shrink: 0;
                    margin-top: 1px;
                    color: #22c55e;
                }

                .wallet-coinos-form {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                }

                .wallet-coinos-btn {
                    align-self: flex-end;
                }

                .wallet-input {
                    flex: 1;
                    padding: 0.5rem 0.75rem;
                    border: 1px solid var(--color-gray-300);
                    border-radius: var(--radius-md);
                    font-size: 0.85rem;
                    font-family: monospace;
                    min-width: 0;
                }
                .wallet-input:focus {
                    outline: none;
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 2px rgba(var(--color-primary-rgb, 59, 130, 246), 0.15);
                }

                .wallet-error {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    margin-top: 0.5rem;
                    font-size: 0.8rem;
                    color: #ef4444;
                }
            `}</style>
        </div>
    );
};

export default WalletConnect;
