import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Clock, Copy, Loader2, MoreHorizontal, Plus, QrCode, Share, Ticket, X } from 'lucide-react';
import { adminApi } from '../../services/api';
import { forgetInviteOnly } from '../../hooks/useInviteOnly';
import { copyText } from '../../utils/clipboard';
import { publicUrl } from '../../utils/publicUrl';
import { inviteLink } from '../../utils/inviteCode';
import logoIcon from '../../assets/logo-icon.svg';

const NOTE_MAX = 80;

/**
 * Admin Panel → Invites (the phone app only; admins only, server-enforced).
 * The invite-only switch, and invite codes: one tap makes one, Share sends
 * it. Nothing about the person is asked for. A code shows here only while
 * it's open; the server keeps no readable copy after that.
 */
const AdminInvites = () => {
    const { t, i18n } = useTranslation();
    const lang = i18n.language?.startsWith('es') ? 'es' : 'en';
    const [data, setData] = useState(null);
    const [loadError, setLoadError] = useState('');
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState(null); // { type: 'error' | 'ok', message }
    const [sheet, setSheet] = useState(null); // { kind: 'ready' | 'actions' | 'qr' | 'confirm' | 'revoke' | 'note', invite? }
    const [copied, setCopied] = useState(false);
    const [note, setNote] = useState('');

    const day = (date) => new Date(date).toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' });

    const load = useCallback(async () => {
        try {
            setData(await adminApi.listInvites());
            setLoadError('');
        } catch {
            setLoadError(t('admin.invites.loadError'));
        }
    }, [t]);

    useEffect(() => { load(); }, [load]);

    const fail = (err) => setNotice({ type: 'error', message: err?.data?.reason === 'too_many_open' ? t('admin.invites.tooMany', { count: data?.maxOpen ?? 100 }) : t('admin.invites.saveError') });

    const setSwitch = async (on) => {
        setBusy('switch');
        setNotice(null);
        try {
            const gate = await adminApi.setInviteOnly(on);
            setData((d) => ({ ...d, ...gate }));
            forgetInviteOnly();
        } catch (err) {
            fail(err);
        } finally {
            setBusy('');
            setSheet(null);
        }
    };

    // Closing the door asks first; opening it doesn't lock anyone out.
    const onToggle = () => (data?.inviteOnly ? setSwitch(false) : setSheet({ kind: 'confirm' }));

    const create = async () => {
        setBusy('create');
        setNotice(null);
        try {
            const { invite } = await adminApi.createInvite();
            setCopied(false);
            setSheet({ kind: 'ready', invite });
            load();
        } catch (err) {
            fail(err);
        } finally {
            setBusy('');
        }
    };

    const linkFor = (invite) => inviteLink(publicUrl(''), invite.code);

    const share = async (invite) => {
        const text = t('admin.invites.shareText', { link: linkFor(invite), code: invite.code, date: day(invite.expiresAt) });
        if (navigator.share) {
            try {
                await navigator.share({ text });
                return;
            } catch (err) {
                if (err?.name === 'AbortError') return;
            }
        }
        // No share menu here (Android's web view): the message, ready to paste.
        if (await copyText(text)) setNotice({ type: 'ok', message: t('admin.invites.messageCopied') });
    };

    const copyCode = async (invite) => {
        if (await copyText(invite.code)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const revoke = async (invite) => {
        setBusy('revoke');
        try {
            await adminApi.revokeInvite(invite.id);
            await load();
        } catch (err) {
            fail(err);
        } finally {
            setBusy('');
            setSheet(null);
        }
    };

    const saveNote = async (invite) => {
        setBusy('note');
        try {
            const res = await adminApi.setInviteNote(invite.id, note);
            setData((d) => ({ ...d, invites: d.invites.map((i) => (i.id === invite.id ? res.invite : i)) }));
            setSheet(sheet?.from === 'ready' ? { kind: 'ready', invite: res.invite } : null);
        } catch (err) {
            fail(err);
        } finally {
            setBusy('');
        }
    };

    const openNote = (invite, from) => {
        setNote(invite.note || '');
        setSheet({ kind: 'note', invite, from });
    };

    const describe = (invite) => {
        switch (invite.status) {
            case 'open':
                return t('admin.invites.expires', { date: day(invite.expiresAt) });
            case 'used':
                return invite.usedBy
                    ? t('admin.invites.joined', { name: invite.usedBy.name || t('admin.invites.someone'), date: day(invite.usedAt) })
                    : t('admin.invites.accountDeleted', { date: day(invite.usedAt) });
            case 'expired':
                return t('admin.invites.notUsed', { date: day(invite.expiresAt) });
            default:
                return t('admin.invites.revokedOn', { date: day(invite.revokedAt) });
        }
    };

    if (!data && !loadError) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
        );
    }

    return (
        <>
            <div className="ai-header">
                <h1>{t('admin.invites.title')}</h1>
                <p className="ai-subtitle">{t('admin.invites.subtitle', { count: data?.days ?? 7 })}</p>
            </div>

            {loadError && <div className="ai-notice error">{loadError}</div>}
            {notice && <div className={`ai-notice ${notice.type}`} role="status">{notice.message}</div>}

            {data && (<>
                <div className={`ai-card ai-switch ${data.inviteOnly ? 'on' : ''}`}>
                    <div className="ai-switch-text">
                        <span className="ai-switch-name">{t('admin.invites.switchName')}</span>
                        <span className="ai-switch-state">{data.inviteOnly ? t('admin.invites.switchOn') : t('admin.invites.switchOff')}</span>
                        {data.changedAt && data.changedBy && (
                            <span className="ai-switch-state">
                                {t(data.inviteOnly ? 'admin.invites.changedOn' : 'admin.invites.changedOff', { name: data.changedBy.name || t('admin.invites.anAdmin'), date: day(data.changedAt) })}
                            </span>
                        )}
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={data.inviteOnly}
                        aria-label={t('admin.invites.switchName')}
                        className={`ai-toggle ${data.inviteOnly ? 'on' : ''}`}
                        onClick={onToggle}
                        disabled={busy === 'switch'}
                    >
                        <span />
                    </button>
                </div>

                <button type="button" className="ai-primary" onClick={create} disabled={busy === 'create'}>
                    {busy === 'create' ? <Loader2 size={18} className="ai-spin" /> : <Plus size={18} />}
                    <span>{t('admin.invites.newInvite')}</span>
                </button>

                <p className="ai-list-head">
                    {t('admin.invites.list')} · {t('admin.invites.openCount', { count: data.openCount })}
                </p>
                {data.invites.length === 0 ? (
                    <p className="ai-empty">{t('admin.invites.empty')}</p>
                ) : (
                    <div className="ai-card ai-list">
                        {data.invites.map((invite) => (
                            <div key={invite.id} className="ai-row">
                                <div className="ai-row-main">
                                    <div className="ai-row-top">
                                        {invite.code
                                            ? <span className="ai-code">{invite.code}</span>
                                            : <span className="ai-row-title">{invite.note || t('admin.invites.madeOn', { date: day(invite.createdAt) })}</span>}
                                        <span className={`ai-chip ${invite.status}`}>{t(`admin.invites.status.${invite.status}`)}</span>
                                    </div>
                                    {invite.code && invite.note && <div className="ai-row-note">{invite.note}</div>}
                                    <div className="ai-row-sub">{describe(invite)} · {t('admin.invites.madeBy', { name: invite.createdBy.name || t('admin.invites.anAdmin') })}</div>
                                </div>
                                {invite.status === 'open' && invite.code && (
                                    <button type="button" className="ai-more" aria-label={t('admin.invites.more')} onClick={() => setSheet({ kind: 'actions', invite })}>
                                        <MoreHorizontal size={20} />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </>)}

            {sheet && createPortal(
                <div className={`ai-overlay ${sheet.kind === 'qr' ? 'qr' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget && sheet.kind !== 'qr') setSheet(null); }}>
                    {sheet.kind === 'confirm' && (
                        <div className="ai-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ai-confirm-title">
                            <h2 id="ai-confirm-title">{t('admin.invites.confirmTitle')}</h2>
                            <p>{t('admin.invites.confirmBody')}</p>
                            <div className="ai-dialog-buttons">
                                <button type="button" onClick={() => setSheet(null)}>{t('admin.invites.cancel')}</button>
                                <button type="button" className="strong" onClick={() => setSwitch(true)} disabled={busy === 'switch'}>{t('admin.invites.confirmOn')}</button>
                            </div>
                        </div>
                    )}

                    {sheet.kind === 'revoke' && (
                        <div className="ai-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ai-revoke-title">
                            <h2 id="ai-revoke-title">{t('admin.invites.revokeTitle')}</h2>
                            <p>{t('admin.invites.revokeBody', { code: sheet.invite.code })}</p>
                            <div className="ai-dialog-buttons">
                                <button type="button" onClick={() => setSheet(null)}>{t('admin.invites.cancel')}</button>
                                <button type="button" className="strong danger" onClick={() => revoke(sheet.invite)} disabled={busy === 'revoke'}>{t('admin.invites.revoke')}</button>
                            </div>
                        </div>
                    )}

                    {sheet.kind === 'ready' && (
                        <Sheet onClose={() => setSheet(null)} label={t('admin.invites.readyTitle')}>
                            <div className="ai-sheet-icon"><Ticket size={22} /></div>
                            <h2 className="ai-sheet-title">{t('admin.invites.readyTitle')}</h2>
                            <p className="ai-sheet-body">{t('admin.invites.readyBody')}</p>
                            <div className="ai-codebox">{sheet.invite.code}</div>
                            {sheet.invite.note && <p className="ai-sheet-note">{sheet.invite.note}</p>}
                            <p className="ai-sheet-meta"><Clock size={14} /> {t('admin.invites.expires', { date: day(sheet.invite.expiresAt) })}</p>
                            <button type="button" className="ai-primary" onClick={() => share(sheet.invite)}>
                                <Share size={18} /> <span>{t('admin.invites.share')}</span>
                            </button>
                            <div className="ai-two">
                                <button type="button" className="ai-secondary" onClick={() => copyCode(sheet.invite)}>
                                    <Copy size={16} /> {copied ? t('admin.invites.copied') : t('admin.invites.copyCode')}
                                </button>
                                <button type="button" className="ai-secondary" onClick={() => setSheet({ kind: 'qr', invite: sheet.invite })}>
                                    <QrCode size={16} /> {t('admin.invites.showQr')}
                                </button>
                            </div>
                            <button type="button" className="ai-link" onClick={() => openNote(sheet.invite, 'ready')}>
                                {sheet.invite.note ? t('admin.invites.editNote') : t('admin.invites.addNote')}
                            </button>
                        </Sheet>
                    )}

                    {sheet.kind === 'note' && (
                        <Sheet onClose={() => setSheet(sheet.from === 'ready' ? { kind: 'ready', invite: sheet.invite } : null)} label={t('admin.invites.noteLabel')}>
                            <h2 className="ai-sheet-title">{t('admin.invites.noteLabel')}</h2>
                            <input
                                className="ai-input"
                                value={note}
                                maxLength={NOTE_MAX}
                                placeholder={t('admin.invites.notePlaceholder')}
                                onChange={(e) => setNote(e.target.value)}
                                autoFocus
                            />
                            <p className="ai-sheet-meta">{t('admin.invites.noteHint')}</p>
                            <button type="button" className="ai-primary" onClick={() => saveNote(sheet.invite)} disabled={busy === 'note'}>
                                {t('admin.invites.saveNote')}
                            </button>
                        </Sheet>
                    )}

                    {sheet.kind === 'actions' && (
                        <div className="ai-actions" role="dialog" aria-modal="true" aria-label={sheet.invite.code}>
                            <div className="ai-actions-group">
                                <div className="ai-actions-head">{sheet.invite.code} · {t('admin.invites.expires', { date: day(sheet.invite.expiresAt) })}</div>
                                <button type="button" onClick={() => { const i = sheet.invite; setSheet(null); share(i); }}>{t('admin.invites.shareAgain')}</button>
                                <button type="button" onClick={() => { copyCode(sheet.invite); setSheet(null); setNotice({ type: 'ok', message: t('admin.invites.codeCopied') }); }}>{t('admin.invites.copyCode')}</button>
                                <button type="button" onClick={() => setSheet({ kind: 'qr', invite: sheet.invite })}>{t('admin.invites.showQr')}</button>
                                <button type="button" onClick={() => openNote(sheet.invite)}>{sheet.invite.note ? t('admin.invites.editNote') : t('admin.invites.addNoteShort')}</button>
                                <button type="button" className="danger" onClick={() => setSheet({ kind: 'revoke', invite: sheet.invite })}>{t('admin.invites.revoke')}</button>
                            </div>
                            <div className="ai-actions-group">
                                <button type="button" className="strong" onClick={() => setSheet(null)}>{t('admin.invites.cancel')}</button>
                            </div>
                        </div>
                    )}

                    {sheet.kind === 'qr' && (
                        <div className="ai-qr" role="dialog" aria-modal="true" aria-label={t('admin.invites.qrTitle')}>
                            <button type="button" className="ai-qr-close" aria-label={t('admin.invites.close')} onClick={() => setSheet(null)}>
                                <X size={24} />
                            </button>
                            <img src={logoIcon} alt="" className="ai-qr-logo" />
                            <h2>{t('admin.invites.qrTitle')}</h2>
                            <p>{t('admin.invites.qrBody')}</p>
                            <div className="ai-qr-code">
                                <QRCodeSVG value={linkFor(sheet.invite)} size={232} level="M" includeMargin={false} />
                            </div>
                            <p className="ai-qr-text">{sheet.invite.code}</p>
                            <p>{t('admin.invites.qrMeta', { date: day(sheet.invite.expiresAt) })}</p>
                        </div>
                    )}

                </div>,
                document.body,
            )}

            <style jsx>{`
                .ai-overlay {
                    position: fixed; inset: 0; z-index: 10100; /* above the bottom bar (10000), as EmailSheet */
                    background: rgba(15, 23, 42, 0.4);
                    display: flex; align-items: flex-end; justify-content: center;
                }
                .ai-overlay.qr { background: #fff; align-items: stretch; }
                .ai-dialog {
                    align-self: center; width: min(320px, calc(100% - 3rem)); background: var(--color-surface);
                    color: var(--color-text, inherit); border-radius: 1rem; overflow: hidden; text-align: center;
                }
                .ai-dialog h2 { font-size: 1.05rem; font-weight: 700; margin: 1.25rem 1rem 0.4rem; }
                .ai-dialog p { font-size: 0.875rem; color: var(--color-gray-600); margin: 0 1.25rem 1.1rem; line-height: 1.45; }
                .ai-dialog-buttons { display: flex; border-top: 1px solid var(--color-gray-200); }
                .ai-dialog-buttons button {
                    flex: 1; padding: 0.85rem; border: none; background: none; font-size: 1rem;
                    color: var(--color-primary); cursor: pointer;
                }
                .ai-dialog-buttons button + button { border-left: 1px solid var(--color-gray-200); }
                .ai-dialog-buttons .strong { font-weight: 700; }
                .ai-dialog-buttons .danger { color: var(--color-error); }
                .ai-actions { width: 100%; max-width: 480px; padding: 0 0.6rem calc(0.6rem + env(safe-area-inset-bottom)); }
                .ai-actions-group {
                    background: var(--color-surface); border-radius: 0.9rem; overflow: hidden; margin-top: 0.5rem;
                    display: flex; flex-direction: column;
                }
                .ai-actions-head { font-size: 0.8rem; color: var(--color-gray-500); text-align: center; padding: 0.75rem; }
                .ai-actions-group button {
                    border: none; border-top: 1px solid var(--color-gray-200); background: none; padding: 0.95rem;
                    font-size: 1.05rem; color: var(--color-primary); cursor: pointer;
                }
                .ai-actions-group .ai-actions-head + button, .ai-actions-group button:first-child { border-top: none; }
                .ai-actions-group .ai-actions-head + button { border-top: 1px solid var(--color-gray-200); }
                .ai-actions-group .danger { color: var(--color-error); }
                .ai-actions-group .strong { font-weight: 700; }
                .ai-qr {
                    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
                    padding: calc(1rem + env(safe-area-inset-top)) 1.5rem calc(1rem + env(safe-area-inset-bottom));
                    color: #0A192F; text-align: center; position: relative;
                }
                .ai-qr-close {
                    position: absolute; top: calc(0.75rem + env(safe-area-inset-top)); left: 0.75rem;
                    border: none; background: none; color: #334155; padding: 0.5rem; cursor: pointer;
                }
                .ai-qr-logo { width: 56px; height: 56px; margin-bottom: 0.75rem; }
                .ai-qr h2 { font-size: 1.4rem; font-weight: 700; color: var(--color-primary); margin: 0 0 0.3rem; }
                .ai-qr p { font-size: 0.9rem; color: #5E6B7F; margin: 0.3rem 0; }
                .ai-qr-code { background: #fff; padding: 14px; border: 1px solid #E2E8F0; border-radius: 18px; margin: 1rem 0; }
                .ai-qr .ai-qr-text {
                    font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-weight: 700; font-size: 1.15rem;
                    letter-spacing: 0.06em; color: #0A192F;
                }
                .ai-header { margin-bottom: 1.1rem; }
                .ai-header h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
                .ai-subtitle { color: var(--color-gray-500); font-size: 0.9rem; }
                .ai-notice { padding: 0.75rem 1rem; border-radius: var(--radius-md); margin-bottom: 1rem; font-size: 0.9rem; }
                .ai-notice.error { background: var(--color-red-tint); color: var(--badge-error-text); border: 1px solid var(--badge-error-bg); }
                .ai-notice.ok { background: var(--color-green-tint); color: var(--color-success-text); border: 1px solid #BBF7D0; }
                .ai-card { background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: var(--radius-lg); }
                .ai-switch { display: flex; align-items: center; gap: 1rem; padding: 0.9rem 1rem; margin-bottom: 0.9rem; }
                .ai-switch.on { background: var(--color-blue-tint); border-color: #BFD3F2; }
                .ai-switch-text { flex: 1; display: flex; flex-direction: column; gap: 0.15rem; }
                .ai-switch-name { font-weight: 600; }
                .ai-switch-state { font-size: 0.8rem; color: var(--color-gray-500); }
                .ai-switch.on .ai-switch-state { color: var(--color-primary); }
                .ai-toggle {
                    width: 50px; height: 30px; border-radius: 15px; border: none; background: var(--color-gray-300);
                    position: relative; cursor: pointer; flex-shrink: 0; transition: background 0.2s;
                }
                .ai-toggle span {
                    position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%;
                    background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.25); transition: left 0.2s;
                }
                .ai-toggle.on { background: var(--color-primary); }
                .ai-toggle.on span { left: 23px; }
                .ai-toggle:disabled { opacity: 0.6; }
                .ai-primary {
                    width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;
                    background: var(--color-primary); color: #fff; border: none; border-radius: 0.9rem;
                    padding: 0.85rem 1rem; font-size: 1rem; font-weight: 600; cursor: pointer;
                }
                .ai-primary:disabled { opacity: 0.6; }
                .ai-primary :global(.ai-spin) { animation: spin 1s linear infinite; }
                .ai-secondary {
                    display: flex; align-items: center; justify-content: center; gap: 0.4rem;
                    background: var(--color-surface); color: var(--color-primary); border: 1.5px solid #C7D7F0;
                    border-radius: 0.9rem; padding: 0.7rem 0.5rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
                }
                .ai-two { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem; }
                .ai-link { border: none; background: none; color: var(--color-primary); font-weight: 600; font-size: 0.875rem; margin-top: 0.9rem; cursor: pointer; }
                .ai-list-head { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--color-gray-500); margin: 1.4rem 0.2rem 0.5rem; }
                .ai-empty { color: var(--color-gray-500); font-size: 0.9rem; }
                .ai-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 0.9rem; border-top: 1px solid var(--color-gray-100); }
                .ai-row:first-child { border-top: none; }
                .ai-row-main { flex: 1; min-width: 0; }
                .ai-row-top { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
                .ai-code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-weight: 700; letter-spacing: 0.03em; }
                .ai-row-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
                .ai-row-note { font-size: 0.85rem; font-weight: 600; margin-top: 0.15rem; }
                .ai-row-sub { font-size: 0.8rem; color: var(--color-gray-500); margin-top: 0.15rem; }
                .ai-chip { font-size: 0.7rem; font-weight: 600; padding: 0.1rem 0.55rem; border-radius: 9999px; }
                .ai-chip.open { background: var(--color-blue-tint); color: var(--color-primary); }
                .ai-chip.used { background: var(--color-green-tint); color: var(--color-success-text); }
                .ai-chip.expired, .ai-chip.revoked { background: var(--color-gray-100); color: var(--color-gray-500); }
                .ai-more { border: none; background: none; color: var(--color-gray-400); padding: 0.4rem; cursor: pointer; }
            `}</style>
        </>
    );
};

/** A sheet from the bottom of the screen. */
function Sheet({ children, onClose, label }) {
    const ref = useRef(null);
    useEffect(() => {
        ref.current?.focus();
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div className="ai-sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
            <div className="ai-grab" />
            {children}
            <style jsx>{`
                .ai-sheet {
                    width: 100%; max-width: 480px; background: var(--color-surface); color: var(--color-text, inherit);
                    border-radius: 1.25rem 1.25rem 0 0; padding: 0.6rem 1.25rem calc(1.5rem + env(safe-area-inset-bottom));
                    display: flex; flex-direction: column; outline: none; text-align: center;
                }
                .ai-grab { width: 36px; height: 5px; border-radius: 3px; background: var(--color-gray-300); margin: 0 auto 1rem; }
                .ai-sheet :global(.ai-sheet-icon) {
                    width: 48px; height: 48px; border-radius: 50%; background: #FFEDE3; color: var(--color-secondary);
                    display: grid; place-items: center; margin: 0 auto 0.6rem;
                }
                .ai-sheet :global(.ai-sheet-title) { font-size: 1.15rem; font-weight: 700; margin: 0 0 0.3rem; }
                .ai-sheet :global(.ai-sheet-body) { font-size: 0.875rem; color: var(--color-gray-500); margin: 0 0 1rem; }
                .ai-sheet :global(.ai-codebox) {
                    font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-weight: 700; font-size: 1.45rem; letter-spacing: 0.06em;
                    background: var(--color-gray-100); border: 1.5px dashed var(--color-gray-400); border-radius: 0.9rem; padding: 0.9rem 0.5rem;
                    user-select: all; -webkit-user-select: all;
                }
                .ai-sheet :global(.ai-sheet-note) { font-size: 0.85rem; margin: 0.6rem 0 0; font-weight: 600; }
                .ai-sheet :global(.ai-sheet-meta) {
                    display: flex; align-items: center; justify-content: center; gap: 0.35rem;
                    font-size: 0.8rem; color: var(--color-gray-500); margin: 0.6rem 0 1rem;
                }
                .ai-sheet :global(.ai-input) {
                    width: 100%; box-sizing: border-box; padding: 0.8rem 1rem; border: 1px solid var(--color-gray-200);
                    border-radius: 0.9rem; font-size: 1rem; background: var(--color-surface); color: inherit; margin-top: 0.6rem;
                }
                .ai-sheet :global(.ai-primary) {
                    width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem;
                    background: var(--color-primary); color: #fff; border: none; border-radius: 0.9rem;
                    padding: 0.85rem 1rem; font-size: 1rem; font-weight: 600; cursor: pointer;
                }
                .ai-sheet :global(.ai-secondary) {
                    display: flex; align-items: center; justify-content: center; gap: 0.4rem;
                    background: var(--color-surface); color: var(--color-primary); border: 1.5px solid #C7D7F0;
                    border-radius: 0.9rem; padding: 0.7rem 0.5rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
                }
                .ai-sheet :global(.ai-two) { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem; }
                .ai-sheet :global(.ai-link) { border: none; background: none; color: var(--color-primary); font-weight: 600; font-size: 0.875rem; margin-top: 0.9rem; cursor: pointer; }
            `}</style>
        </div>
    );
}

export default AdminInvites;
