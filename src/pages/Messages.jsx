import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Send, MoreVertical, Lock, MessageCircle, Loader2, AlertTriangle, X, ArrowLeft, Bell, BellOff } from 'lucide-react';
import { useNostrDMs } from '../hooks/useNostr';
import { nostrService } from '../services/nostrService';
import { nostrSigner } from '../services/nostrSigner';
import { Link, useLocation } from 'react-router-dom';
import { searchApi, notificationsApi } from '../services/api';
import { nip19 } from 'nostr-tools';
import { notifyIncomingMessage, requestNotificationPermission, getNotificationPermission, subscribeToPush } from '../utils/notificationManager';

const Messages = () => {
    const { t } = useTranslation();
    const [notifPermission, setNotifPermission] = useState(getNotificationPermission());

    // Notification callback — fires for every received (non-sender) DM
    const profilesRef = useRef({});
    const handleIncomingMessage = useCallback((dm) => {
        const p = profilesRef.current[dm.partnerPubkey];
        const senderName = p?.name || p?.display_name || dm.partnerPubkey.substring(0, 12) + '...';
        notifyIncomingMessage(dm.id, senderName, dm.content);
    }, []);

    const {
        messages,
        conversations,
        profiles,
        loading,
        error,
        connect,
        publicKey,
        sendMessage,
    } = useNostrDMs({ onIncomingMessage: handleIncomingMessage });

    const [activeChatPubkey, setActiveChatPubkey] = useState(null);
    const [openChats, setOpenChats] = useState([]);
    const [newMessage, setNewMessage] = useState('');
    const [sending, setSending] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [userSearchResults, setUserSearchResults] = useState([]);
    const [searchingUsers, setSearchingUsers] = useState(false);
    const [searchFocused, setSearchFocused] = useState(false);
    const [mobileView, setMobileView] = useState('sidebar'); // 'sidebar' | 'chat'
    const chatEndRef = useRef(null);
    const searchTimerRef = useRef(null);
    const messageInputRef = useRef(null);
    profilesRef.current = profiles;

    // NIP-17 DMs need bulk NIP-44 decryption (2 ops per gift-wrap, up to
    // ~100 wraps per sync) — with an Amber NIP-55 session every op is a full
    // app switch, which is unusable. Block and steer to NIP-46 instead.
    const isAmberSigner = nostrSigner.storedMethod === 'amber';

    // Auto-connect on mount
    useEffect(() => {
        if (isAmberSigner) return; // never fire the decrypt loop under NIP-55
        if (!publicKey && !loading) {
            connect();
        }
    }, []);

    // Scroll to bottom when messages change
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [activeChatPubkey, messages]);

    const handleSendMessage = async () => {
        if (!newMessage.trim() || !activeChatPubkey || sending) return;

        setSending(true);
        try {
            await sendMessage(activeChatPubkey, newMessage.trim());
            setNewMessage('');
            if (messageInputRef.current) messageInputRef.current.style.height = 'auto';
        } catch (err) {
            console.error('Failed to send message:', err);
        } finally {
            setSending(false);
        }
    };

    // Unified search: filters existing convos + searches for new users
    const handleSearch = useCallback((query) => {
        setSearchQuery(query);

        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

        // If it looks like an npub or hex pubkey, or too short, skip user search
        if (!query.trim() || query.trim().length < 2 || query.startsWith('npub') || /^[0-9a-f]{10,}$/i.test(query)) {
            setUserSearchResults([]);
            setSearchingUsers(false);
            return;
        }

        setSearchingUsers(true);
        searchTimerRef.current = setTimeout(async () => {
            try {
                const [biesRes, nostrResults] = await Promise.allSettled([
                    searchApi.search(query, 'profiles', 1, 8),
                    nostrService.searchProfiles(query, 8),
                ]);

                const results = [];
                const seen = new Set();
                // Exclude pubkeys already in conversations
                const existingPubkeys = new Set(Object.keys(conversations));

                if (biesRes.status === 'fulfilled' && biesRes.value?.profiles) {
                    for (const p of biesRes.value.profiles) {
                        if (p.user?.nostrPubkey && !seen.has(p.user.nostrPubkey) && !existingPubkeys.has(p.user.nostrPubkey)) {
                            seen.add(p.user.nostrPubkey);
                            results.push({
                                pubkey: p.user.nostrPubkey,
                                name: p.name || '',
                                avatar: p.avatar || '',
                                source: 'BIES',
                            });
                        }
                    }
                }

                if (nostrResults.status === 'fulfilled') {
                    for (const p of nostrResults.value) {
                        if (p.pubkey && !seen.has(p.pubkey) && !existingPubkeys.has(p.pubkey)) {
                            seen.add(p.pubkey);
                            results.push({
                                pubkey: p.pubkey,
                                name: p.display_name || p.name || '',
                                avatar: p.picture || '',
                                source: 'Nostr',
                                nip05: p.nip05 || '',
                            });
                        }
                    }
                }

                setUserSearchResults(results);
            } catch (err) {
                console.error('User search failed:', err);
            } finally {
                setSearchingUsers(false);
            }
        }, 300);
    }, [conversations]);

    const openChat = (pubkey) => {
        setOpenChats(prev => prev.includes(pubkey) ? prev : [...prev, pubkey]);
        setActiveChatPubkey(pubkey);
        setMobileView('chat');
    };

    // Deep link: navigate('/messages', { state: { pubkey } }) opens that chat
    // (used by marketplace "Message seller").
    const statePubkey = useLocation().state?.pubkey;
    useEffect(() => {
        if (typeof statePubkey === 'string' && /^[0-9a-f]{64}$/i.test(statePubkey)) {
            openChat(statePubkey);
        }
    }, [statePubkey]);  

    const closeTab = (e, pubkey) => {
        e.stopPropagation();
        const remaining = openChats.filter(p => p !== pubkey);
        setOpenChats(remaining);
        if (activeChatPubkey === pubkey) {
            setActiveChatPubkey(remaining[remaining.length - 1] || null);
        }
    };

    const handleSelectUser = (pubkey) => {
        openChat(pubkey);
        setSearchQuery('');
        setUserSearchResults([]);
        setSearchFocused(false);
    };

    const handleSearchKeyDown = (e) => {
        if (e.key !== 'Enter') return;
        const input = searchQuery.trim();
        if (!input) return;

        // Try as npub or hex pubkey to start a new chat
        let pubkey = input;
        try {
            if (input.startsWith('npub')) {
                pubkey = nip19.decode(input).data;
            }
        } catch {
            return;
        }

        if (/^[0-9a-f]{64}$/i.test(pubkey)) {
            handleSelectUser(pubkey);
        }
    };

    const getDisplayName = (pubkey) => {
        const profile = profiles[pubkey];
        if (profile?.name) return profile.name;
        if (profile?.display_name) return profile.display_name;
        try {
            return nip19.npubEncode(pubkey).substring(0, 16) + '...';
        } catch {
            return pubkey.substring(0, 12) + '...';
        }
    };

    const getAvatar = (pubkey) => {
        const profile = profiles[pubkey];
        return profile?.picture || null;
    };

    const formatTime = (timestamp) => {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const diff = now - date;

        if (diff < 86400000) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else if (diff < 604800000) {
            return date.toLocaleDateString([], { weekday: 'short' });
        }
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    // Sort conversations by last message time
    const sortedConversations = Object.entries(conversations)
        .map(([pubkey, msgs]) => ({
            pubkey,
            messages: msgs,
            lastMessage: msgs[msgs.length - 1],
        }))
        .filter(c => {
            if (!searchQuery) return true;
            const name = getDisplayName(c.pubkey).toLowerCase();
            return name.includes(searchQuery.toLowerCase());
        })
        .sort((a, b) => (b.lastMessage?.created_at || 0) - (a.lastMessage?.created_at || 0));

    const activeMessages = activeChatPubkey ? (conversations[activeChatPubkey] || []) : [];

    // Amber (NIP-55) sessions can't drive messaging — see comment above.
    if (isAmberSigner) {
        return (
            <div className="messages-page">
                <div className="connect-container">
                    <div className="connect-card">
                        <Lock size={48} className="mb-4 text-primary" />
                        <h2>Private Messages</h2>
                        <p className="text-gray-500 mb-6 text-center">
                            {t('messages.amberSignerWarning')}
                        </p>
                        <Link className="btn btn-primary" to="/login">
                            {t('login.remoteSignerScan')}
                        </Link>
                    </div>
                </div>
                <style jsx>{`${sharedStyles}`}</style>
            </div>
        );
    }

    // Not connected state
    if (!publicKey && !loading) {
        return (
            <div className="messages-page">
                <div className="connect-container">
                    <div className="connect-card">
                        <Lock size={48} className="mb-4 text-primary" />
                        <h2>Private Messages</h2>
                        <p className="text-gray-500 mb-6 text-center">
                            {error
                                ? 'Your Nostr signing session has expired. Please log in again to access encrypted messages.'
                                : 'End-to-end encrypted messaging powered by Nostr (NIP-17). Log in with any Nostr method to get started.'}
                        </p>
                        {error && (
                            <div className="error-banner mb-4">
                                <AlertTriangle size={16} /> {error}
                            </div>
                        )}
                        <button className="btn btn-primary" onClick={connect} disabled={loading}>
                            {loading ? 'Connecting...' : 'Connect'}
                        </button>
                    </div>
                </div>
                <style jsx>{`${sharedStyles}`}</style>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="messages-page">
                <div className="connect-container">
                    <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
                    <p className="text-gray-500" style={{ marginTop: '1rem' }}>Connecting to Nostr relays...</p>
                </div>
                <style jsx>{`${sharedStyles}`}</style>
            </div>
        );
    }

    return (
        <div className="messages-page">
            <div className="messages-layout">
                {/* Sidebar List */}
                <div className={`messages-sidebar${mobileView === 'chat' ? ' mobile-hidden' : ''}`}>
                    <div className="sidebar-header page-title-block">
                        <h2>Messages</h2>
                    </div>

                    {notifPermission === 'default' && (
                        <button
                            className="notif-prompt"
                            onClick={async () => {
                                const perm = await requestNotificationPermission();
                                setNotifPermission(perm);
                                if (perm === 'granted') {
                                    try {
                                        const { publicKey } = await notificationsApi.getVapidKey();
                                        if (publicKey) {
                                            const sub = await subscribeToPush(publicKey);
                                            if (sub) await notificationsApi.pushSubscribe(sub);
                                        }
                                    } catch { /* push is best-effort */ }
                                }
                            }}
                        >
                            <Bell size={14} />
                            <span>Enable notifications</span>
                        </button>
                    )}
                    {notifPermission === 'denied' && (
                        <div className="notif-prompt denied">
                            <BellOff size={14} />
                            <span>Notifications blocked — enable in browser settings</span>
                        </div>
                    )}

                    <div className="search-box">
                        <Search size={16} className="search-icon" />
                        <input
                            type="text"
                            placeholder="Search or start a new chat..."
                            value={searchQuery}
                            onChange={e => handleSearch(e.target.value)}
                            onKeyDown={handleSearchKeyDown}
                            onFocus={() => setSearchFocused(true)}
                            onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
                        />
                        {searchQuery && (
                            <button className="search-clear" onClick={() => { setSearchQuery(''); setUserSearchResults([]); }}>
                                <X size={14} />
                            </button>
                        )}
                    </div>

                    {searchFocused && searchQuery.trim().length >= 2 && (
                        <div className="search-results-panel">
                            {searchingUsers && (
                                <div className="search-status">
                                    <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                                    <span>Searching users...</span>
                                </div>
                            )}
                            {userSearchResults.length > 0 && (
                                <>
                                    <div className="search-section-label">Start new conversation</div>
                                    <div className="user-search-results">
                                        {userSearchResults.map(user => (
                                            <div
                                                key={user.pubkey}
                                                className="user-result-item"
                                                onClick={() => handleSelectUser(user.pubkey)}
                                            >
                                                <div className="chat-avatar small">
                                                    {user.avatar ? (
                                                        <img src={user.avatar} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                                                    ) : (
                                                        (user.name || '??').substring(0, 2).toUpperCase()
                                                    )}
                                                </div>
                                                <div className="user-result-info">
                                                    <span className="user-result-name">{user.name || nip19.npubEncode(user.pubkey).substring(0, 16) + '...'}</span>
                                                    {user.nip05 && <span className="user-result-nip05">{user.nip05}</span>}
                                                </div>
                                                <span className={`source-badge ${user.source.toLowerCase()}`}>{user.source}</span>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                            {!searchingUsers && userSearchResults.length === 0 && !searchQuery.startsWith('npub') && !/^[0-9a-f]{10,}$/i.test(searchQuery) && (
                                <div className="search-status" style={{ color: 'var(--color-gray-400)' }}>
                                    No new users found — try an npub to message directly
                                </div>
                            )}
                        </div>
                    )}

                    <div className="conversation-list">
                        {sortedConversations.length === 0 ? (
                            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-gray-400)', fontSize: '0.9rem' }}>
                                {Object.keys(conversations).length === 0 ? 'No messages yet' : 'No matches'}
                            </div>
                        ) : (
                            sortedConversations.map(({ pubkey, lastMessage }) => {
                                const avatar = getAvatar(pubkey);
                                return (
                                    <div
                                        key={pubkey}
                                        className={`chat-item ${activeChatPubkey === pubkey ? 'active' : ''}`}
                                        onClick={() => openChat(pubkey)}
                                    >
                                        <div className="chat-avatar">
                                            {avatar ? (
                                                <img src={avatar} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                                            ) : (
                                                getDisplayName(pubkey).substring(0, 2).toUpperCase()
                                            )}
                                        </div>
                                        <div className="chat-info">
                                            <div className="flex justify-between">
                                                <span className="chat-name">{getDisplayName(pubkey)}</span>
                                                <span className="chat-time">{formatTime(lastMessage.created_at)}</span>
                                            </div>
                                            <p className="chat-preview">
                                                {lastMessage.isSender ? 'You: ' : ''}
                                                {lastMessage.content.substring(0, 50)}
                                            </p>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* Chat Area */}
                <div className={`chat-area${mobileView === 'sidebar' ? ' mobile-hidden' : ''}`}>
                    {openChats.length > 0 && (
                        <div className="chat-tabs">
                            {openChats.map(pk => (
                                <button
                                    key={pk}
                                    className={`chat-tab${activeChatPubkey === pk ? ' active' : ''}`}
                                    onClick={() => setActiveChatPubkey(pk)}
                                >
                                    <span className="chat-tab-name">{getDisplayName(pk)}</span>
                                    <span className="chat-tab-close" onClick={(e) => closeTab(e, pk)}>×</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {activeChatPubkey ? (
                        <>
                            <div className="chat-header">
                                <div className="flex items-center gap-3">
                                    <button className="icon-btn back-btn" onClick={() => setMobileView('sidebar')} aria-label="Back to conversations">
                                        <ArrowLeft size={20} />
                                    </button>
                                    <div className="chat-avatar small">
                                        {getAvatar(activeChatPubkey) ? (
                                            <img src={getAvatar(activeChatPubkey)} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                                        ) : (
                                            getDisplayName(activeChatPubkey).substring(0, 2).toUpperCase()
                                        )}
                                    </div>
                                    <div>
                                        <h3>{getDisplayName(activeChatPubkey)}</h3>
                                        <span className="nip17-badge">NIP-17 Encrypted</span>
                                    </div>
                                </div>
                                <div className="header-actions">
                                    <button className="icon-btn"><MoreVertical size={20} /></button>
                                </div>
                            </div>

                            <div className="active-chat-content">
                                {activeMessages.length === 0 ? (
                                    <div style={{ textAlign: 'center', color: 'var(--color-gray-400)', margin: 'auto' }}>
                                        <Lock size={32} style={{ marginBottom: '0.5rem', opacity: 0.5 }} />
                                        <p>Start an encrypted conversation</p>
                                    </div>
                                ) : (
                                    activeMessages.map(msg => (
                                        <div key={msg.id} className={`msg ${msg.isSender ? 'sent' : 'received'}`}>
                                            <p>{msg.content}</p>
                                            <span className="msg-time">{formatTime(msg.created_at)}</span>
                                        </div>
                                    ))
                                )}
                                <div ref={chatEndRef} />
                            </div>

                            <div className="chat-input-area">
                                <textarea
                                    ref={messageInputRef}
                                    placeholder="Type a message..."
                                    value={newMessage}
                                    onChange={(e) => {
                                        setNewMessage(e.target.value);
                                        e.target.style.height = 'auto';
                                        e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleSendMessage();
                                        }
                                    }}
                                    disabled={sending}
                                    rows={1}
                                />
                                <button className="btn btn-primary send-btn" onClick={handleSendMessage} disabled={sending || !newMessage.trim()}>
                                    {sending ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={18} />}
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full text-gray-400">
                            <MessageCircle size={48} className="mb-4 opacity-50" />
                            <p>Select a conversation to start messaging</p>
                            <p style={{ fontSize: '0.8rem', marginTop: '0.5rem', opacity: 0.7 }}>
                                All messages are end-to-end encrypted with NIP-17
                            </p>
                        </div>
                    )}
                </div>
            </div>

            <style jsx>{`${sharedStyles}`}</style>
        </div>
    );
};

const sharedStyles = `
    /* ── Page wrapper lives in index.css (styled-jsx can't scope root element) ── */

    /* ── Connect / loading centered cards ── */
    .connect-container {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        flex: 1;
    }
    .connect-card {
        background: var(--color-surface);
        padding: 3rem;
        border-radius: var(--radius-xl);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        align-items: center;
        max-width: 500px;
        width: 100%;
        border: 1px solid var(--color-gray-200);
    }

    .error-banner {
        background: var(--color-red-tint);
        color: #EF4444;
        padding: 0.75rem 1rem;
        border-radius: 8px;
        font-size: 0.875rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
    }

    /* ── Two-pane layout ── */
    .messages-layout {
        display: flex;
        flex: 1 1 0%;
        min-height: 0;
        border: 1px solid var(--color-gray-200);
        border-radius: var(--radius-lg);
        overflow: hidden;
        background: var(--color-surface);
        box-sizing: border-box;
    }

    /* ── Sidebar ── */
    .messages-sidebar { width: 320px; flex-shrink: 0; border-right: 1px solid var(--color-gray-200); display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
    .sidebar-header { padding: 1rem; border-bottom: 1px solid var(--color-gray-100); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }

    /* ── Notification prompt ── */
    .notif-prompt { margin: 0.5rem 0.75rem; padding: 0.5rem 0.75rem; background: var(--color-blue-tint, #EFF6FF); border: 1px solid var(--color-primary, #0047ab); border-radius: var(--radius-md, 8px); display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; font-weight: 500; color: var(--color-primary, #0047ab); cursor: pointer; transition: background 0.15s; flex-shrink: 0; font-family: inherit; }
    .notif-prompt:hover { background: var(--color-primary, #0047ab); color: white; }
    .notif-prompt.denied { background: var(--color-gray-100); border-color: var(--color-gray-300); color: var(--color-gray-500); cursor: default; font-size: 0.75rem; }

    /* ── Unified search box ── */
    .search-box { margin: 0.75rem; padding: 0.5rem 0.75rem; background: var(--color-gray-100); border-radius: var(--radius-full); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; border: 1px solid transparent; transition: border-color 0.2s, background 0.2s; }
    .search-box:focus-within { border-color: var(--color-primary); background: var(--color-surface); }
    .search-box input { background: transparent; border: none; outline: none; font-size: 0.9rem; flex: 1; color: var(--color-text); cursor: text; }
    .search-icon { color: var(--color-gray-400); flex-shrink: 0; }
    .search-clear { background: none; border: none; cursor: pointer; padding: 2px; border-radius: 50%; color: var(--color-gray-400); display: flex; align-items: center; }
    .search-clear:hover { background: var(--color-gray-200); color: var(--color-gray-600); }

    /* ── Search results dropdown ── */
    .search-results-panel { border-bottom: 1px solid var(--color-gray-200); background: var(--color-surface); flex-shrink: 0; }
    .search-section-label { padding: 0.4rem 0.75rem; font-size: 0.7rem; font-weight: 600; color: var(--color-gray-400); text-transform: uppercase; letter-spacing: 0.05em; }
    .search-status { padding: 0.5rem 0.75rem; font-size: 0.8rem; color: var(--color-gray-500); display: flex; align-items: center; gap: 0.5rem; }

    .user-search-results { max-height: 240px; overflow-y: auto; }
    .user-result-item { padding: 0.5rem 0.75rem; display: flex; align-items: center; gap: 0.75rem; cursor: pointer; transition: background 0.15s; }
    .user-result-item:hover { background: var(--color-gray-100); }
    .user-result-info { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
    .user-result-name { font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .user-result-nip05 { font-size: 0.7rem; color: var(--color-gray-400); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .source-badge { font-size: 0.65rem; padding: 1px 6px; border-radius: 99px; font-weight: 600; flex-shrink: 0; }
    .source-badge.bies { background: var(--color-blue-tint); color: #1E40AF; }
    .source-badge.nostr { background: #F3E8FF; color: #7C3AED; }

    .conversation-list { flex: 1 1 0%; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    .chat-item { padding: 1rem; display: flex; gap: 1rem; cursor: pointer; border-bottom: 1px solid var(--color-gray-50); transition: background 0.2s; position: relative; }
    .chat-item:hover { background: var(--color-gray-50); }
    .chat-item.active { background: var(--color-gray-100); border-left: 3px solid var(--color-primary); }

    .chat-avatar { width: 40px; height: 40px; background: var(--color-gray-200); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 600; color: var(--color-gray-600); flex-shrink: 0; overflow: hidden; }
    .chat-avatar.small { width: 32px; height: 32px; font-size: 0.8rem; }

    .chat-info { flex: 1; overflow: hidden; min-width: 0; }
    .chat-name { font-weight: 600; font-size: 0.95rem; }
    .chat-time { font-size: 0.75rem; color: var(--color-gray-400); white-space: nowrap; }
    .chat-preview { font-size: 0.85rem; color: var(--color-gray-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .unread-badge { position: absolute; right: 1rem; top: 50%; transform: translateY(-50%); background: var(--color-primary); color: white; font-size: 0.7rem; padding: 2px 6px; border-radius: 99px; }

    .nip17-badge { font-size: 0.7rem; background: var(--color-green-tint); color: #166534; padding: 1px 6px; border-radius: 99px; }

    /* ── Chat tabs ── */
    .chat-tabs { display: flex; overflow-x: auto; background: var(--color-surface); border-bottom: 1px solid var(--color-gray-200); flex-shrink: 0; scrollbar-width: none; }
    .chat-tabs::-webkit-scrollbar { display: none; }
    .chat-tab { display: flex; align-items: center; gap: 0.4rem; padding: 0.5rem 0.75rem; border: none; border-bottom: 2px solid transparent; background: none; cursor: pointer; font-size: 0.8rem; color: var(--color-gray-500); white-space: nowrap; flex-shrink: 0; transition: all 0.15s; font-family: inherit; }
    .chat-tab.active { color: var(--color-primary); border-bottom-color: var(--color-primary); background: var(--color-gray-50); }
    .chat-tab:hover { background: var(--color-gray-50); color: var(--color-text); }
    .chat-tab-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    .chat-tab-close { width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; line-height: 1; flex-shrink: 0; }
    .chat-tab-close:hover { background: var(--color-gray-200); }

    /* ── Chat area ── */
    .chat-area { flex: 1 1 0%; display: flex; flex-direction: column; background: var(--color-gray-50); min-width: 0; min-height: 0; overflow: hidden; }
    .chat-header { padding: 0.75rem 1rem; background: var(--color-surface); border-bottom: 1px solid var(--color-gray-200); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }

    .active-chat-content { flex: 1 1 0%; min-height: 0; padding: 1.5rem; overflow-y: auto; -webkit-overflow-scrolling: touch; display: flex; flex-direction: column; gap: 0.75rem; }

    .msg { max-width: 60%; padding: 0.75rem 1rem; border-radius: 12px; word-break: break-word; }
    .msg.received { background: var(--color-surface); border: 1px solid var(--color-gray-200); align-self: flex-start; border-bottom-left-radius: 2px; }
    .msg.sent { background: var(--color-primary); color: white; align-self: flex-end; border-bottom-right-radius: 2px; }
    .msg-time { font-size: 0.7rem; opacity: 0.7; margin-top: 4px; display: block; text-align: right; }

    /* ── Message compose textarea ── */
    .chat-input-area {
        padding: 0.75rem 1rem;
        background: var(--color-surface);
        border-top: 1px solid var(--color-gray-200);
        display: flex;
        gap: 0.75rem;
        align-items: flex-end;
        flex-shrink: 0;
        padding-bottom: max(0.75rem, env(safe-area-inset-bottom, 0.75rem));
    }
    .chat-input-area textarea { flex: 1; padding: 0.6rem 1rem; border: 1px solid var(--color-gray-300); border-radius: 20px; outline: none; resize: none; font-family: inherit; font-size: 0.95rem; line-height: 1.4; max-height: 120px; overflow-y: auto; cursor: text; background: var(--color-surface); color: var(--color-text); }
    .chat-input-area textarea:focus { border-color: var(--color-primary); }
    .chat-input-area textarea:disabled { opacity: 0.5; }
    .send-btn { border-radius: 50%; width: 44px; height: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; padding: 0; }

    /* ── Utility ── */
    .icon-btn { padding: 8px; border-radius: 50%; color: var(--color-gray-500); border: none; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .icon-btn:hover { background: var(--color-gray-100); }
    .back-btn { display: none; }
    .flex { display: flex; }
    .items-center { align-items: center; }
    .justify-between { justify-content: space-between; }
    .gap-3 { gap: 0.75rem; }
    .text-primary { color: var(--color-primary); }
    .text-gray-400 { color: var(--color-gray-400); }
    .text-gray-500 { color: var(--color-gray-500); }
    .h-full { height: 100%; }
    .flex-col { flex-direction: column; }
    .btn { border: none; cursor: pointer; font-weight: 600; }
    .btn-primary { background: var(--color-primary); color: white; border: none; padding: 0.75rem 1.5rem; border-radius: var(--radius-full); cursor: pointer; font-weight: 600; }
    .btn-primary:hover { opacity: 0.9; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .mb-4 { margin-bottom: 1rem; }
    .mb-6 { margin-bottom: 1.5rem; }

    /* ── Mobile ── */
    @media (max-width: 768px) {
        .messages-layout {
            border-radius: 0;
            border-left: none;
            border-right: none;
            border-top: none;
        }
        .messages-sidebar {
            width: 100%;
            border-right: none;
        }
        .chat-area {
            width: 100%;
        }
        .mobile-hidden {
            display: none !important;
        }
        .back-btn {
            display: flex;
        }
        .msg {
            max-width: 82%;
        }
        .active-chat-content {
            padding: 1rem 0.75rem;
        }
        .chat-input-area {
            padding: 0.625rem 0.75rem;
            padding-bottom: max(0.625rem, env(safe-area-inset-bottom, 0.625rem));
        }
        .connect-card {
            padding: 2rem 1.5rem;
            border-radius: var(--radius-lg);
            border: none;
            box-shadow: none;
        }
    }
`;

export default Messages;
