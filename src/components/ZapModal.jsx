import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Zap, Loader2, Check, Copy, AlertCircle, ChevronRight, Wallet } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { nostrService, PUBLIC_RELAYS } from '../services/nostrService';
import { resolveLud16, requestInvoice, payWithWebLN, createZapRequest } from '../services/lightningService';
import { profilesApi } from '../services/api';
import { useWallet } from '../hooks/useWallet';
import { getAssetUrl } from '../utils/assets';

const AMOUNT_PRESETS = [21, 100, 500, 1000, 5000];

/**
 * Modal for sending Lightning zaps to one or more recipients.
 * Supports NWC (Nostr Wallet Connect), WebLN (Alby etc.), and QR code fallback.
 * Splits equally among recipients with valid lud16.
 *
 * @param {Array<{pubkey: string, name: string, avatar?: string}>} props.recipients
 * @param {string} [props.eventId]
 * @param {string} [props.aTag] - Addressable event coordinate (kind:pubkey:dTag) for NIP-57 'a' tagging
 * @param {number} [props.fixedAmount] - Lock the amount (hides presets/custom input) — used by purchase flows
 * @param {function} [props.onPaid] - Called with 'paid' when all payments succeed, or 'qr' when a manual QR/invoice is shown (so callers can start confirming)
 * @param {function} props.onClose
 */
