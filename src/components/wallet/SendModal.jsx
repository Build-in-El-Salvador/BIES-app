import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
    X, Zap, ClipboardPaste, CheckCircle, AlertCircle, AlertTriangle, Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../../hooks/useWallet';
import {
    isBolt11, decodeBolt11Amount, isBolt12Offer, isLnurl,
    resolveLud16, requestInvoice,
} from '../../services/lightningService';

/**
 * SendModal — pay a bolt11 invoice OR a Lightning address / LNURL + amount.
 *
 * Substates: 'input' -> 'resolving' -> 'confirm' -> 'paying' -> 'success' | 'error'.
 * Bolt11 amounts are decoded client-side for the preview (HRP parse only);
 * addresses/LNURLs resolve via the existing lightningService (msats = sats*1000).
 * Payment goes through the untouched useWallet.payInvoice.
 */
const SendModal = ({ open, onClose, onPaid }) => {
    const { t } = useTranslation();
    const { payInvoice, balance, refreshBalance, walletType } = useWallet();

    const [step, setStep] = useState('input'); // 'input' | 'resolving' | 'confirm' | 'paying' | 'success' | 'error' | 'unknown'
    const [input, setInput] = useState('');
    const [amount, setAmount] = useState('');
    const [inlineError, setInlineError] = useState('');
    const [resolved, setResolved] = useState(null); // { bolt11, amountSats, destination }
    const [payError, setPayError] = useState('');
    // Generation counter: bumped on every open/close so in-flight LNURL
    // resolves from a previous session can never mutate the current one.
    const sessionRef = useRef(0);

    // Fresh state on every open.
    useEffect(() => {
        sessionRef.current += 1;
        if (!open) return;
        setStep('input');
        setInput('');
        setAmount('');
        setInlineError('');
        setResolved(null);
        setPayError('');
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

    // ESC to close (never mid-payment).
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            if (step === 'paying') return;
            onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, step, onClose]);

    if (!open) return null;

    // ── Live classification of the destination field ────────────────────────
    const cleaned = input.trim().replace(/^lightning:/i, '');
    const bolt11Detected = !!cleaned && isBolt11(cleaned);
    const bolt12Detected = !bolt11Detected && !!cleaned && isBolt12Offer(cleaned);
    const lnurlDetected = !bolt11Detected && !bolt12Detected && !!cleaned && isLnurl(cleaned);
    const addressDetected = !bolt11Detected && !bolt12Detected && !lnurlDetected
        && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned);
    const needsAmount = lnurlDetected || addressDetected;
    const decodedAmount = bolt11Detected ? decodeBolt11Amount(cleaned) : null;

    const liveError = bolt12Detected
        ? t('wallet.send.noBolt12', 'Bolt12 offers are not supported here — use the zap button instead')
        : (bolt11Detected && decodedAmount == null)
            ? t('wallet.send.noAmountInvoice', 'Invoices without an amount are not supported — ask for one with an amount or use a Lightning address')
            : '';

    const insufficient = resolved && balance != null && resolved.amountSats * 1000 > balance;

    const handlePaste = async () => {
        setInlineError('');
        try {
            if (!navigator.clipboard?.readText) throw new Error('unsupported');
            const text = (await navigator.clipboard.readText()).trim();
            if (!text) {
                setInlineError(t('wallet.send.clipboardEmpty', 'Clipboard is empty — copy an invoice or address first'));
                return;
            }
            setInput(text);
        } catch {
            setInlineError(t('wallet.send.pasteFailed', 'Could not read the clipboard — please paste manually'));
        }
    };

    const handleSubmit = async () => {
        setInlineError('');
        if (!cleaned) {
            setInlineError(t('wallet.send.emptyInput', 'Paste an invoice or enter a Lightning address'));
            return;
        }
        if (bolt12Detected) {
            setInlineError(t('wallet.send.noBolt12', 'Bolt12 offers are not supported here — use the zap button instead'));
            return;
        }
        if (bolt11Detected) {
            if (decodedAmount == null) {
                setInlineError(t('wallet.send.noAmountInvoice', 'Invoices without an amount are not supported — ask for one with an amount or use a Lightning address'));
                return;
            }
            setResolved({ bolt11: cleaned, amountSats: decodedAmount, destination: null });
            setStep('confirm');
            return;
        }
        if (!needsAmount) {
            setInlineError(t('wallet.send.invalidInput', "That doesn't look like an invoice or Lightning address"));
            return;
        }

        const amountSats = Number(amount);
        if (!Number.isInteger(amountSats) || amountSats <= 0) {
            setInlineError(t('wallet.send.invalidAmount', 'Enter a whole number of sats'));
            return;
        }

        const session = sessionRef.current;
        setStep('resolving');
        try {
            const lnurlData = await resolveLud16(cleaned);
            if (sessionRef.current !== session) return; // modal closed/reopened mid-resolve
            if (!lnurlData || !lnurlData.callback) {
                throw new Error(t('wallet.send.resolveFailed', 'Could not resolve that Lightning address'));
            }
            const msats = amountSats * 1000;
            const min = Number(lnurlData.minSendable) || 0;
            const max = Number(lnurlData.maxSendable) || Infinity;
            if (msats < min || msats > max) {
                throw new Error(t('wallet.send.amountRange', {
                    defaultValue: 'Amount must be between {{min}} and {{max}} sats',
                    min: Math.ceil(min / 1000).toLocaleString(),
                    max: max === Infinity ? '∞' : Math.floor(max / 1000).toLocaleString(),
                }));
            }
            const invoiceData = await requestInvoice(lnurlData.callback, msats);
            if (sessionRef.current !== session) return; // modal closed/reopened mid-resolve
            if (!invoiceData?.pr) {
                throw new Error(t('wallet.send.invoiceFailed', 'Could not get an invoice for that address'));
            }
            // LUD-06: the wallet MUST verify the returned invoice matches the
            // amount the user asked for — never trust the LNURL server.
            const invSats = decodeBolt11Amount(invoiceData.pr);
            if (invSats == null || invSats !== amountSats) {
                throw new Error(t('wallet.send.amountMismatch', 'The invoice returned does not match the requested amount'));
            }
            setResolved({ bolt11: invoiceData.pr, amountSats, destination: cleaned });
            setStep('confirm');
        } catch (err) {
            if (sessionRef.current !== session) return; // stale session — drop it
            setInlineError(err?.message || t('wallet.send.resolveFailed', 'Could not resolve that Lightning address'));
            setStep('input');
        }
    };

    const handlePay = async () => {
        if (!resolved || insufficient) return;
        setPayError('');
        setStep('paying');
        try {
            await payInvoice(resolved.bolt11);
            setStep('success');
            if (onPaid) onPaid();
        } catch (err) {
            if (err?.code === 'TIMEOUT') {
                // The wallet went silent — the payment may STILL have settled.
                // Never present this as a definitive failure (a retry through
                // the address path would mint a fresh invoice = double spend).
                refreshBalance();
                setStep('unknown');
                return;
            }
            setPayError(err?.message === 'wallet_token_expired'
                ? t('wallet.sessionExpired', 'Wallet session expired — reconnect your Coinos wallet in Settings')
                : (err?.message || t('wallet.send.payFailed', 'Payment failed')));
            setStep('error');
        }
    };

    const busy = step === 'resolving' || step === 'paying';
    const showInput = step === 'input' || step === 'resolving';
    const showConfirm = step === 'confirm' || step === 'paying';

    return createPortal(
        <div
            className="sm-overlay"
            onClick={(e) => {
                if (e.target === e.currentTarget && !busy) onClose();
            }}
        >
            <div className="sm-card" role="dialog" aria-modal="true" data-testid="wallet-send-modal">
                <div className="sm-header">
                    <h3 className="sm-title">{t('wallet.send.title', 'Send sats')}</h3>
                    <button
                        className="sm-close"
                        aria-label={t('common.close', 'Close')}
                        disabled={step === 'paying'}
                        onClick={onClose}
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="sm-body">
                    {/* input / resolving */}
                    {showInput && (
                        <>
                            <label className="sm-field">
                                <span className="sm-label">
                                    {t('wallet.send.inputLabel', 'Invoice or Lightning address')}
                                </span>
                                <textarea
                                    className="sm-input sm-textarea"
                                    data-testid="wallet-send-input"
                                    placeholder={t('wallet.send.inputPlaceholder', 'lnbc... or name@domain.com')}
                                    value={input}
                                    rows={3}
                                    disabled={step === 'resolving'}
                                    onChange={(e) => { setInput(e.target.value); setInlineError(''); }}
                                />
                            </label>

                            <button
                                className="sm-paste-btn"
                                disabled={step === 'resolving'}
                                onClick={handlePaste}
                            >
                                <ClipboardPaste size={15} />
                                {t('wallet.send.paste', 'Paste from clipboard')}
                            </button>

                            {bolt11Detected && decodedAmount != null && (
                                <p className="sm-preview">
                                    <Zap size={14} />
                                    {t('wallet.send.invoicePreview', {
                                        defaultValue: 'Invoice for {{amount}} sats',
                                        amount: decodedAmount.toLocaleString(),
                                    })}
                                </p>
                            )}

                            {needsAmount && (
                                <label className="sm-field">
                                    <span className="sm-label">{t('wallet.send.amountLabel', 'Amount (sats)')}</span>
                                    <input
                                        type="number"
                                        inputMode="numeric"
                                        min="1"
                                        step="1"
                                        className="sm-input"
                                        data-testid="wallet-send-amount"
                                        placeholder="1000"
                                        value={amount}
                                        disabled={step === 'resolving'}
                                        onChange={(e) => { setAmount(e.target.value); setInlineError(''); }}
                                        onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                                    />
                                </label>
                            )}

                            {(inlineError || liveError) && (
                                <p className="sm-error"><AlertCircle size={14} /> {inlineError || liveError}</p>
                            )}

                            <button
                                className="sm-submit"
                                data-testid="wallet-send-submit"
                                disabled={step === 'resolving' || !!liveError}
                                onClick={handleSubmit}
                            >
                                {step === 'resolving'
                                    ? <><Loader2 size={16} className="sm-spin" /> {t('wallet.send.resolving', 'Fetching invoice...')}</>
                                    : t('wallet.send.continue', 'Continue')}
                            </button>
                        </>
                    )}

                    {/* confirm / paying */}
                    {showConfirm && resolved && (
                        <div className="sm-confirm" data-testid="wallet-send-confirm">
                            <div className="sm-confirm-row">
                                <span className="sm-confirm-label">{t('wallet.send.to', 'To')}</span>
                                <span className="sm-confirm-value sm-confirm-dest">
                                    {resolved.destination || t('wallet.send.invoiceDest', 'Lightning invoice')}
                                </span>
                            </div>
                            <div className="sm-confirm-row">
                                <span className="sm-confirm-label">{t('wallet.send.amountLabel', 'Amount (sats)')}</span>
                                <span className="sm-confirm-value sm-confirm-amount">
                                    {resolved.amountSats.toLocaleString()} {t('wallet.sats', 'sats')}
                                </span>
                            </div>

                            {insufficient && (
                                <p className="sm-warning">
                                    <AlertTriangle size={14} />
                                    {t('wallet.send.insufficient', 'Not enough balance for this payment')}
                                </p>
                            )}

                            <div className="sm-confirm-actions">
                                <button
                                    className="sm-btn-ghost"
                                    disabled={step === 'paying'}
                                    onClick={() => setStep('input')}
                                >
                                    {t('common.back', 'Back')}
                                </button>
                                <button
                                    className="sm-submit sm-submit-inline"
                                    data-testid="wallet-send-pay"
                                    disabled={step === 'paying' || insufficient}
                                    onClick={handlePay}
                                >
                                    {step === 'paying'
                                        ? <><Loader2 size={16} className="sm-spin" /> {t('wallet.send.paying', 'Paying...')}</>
                                        : <><Zap size={16} /> {t('wallet.send.pay', 'Pay')}</>}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* success */}
                    {step === 'success' && resolved && (
                        <div className="sm-result" data-testid="wallet-send-success">
                            <CheckCircle size={48} className="sm-result-icon-ok" />
                            <h4 className="sm-result-title">{t('wallet.send.successTitle', 'Payment sent!')}</h4>
                            <p className="sm-result-sub">
                                -{resolved.amountSats.toLocaleString()} {t('wallet.sats', 'sats')}
                                {resolved.destination && (
                                    <span className="sm-result-dest"> → {resolved.destination}</span>
                                )}
                            </p>
                            <button className="sm-submit" onClick={onClose}>
                                {t('common.done', 'Done')}
                            </button>
                        </div>
                    )}

                    {/* error */}
                    {step === 'error' && (
                        <div className="sm-result" data-testid="wallet-send-error">
                            <AlertCircle size={40} className="sm-result-icon-err" />
                            <h4 className="sm-result-title">{t('wallet.send.errorTitle', 'Payment failed')}</h4>
                            <p className="sm-result-sub">{payError}</p>
                            <button className="sm-btn-ghost" onClick={() => setStep('confirm')}>
                                {t('common.back', 'Back')}
                            </button>
                        </div>
                    )}

                    {/* unknown — wallet timed out, payment may still have settled */}
                    {step === 'unknown' && (
                        <div className="sm-result" data-testid="wallet-send-unknown">
                            <AlertTriangle size={40} className="sm-result-icon-warn" />
                            <h4 className="sm-result-title">{t('wallet.send.unknownTitle', 'Payment status unknown')}</h4>
                            <p className="sm-result-sub">
                                {t('wallet.send.unknownBody', 'Your wallet did not respond in time, but the payment may still have gone through. Check your balance and transactions before trying again — paying again could send the sats twice.')}
                            </p>
                            <button className="sm-submit" onClick={onClose}>
                                {t('common.close', 'Close')}
                            </button>
                            <button className="sm-btn-ghost" onClick={() => setStep('confirm')}>
                                {t('wallet.send.retryAnyway', 'I checked — it did not go through')}
                            </button>
                        </div>
                    )}
                </div>
            </div>

            <style jsx>{`
                .sm-overlay {
                    position: fixed;
                    inset: 0;
                    z-index: 10001;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.6);
                    backdrop-filter: blur(4px);
                }

                .sm-card {
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

                .sm-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 1rem 1.25rem;
                    border-bottom: 1px solid var(--color-gray-200);
                    flex-shrink: 0;
                }

                .sm-title {
                    margin: 0;
                    font-size: 1.1rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                }

                .sm-close {
                    display: flex;
                    padding: 4px;
                    border: none;
                    background: none;
                    color: var(--color-gray-500);
                    cursor: pointer;
                }

                .sm-close:hover:not(:disabled) { color: var(--color-gray-900); }
                .sm-close:disabled { opacity: 0.5; cursor: default; }

                .sm-body {
                    padding: 1.25rem;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 0.9rem;
                }

                .sm-field {
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                }

                .sm-label {
                    font-size: 0.8rem;
                    font-weight: 600;
                    color: var(--color-gray-500);
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                }

                .sm-input {
                    width: 100%;
                    padding: 0.6rem 0.75rem;
                    border: 1.5px solid var(--color-gray-300);
                    border-radius: var(--radius-md);
                    font-size: 0.88rem;
                    font-family: monospace;
                    background: var(--color-surface);
                    color: var(--color-gray-900);
                    outline: none;
                    box-sizing: border-box;
                    transition: border-color 0.15s;
                }

                .sm-input::placeholder { color: var(--color-gray-400); }
                .sm-input:focus { border-color: var(--color-primary); }

                .sm-textarea {
                    resize: vertical;
                    word-break: break-all;
                }

                .sm-paste-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.35rem;
                    padding: 0.5rem 0.75rem;
                    border: 1.5px dashed var(--color-gray-300);
                    border-radius: var(--radius-md);
                    background: none;
                    font-size: 0.82rem;
                    font-weight: 600;
                    font-family: inherit;
                    color: var(--color-primary);
                    cursor: pointer;
                }

                .sm-paste-btn:hover:not(:disabled) { border-color: var(--color-primary); }

                .sm-preview {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    margin: 0;
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: var(--color-gray-900);
                }

                .sm-preview :global(svg) { color: #f59e0b; }

                .sm-error {
                    display: flex;
                    align-items: flex-start;
                    gap: 0.35rem;
                    margin: 0;
                    font-size: 0.82rem;
                    line-height: 1.4;
                    color: var(--color-error, #EF4444);
                }

                .sm-error :global(svg) { flex-shrink: 0; margin-top: 2px; }

                .sm-warning {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    margin: 0;
                    font-size: 0.82rem;
                    color: var(--color-warning, #f59e0b);
                }

                .sm-submit {
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

                .sm-submit:hover:not(:disabled) {
                    background: var(--color-secondary-dark, #CC4A00);
                }

                .sm-submit:disabled { opacity: 0.6; cursor: not-allowed; }

                .sm-submit-inline { flex: 1; width: auto; }

                .sm-btn-ghost {
                    padding: 0.7rem 1rem;
                    border: 1.5px solid var(--color-gray-300);
                    border-radius: var(--radius-md);
                    background: var(--color-surface);
                    font-size: 0.88rem;
                    font-weight: 600;
                    font-family: inherit;
                    color: var(--color-gray-600, var(--color-gray-500));
                    cursor: pointer;
                }

                .sm-btn-ghost:hover:not(:disabled) {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }

                .sm-btn-ghost:disabled { opacity: 0.5; cursor: default; }

                :global(.sm-spin) { animation: sm-spin 1s linear infinite; }

                @keyframes sm-spin {
                    to { transform: rotate(360deg); }
                }

                /* ── Confirm ────────────────────────────────────────────── */
                .sm-confirm {
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                }

                .sm-confirm-row {
                    display: flex;
                    flex-direction: column;
                    gap: 0.15rem;
                }

                .sm-confirm-label {
                    font-size: 0.72rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--color-gray-400);
                }

                .sm-confirm-value { color: var(--color-gray-900); }

                .sm-confirm-dest {
                    font-family: monospace;
                    font-size: 0.88rem;
                    word-break: break-all;
                }

                .sm-confirm-amount {
                    font-size: 1.4rem;
                    font-weight: 800;
                }

                .sm-confirm-actions {
                    display: flex;
                    gap: 0.5rem;
                    margin-top: 0.25rem;
                }

                /* ── Result (success / error) ───────────────────────────── */
                .sm-result {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.6rem;
                    text-align: center;
                    padding: 0.5rem 0;
                }

                .sm-result :global(.sm-result-icon-ok) { color: var(--color-success, #22c55e); }
                .sm-result :global(.sm-result-icon-err) { color: var(--color-error, #EF4444); }
                .sm-result :global(.sm-result-icon-warn) { color: var(--color-warning, #f59e0b); }

                .sm-result-title {
                    margin: 0;
                    font-size: 1.05rem;
                    color: var(--color-gray-900);
                }

                .sm-result-sub {
                    margin: 0;
                    font-size: 0.9rem;
                    color: var(--color-gray-500);
                    word-break: break-all;
                }

                .sm-result-dest { font-family: monospace; font-size: 0.82rem; }

                @media (max-width: 768px) {
                    .sm-overlay {
                        align-items: flex-end;
                    }

                    .sm-card {
                        width: 100%;
                        max-width: none;
                        max-height: 92vh;
                        max-height: calc(100dvh - env(safe-area-inset-top, 0px) - 0.5rem);
                        border-radius: var(--radius-lg) var(--radius-lg) 0 0;
                    }

                    .sm-body {
                        padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));
                    }
                }
            `}</style>
        </div>,
        document.body,
    );
};

export default SendModal;
