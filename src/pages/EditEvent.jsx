import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
    ArrowLeft, Calendar, MapPin, Clock, Users, Globe, Tag, ShieldCheck,
    Eye, Lock, EyeOff, Ticket, Award, UserCheck, AlertCircle, Loader2,
    Plus, Trash2, Camera, Save, X, Link as LinkIcon,
    Image as ImageIcon, Layout as LayoutIcon, LineChart as LineChartIcon,
    AlignLeft as AlignLeftIcon, GripVertical, Upload,
    Radio, Zap,
} from 'lucide-react';
import { eventsApi, uploadApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { nostrService } from '../services/nostrService';
import { nostrSigner } from '../services/nostrSigner';
import MemberSearchSelect from '../components/MemberSearchSelect';
import TagInput from '../components/TagInput';
import RichTextEditor from '../components/RichTextEditor';
import { getAssetUrl } from '../utils/assets';
import { useSectionDrag, reorderArray } from '../hooks/useSectionDrag';

const VISIBILITY_OPTIONS = [
    { value: 'PUBLIC', label: 'Public', icon: <Globe size={15} />, desc: 'Visible to everyone on BIES' },
    { value: 'LIMITED_SPACES', label: 'Limited Spaces', icon: <Users size={15} />, desc: 'Public listing — capacity is limited' },
    { value: 'INVITE_ONLY', label: 'Invite Only', icon: <UserCheck size={15} />, desc: 'Listed but RSVPs require an invite' },
    { value: 'PRIVATE', label: 'Private', icon: <Lock size={15} />, desc: 'Hidden from public — share via messages' },
    { value: 'DRAFT', label: 'Draft', icon: <EyeOff size={15} />, desc: 'Saved as draft — only you can see it' },
];

const CATEGORIES = ['NETWORKING', 'CONFERENCE', 'WORKSHOP', 'HACKATHON', 'MEETUP', 'DEMO_DAY', 'OTHER'];

const TICKET_MODE_OPTIONS = [
    { value: 'FREE', label: 'Free', icon: <Users size={15} />, desc: 'Attendees RSVP at no cost' },
    { value: 'PAID', label: 'Paid in sats', icon: <Zap size={15} />, desc: 'Sell tickets in-app — sats go straight to your Lightning address' },
    { value: 'EXTERNAL', label: 'External link', icon: <LinkIcon size={15} />, desc: 'Send attendees to an external ticketing page' },
];

const toLocalDate = (iso) => { if (!iso) return ''; return iso.substring(0, 10); };
const toLocalTime = (iso) => {
    if (!iso) return '';
    try { const d = new Date(iso); return d.toTimeString().substring(0, 5); } catch { return ''; }
};
const normalizeGuestList = (arr) => {
    if (!arr || !Array.isArray(arr)) return [];
    return arr.filter(g => g && g.name);
};

const EditEvent = () => {
    const { id } = useParams();
    const { user } = useAuth();
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const [pageLoading, setPageLoading] = useState(true);
    const [uploadLoading, setUploadLoading] = useState(false);
    const [submitError, setSubmitError] = useState('');
    const [nostrStatus, setNostrStatus] = useState(null);

    const [form, setForm] = useState({
        title: '', category: '', description: '',
        locationName: '', locationAddress: '', locationMapUrl: '',
        isOnline: false, onlineUrl: '',
        startDate: '', startTime: '', endDate: '', endTime: '',
        maxAttendees: '', thumbnail: null,
        ticketMode: 'FREE', ticketUrl: '', priceSats: '', ticketCapacity: '', payoutLightningAddress: '',
        visibility: 'PUBLIC', isOfficial: false, endorsementRequested: false, guestList: [],
        nostrPublish: 'bies',
    });
    const [tags, setTags] = useState([]);
    const [customSections, setCustomSections] = useState([]);
    const [relayHealth, setRelayHealth] = useState(null);

    useEffect(() => {
        if (form.visibility !== 'DRAFT' && form.visibility !== 'PRIVATE' && form.nostrPublish !== 'none') {
            nostrService.checkRelayHealth().then(setRelayHealth).catch(() => {});
        }
    }, [form.visibility, form.nostrPublish]);

    useEffect(() => {
        const load = async () => {
            setPageLoading(true);
            try {
                const event = await eventsApi.get(id);
                let locName = event.locationName || '';
                let locAddr = event.locationAddress || '';
                if (!locName && event.location) {
                    const parts = event.location.split(', ');
                    locName = parts[0] || '';
                    locAddr = parts.slice(1).join(', ') || '';
                }
                setForm({
                    title: event.title || '',
                    category: event.category || '',
                    description: event.description || '',
                    locationName: locName,
                    locationAddress: locAddr,
                    locationMapUrl: event.locationMapUrl || '',
                    isOnline: event.isOnline || false,
                    onlineUrl: event.onlineUrl || '',
                    startDate: toLocalDate(event.startDate),
                    startTime: toLocalTime(event.startDate),
                    endDate: toLocalDate(event.endDate),
                    endTime: toLocalTime(event.endDate),
                    maxAttendees: event.maxAttendees ? String(event.maxAttendees) : '',
                    thumbnail: event.thumbnail || null,
                    ticketMode: event.priceSats > 0 ? 'PAID' : event.ticketUrl ? 'EXTERNAL' : 'FREE',
                    ticketUrl: event.ticketUrl || '',
                    priceSats: event.priceSats ? String(event.priceSats) : '',
                    ticketCapacity: event.ticketCapacity ? String(event.ticketCapacity) : '',
                    payoutLightningAddress: event.payoutLightningAddress || '',
                    visibility: event.visibility || 'PUBLIC',
                    isOfficial: event.isOfficial || false,
                    endorsementRequested: event.endorsementRequested || false,
                    guestList: normalizeGuestList(event.guestList),
                    nostrPublish: event.nostrPublish || 'none',
                });
                setTags(Array.isArray(event.tags) ? event.tags : []);
                // Normalize sections to rich format
                setCustomSections(
                    Array.isArray(event.customSections)
                        ? event.customSections.map(s => ({
                            title: s.title || '',
                            type: s.type || 'TEXT',
                            placement: s.placement || 'LEFT',
                            body: s.body || s.content || '',
                            imageUrl: s.imageUrl || '',
                            images: s.images || [],
                            graphType: s.graphType || 'BAR',
                            xAxisLabel: s.xAxisLabel || '',
                            yAxisLabel: s.yAxisLabel || '',
                            dataPoints: s.dataPoints || [],
                        }))
                        : []
                );
            } catch (err) {
                setSubmitError('Failed to load event.');
            } finally {
                setPageLoading(false);
            }
        };
        load();
    }, [id]);

    // Prefill the payout address from the logged-in user's profile Lightning
    // address once the event has loaded without one of its own
    useEffect(() => {
        const lnAddr = user?.profile?.lightningAddress;
        if (!lnAddr || pageLoading) return;
        setForm(prev => (prev.payoutLightningAddress ? prev : { ...prev, payoutLightningAddress: lnAddr }));
    }, [user?.profile?.lightningAddress, pageLoading]);

    const isBusy = loading || uploadLoading;

    const handleChange = (e) => {
        const { name, value, type, checked } = e.target;
        setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    };

    const handleImageUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploadLoading(true);
        setSubmitError('');
        try {
            const result = await uploadApi.media(file);
            setForm(prev => ({ ...prev, thumbnail: result.url }));
        } catch (err) {
            setSubmitError(err.message || 'Failed to upload image.');
        } finally {
            setUploadLoading(false);
            if (e.target) e.target.value = '';
        }
    };

    // ─── Custom Sections ─────────────────────────────────────────────────────

    const addSection = (type = 'TEXT', placement = 'LEFT') => {
        const extra = {
            TEXT: { body: '' },
            PHOTO: { imageUrl: '' },
            CAROUSEL: { images: [] },
            GRAPH: { graphType: 'BAR', xAxisLabel: '', yAxisLabel: '', dataPoints: [{ label: 'Data 1', value: '100' }] },
        }[type] || { body: '' };
        setCustomSections(prev => [...prev, { title: '', type, placement, ...extra }]);
    };

    const updateSection = (index, field, value) =>
        setCustomSections(prev => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));

    const removeSection = (index) =>
        setCustomSections(prev => prev.filter((_, i) => i !== index));

    const moveSection = (fromIdx, toIdx) =>
        setCustomSections(prev => reorderArray(prev, fromIdx, toIdx));

    const { draggingIdx, getSectionDragProps } = useSectionDrag(moveSection);

    const handleSectionImageUpload = async (index, file) => {
        if (!file) return;
        try {
            const result = await uploadApi.media(file);
            updateSection(index, 'imageUrl', result.url);
        } catch { setSubmitError('Failed to upload image.'); }
    };

    const handleCarouselImageUpload = async (index, file) => {
        if (!file) return;
        try {
            const result = await uploadApi.media(file);
            setCustomSections(prev => {
                const updated = [...prev];
                updated[index] = { ...updated[index], images: [...(updated[index].images || []), result.url] };
                return updated;
            });
        } catch { setSubmitError('Failed to upload carousel image.'); }
    };

    const removeCarouselImage = (sIdx, iIdx) =>
        setCustomSections(prev => prev.map((s, i) => i === sIdx ? { ...s, images: s.images.filter((_, j) => j !== iIdx) } : s));

    const addGraphDataPoint = (index) =>
        setCustomSections(prev => prev.map((s, i) => i === index ? { ...s, dataPoints: [...(s.dataPoints || []), { label: '', value: '' }] } : s));

    const updateGraphDataPoint = (sIdx, pIdx, field, value) =>
        setCustomSections(prev => prev.map((s, i) => {
            if (i !== sIdx) return s;
            const pts = [...s.dataPoints];
            pts[pIdx] = { ...pts[pIdx], [field]: value };
            return { ...s, dataPoints: pts };
        }));

    const removeGraphDataPoint = (sIdx, pIdx) =>
        setCustomSections(prev => prev.map((s, i) => i === sIdx ? { ...s, dataPoints: s.dataPoints.filter((_, j) => j !== pIdx) } : s));

    const renderSection = (section, idx) => {
        const stype = section.type || 'TEXT';
        const typeConfig = {
            TEXT:     { icon: <AlignLeftIcon size={12} />,  label: 'Text',     color: '#2563eb', bg: 'var(--color-blue-tint)', border: '#bfdbfe' },
            PHOTO:    { icon: <ImageIcon size={12} />,       label: 'Photo',    color: '#16a34a', bg: 'var(--color-green-tint)', border: '#bbf7d0' },
            CAROUSEL: { icon: <LayoutIcon size={12} />,      label: 'Carousel', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
            GRAPH:    { icon: <LineChartIcon size={12} />,   label: 'Graph',    color: '#ea580c', bg: 'var(--color-orange-tint)', border: '#fed7aa' },
        }[stype] || { icon: null, label: stype, color: 'var(--color-gray-500)', bg: 'var(--color-gray-100)', border: 'var(--color-gray-200)' };

        const isBeingDragged = draggingIdx === idx;
        return (
            <div key={idx} {...getSectionDragProps(idx)} style={{ marginBottom: '1rem', background: 'var(--color-surface)', border: `1px solid ${typeConfig.border}`, borderRadius: '12px', overflow: 'hidden', boxShadow: isBeingDragged ? `0 4px 16px rgba(0,0,0,0.15)` : '0 1px 4px rgba(0,0,0,0.06)', opacity: isBeingDragged ? 0.5 : 1, transition: 'box-shadow 0.2s, opacity 0.2s' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.55rem 0.875rem', background: typeConfig.bg, borderBottom: `1px solid ${typeConfig.border}` }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: typeConfig.color }}>
                        <GripVertical size={14} style={{ cursor: 'grab', color: 'var(--color-gray-400)', marginRight: '0.2rem', flexShrink: 0 }} />
                        {typeConfig.icon} {typeConfig.label} Section
                    </span>
                    <button type="button" className="team-remove" onClick={() => removeSection(idx)}><Trash2 size={15} /></button>
                </div>
                <div style={{ padding: '1rem 1.125rem 1.25rem' }}>
                    <input
                        type="text" value={section.title}
                        onChange={(e) => updateSection(idx, 'title', e.target.value)}
                        style={{ width: '100%', padding: '0.4rem 0', border: 'none', borderBottom: `2px solid ${typeConfig.border}`, background: 'transparent', outline: 'none', fontSize: '0.95rem', fontWeight: 700, color: 'var(--color-gray-900)', fontFamily: 'var(--font-display)', marginBottom: '0.875rem', transition: 'border-color 0.2s', boxSizing: 'border-box' }}
                        onFocus={e => e.target.style.borderBottomColor = typeConfig.color}
                        onBlur={e => e.target.style.borderBottomColor = typeConfig.border}
                        placeholder="Section Title"
                    />
                    {stype === 'TEXT' && (
                        <RichTextEditor value={section.body} onChange={val => updateSection(idx, 'body', val)} placeholder="Section content..." minHeight="100px" />
                    )}
                    {stype === 'PHOTO' && (
                        section.imageUrl
                            ? <div style={{ position: 'relative', display: 'inline-block' }}>
                                <img src={section.imageUrl} alt="" style={{ maxWidth: '100%', maxHeight: '300px', borderRadius: '8px' }} />
                                <button type="button" onClick={() => updateSection(idx, 'imageUrl', '')} style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.6)', color: 'white', border: 'none', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem' }}><X size={12} /> Remove</button>
                              </div>
                            : <label className="deck-upload-area" style={{ padding: '2.5rem 1rem' }}>
                                <Upload size={28} style={{ color: 'var(--color-gray-400)', marginBottom: '0.5rem' }} />
                                <p style={{ fontSize: '0.9rem', fontWeight: 600, color: '#16a34a', margin: '0 0 0.25rem' }}>Upload Photo</p>
                                <p style={{ fontSize: '0.75rem', color: 'var(--color-gray-400)', margin: 0 }}>JPG, PNG, WebP</p>
                                <input type="file" accept="image/*" onChange={e => handleSectionImageUpload(idx, e.target.files?.[0])} style={{ display: 'none' }} />
                              </label>
                    )}
                    {stype === 'CAROUSEL' && (
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {(section.images || []).map((img, iIdx) => (
                                <div key={iIdx} style={{ position: 'relative', width: '100px', height: '100px', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--color-gray-200)' }}>
                                    <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                    <button type="button" onClick={() => removeCarouselImage(idx, iIdx)} style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.5)', color: 'white', border: 'none', borderRadius: '50%', padding: '2px', cursor: 'pointer' }}><X size={12} /></button>
                                </div>
                            ))}
                            <label className="deck-upload-area" style={{ width: '100px', height: '100px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '4px' }}>
                                <Plus size={24} style={{ color: 'var(--color-gray-400)' }} />
                                <span style={{ fontSize: '0.65rem', color: 'var(--color-gray-400)' }}>Add Photo</span>
                                <input type="file" accept="image/*" onChange={e => handleCarouselImageUpload(idx, e.target.files?.[0])} style={{ display: 'none' }} />
                            </label>
                        </div>
                    )}
                    {stype === 'GRAPH' && (
                        <div>
                            <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem', alignItems: 'center' }}>
                                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-gray-700)', whiteSpace: 'nowrap' }}>Chart Type</label>
                                <select value={section.graphType || 'BAR'} onChange={e => updateSection(idx, 'graphType', e.target.value)} className="input-field" style={{ width: '140px' }}>
                                    <option value="BAR">Bar Chart</option>
                                    <option value="LINE">Line Chart</option>
                                    <option value="PIE">Pie Chart</option>
                                </select>
                            </div>
                            {section.graphType !== 'PIE' && (
                                <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                    <input type="text" value={section.xAxisLabel || ''} onChange={e => updateSection(idx, 'xAxisLabel', e.target.value)} className="input-field" placeholder="X-Axis Label" style={{ flex: 1 }} />
                                    <input type="text" value={section.yAxisLabel || ''} onChange={e => updateSection(idx, 'yAxisLabel', e.target.value)} className="input-field" placeholder="Y-Axis Label" style={{ flex: 1 }} />
                                </div>
                            )}
                            <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-gray-700)', marginBottom: '0.4rem' }}>Data Points</p>
                            {(section.dataPoints || []).map((pt, pIdx) => (
                                <div key={pIdx} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.4rem', alignItems: 'center' }}>
                                    <GripVertical size={14} style={{ color: 'var(--color-gray-400)', flexShrink: 0 }} />
                                    <input type="text" value={pt.label} onChange={e => updateGraphDataPoint(idx, pIdx, 'label', e.target.value)} className="input-field" placeholder="Label" style={{ flex: 1 }} />
                                    <input type="number" value={pt.value} onChange={e => updateGraphDataPoint(idx, pIdx, 'value', e.target.value)} className="input-field" placeholder="Value" style={{ width: '100px' }} />
                                    <button type="button" className="team-remove" onClick={() => removeGraphDataPoint(idx, pIdx)}><Trash2 size={14} /></button>
                                </div>
                            ))}
                            <button type="button" className="add-btn-sm" onClick={() => addGraphDataPoint(idx)}><Plus size={13} /> Add Point</button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderCustomSections = (placement) =>
        customSections
            .map((s, idx) => ({ ...s, _idx: idx }))
            .filter(s => placement === 'LEFT' ? (s.placement === 'LEFT' || !s.placement) : s.placement === 'RIGHT')
            .map(s => renderSection(s, s._idx));

    // ─── Submit ───────────────────────────────────────────────────────────────

    const buildPayload = () => {
        if (!form.startDate) throw new Error('Start date is required');
        if (form.ticketMode === 'PAID') {
            const price = parseInt(form.priceSats, 10);
            if (!price || price <= 0) throw new Error('Ticket price (sats) is required for paid events');
        }
        const startDate = new Date(`${form.startDate}T${form.startTime || '00:00'}:00`).toISOString();
        const endDate = form.endDate ? new Date(`${form.endDate}T${form.endTime || '23:59'}:00`).toISOString() : undefined;
        return {
            title: form.title,
            category: form.category,
            description: form.description,
            location: [form.locationName, form.locationAddress].filter(Boolean).join(', '),
            locationName: form.locationName,
            locationAddress: form.locationAddress,
            locationMapUrl: form.locationMapUrl || undefined,
            isOnline: form.isOnline,
            onlineUrl: form.onlineUrl || undefined,
            startDate, endDate,
            maxAttendees: form.maxAttendees ? parseInt(form.maxAttendees) : undefined,
            thumbnail: form.thumbnail || undefined,
            ticketUrl: form.ticketMode === 'EXTERNAL' ? (form.ticketUrl || '') : '',
            priceSats: form.ticketMode === 'PAID' ? parseInt(form.priceSats, 10) : 0,
            ticketCapacity: form.ticketMode === 'PAID' && form.ticketCapacity ? parseInt(form.ticketCapacity, 10) : null,
            payoutLightningAddress: form.ticketMode === 'PAID' ? (form.payoutLightningAddress || '').trim() : '',
            tags,
            visibility: form.visibility,
            isOfficial: form.isOfficial,
            endorsementRequested: form.endorsementRequested,
            guestList: form.guestList,
            customSections,
            nostrPublish: form.nostrPublish,
        };
    };

    const handleSubmit = async () => {
        setLoading(true);
        setSubmitError('');
        setNostrStatus(null);
        try {
            const payload = buildPayload();
            const updated = await eventsApi.update(id, payload);
            const eventData = updated.data || updated;

            // Track the publish outcome locally — the nostrStatus state read
            // below would be the stale value captured at render time
            let publishOutcome = null;

            if (payload.nostrPublish !== 'none' && nostrSigner.signsOnDevice && !eventData.nostrPublished) {
                setNostrStatus('publishing');
                try {
                    await nostrService.publishCalendarEvent({
                        id: eventData.id || id,
                        title: payload.title,
                        description: payload.description,
                        startDate: payload.startDate,
                        endDate: payload.endDate,
                        location: [payload.locationName, payload.locationAddress].filter(Boolean).join(', '),
                        locationAddress: payload.locationAddress,
                        isOnline: payload.isOnline,
                        onlineUrl: payload.onlineUrl,
                        category: payload.category,
                        tags: payload.tags,
                        thumbnail: payload.thumbnail,
                        ticketUrl: payload.ticketUrl,
                    }, payload.nostrPublish);
                    publishOutcome = 'success';
                    setNostrStatus('success');
                } catch (nostrErr) {
                    console.warn('[NIP-52] Client-side publish failed:', nostrErr);
                    publishOutcome = 'failed';
                    setNostrStatus('failed');
                }
            } else if (eventData.nostrPublished) {
                publishOutcome = 'success';
                setNostrStatus('success');
            }

            setTimeout(() => navigate('/events/my'), publishOutcome === 'failed' ? 2000 : 500);
        } catch (err) {
            if (err.data?.details) {
                setSubmitError(`${err.message}: ${err.data.details.map(d => `${d.field}: ${d.message}`).join(', ')}`);
            } else {
                setSubmitError(err.message || 'Failed to update event');
            }
        } finally {
            setLoading(false);
        }
    };

    const needsGuestList = form.visibility === 'PRIVATE' || form.visibility === 'INVITE_ONLY';

    if (pageLoading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4rem' }}>
                <Loader2 size={36} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-primary)' }} />
            </div>
        );
    }

    return (
        <div className="event-edit-page">
            <div className="container py-8 max-w-6xl">

                <div className="page-header">
                    <div>
                        <button onClick={() => navigate(-1)} className="back-link">
                            <ArrowLeft size={18} /> Back
                        </button>
                        <h1 className="h1-title">Edit Event</h1>
                        <p className="text-gray-500">Update your event details.</p>
                    </div>
                </div>

                {submitError && (
                    <div className="error-banner"><AlertCircle size={16} /> {submitError}</div>
                )}

                {nostrStatus && nostrStatus !== 'skipped' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1rem', background: nostrStatus === 'success' ? 'var(--color-green-tint)' : nostrStatus === 'failed' ? 'var(--color-red-tint)' : 'var(--color-blue-tint)', color: nostrStatus === 'success' ? '#166534' : nostrStatus === 'failed' ? '#B91C1C' : '#1d4ed8', borderRadius: '8px', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
                        {nostrStatus === 'publishing' && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />}
                        {nostrStatus === 'success' && <Radio size={16} />}
                        {nostrStatus === 'failed' && <AlertCircle size={16} />}
                        {nostrStatus === 'publishing' && 'Publishing to Nostr relays...'}
                        {nostrStatus === 'success' && 'Updated on Nostr (NIP-52 calendar event)'}
                        {nostrStatus === 'failed' && 'Failed to update on Nostr — changes saved to BIES only'}
                    </div>
                )}

                {/* Cover Image Banner */}
                <div className="profile-card mb-8" style={{ padding: 0, overflow: 'hidden' }}>
                    <div className="cover-banner" style={{ backgroundImage: form.thumbnail ? `url(${getAssetUrl(form.thumbnail)})` : 'none' }}>
                        {uploadLoading && (
                            <div className="upload-overlay">
                                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', color: 'white' }} />
                                <span style={{ color: 'white', fontWeight: 600, marginTop: '0.5rem' }}>Uploading...</span>
                            </div>
                        )}
                        <div className="banner-actions-left">
                            <label className="banner-btn" style={{ cursor: uploadLoading ? 'not-allowed' : 'pointer' }}>
                                {uploadLoading ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Camera size={16} />}
                                {form.thumbnail ? 'Change Cover' : 'Add Cover Image'}
                                <input type="file" accept="image/*" onChange={handleImageUpload} style={{ display: 'none' }} disabled={uploadLoading} />
                            </label>
                            {form.thumbnail && !uploadLoading && (
                                <button type="button" className="banner-btn danger" onClick={() => setForm(p => ({ ...p, thumbnail: null }))}>
                                    <X size={16} /> Remove
                                </button>
                            )}
                        </div>
                        <div className="banner-actions-right">
                            <button type="button" onClick={handleSubmit} disabled={isBusy} className="save-btn">
                                {loading ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={18} />}
                                {loading ? 'Saving...' : 'Save Changes'}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Two-column layout */}
                <div style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start' }}>

                    {/* ─── Left Column ─────────────────────────────────── */}
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2rem', minWidth: 0 }}>

                        {/* About */}
                        <div className="profile-card">
                            <div className="section-inner">
                                <h3 className="h3-title section-heading">About the Event</h3>

                                <div className="form-row-label">
                                    <label className="form-label">Event Title</label>
                                    <div className="form-content">
                                        <input type="text" name="title" value={form.title} onChange={handleChange} className="input-field" placeholder="e.g. Lightning Network Workshop" required />
                                    </div>
                                </div>

                                <div className="form-row-label">
                                    <label className="form-label">Category</label>
                                    <div className="form-content">
                                        <select name="category" value={form.category} onChange={handleChange} className="input-field" required>
                                            <option value="">Select a category</option>
                                            {CATEGORIES.map(cat => (
                                                <option key={cat} value={cat}>
                                                    {cat.replace(/_/g, ' ').charAt(0) + cat.replace(/_/g, ' ').slice(1).toLowerCase()}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                </div>

                                <div className="form-row-label" style={{ marginBottom: 0 }}>
                                    <label className="form-label">Description</label>
                                    <div className="form-content">
                                        <RichTextEditor
                                            value={form.description}
                                            onChange={val => setForm(p => ({ ...p, description: val }))}
                                            placeholder="Describe your event, what attendees can expect, and any requirements…"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Left custom sections */}
                        {renderCustomSections('LEFT')}

                        <div className="add-section-buttons-container">
                            <p className="section-label-hint">Add Section to Main Column</p>
                            <div className="add-section-buttons">
                                <button type="button" className="add-btn sm" onClick={() => addSection('TEXT', 'LEFT')}><AlignLeftIcon size={14} /> + Text</button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('PHOTO', 'LEFT')}><ImageIcon size={14} /> + Photo</button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('CAROUSEL', 'LEFT')}><LayoutIcon size={14} /> + Carousel</button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('GRAPH', 'LEFT')}><LineChartIcon size={14} /> + Graph</button>
                            </div>
                        </div>
                    </div>

                    {/* ─── Right Sidebar ───────────────────────────────── */}
                    <div style={{ width: '360px', display: 'flex', flexDirection: 'column', gap: '1.5rem', flexShrink: 0 }}>

                        {/* Event Details */}
                        <div className="profile-card">
                            <div className="section-inner" style={{ padding: '1.5rem' }}>
                                <h3 className="h3-title section-heading" style={{ fontSize: '1rem' }}>Event Details</h3>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label"><Calendar size={13} style={{ display: 'inline', marginRight: 4 }} />Start Date & Time</label>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        <input type="date" name="startDate" value={form.startDate} onChange={handleChange} className="input-field sm" style={{ flex: 1 }} required />
                                        <input type="time" name="startTime" value={form.startTime} onChange={handleChange} className="input-field sm" style={{ width: '110px' }} required />
                                    </div>
                                </div>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label"><Clock size={13} style={{ display: 'inline', marginRight: 4 }} />End Date & Time <span style={{ fontWeight: 400, color: 'var(--color-gray-400)' }}>(optional)</span></label>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        <input type="date" name="endDate" value={form.endDate} onChange={handleChange} className="input-field sm" style={{ flex: 1 }} />
                                        <input type="time" name="endTime" value={form.endTime} onChange={handleChange} className="input-field sm" style={{ width: '110px' }} />
                                    </div>
                                </div>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label"><MapPin size={13} style={{ display: 'inline', marginRight: 4 }} />Venue Name</label>
                                    <input type="text" name="locationName" value={form.locationName} onChange={handleChange} className="input-field sm" placeholder="e.g. Bitcoin Embassy" />
                                </div>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label">Address</label>
                                    <input type="text" name="locationAddress" value={form.locationAddress} onChange={handleChange} className="input-field sm" placeholder="Street, City, Country" />
                                </div>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label"><LinkIcon size={13} style={{ display: 'inline', marginRight: 4 }} />Maps Link <span style={{ fontWeight: 400, color: 'var(--color-gray-400)' }}>(optional)</span></label>
                                    <input type="url" name="locationMapUrl" value={form.locationMapUrl} onChange={handleChange} className="input-field sm" placeholder="https://maps.google.com/…" />
                                </div>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label checkbox-label-inline">
                                        <input type="checkbox" name="isOnline" checked={form.isOnline} onChange={handleChange} style={{ width: 16, height: 16, accentColor: 'var(--color-primary)' }} />
                                        <Globe size={13} style={{ color: 'var(--color-primary)' }} /> Online / Virtual Option
                                    </label>
                                </div>

                                {form.isOnline && (
                                    <div className="sidebar-form-group">
                                        <label className="sidebar-label">Online URL</label>
                                        <input type="url" name="onlineUrl" value={form.onlineUrl} onChange={handleChange} className="input-field sm" placeholder="https://meet.google.com/…" />
                                    </div>
                                )}

                                <div className="sidebar-form-group" style={{ marginBottom: 0 }}>
                                    <label className="sidebar-label"><Users size={13} style={{ display: 'inline', marginRight: 4 }} />Max Attendees <span style={{ fontWeight: 400, color: 'var(--color-gray-400)' }}>(optional)</span></label>
                                    <input type="number" name="maxAttendees" value={form.maxAttendees} onChange={handleChange} className="input-field sm" placeholder="Unlimited" min="1" />
                                </div>
                            </div>
                        </div>

                        {/* Ticketing */}
                        <div className="profile-card">
                            <div className="section-inner" style={{ padding: '1.5rem' }}>
                                <h3 className="h3-title section-heading" style={{ fontSize: '1rem' }}>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <Ticket size={16} style={{ color: '#f7931a' }} /> Ticketing
                                    </span>
                                </h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                    {TICKET_MODE_OPTIONS.map(opt => (
                                        <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.75rem', border: `1px solid ${form.ticketMode === opt.value ? 'var(--color-secondary)' : 'var(--color-gray-200)'}`, borderRadius: '8px', cursor: 'pointer', background: form.ticketMode === opt.value ? 'var(--color-orange-tint)' : 'var(--color-gray-50)', transition: 'all 0.15s' }}>
                                            <input type="radio" name="ticketMode" value={opt.value} checked={form.ticketMode === opt.value} onChange={handleChange} style={{ display: 'none' }} />
                                            <span style={{ color: form.ticketMode === opt.value ? 'var(--color-secondary)' : 'var(--color-gray-500)', flexShrink: 0 }}>{opt.icon}</span>
                                            <span>
                                                <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-gray-900)' }}>{opt.label}</span>
                                                <span style={{ display: 'block', fontSize: '0.73rem', color: 'var(--color-gray-500)' }}>{opt.desc}</span>
                                            </span>
                                        </label>
                                    ))}
                                </div>

                                {form.ticketMode === 'PAID' && (
                                    <div style={{ marginTop: '1rem' }}>
                                        <div className="sidebar-form-group">
                                            <label className="sidebar-label"><Zap size={13} style={{ display: 'inline', marginRight: 4, color: '#f7931a' }} />Ticket Price (sats)</label>
                                            <input type="number" name="priceSats" value={form.priceSats} onChange={handleChange} className="input-field sm" placeholder="e.g. 21000" min="1" />
                                        </div>
                                        <div className="sidebar-form-group">
                                            <label className="sidebar-label"><Users size={13} style={{ display: 'inline', marginRight: 4 }} />Ticket Capacity <span style={{ fontWeight: 400, color: 'var(--color-gray-400)' }}>(optional)</span></label>
                                            <input type="number" name="ticketCapacity" value={form.ticketCapacity} onChange={handleChange} className="input-field sm" placeholder="Unlimited" min="1" />
                                        </div>
                                        <div className="sidebar-form-group" style={{ marginBottom: 0 }}>
                                            <label className="sidebar-label"><Zap size={13} style={{ display: 'inline', marginRight: 4 }} />Payout Lightning Address</label>
                                            <input type="text" name="payoutLightningAddress" value={form.payoutLightningAddress} onChange={handleChange} className="input-field sm" placeholder="you@coinos.io" />
                                            <p style={{ fontSize: '0.73rem', color: 'var(--color-gray-500)', margin: '0.4rem 0 0' }}>Ticket payments go straight to this address — no middleman. Prefilled from your profile.</p>
                                        </div>
                                    </div>
                                )}

                                {form.ticketMode === 'EXTERNAL' && (
                                    <div className="sidebar-form-group" style={{ marginTop: '1rem', marginBottom: 0 }}>
                                        <label className="sidebar-label"><LinkIcon size={13} style={{ display: 'inline', marginRight: 4 }} />Ticket / Registration Link</label>
                                        <input type="url" name="ticketUrl" value={form.ticketUrl} onChange={handleChange} className="input-field sm" placeholder="https://lu.ma/your-event" />
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Visibility */}
                        <div className="profile-card">
                            <div className="section-inner" style={{ padding: '1.5rem' }}>
                                <h3 className="h3-title section-heading" style={{ fontSize: '1rem' }}>Visibility</h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                    {VISIBILITY_OPTIONS.map(opt => (
                                        <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.75rem', border: `1px solid ${form.visibility === opt.value ? 'var(--color-primary)' : 'var(--color-gray-200)'}`, borderRadius: '8px', cursor: 'pointer', background: form.visibility === opt.value ? 'var(--color-blue-tint)' : 'var(--color-gray-50)', transition: 'all 0.15s' }}>
                                            <input type="radio" name="visibility" value={opt.value} checked={form.visibility === opt.value} onChange={handleChange} style={{ display: 'none' }} />
                                            <span style={{ color: form.visibility === opt.value ? 'var(--color-primary)' : 'var(--color-gray-500)', flexShrink: 0 }}>{opt.icon}</span>
                                            <span>
                                                <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-gray-900)' }}>{opt.label}</span>
                                                <span style={{ display: 'block', fontSize: '0.73rem', color: 'var(--color-gray-500)' }}>{opt.desc}</span>
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Nostr Publishing (NIP-52) */}
                        {form.visibility !== 'DRAFT' && form.visibility !== 'PRIVATE' && (
                            <div className="profile-card">
                                <div className="section-inner" style={{ padding: '1.5rem' }}>
                                    <h3 className="h3-title section-heading" style={{ fontSize: '1rem' }}>
                                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                            <Radio size={16} style={{ color: '#8b5cf6' }} /> Nostr Publishing
                                        </span>
                                    </h3>
                                    <p style={{ fontSize: '0.78rem', color: 'var(--color-gray-500)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
                                        Publish this event as a NIP-52 calendar event on Nostr. Other Nostr clients can discover and display it.
                                    </p>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                        {[
                                            { value: 'none', label: 'Don\'t Publish', desc: 'Event stays on BIES only', color: 'var(--color-gray-500)', bg: 'var(--color-gray-50)', border: 'var(--color-gray-200)' },
                                            { value: 'bies', label: 'BIES Relay Only', desc: 'Published to the private BIES relay', color: '#2563eb', bg: 'var(--color-blue-tint)', border: '#bfdbfe' },
                                            { value: 'public', label: 'Public Relays', desc: 'Published to public Nostr relays (damus, primal, etc.)', color: '#16a34a', bg: 'var(--color-green-tint)', border: '#bbf7d0' },
                                            { value: 'both', label: 'Both', desc: 'Published to BIES relay and public relays', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
                                        ].map(opt => (
                                            <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.55rem 0.75rem', border: `1px solid ${form.nostrPublish === opt.value ? opt.border : 'var(--color-gray-200)'}`, borderRadius: '8px', cursor: 'pointer', background: form.nostrPublish === opt.value ? opt.bg : 'var(--color-gray-50)', transition: 'all 0.15s' }}>
                                                <input type="radio" name="nostrPublish" value={opt.value} checked={form.nostrPublish === opt.value} onChange={handleChange} style={{ display: 'none' }} />
                                                <span style={{ width: '16px', height: '16px', borderRadius: '50%', border: `2px solid ${form.nostrPublish === opt.value ? opt.color : 'var(--color-gray-300)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                                    {form.nostrPublish === opt.value && <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: opt.color }} />}
                                                </span>
                                                <span>
                                                    <span style={{ display: 'block', fontSize: '0.83rem', fontWeight: 600, color: 'var(--color-gray-900)' }}>{opt.label}</span>
                                                    <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--color-gray-500)' }}>{opt.desc}</span>
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                    {relayHealth && form.nostrPublish !== 'none' && (
                                        <div style={{ marginTop: '0.75rem', padding: '0.6rem 0.75rem', background: 'var(--color-gray-50)', borderRadius: '6px', border: '1px solid var(--color-gray-200)' }}>
                                            <p style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--color-gray-500)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Relay Status</p>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                                {relayHealth.map((r, i) => (
                                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--color-gray-600)' }}>
                                                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: r.connected ? '#22c55e' : '#ef4444', flexShrink: 0 }} />
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.url.replace(/^wss?:\/\//, '')}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Guest List */}
                        {needsGuestList && (
                            <div className="profile-card">
                                <div className="section-inner" style={{ padding: '1.5rem' }}>
                                    <h3 className="h3-title section-heading" style={{ fontSize: '1rem' }}>Guest List</h3>
                                    <MemberSearchSelect value={form.guestList} onChange={list => setForm(p => ({ ...p, guestList: list }))} />
                                    <p style={{ fontSize: '0.73rem', color: 'var(--color-gray-500)', marginTop: '0.5rem' }}>Search and add BIES members to your guest list.</p>
                                </div>
                            </div>
                        )}

                        {/* Tags */}
                        <div className="profile-card">
                            <div className="section-inner" style={{ padding: '1.5rem' }}>
                                <h3 className="h3-title section-heading" style={{ fontSize: '1rem' }}>Tags</h3>
                                <TagInput tags={tags} onChange={setTags} />
                                <p style={{ fontSize: '0.73rem', color: 'var(--color-gray-500)', marginTop: '0.4rem' }}>Press Enter or comma to add a tag.</p>
                            </div>
                        </div>

                        {/* Right custom sections */}
                        {renderCustomSections('RIGHT')}

                        <div className="add-section-buttons-container">
                            <p className="section-label-hint">Add Section to Sidebar</p>
                            <div className="add-section-buttons">
                                <button type="button" className="add-btn sm" onClick={() => addSection('TEXT', 'RIGHT')}><AlignLeftIcon size={14} /> + Text</button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('PHOTO', 'RIGHT')}><ImageIcon size={14} /> + Photo</button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('CAROUSEL', 'RIGHT')}><LayoutIcon size={14} /> + Carousel</button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('GRAPH', 'RIGHT')}><LineChartIcon size={14} /> + Graph</button>
                            </div>
                        </div>

                        {/* Settings */}
                        {(user?.isAdmin || user?.role === 'MOD' || (!form.isOfficial && form.visibility !== 'DRAFT' && form.visibility !== 'PRIVATE')) && (
                            <div className="profile-card">
                                <div className="section-inner" style={{ padding: '1.5rem' }}>
                                    <h3 className="h3-title section-heading" style={{ fontSize: '1rem' }}>Settings</h3>

                                    {(user?.isAdmin || user?.role === 'MOD') && (
                                        <label className="settings-option orange">
                                            <input type="checkbox" name="isOfficial" checked={form.isOfficial} onChange={handleChange} style={{ marginTop: '2px', width: 16, height: 16, accentColor: 'var(--color-secondary)' }} />
                                            <div>
                                                <span className="settings-option-title"><ShieldCheck size={14} /> Official BIES Event</span>
                                                <p className="settings-option-desc">Official events appear prominently at the top of the events page.</p>
                                            </div>
                                        </label>
                                    )}

                                    {!form.isOfficial && form.visibility !== 'DRAFT' && form.visibility !== 'PRIVATE' && (
                                        <label className="settings-option amber">
                                            <input type="checkbox" name="endorsementRequested" checked={form.endorsementRequested} onChange={handleChange} style={{ marginTop: '2px', width: 16, height: 16, accentColor: '#d97706' }} />
                                            <div>
                                                <span className="settings-option-title"><Award size={14} /> Request BIES Endorsement</span>
                                                <p className="settings-option-desc">Endorsed events receive a badge and increased visibility.</p>
                                            </div>
                                        </label>
                                    )}
                                </div>
                            </div>
                        )}

                    </div>
                </div>

                <div style={{ marginTop: '2.5rem', display: 'flex', justifyContent: 'flex-end', gap: '1rem', paddingBottom: '2rem' }}>
                    <button type="button" onClick={() => navigate(-1)} className="btn btn-outline">Cancel</button>
                    <button type="button" onClick={handleSubmit} disabled={isBusy} className="btn btn-primary">
                        {loading ? 'Saving...' : 'Save Changes'}
                    </button>
                </div>

            </div>

            <style jsx>{`
                .event-edit-page { background: var(--color-gray-100); min-height: 100vh; padding-bottom: 4rem; }
                .py-8 { padding-top: 2rem; padding-bottom: 2rem; }
                .mb-8 { margin-bottom: 2rem; }
                .max-w-6xl { max-width: 1200px; margin: 0 auto; }
                .page-header { margin-bottom: 2rem; }
                .back-link { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--color-gray-500); font-weight: 500; font-size: 0.9rem; background: none; border: none; cursor: pointer; padding: 0; margin-bottom: 0.75rem; }
                .back-link:hover { color: var(--color-primary); }
                .h1-title { font-size: 2rem; font-weight: 700; font-family: var(--font-display); margin-bottom: 0.25rem; }
                .h3-title { font-size: 1.2rem; font-weight: 700; font-family: var(--font-display); }
                .text-gray-500 { color: var(--color-gray-500); margin: 0; }
                .error-banner { display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1rem; background: var(--color-red-tint); color: #B91C1C; border-radius: 8px; margin-bottom: 1.5rem; font-size: 0.9rem; }
                .profile-card { background: var(--color-surface); border-radius: 16px; box-shadow: var(--shadow-sm); border: 1px solid var(--color-gray-200); }
                .section-inner { padding: 2rem; }
                .section-heading { margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid var(--color-gray-200); }
                .cover-banner { position: relative; height: 220px; background-color: #0a192f; background-size: cover; background-position: center; display: flex; align-items: flex-end; justify-content: space-between; padding: 1.25rem; }
                .cover-banner::before { content: ''; position: absolute; inset: 0; background: linear-gradient(transparent 40%, rgba(0,0,0,0.45)); pointer-events: none; }
                .upload-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.5); display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 15; }
                .banner-actions-left, .banner-actions-right { position: relative; z-index: 20; display: flex; gap: 0.5rem; }
                .banner-btn { display: flex; align-items: center; gap: 0.4rem; background: var(--color-surface); color: var(--color-gray-900); border-radius: 8px; height: 38px; padding: 0 16px; font-weight: 600; font-size: 0.85rem; border: none; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.15); white-space: nowrap; }
                .banner-btn:hover { opacity: 0.9; }
                .banner-btn.danger { color: #EF4444; }
                .save-btn { display: inline-flex; align-items: center; gap: 0.5rem; background: var(--color-primary); color: white; border: none; border-radius: 8px; height: 44px; padding: 0 24px; font-weight: 700; font-size: 1rem; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.25); white-space: nowrap; }
                .save-btn:disabled { opacity: 0.7; cursor: not-allowed; }
                .form-row-label { display: grid; grid-template-columns: 140px 1fr; gap: 1.5rem; align-items: start; margin-bottom: 1.75rem; }
                .form-label { text-align: right; color: var(--color-gray-700); font-weight: 600; font-size: 0.875rem; padding-top: 0.6rem; }
                .form-content { min-width: 0; }
                .input-field { width: 100%; padding: 0.75rem 1rem; border: 1px solid var(--color-gray-300); background: var(--color-surface); color: var(--color-text, inherit); border-radius: 8px; outline: none; font-size: 0.95rem; transition: all 0.2s; box-sizing: border-box; }
                .input-field:focus { border-color: var(--color-primary); box-shadow: 0 0 0 3px rgba(0,82,204,0.1); }
                select.input-field { appearance: auto; cursor: pointer; }
                .sidebar-form-group { margin-bottom: 1rem; }
                .sidebar-label { display: flex; align-items: center; font-size: 0.82rem; font-weight: 600; color: var(--color-gray-700); margin-bottom: 0.4rem; }
                .checkbox-label-inline { display: flex; align-items: center; gap: 0.4rem; cursor: pointer; font-size: 0.82rem; font-weight: 600; color: var(--color-gray-700); }
                .input-field.sm { padding: 0.5rem 0.75rem; font-size: 0.85rem; border-radius: 6px; }
                .team-remove { background: none; border: none; cursor: pointer; padding: 0.35rem; color: var(--color-gray-400); border-radius: 6px; transition: all 0.15s; display: flex; align-items: center; }
                .team-remove:hover { color: #ef4444; background: var(--color-red-tint); }
                .add-section-buttons-container { padding: 1.25rem; background: var(--color-gray-100); border: 1px dashed var(--color-gray-300); border-radius: 12px; }
                .section-label-hint { font-size: 0.73rem; font-weight: 600; color: var(--color-gray-500); margin-bottom: 0.6rem; text-transform: uppercase; letter-spacing: 0.05em; }
                .add-section-buttons { display: flex; gap: 0.4rem; flex-wrap: wrap; }
                .add-btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.6rem 1.25rem; border-radius: 8px; border: 2px dashed var(--color-gray-300); background: none; color: var(--color-primary); font-weight: 600; font-size: 0.88rem; cursor: pointer; transition: all 0.15s; }
                .add-btn:hover { border-color: var(--color-primary); background: var(--color-blue-tint); }
                .add-btn.sm { padding: 0.35rem 0.7rem; font-size: 0.78rem; border-radius: 6px; }
                .add-btn-sm { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.35rem 0.75rem; border-radius: 6px; border: 1px dashed var(--color-gray-300); background: none; color: var(--color-primary); font-weight: 600; font-size: 0.78rem; cursor: pointer; margin-top: 0.25rem; }
                .add-btn-sm:hover { border-color: var(--color-primary); background: var(--color-blue-tint); }
                .deck-upload-area { border: 2px dashed var(--color-gray-300); border-radius: 12px; padding: 1.5rem; text-align: center; cursor: pointer; transition: all 0.2s; background: var(--color-gray-50); display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; box-sizing: border-box; }
                .deck-upload-area:hover { border-color: var(--color-primary); background: var(--color-green-tint); }
                .placement-toggle { display: flex; background: var(--color-gray-100); padding: 2px; border-radius: 6px; }
                .placement-toggle button { padding: 2px 8px; font-size: 0.72rem; font-weight: 600; border-radius: 4px; border: none; background: transparent; color: var(--color-gray-500); cursor: pointer; transition: all 0.1s; }
                .placement-toggle button.active { background: var(--color-surface); color: var(--color-primary); box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
                @keyframes spin { to { transform: rotate(360deg); } }
                @media (max-width: 1024px) {
                    .event-edit-page > .container > div[style] { flex-direction: column !important; }
                    .event-edit-page > .container > div[style] > div:last-child { width: 100% !important; }
                }
                .settings-option { display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.75rem; border-radius: 8px; cursor: pointer; margin-bottom: 0.75rem; }
                .settings-option.orange { background: var(--color-orange-tint); border: 1px solid var(--badge-warning-bg); }
                .settings-option.amber { background: var(--color-amber-tint); border: 1px solid var(--badge-warning-bg); }
                .settings-option-title { display: flex; align-items: center; gap: 0.35rem; font-weight: 700; font-size: 0.85rem; color: var(--badge-warning-text); }
                .settings-option-desc { font-size: 0.73rem; color: var(--color-gray-500); margin: 0.2rem 0 0; }
                @media (max-width: 768px) {
                    .form-row-label { grid-template-columns: 1fr; gap: 0.5rem; }
                    .form-label { text-align: left; padding-top: 0; }
                }
            `}</style>
        </div>
    );
};

export default EditEvent;