const ZapModal = ({ recipients = [], eventId, aTag, fixedAmount, onPaid, onClose }) => {
    // Lock body scroll while modal is open (prevents background scroll on mobile)
    useEffect(() => {
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
    }, []);
    const { connected: walletConnected, walletType, payInvoice: walletPayInvoice } = useWallet();
    // Backwards-compat aliases used throughout the component
    const nwcConnected = walletConnected;
    const nwcPayInvoice = walletPayInvoice;
    // Bolt12 offers can only go through a real NWC wallet — Coinos's BOLT-11
    // payment endpoint can't pay offers, so those fall back to the QR flow.
    const canPayBolt12ViaWallet = walletConnected && walletType === 'nwc';
    const [phase, setPhase] = useState('resolving'); // resolving | ready | paying | qr | success | error
    const [resolvedRecipients, setResolvedRecipients] = useState([]);
    const [selectedAmount, setSelectedAmount] = useState(fixedAmount || 100);
    const [customAmount, setCustomAmount] = useState('');
    const [comment, setComment] = useState('');
    const [bolt11, setBolt11] = useState('');
    const [progress, setProgress] = useState({ step: 0, total: 0, name: '' });
    const [errorMsg, setErrorMsg] = useState('');
    const [payResults, setPayResults] = useState([]);
    const [copied, setCopied] = useState(false);

    const amount = fixedAmount || (customAmount ? parseInt(customAmount, 10) : selectedAmount);

    // Resolve lud16 and bolt12Offer for all recipients on mount.
    // Priority: 1) lud16/bolt12Offer passed from parent, 2) Nostr profile, 3) BIES API profile
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const resolved = [];
            for (const r of recipients) {
                if (!r.pubkey) continue;

                let lud16 = r.lud16 || '';
                let bolt12Offer = r.bolt12Offer || '';

                // If we already have a payment method from parent, use it
                if (lud16 || bolt12Offer) {
                    resolved.push({ ...r, lud16, bolt12Offer });
                    continue;
                }

                // 2. Fetch from Nostr relays
                try {
                    const profile = await nostrService.getProfile(r.pubkey);
                    if (profile?.lud16) lud16 = profile.lud16;
                    else if (profile?.lud06) lud16 = profile.lud06; // raw LNURL fallback
                    if (profile?.bolt12) bolt12Offer = profile.bolt12;
                    if (lud16 || bolt12Offer) {
                        resolved.push({ ...r, lud16, bolt12Offer });
                        continue;
                    }
                } catch { /* skip */ }

                // 3. Fallback: check BIES API profile
                try {
                    const biesProfile = await profilesApi.get(r.pubkey);
                    if (biesProfile?.lightningAddress) lud16 = biesProfile.lightningAddress;
                    if (biesProfile?.bolt12Offer) bolt12Offer = biesProfile.bolt12Offer;
                    if (lud16 || bolt12Offer) {
                        resolved.push({ ...r, lud16, bolt12Offer });
                        continue;
                    }
                } catch { /* skip */ }
            }
            if (cancelled) return;
            setResolvedRecipients(resolved);
            setPhase(resolved.length > 0 ? 'ready' : 'error');
            if (resolved.length === 0) {
                setErrorMsg('No recipients have a Lightning address or Bolt12 offer set.');
            }
        })();
        return () => { cancelled = true; };
    }, [recipients]);

    const perRecipientAmount = resolvedRecipients.length > 0
        ? Math.floor(amount / resolvedRecipients.length)
        : 0;

    const handleZap = async () => {
        if (!amount || amount < 1) return;
        setPhase('paying');
        setPayResults([]);
        setErrorMsg('');

        const results = [];
        let hasPendingQR = false;

        for (let i = 0; i < resolvedRecipients.length; i++) {
            const recipient = resolvedRecipients[i];
            setProgress({ step: i + 1, total: resolvedRecipients.length, name: recipient.name });

            const msats = perRecipientAmount * 1000;

            // ── Bolt12 offer path (no LNURL needed) ──────────────────────
            if (recipient.bolt12Offer && !recipient.lud16) {
                // Bolt12 offers can only be paid via NWC or shown as QR
                if (canPayBolt12ViaWallet) {
                    try {
                        await nwcPayInvoice(recipient.bolt12Offer);
                        results.push({ name: recipient.name, success: true });
                        continue;
                    } catch (nwcErr) {
                        console.warn('[ZapModal] NWC Bolt12 payment failed:', nwcErr.message);
                        results.push({ name: recipient.name, success: false, error: nwcErr.message });
                        continue;
                    }
                }
                // No wallet connected — show Bolt12 offer as QR for manual payment
                if (!hasPendingQR) {
                    hasPendingQR = true;
                    setBolt11(recipient.bolt12Offer);
                    results.push({ name: recipient.name, success: false, bolt12: recipient.bolt12Offer, pending: true });
                } else {
                    results.push({ name: recipient.name, success: false, bolt12: recipient.bolt12Offer, error: 'Pay manually' });
                }
                continue;
            }

            // ── LNURL/lud16 path (existing flow, prefers Bolt12 via NWC if available) ──
            // 1. Resolve LNURL
            const lnurlData = await resolveLud16(recipient.lud16);
            if (!lnurlData) {
                // If LNURL fails but we have a bolt12 offer, fall back to that
                if (recipient.bolt12Offer) {
                    if (canPayBolt12ViaWallet) {
                        try {
                            await nwcPayInvoice(recipient.bolt12Offer);
                            results.push({ name: recipient.name, success: true });
                            continue;
                        } catch (nwcErr) {
                            console.warn('[ZapModal] NWC Bolt12 fallback failed:', nwcErr.message);
                        }
                    }
                    if (!hasPendingQR) {
                        hasPendingQR = true;
                        setBolt11(recipient.bolt12Offer);
                        results.push({ name: recipient.name, success: false, bolt12: recipient.bolt12Offer, pending: true });
                    } else {
                        results.push({ name: recipient.name, success: false, bolt12: recipient.bolt12Offer, error: 'Pay manually' });
                    }
                    continue;
                }
                results.push({ name: recipient.name, success: false, error: 'Could not resolve Lightning address' });
                continue;
            }

            if (msats < lnurlData.minSendable || msats > lnurlData.maxSendable) {
                const min = Math.ceil(lnurlData.minSendable / 1000);
                const max = Math.floor(lnurlData.maxSendable / 1000);
                results.push({ name: recipient.name, success: false, error: `Amount must be ${min}-${max} sats` });
                continue;
            }

            // 2. Create zap request if LNURL supports Nostr
            let zapReq = null;
            if (lnurlData.allowsNostr && lnurlData.nostrPubkey) {
                zapReq = await createZapRequest({
                    recipientPubkey: recipient.pubkey,
                    amountMsats: msats,
                    relays: PUBLIC_RELAYS,
                    eventId,
                    aTag,
                    content: comment,
                });
            }

            // 3. Get invoice
            const invoiceData = await requestInvoice(lnurlData.callback, msats, zapReq);
            if (!invoiceData?.pr) {
                results.push({ name: recipient.name, success: false, error: 'Failed to get invoice' });
                continue;
            }

            // 4. Try NWC wallet first (if connected), then WebLN, then QR fallback
            if (nwcConnected) {
                try {
                    await nwcPayInvoice(invoiceData.pr);
                    results.push({ name: recipient.name, success: true });
                    continue;
                } catch (nwcErr) {
                    console.warn('[ZapModal] NWC payment failed:', nwcErr.message);
                    // Show NWC error directly instead of silently falling through
                    results.push({ name: recipient.name, success: false, error: nwcErr.message });
                    continue;
                }
            }

            const weblnResult = await payWithWebLN(invoiceData.pr);
            if (weblnResult.success) {
                results.push({ name: recipient.name, success: true });
            } else {
                // First unpaid invoice → show QR
                if (!hasPendingQR) {
                    hasPendingQR = true;
                    setBolt11(invoiceData.pr);
                    results.push({ name: recipient.name, success: false, bolt11: invoiceData.pr, pending: true });
                } else {
                    results.push({ name: recipient.name, success: false, bolt11: invoiceData.pr, error: 'Pay manually' });
                }
            }
        }

        setPayResults(results);
        const allSuccess = results.every(r => r.success);
        if (allSuccess) {
            setPhase('success');
            onPaid?.('paid');
        } else if (hasPendingQR) {
            setPhase('qr');
            // Caller can start watching for the payment landing externally
            onPaid?.('qr');
        } else {
            setPhase('error');
            const firstError = results.find(r => !r.success && r.error);
            setErrorMsg(firstError?.error || 'Failed to complete zap.');
        }
    };

    const copyInvoice = () => {
        navigator.clipboard.writeText(bolt11);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const isBolt12QR = bolt11 && bolt11.startsWith('lno1');
    const invoiceUri = bolt11
        ? isBolt12QR ? `bitcoin:?lno=${bolt11}` : `lightning:${bolt11}`
        : '';

    return createPortal(
        <div className="zap-overlay" data-testid="zap-modal" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }} onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()} onTouchMove={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) e.preventDefault(); }}>
            <div className="zap-card">
                {/* Header */}
                <div className="zap-header">
                    <h3 className="zap-title">
                        <Zap size={18} style={{ color: '#f7931a' }} />
                        Send Zap
                    </h3>
                    <button className="zap-close" onClick={onClose}>
                        <X size={20} />
                    </button>
                </div>

                {/* Body */}
                <div className="zap-body">
                    {phase === 'resolving' && (
                        <div className="zap-center" data-testid="zap-resolving">
                            <Loader2 size={28} className="zap-spin" />
                            <p className="zap-status-text">Resolving Lightning addresses...</p>
                        </div>
                    )}

                    {phase === 'ready' && (
                        <>
                            {/* Recipients */}
                            {resolvedRecipients.length > 1 && (
                                <div className="zap-recipients">
                                    <div className="zap-label">Split between {resolvedRecipients.length} recipients</div>
                                    <div className="zap-recipient-list">
                                        {resolvedRecipients.map((r, i) => (
                                            <div key={i} className="zap-recipient">
                                                <div className="zap-recipient-avatar">
                                                    {r.avatar
                                                        ? <img src={getAssetUrl(r.avatar)} alt={r.name} />
                                                        : <span>{(r.name || '?')[0]?.toUpperCase()}</span>
                                                    }
                                                </div>
                                                <span className="zap-recipient-name">{r.name}</span>
                                                <span className="zap-recipient-share">
                                                    {perRecipientAmount.toLocaleString()} sats
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {resolvedRecipients.length === 1 && (
                                <div className="zap-single-recipient">
                                    <div className="zap-recipient-avatar lg">
                                        {resolvedRecipients[0].avatar
                                            ? <img src={getAssetUrl(resolvedRecipients[0].avatar)} alt={resolvedRecipients[0].name} />
                                            : <span>{(resolvedRecipients[0].name || '?')[0]?.toUpperCase()}</span>
                                        }
                                    </div>
                                    <span className="zap-recipient-label">{resolvedRecipients[0].name}</span>
                                </div>
                            )}

                            {/* Amount presets (hidden when the amount is fixed by a purchase flow) */}
                            {!fixedAmount && (
                                <>
                                    <div className="zap-label">Amount (sats)</div>
                                    <div className="zap-amounts">
                                        {AMOUNT_PRESETS.map(a => (
                                            <button
                                                key={a}
                                                className={`zap-amount-chip ${!customAmount && selectedAmount === a ? 'active' : ''}`}
                                                data-testid={`zap-amount-${a}`}
                                                onClick={() => { setSelectedAmount(a); setCustomAmount(''); }}
                                            >
                                                {a >= 1000 ? `${a / 1000}k` : a}
                                            </button>
                                        ))}
                                    </div>

                                    {/* Custom amount */}
                                    <input
                                        type="number"
                                        className="zap-custom-input"
                                        data-testid="zap-custom-amount"
                                        placeholder="Custom amount"
                                        value={customAmount}
                                        onChange={(e) => setCustomAmount(e.target.value)}
                                        min="1"
                                    />
                                </>
                            )}
                            {fixedAmount > 0 && (
                                <div className="zap-label" style={{ textAlign: 'center', fontSize: '1.05rem', color: '#f7931a', textTransform: 'none', letterSpacing: 0 }}>
                                    ⚡ {fixedAmount.toLocaleString()} sats
                                </div>
                            )}

                            {/* Comment */}
                            <input
                                type="text"
                                className="zap-comment-input"
                                data-testid="zap-comment"
                                placeholder="Add a comment (optional)"
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                                maxLength={140}
                            />

                            {/* Zap button */}
                            <button
                                className="zap-send-btn"
                                data-testid="zap-send-btn"
                                onClick={handleZap}
                                disabled={!amount || amount < 1}
                            >
                                {nwcConnected && <Wallet size={16} />}
                                <Zap size={16} />
                                Zap {amount?.toLocaleString() || 0} sats
                            </button>
                            {nwcConnected && (
                                <p className="zap-wallet-hint">
                                    Paying with {walletType === 'coinos' ? 'Coinos wallet' : 'connected wallet'}
                                </p>
                            )}
                        </>
                    )}

                    {phase === 'paying' && (
                        <div className="zap-center" data-testid="zap-paying">
                            <Loader2 size={28} className="zap-spin" />
                            <p className="zap-status-text">
                                {progress.total > 1
                                    ? `Paying ${progress.name} (${progress.step}/${progress.total})...`
                                    : nwcConnected
                                        ? `Paying with wallet...`
                                        : `Requesting invoice...`
                                }
                            </p>
                        </div>
                    )}

                    {phase === 'qr' && (
                        <div className="zap-qr-section" data-testid="zap-qr">
                            <p className="zap-status-text">
                                {isBolt12QR
                                    ? 'Scan this Bolt12 offer with a compatible wallet (Phoenix, Zeus, etc.)'
                                    : 'Scan or copy the invoice to pay'}
                            </p>
                            <div className="zap-qr-wrapper">
                                <QRCodeSVG
                                    value={invoiceUri}
                                    size={220}
                                    level="M"
                                    marginSize={2}
                                    bgColor="#ffffff"
                                    fgColor="#000000"
                                />
                            </div>
                            <div className="zap-invoice-box">
                                <code className="zap-invoice-text">{bolt11}</code>
                            </div>
                            <button className="zap-copy-btn" data-testid="zap-copy-invoice" onClick={copyInvoice}>
                                {copied ? <Check size={14} /> : <Copy size={14} />}
                                {copied ? 'Copied!' : isBolt12QR ? 'Copy Offer' : 'Copy Invoice'}
                            </button>
                            <a
                                href={isBolt12QR ? `bitcoin:?lno=${bolt11}` : `lightning:${bolt11}`}
                                className="zap-open-wallet"
                            >
                                Open in Wallet <ChevronRight size={14} />
                            </a>

                            {/* Show results if split */}
                            {payResults.length > 1 && (
                                <div className="zap-results">
                                    {payResults.map((r, i) => (
                                        <div key={i} className={`zap-result-item ${r.success ? 'success' : ''}`}>
                                            {r.success ? <Check size={14} /> : <AlertCircle size={14} />}
                                            <span>{r.name}</span>
                                            <span className="zap-result-status">
                                                {r.success ? 'Paid' : r.pending ? 'Pending' : r.error}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {phase === 'success' && (
                        <div className="zap-center" data-testid="zap-success">
                            <div className="zap-success-icon">
                                <Zap size={32} />
                            </div>
                            <p className="zap-status-text zap-success-text">
                                Zapped {amount.toLocaleString()} sats!
                            </p>
                            {payResults.length > 1 && (
                                <div className="zap-results">
                                    {payResults.map((r, i) => (
                                        <div key={i} className="zap-result-item success">
                                            <Check size={14} />
                                            <span>{r.name}</span>
                                            <span className="zap-result-status">Paid</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <button className="zap-done-btn" onClick={onClose}>Done</button>
                        </div>
                    )}

                    {phase === 'error' && (
                        <div className="zap-center" data-testid="zap-error">
                            <AlertCircle size={28} style={{ color: '#ef4444' }} />
                            <p className="zap-status-text" style={{ color: '#ef4444' }}>{errorMsg}</p>
                            <button className="zap-done-btn" onClick={() => {
                                if (resolvedRecipients.length > 0) setPhase('ready');
                                else onClose();
                            }}>
                                {resolvedRecipients.length > 0 ? 'Try Again' : 'Close'}
                            </button>
                        </div>
                    )}
                </div>
            </div>

            <style jsx>{`
                .zap-overlay {
                    position: fixed;
                    inset: 0;
                    z-index: 10001;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.6);
                    backdrop-filter: blur(4px);
                    touch-action: none;
                    overscroll-behavior: contain;
                    -webkit-overflow-scrolling: auto;
                }

                .zap-card {
                    background: var(--color-surface);
                    border-radius: 16px;
                    width: 90vw;
                    max-width: 420px;
                    max-height: 90vh;
                    overflow-y: auto;
                    box-shadow: 0 25px 50px rgba(0, 0, 0, 0.3);
                    touch-action: pan-y;
                    overscroll-behavior: contain;
                }

                .zap-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 1rem 1.25rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }

                .zap-title {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-weight: 700;
                    font-size: 1.1rem;
                    font-family: var(--font-display, 'PP Formula Narrow', sans-serif);
                    margin: 0;
                }

                .zap-close {
                    background: none;
                    border: none;
                    cursor: pointer;
                    color: var(--color-gray-500);
                    padding: 4px;
                    display: flex;
                }

                .zap-close:hover { color: var(--color-gray-900); }

                .zap-body {
                    padding: 1.25rem;
                }

                .zap-center {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 2rem 0;
                }

                .zap-spin {
                    animation: zap-spin 1s linear infinite;
                    color: #f7931a;
                }

                @keyframes zap-spin {
                    to { transform: rotate(360deg); }
                }

                .zap-status-text {
                    color: var(--color-gray-600);
                    font-size: 0.9rem;
                    text-align: center;
                    margin: 0;
                }

                .zap-label {
                    font-size: 0.8rem;
                    font-weight: 600;
                    color: var(--color-gray-500);
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 0.5rem;
                }

                /* Recipients */
                .zap-recipients {
                    margin-bottom: 1.25rem;
                }

                .zap-recipient-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                }

                .zap-recipient {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.4rem 0.6rem;
                    background: var(--color-gray-100);
                    border-radius: 8px;
                }

                .zap-recipient-avatar {
                    width: 28px;
                    height: 28px;
                    border-radius: 50%;
                    overflow: hidden;
                    background: var(--color-gray-200);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.7rem;
                    font-weight: 700;
                    color: var(--color-gray-600);
                    flex-shrink: 0;
                }

                .zap-recipient-avatar.lg {
                    width: 48px;
                    height: 48px;
                    font-size: 1rem;
                }

                .zap-recipient-avatar img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }

                .zap-recipient-name {
                    flex: 1;
                    font-size: 0.85rem;
                    font-weight: 500;
                }

                .zap-recipient-share {
                    font-size: 0.8rem;
                    color: #f7931a;
                    font-weight: 600;
                }

                .zap-single-recipient {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.5rem;
                    margin-bottom: 1.25rem;
                }

                .zap-recipient-label {
                    font-size: 0.95rem;
                    font-weight: 600;
                    color: var(--color-gray-900);
                }

                /* Amount chips */
                .zap-amounts {
                    display: flex;
                    gap: 0.5rem;
                    margin-bottom: 0.75rem;
                    flex-wrap: wrap;
                }

                .zap-amount-chip {
                    padding: 0.4rem 0.85rem;
                    border: 1.5px solid var(--color-gray-200);
                    border-radius: 20px;
                    background: var(--color-surface);
                    font-size: 0.85rem;
                    font-weight: 500;
                    cursor: pointer;
                    color: var(--color-gray-600);
                    transition: all 0.15s ease;
                    font-family: var(--font-sans, 'Inter', sans-serif);
                }

                .zap-amount-chip:hover {
                    border-color: #f7931a;
                    color: #f7931a;
                }

                .zap-amount-chip.active {
                    background: #f7931a;
                    border-color: #f7931a;
                    color: white;
                }

                .zap-custom-input,
                .zap-comment-input {
                    width: 100%;
                    padding: 0.6rem 0.75rem;
                    border: 1.5px solid var(--color-gray-200);
                    border-radius: 8px;
                    font-size: 0.875rem;
                    font-family: var(--font-sans, 'Inter', sans-serif);
                    outline: none;
                    box-sizing: border-box;
                    transition: border-color 0.15s;
                }

                .zap-custom-input:focus,
                .zap-comment-input:focus {
                    border-color: #f7931a;
                }

                .zap-custom-input {
                    margin-bottom: 0.5rem;
                }

                .zap-comment-input {
                    margin-bottom: 1rem;
                }

                .zap-custom-input::-webkit-inner-spin-button,
                .zap-custom-input::-webkit-outer-spin-button {
                    -webkit-appearance: none;
                    margin: 0;
                }

                .zap-send-btn {
                    width: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.4rem;
                    padding: 0.75rem;
                    background: #f7931a;
                    color: white;
                    border: none;
                    border-radius: 10px;
                    font-size: 0.95rem;
                    font-weight: 600;
                    cursor: pointer;
                    font-family: var(--font-sans, 'Inter', sans-serif);
                    transition: background 0.15s;
                }

                .zap-send-btn:hover { background: #e8841a; }
                .zap-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

                .zap-wallet-hint {
                    text-align: center;
                    font-size: 0.78rem;
                    color: #22c55e;
                    margin-top: 0.35rem;
                }

                /* QR / Invoice section */
                .zap-qr-section {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 1rem 0;
                }

                .zap-qr-wrapper {
                    background: #ffffff;
                    border-radius: 12px;
                    padding: 0.5rem;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .zap-invoice-box {
                    background: var(--color-gray-100);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 8px;
                    padding: 0.75rem;
                    width: 100%;
                    box-sizing: border-box;
                    word-break: break-all;
                }

                .zap-invoice-text {
                    font-size: 0.75rem;
                    color: var(--color-gray-600);
                }

                .zap-copy-btn {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    padding: 0.5rem 1rem;
                    border: 1.5px solid var(--color-gray-200);
                    border-radius: 8px;
                    background: var(--color-surface);
                    font-size: 0.85rem;
                    cursor: pointer;
                    color: var(--color-gray-600);
                    font-family: var(--font-sans, 'Inter', sans-serif);
                    transition: all 0.15s;
                }

                .zap-copy-btn:hover {
                    border-color: #f7931a;
                    color: #f7931a;
                }

                .zap-open-wallet {
                    display: flex;
                    align-items: center;
                    gap: 0.25rem;
                    padding: 0.6rem 1.2rem;
                    background: #f7931a;
                    color: white;
                    border-radius: 8px;
                    text-decoration: none;
                    font-size: 0.85rem;
                    font-weight: 600;
                    transition: background 0.15s;
                }

                .zap-open-wallet:hover { background: #e8841a; }

                /* Results */
                .zap-results {
                    width: 100%;
                    display: flex;
                    flex-direction: column;
                    gap: 0.35rem;
                    margin-top: 0.5rem;
                }

                .zap-result-item {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    font-size: 0.8rem;
                    color: var(--color-gray-500);
                    padding: 0.3rem 0;
                }

                .zap-result-item.success { color: #10b981; }

                .zap-result-status {
                    margin-left: auto;
                    font-weight: 500;
                }

                /* Success */
                .zap-success-icon {
                    width: 56px;
                    height: 56px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #f7931a 0%, #fbbf24 100%);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                }

                .zap-success-text {
                    font-size: 1.1rem;
                    font-weight: 700;
                    color: var(--color-gray-900);
                }

                .zap-done-btn {
                    padding: 0.5rem 2rem;
                    border: 1.5px solid var(--color-gray-200);
                    border-radius: 8px;
                    background: var(--color-surface);
                    font-size: 0.875rem;
                    cursor: pointer;
                    color: var(--color-gray-600);
                    font-family: var(--font-sans, 'Inter', sans-serif);
                    margin-top: 0.5rem;
                }

                .zap-done-btn:hover { border-color: #94a3b8; }
            `}</style>
        </div>,
        document.body
    );
};

export default ZapModal;
