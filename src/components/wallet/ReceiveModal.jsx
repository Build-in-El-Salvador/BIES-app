import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import {
    X, Zap, Copy, Check, CheckCircle, AlertCircle, Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../../hooks/useWallet';

/**
 * ReceiveModal — generate a bolt11 invoice (amount + optional memo) with QR +
 * copy, falling back to the user's static Lightning address.
 *
 * Substates: 'form' -> 'creating' -> 'invoice' -> 'paid' | 'error'.
 * The invoice form only appears when receiveCapabilities.canMakeInvoice;
 * otherwise the modal goes straight to the Lightning-address block.
 *
 * Paid-detection: while the invoice is showing and the wallet can list
 * transactions, poll every 5s for a transaction matching the invoice hash.
 * Busy/error state is strictly local — never the shared wallet store.
 */
const ReceiveModal = ({ open, onClose, onPaid }) => {
    const { t } = useTranslation();
    const { makeInvoice, listTransactions, receiveCapabilities, refreshBalance, walletType } = useWallet();

    const caps = receiveCapabilities
        || { canMakeInvoice: false, canListTransactions: false, lightningAddress: null };

    const [step, setStep] = useState('form'); // 'form' | 'creating' | 'invoice' | 'paid' | 'error'
    const [amount, setAmount] = useState('');
    const [memo, setMemo] = useState('');
    const [invoice, setInvoice] = useState('');
    const [hash, setHash] = useState(null);
    const [error, setError] = useState('');
    const [unsupported, setUnsupported] = useState(false);
    const [invoiceCopied, setInvoiceCopied] = useState(false);
    const [addressCopied, setAddressCopied] = useState(false);
    const pollBusyRef = useRef(false);
    // Generation counter: bumped on every open/close so late-resolving
    // makeInvoice calls or poll ticks from a previous session can never
    // mutate the current one (e.g. flash "paid" for a fresh invoice).
    const sessionRef = useRef(0);

    // Fresh state on every open.
    useEffect(() => {
        sessionRef.current += 1;
        if (!open) return;
        setStep('form');
        setAmount('');
        setMemo('');
        setInvoice('');
        setHash(null);
        setError('');
        setUnsupported(false);
        setInvoiceCopied(false);
        setAddressCopied(false);
    }, [open]);

    // Idempotent body scroll lock — skip if another modal already locked it.
    useEffect(() => {
        if (!open) return undefined;
        if (document.body.style.position === 'fixed') return undefined;
        const scrollY = window.scrollY;
        document.body.style.position = 'fixed';
        document.body.style.top = `-${scrollY}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.left = '';
            document.body.style.right = '';
            document.body.style.overflow = '';
            window.scrollTo(0, scrollY);
        };
    }, [open]);

    // ESC to close — allowed in every state: unlike Send's 'paying', an
    // in-flight invoice creation is completely safe to abandon (the session
    // guard drops its late result).
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    // Paid-detection polling — only while the invoice is showing, we know its
    // hash, and the wallet can actually list transactions. Cleared on
    // close/paid/unmount so idle modals never hammer relays.
    useEffect(() => {
        if (!open || step !== 'invoice' || !hash || !caps.canListTransactions) return undefined;
        if (typeof listTransactions !== 'function') return undefined;

        const tick = async () => {
            if (pollBusyRef.current) return;
            pollBusyRef.current = true;
            const session = sessionRef.current;
            try {
                const { transactions } = await listTransactions({ limit: 10 });
                // Bail if the modal was closed/reopened while the (slow)
                // list_transactions request was in flight — a stale "paid"
                // must never hijack a fresh session.
                if (sessionRef.current !== session) return;
                const paid = (transactions || []).some(
                    (tx) => tx.type === 'incoming' && tx.hash && tx.hash === hash,
                );
                if (paid) {
                    setStep('paid');
                    refreshBalance();
                    if (onPaid) onPaid();
                }
            } catch {
                // Transient — keep polling until close/paid.
            } finally {
                pollBusyRef.current = false;
            }
        };

        const id = setInterval(tick, 5000);
        return () => clearInterval(id);
    }, [open, step, hash, caps.canListTransactions]);  

    if (!open) return null;

    const handleCreate = async () => {
        const amountSats = Number(amount);
        if (!Number.isInteger(amountSats) || amountSats <= 0) {
            setError(t('wallet.receive.invalidAmount', 'Enter a whole number of sats'));
            return;
        }
        setError('');
        setStep('creating');
        const session = sessionRef.current;
        try {
            const res = await makeInvoice(amountSats, memo.trim() || undefined);
            if (sessionRef.current !== session) return; // modal closed/reopened mid-create
            if (!res?.invoice) {
                // Belt-and-braces: never enter the invoice step (and its QR
                // render) with a missing bolt11.
                throw new Error(t('wallet.receive.failed', 'Could not create the invoice — please try again'));
            }
            setInvoice(res.invoice);
            setHash(res.hash ?? null);
            setStep('invoice');
        } catch (err) {
            if (sessionRef.current !== session) return; // stale session — drop it
            if (err?.code === 'UNSUPPORTED') {
                setUnsupported(true);
                setError('');
            } else if (err?.message === 'wallet_token_expired') {
                setError(walletType === 'blink'
                    ? t('wallet.sessionExpiredBlink', 'Your Blink API key no longer works — reconnect your Blink wallet in Settings')
                    : t('wallet.sessionExpired', 'Wallet session expired — reconnect your Coinos wallet in Settings'));
            } else {
                setError(err?.message || t('wallet.receive.failed', 'Could not create the invoice — please try again'));
            }
            setStep('error');
        }
    };

    const copyInvoice = async () => {
        try {
            // Copy the RAW lowercase bolt11 (the QR wraps it in a lightning: URI).
            await navigator.clipboard.writeText(invoice);
            setInvoiceCopied(true);
            setTimeout(() => setInvoiceCopied(false), 2000);
        } catch { /* clipboard unavailable */ }
    };

    const copyAddress = async () => {
        if (!caps.lightningAddress) return;
        try {
            await navigator.clipboard.writeText(caps.lightningAddress);
            setAddressCopied(true);
            setTimeout(() => setAddressCopied(false), 2000);
        } catch { /* clipboard unavailable */ }
    };

    const truncatedInvoice = invoice.length > 40
        ? `${invoice.slice(0, 26)}…${invoice.slice(-12)}`
        : invoice;

    const showForm = caps.canMakeInvoice && (step === 'form' || step === 'creating');
    const showAddressBlock = !!caps.lightningAddress
        && (step === 'form' || step === 'creating' || step === 'invoice' || (step === 'error' && unsupported));

    return createPortal(
        <div
            className="rm-overlay"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="rm-card" role="dialog" aria-modal="true" data-testid="wallet-receive-modal">
                <div className="rm-header">
                    <h3 className="rm-title">{t('wallet.receive.title', 'Receive sats')}</h3>
                    <button
                        className="rm-close"
                        aria-label={t('common.close', 'Close')}
                        onClick={onClose}
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="rm-body">
                    {/* form / creating */}
                    {showForm && (
                        <>
                            <label className="rm-field">
                                <span className="rm-label">{t('wallet.receive.amountLabel', 'Amount (sats)')}</span>
                                <input
                                    type="number"
                                    inputMode="numeric"
                                    min="1"
                                    step="1"
                                    className="rm-input"
                                    data-testid="wallet-receive-amount"
                                    placeholder="1000"
                                    value={amount}
                                    disabled={step === 'creating'}
                                    onChange={(e) => setAmount(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                                />
                            </label>
                            <label className="rm-field">
                                <span className="rm-label">{t('wallet.receive.memoLabel', 'Memo (optional)')}</span>
                                <input
                                    type="text"
                                    className="rm-input"
                                    data-testid="wallet-receive-memo"
                                    placeholder={t('wallet.receive.memoPlaceholder', 'What is this for?')}
                                    value={memo}
                                    maxLength={256}
                                    disabled={step === 'creating'}
                                    onChange={(e) => setMemo(e.target.value)}
                                />
                            </label>
                            {error && <p className="rm-error"><AlertCircle size={14} /> {error}</p>}
                            <button
                                className="rm-submit"
                                data-testid="wallet-receive-submit"
                                disabled={step === 'creating'}
                                onClick={handleCreate}
                            >
                                {step === 'creating'
                                    ? <><Loader2 size={16} className="rm-spin" /> {t('wallet.receive.creating', 'Creating invoice...')}</>
                                    : <><Zap size={16} /> {t('wallet.receive.submit', 'Create invoice')}</>}
                            </button>
                        </>
                    )}

                    {/* invoice */}
                    {step === 'invoice' && (
                        <>
                            <div className="rm-qr-wrap" data-testid="wallet-invoice-qr">
                                {/* lightning: URI + level M — matches ZapModal so camera
                                    apps offer to open a wallet and glare-tolerance is equal */}
                                <QRCodeSVG
                                    value={`lightning:${invoice}`}
                                    size={220}
                                    level="M"
                                    marginSize={2}
                                    bgColor="#ffffff"
                                    fgColor="#000000"
                                />
                            </div>
                            <p className="rm-recap">
                                <strong>{Number(amount).toLocaleString()} {t('wallet.sats', 'sats')}</strong>
                                {memo.trim() && <span className="rm-recap-memo"> · {memo.trim()}</span>}
                            </p>
                            <div className="rm-invoice-row">
                                <code className="rm-invoice-text">{truncatedInvoice}</code>
                                <button
                                    className="rm-copy-btn"
                                    data-testid="wallet-invoice-copy"
                                    onClick={copyInvoice}
                                >
                                    {invoiceCopied ? <Check size={14} /> : <Copy size={14} />}
                                    {invoiceCopied
                                        ? t('wallet.copied', 'Copied')
                                        : t('wallet.receive.copyInvoice', 'Copy invoice')}
                                </button>
                            </div>
                            {hash && caps.canListTransactions && (
                                <p className="rm-waiting">
                                    <Loader2 size={13} className="rm-spin" />
                                    {t('wallet.receive.waiting', 'Waiting for payment...')}
                                </p>
                            )}
                        </>
                    )}

                    {/* paid */}
                    {step === 'paid' && (
                        <div className="rm-result" data-testid="wallet-receive-paid">
                            <CheckCircle size={48} className="rm-result-icon-ok" />
                            <h4 className="rm-result-title">{t('wallet.receive.paidTitle', 'Payment received!')}</h4>
                            <p className="rm-result-sub">
                                +{Number(amount).toLocaleString()} {t('wallet.sats', 'sats')}
                            </p>
                            <button className="rm-submit" onClick={onClose}>
                                {t('common.done', 'Done')}
                            </button>
                        </div>
                    )}

                    {/* error */}
                    {step === 'error' && (
                        <div className="rm-result">
                            <AlertCircle size={40} className="rm-result-icon-err" />
                            <p className="rm-result-sub">
                                {unsupported
                                    ? t('wallet.receive.unsupported', 'Your wallet cannot create invoices — share your Lightning address instead')
                                    : error}
                            </p>
                            {!unsupported && caps.canMakeInvoice && (
                                <button className="rm-submit" onClick={() => { setError(''); setStep('form'); }}>
                                    {t('common.back', 'Back')}
                                </button>
                            )}
                        </div>
                    )}

                    {/* Lightning address fallback */}
                    {showAddressBlock && (
                        <>
                            <div className="rm-divider">
                                <span>{t('wallet.receive.orAddress', 'or share your Lightning address')}</span>
                            </div>
                            <button className="rm-address" onClick={copyAddress}>
                                <Zap size={14} />
                                <span className="rm-address-text">{caps.lightningAddress}</span>
                                {addressCopied ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                            {!caps.canMakeInvoice && (
                                <p className="rm-address-hint">
                                    {t('wallet.receive.addressHint', 'Anyone can send sats to this address at any time.')}
                                </p>
                            )}
                            {/* blink never clobbers a custom profile address, so a non-@blink.sv
                                address under a blink connection is also "from the profile" */}
                            {(walletType === 'nwc'
                                || (walletType === 'blink'
                                    && !/@blink\.sv$/i.test(caps.lightningAddress || ''))) && (
                                <p className="rm-address-hint">
                                    {t('wallet.receive.profileAddressHint', 'This address comes from your profile — it may point to a different wallet than the one connected here.')}
                                </p>
                            )}
                        </>
                    )}
                </div>
            </div>

            <style jsx>{`
                .rm-overlay {
                    position: fixed;
                    inset: 0;
                    z-index: 10001;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.6);
                    backdrop-filter: blur(4px);
                }

                .rm-card {
                    background: var(--color-surface);
                    border-radius: var(--radius-lg);
                    width: 92vw;
                    max-width: 400px;
                    max-height: 90vh;
                    max-height: calc(100dvh - 2rem);
                    display: flex;
                    flex-direction: column;
                    box-shadow: var(--shadow-lg);
                    overflow: hidden;
                }

                .rm-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 1rem 1.25rem;
                    border-bottom: 1px solid var(--color-gray-200);
                    flex-shrink: 0;
                }

                .rm-title {
                    margin: 0;
                    font-size: 1.1rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                }

                .rm-close {
                    display: flex;
                    padding: 4px;
                    border: none;
                    background: none;
                    color: var(--color-gray-500);
                    cursor: pointer;
                }

                .rm-close:hover:not(:disabled) { color: var(--color-gray-900); }
                .rm-close:disabled { opacity: 0.5; cursor: default; }

                .rm-body {
                    padding: 1.25rem;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 0.9rem;
                }

                .rm-field {
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                }

                .rm-label {
                    font-size: 0.8rem;
                    font-weight: 600;
                    color: var(--color-gray-500);
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                }

                .rm-input {
                    width: 100%;
                    padding: 0.6rem 0.75rem;
                    border: 1.5px solid var(--color-gray-300);
                    border-radius: var(--radius-md);
                    font-size: 0.9rem;
                    font-family: inherit;
                    background: var(--color-surface);
                    color: var(--color-gray-900);
                    outline: none;
                    box-sizing: border-box;
                    transition: border-color 0.15s;
                }

                .rm-input::placeholder { color: var(--color-gray-400); }
                .rm-input:focus { border-color: var(--color-primary); }

                .rm-error {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    margin: 0;
                    font-size: 0.82rem;
                    color: var(--color-error, #EF4444);
                }

                .rm-submit {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.4rem;
                    width: 100%;
                    padding: 0.75rem;
                    border: none;
                    border-radius: var(--radius-md);
                    background: var(--color-secondary);
                    color: white;
                    font-size: 0.92rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: background 0.15s;
                }

                .rm-submit:hover:not(:disabled) {
                    background: var(--color-secondary-dark, #CC4A00);
                }

                .rm-submit:disabled { opacity: 0.6; cursor: wait; }

                :global(.rm-spin) { animation: rm-spin 1s linear infinite; }

                @keyframes rm-spin {
                    to { transform: rotate(360deg); }
                }

                /* ── Invoice view ───────────────────────────────────────── */
                .rm-qr-wrap {
                    display: flex;
                    justify-content: center;
                    padding: 0.75rem;
                    background: #ffffff; /* hard white so the QR scans in dark mode */
                    border-radius: var(--radius-md);
                    align-self: center;
                }

                .rm-recap {
                    margin: 0;
                    text-align: center;
                    font-size: 0.95rem;
                    color: var(--color-gray-900);
                }

                .rm-recap-memo { color: var(--color-gray-500); font-size: 0.85rem; }

                .rm-invoice-row {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                }

                .rm-invoice-text {
                    flex: 1;
                    min-width: 0;
                    padding: 0.5rem 0.6rem;
                    background: var(--color-gray-100);
                    border-radius: var(--radius-md);
                    font-size: 0.72rem;
                    color: var(--color-gray-600, var(--color-gray-500));
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .rm-copy-btn {
                    display: flex;
                    align-items: center;
                    gap: 0.3rem;
                    padding: 0.5rem 0.75rem;
                    border: 1.5px solid var(--color-gray-300);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    font-size: 0.8rem;
                    font-weight: 600;
                    color: var(--color-gray-600, var(--color-gray-500));
                    cursor: pointer;
                    white-space: nowrap;
                    flex-shrink: 0;
                }

                .rm-copy-btn:hover { border-color: var(--color-primary); color: var(--color-primary); }

                .rm-waiting {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.4rem;
                    margin: 0;
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                }

                /* ── Result (paid / error) ──────────────────────────────── */
                .rm-result {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.6rem;
                    text-align: center;
                    padding: 0.5rem 0;
                }

                .rm-result :global(.rm-result-icon-ok) { color: var(--color-success, #22c55e); }
                .rm-result :global(.rm-result-icon-err) { color: var(--color-error, #EF4444); }

                .rm-result-title {
                    margin: 0;
                    font-size: 1.05rem;
                    color: var(--color-gray-900);
                }

                .rm-result-sub {
                    margin: 0;
                    font-size: 0.9rem;
                    color: var(--color-gray-500);
                }

                /* ── Divider + address block ────────────────────────────── */
                .rm-divider {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                }
                .rm-divider::before,
                .rm-divider::after {
                    content: '';
                    flex: 1;
                    height: 1px;
                    background: var(--color-gray-200);
                }
                .rm-divider span {
                    font-size: 0.72rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--color-gray-400);
                }

                .rm-address {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.4rem;
                    width: 100%;
                    padding: 0.6rem 0.75rem;
                    border: 1.5px solid var(--color-gray-200);
                    border-radius: var(--radius-full);
                    background: var(--color-gray-100);
                    font-size: 0.85rem;
                    font-family: monospace;
                    color: var(--color-gray-600, var(--color-gray-500));
                    cursor: pointer;
                    transition: border-color 0.15s;
                }

                .rm-address:hover { border-color: var(--color-primary); }

                .rm-address :global(svg:first-child) { color: #f59e0b; flex-shrink: 0; }

                .rm-address-text {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .rm-address-hint {
                    margin: 0;
                    font-size: 0.78rem;
                    text-align: center;
                    color: var(--color-gray-400);
                }

                @media (max-width: 768px) {
                    .rm-overlay {
                        align-items: flex-end;
                    }

                    .rm-card {
                        width: 100%;
                        max-width: none;
                        max-height: 92vh;
                        max-height: calc(100dvh - env(safe-area-inset-top, 0px) - 0.5rem);
                        border-radius: var(--radius-lg) var(--radius-lg) 0 0;
                    }

                    .rm-body {
                        padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));
                    }
                }
            `}</style>
        </div>,
        document.body,
    );
};

export default ReceiveModal;
