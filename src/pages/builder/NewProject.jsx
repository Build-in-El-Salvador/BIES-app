import React, { useState, useEffect } from 'react';
import { Camera, Loader2, FileText, X, Save, Upload, Plus, UserPlus, Trash2, Image as ImageIcon, Layout as LayoutIcon, LineChart as LineChartIcon, AlignLeft as AlignLeftIcon, GripVertical } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { projectsApi, uploadApi, profilesApi } from '../../services/api';
import RichTextEditor from '../../components/RichTextEditor';
import { useSectionDrag, reorderArray } from '../../hooks/useSectionDrag';
import BackButton from '../../components/BackButton';

const NewProject = () => {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const editId = searchParams.get('edit');

    const [loading, setLoading] = useState(false);
    const [loadingProject, setLoadingProject] = useState(!!editId);
    const [imageUploading, setImageUploading] = useState(false);
    const [error, setError] = useState('');
    const [deckFile, setDeckFile] = useState(null);
    const [deckUploading, setDeckUploading] = useState(false);
    const [existingDeck, setExistingDeck] = useState(false);
    const [teamAvatarUploading, setTeamAvatarUploading] = useState(null); // index of uploading member
    const [memberSearchResults, setMemberSearchResults] = useState([]);
    const [memberSearchIndex, setMemberSearchIndex] = useState(null); // which team member index is searching
    const [form, setForm] = useState({
        name: '',
        category: '',
        stage: 'IDEA',
        description: '',
        fundingGoal: '',
        raisedAmount: '',
        website: '',
        coverImage: '',
        ownerRole: '',
        teamInfo: [],
        customSections: [],
        useOfFunds: [],
        requiresDeckApproval: true,
    });

    useEffect(() => {
        if (editId) {
            projectsApi.get(editId).then(project => {
                setForm({
                    name: project.title || '',
                    category: project.category || '',
                    stage: project.stage || 'IDEA',
                    description: project.description || '',
                    fundingGoal: project.fundingGoal || '',
                    raisedAmount: project.raisedAmount || '',
                    website: project.websiteUrl || '',
                    coverImage: project.thumbnail || '',
                    ownerRole: project.ownerRole || '',
                    teamInfo: project.teamInfo || [],
                    customSections: project.customSections || [],
                    useOfFunds: project.useOfFunds || [],
                    requiresDeckApproval: project.requiresDeckApproval !== undefined ? project.requiresDeckApproval : true,
                });
                if (project.deckKey) setExistingDeck(true);
            }).catch(() => {
                setError('Failed to load project for editing.');
            }).finally(() => setLoadingProject(false));
        }
    }, [editId]);

    const handleChange = (field) => (e) => {
        setForm(prev => ({ ...prev, [field]: e.target.value }));
    };

    const handleImageUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setImageUploading(true);
        setError('');
        try {
            const result = await uploadApi.media(file);
            setForm(prev => ({ ...prev, coverImage: result.url }));
        } catch {
            setError('Failed to upload image. Please try again.');
        } finally {
            setImageUploading(false);
        }
    };

    const handleDeckUpload = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.type !== 'application/pdf') { setError('Please upload a PDF file'); return; }
        if (file.size > 20 * 1024 * 1024) { setError('File must be under 20MB'); return; }
        setDeckFile(file);
        setError('');
    };

    // ─── Team Members ────────────────────────────────────────
    const addTeamMember = () => {
        setForm(prev => ({
            ...prev,
            teamInfo: [...prev.teamInfo, { name: '', position: '', avatar: '' }],
        }));
    };

    const updateTeamMember = (index, field, value) => {
        setForm(prev => {
            const updated = [...prev.teamInfo];
            updated[index] = { ...updated[index], [field]: value };
            return { ...prev, teamInfo: updated };
        });
    };

    const removeTeamMember = (index) => {
        setForm(prev => ({
            ...prev,
            teamInfo: prev.teamInfo.filter((_, i) => i !== index),
        }));
    };

    const handleMemberNameChange = (index, value) => {
        updateTeamMember(index, 'name', value);
        updateTeamMember(index, 'biesUserId', ''); // clear any prior selection
        setMemberSearchIndex(index);
        if (value.trim().length >= 2) {
            const timer = setTimeout(async () => {
                try {
                    const res = await profilesApi.list({ search: value, limit: 5 });
                    const list = res?.data || res || [];
                    setMemberSearchResults(list);
                } catch {
                    setMemberSearchResults([]);
                }
            }, 300);
            return () => clearTimeout(timer);
        } else {
            setMemberSearchResults([]);
        }
    };

    const selectBiesMember = (index, profile) => {
        updateTeamMember(index, 'name', profile.name || '');
        updateTeamMember(index, 'avatar', profile.avatar || '');
        updateTeamMember(index, 'biesUserId', profile.userId || profile.user?.id || '');
        setMemberSearchResults([]);
        setMemberSearchIndex(null);
    };

    const handleTeamAvatarUpload = async (index, e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setTeamAvatarUploading(index);
        try {
            const result = await uploadApi.media(file);
            updateTeamMember(index, 'avatar', result.url);
        } catch {
            setError('Failed to upload team member photo.');
        } finally {
            setTeamAvatarUploading(null);
        }
    };

    // ─── Custom Sections ─────────────────────────────────────
    const addSection = (type = 'TEXT', placement = 'LEFT') => {
        const base = { title: '', type, placement };
        let additional = {};
        if (type === 'TEXT') additional = { body: '' };
        if (type === 'PHOTO') additional = { imageUrl: '' };
        if (type === 'CAROUSEL') additional = { images: [] };
        if (type === 'GRAPH') additional = { graphType: 'BAR', xAxisLabel: '', yAxisLabel: '', dataPoints: [{ label: 'Data 1', value: '100' }] };

        setForm(prev => ({
            ...prev,
            customSections: [...prev.customSections, { ...base, ...additional }],
        }));
    };

    const updateSection = (index, field, value) => {
        setForm(prev => {
            const updated = [...prev.customSections];
            updated[index] = { ...updated[index], [field]: value };
            return { ...prev, customSections: updated };
        });
    };

    const removeSection = (index) => {
        setForm(prev => ({
            ...prev,
            customSections: prev.customSections.filter((_, i) => i !== index),
        }));
    };

    const moveSection = (fromIdx, toIdx) => {
        setForm(prev => ({
            ...prev,
            customSections: reorderArray(prev.customSections, fromIdx, toIdx),
        }));
    };

    const { draggingIdx, getSectionDragProps } = useSectionDrag(moveSection);

    const handleSectionImageUpload = async (index, file) => {
        if (!file) return;
        setLoading(true);
        try {
            const result = await uploadApi.media(file);
            updateSection(index, 'imageUrl', result.url);
        } catch {
            setError('Failed to upload image.');
        } finally {
            setLoading(false);
        }
    };

    const handleCarouselImageUpload = async (index, file) => {
        if (!file) return;
        setLoading(true);
        try {
            const result = await uploadApi.media(file);
            setForm(prev => {
                const updated = [...prev.customSections];
                const section = { ...updated[index] };
                section.images = [...(section.images || []), result.url];
                updated[index] = section;
                return { ...prev, customSections: updated };
            });
        } catch {
            setError('Failed to upload carousel image.');
        } finally {
            setLoading(false);
        }
    };

    const removeCarouselImage = (sectionIndex, imageIndex) => {
        setForm(prev => {
            const updated = [...prev.customSections];
            const section = { ...updated[sectionIndex] };
            section.images = section.images.filter((_, i) => i !== imageIndex);
            updated[sectionIndex] = section;
            return { ...prev, customSections: updated };
        });
    };

    const addGraphDataPoint = (index) => {
        setForm(prev => {
            const updated = [...prev.customSections];
            const section = { ...updated[index] };
            section.dataPoints = [...(section.dataPoints || []), { label: '', value: '' }];
            updated[index] = section;
            return { ...prev, customSections: updated };
        });
    };

    const updateGraphDataPoint = (sectionIndex, pointIndex, field, value) => {
        setForm(prev => {
            const updated = [...prev.customSections];
            const section = { ...updated[sectionIndex] };
            const newPoints = [...section.dataPoints];
            newPoints[pointIndex] = { ...newPoints[pointIndex], [field]: value };
            section.dataPoints = newPoints;
            updated[sectionIndex] = section;
            return { ...prev, customSections: updated };
        });
    };

    const removeGraphDataPoint = (sectionIndex, pointIndex) => {
        setForm(prev => {
            const updated = [...prev.customSections];
            const section = { ...updated[sectionIndex] };
            section.dataPoints = section.dataPoints.filter((_, i) => i !== pointIndex);
            updated[sectionIndex] = section;
            return { ...prev, customSections: updated };
        });
    };

    // ─── Use of Funds ──────────────────────────────────────────
    const addUseOfFunds = () => {
        setForm(prev => ({
            ...prev,
            useOfFunds: [...prev.useOfFunds, { label: '', percentage: '' }],
        }));
    };

    const updateUseOfFunds = (index, field, value) => {
        setForm(prev => {
            const updated = [...prev.useOfFunds];
            updated[index] = { ...updated[index], [field]: field === 'percentage' ? value.replace(/[^0-9.]/g, '') : value };
            return { ...prev, useOfFunds: updated };
        });
    };

    const removeUseOfFunds = (index) => {
        setForm(prev => ({
            ...prev,
            useOfFunds: prev.useOfFunds.filter((_, i) => i !== index),
        }));
    };

    // Helper to calculate total percentage safely with decimals
    const getFundsTotal = () => {
        const total = form.useOfFunds.reduce((sum, u) => sum + (parseFloat(u.percentage) || 0), 0);
        return parseFloat(total.toFixed(2));
    };
    const fundsTotal = getFundsTotal();

    // ─── Submit ──────────────────────────────────────────────
    const handleSubmit = async (e) => {
        e?.preventDefault();
        setLoading(true);
        setError('');

        try {
            const payload = {
                title: form.name,
                description: form.description,
                category: form.category || undefined,
                stage: form.stage || undefined,
                fundingGoal: form.fundingGoal ? Number(form.fundingGoal) : undefined,
                raisedAmount: form.raisedAmount !== '' ? Number(form.raisedAmount) : undefined,
                websiteUrl: form.website || undefined,
                thumbnail: form.coverImage || undefined,
                ownerRole: form.ownerRole || undefined,
                teamInfo: form.teamInfo.filter(m => m.name.trim()),
                customSections: form.customSections.filter(s => s.title.trim() || (s.type === 'TEXT' && s.body?.trim()) || s.type !== 'TEXT'),
                useOfFunds: form.useOfFunds.filter(u => u.label.trim() && parseFloat(u.percentage) > 0),
                requiresDeckApproval: form.requiresDeckApproval,
            };
            Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

            let project;
            if (editId) {
                project = await projectsApi.update(editId, payload);
            } else {
                project = await projectsApi.create(payload);
            }

            if (deckFile && project?.id) {
                setDeckUploading(true);
                await uploadApi.deck(deckFile, project.id);
            }

            navigate('/dashboard/builder/projects');
        } catch (err) {
            setError(err.message || 'Failed to save project.');
        } finally {
            setLoading(false);
            setDeckUploading(false);
        }
    };

    if (loadingProject) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
        );
    }

    const isBusy = loading || imageUploading || deckUploading;

    const renderSection = (section, idx) => {
        const stype = section.type || 'TEXT';
        const typeConfig = {
            TEXT: { icon: <AlignLeftIcon size={12} />, label: 'Text', color: '#2563eb', bg: 'var(--color-blue-tint)', border: '#bfdbfe' },
            PHOTO: { icon: <ImageIcon size={12} />, label: 'Photo', color: '#16a34a', bg: 'var(--color-green-tint)', border: '#bbf7d0' },
            CAROUSEL: { icon: <LayoutIcon size={12} />, label: 'Carousel', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
            GRAPH: { icon: <LineChartIcon size={12} />, label: 'Graph', color: '#ea580c', bg: 'var(--color-orange-tint)', border: '#fed7aa' },
        }[stype] || { icon: null, label: stype, color: 'var(--color-gray-500)', bg: 'var(--color-gray-100)', border: 'var(--color-gray-200)' };

        const isBeingDragged = draggingIdx === idx;
        return (
            <div key={idx} {...getSectionDragProps(idx)} style={{
                marginBottom: '1rem', background: 'var(--color-surface)',
                border: `1px solid ${typeConfig.border}`,
                borderRadius: '12px', overflow: 'hidden',
                boxShadow: isBeingDragged ? '0 4px 16px rgba(0,0,0,0.15)' : '0 1px 4px rgba(0,0,0,0.06)',
                opacity: isBeingDragged ? 0.5 : 1,
                transition: 'box-shadow 0.2s, opacity 0.2s',
            }}>
                {/* Section Header */}
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '0.55rem 0.875rem',
                    background: typeConfig.bg,
                    borderBottom: `1px solid ${typeConfig.border}`,
                }}>
                    <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                        fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '0.07em', color: typeConfig.color,
                    }}>
                        <GripVertical size={14} style={{ cursor: 'grab', color: 'var(--color-gray-400)', marginRight: '0.2rem', flexShrink: 0 }} />
                        {typeConfig.icon}
                        {typeConfig.label} Section
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div style={{
                            display: 'flex', background: 'var(--color-surface)', padding: '2px',
                            borderRadius: '6px', border: `1px solid ${typeConfig.border}`,
                            boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.05)'
                        }}>
                            <button
                                type="button"
                                style={{
                                    padding: '2px 8px', fontSize: '0.65rem', fontWeight: 700,
                                    borderRadius: '4px', border: 'none', cursor: 'pointer',
                                    background: (section.placement === 'LEFT' || !section.placement) ? typeConfig.color : 'transparent',
                                    color: (section.placement === 'LEFT' || !section.placement) ? '#fff' : 'var(--color-gray-500)',
                                    transition: 'all 0.2s'
                                }}
                                onClick={() => updateSection(idx, 'placement', 'LEFT')}
                            >
                                Left
                            </button>
                            <button
                                type="button"
                                style={{
                                    padding: '2px 8px', fontSize: '0.65rem', fontWeight: 700,
                                    borderRadius: '4px', border: 'none', cursor: 'pointer',
                                    background: section.placement === 'RIGHT' ? typeConfig.color : 'transparent',
                                    color: section.placement === 'RIGHT' ? '#fff' : 'var(--color-gray-500)',
                                    transition: 'all 0.2s'
                                }}
                                onClick={() => updateSection(idx, 'placement', 'RIGHT')}
                            >
                                Right
                            </button>
                        </div>
                        <button type="button" className="team-remove" onClick={() => removeSection(idx)}>
                            <Trash2 size={15} />
                        </button>
                    </div>
                </div>
                {/* Section Body */}
                <div style={{ padding: '1rem 1.125rem 1.25rem' }}>
                    <input
                        type="text"
                        value={section.title}
                        onChange={(e) => updateSection(idx, 'title', e.target.value)}
                        style={{
                            width: '100%', padding: '0.4rem 0',
                            border: 'none', borderBottom: `2px solid ${typeConfig.border}`,
                            background: 'transparent', outline: 'none',
                            fontSize: '0.95rem', fontWeight: 700, color: 'var(--color-gray-900)',
                            fontFamily: 'var(--font-display)', marginBottom: '0.875rem',
                            transition: 'border-color 0.2s',
                        }}
                        onFocus={e => e.target.style.borderBottomColor = typeConfig.color}
                        onBlur={e => e.target.style.borderBottomColor = typeConfig.border}
                        placeholder="Section Title"
                    />

                    {stype === 'TEXT' && (
                        <RichTextEditor
                            value={section.body}
                            onChange={(val) => updateSection(idx, 'body', val)}
                            placeholder="Section content..."
                            minHeight="100px"
                        />
                    )}

                    {stype === 'PHOTO' && (
                        <div className="photo-upload-container">
                            {section.imageUrl ? (
                                <div className="photo-preview-wrapper" style={{ position: 'relative', display: 'inline-block' }}>
                                    <img src={section.imageUrl} alt="Section" style={{ maxWidth: '100%', maxHeight: '300px', borderRadius: '8px' }} />
                                    <button type="button" className="banner-btn danger" style={{ position: 'absolute', top: 8, right: 8 }} onClick={() => updateSection(idx, 'imageUrl', '')}>
                                        <X size={14} /> Remove
                                    </button>
                                </div>
                            ) : (
                                <label className="deck-upload-area" style={{ padding: '2rem 1rem' }}>
                                    <Upload size={24} style={{ color: 'var(--color-gray-400)', marginBottom: '0.5rem' }} />
                                    <p style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-primary)' }}>Upload Image</p>
                                    <input type="file" accept="image/*" onChange={(e) => handleSectionImageUpload(idx, e.target.files?.[0])} style={{ display: 'none' }} />
                                </label>
                            )}
                        </div>
                    )}

                    {stype === 'CAROUSEL' && (
                        <div className="carousel-upload-container">
                            <div className="carousel-grid" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                                {(section.images || []).map((img, iIndex) => (
                                    <div key={iIndex} style={{ position: 'relative', width: '100px', height: '100px', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--color-gray-200)' }}>
                                        <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                        <button type="button" onClick={() => removeCarouselImage(idx, iIndex)} style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.5)', color: 'white', border: 'none', borderRadius: '50%', padding: '2px', cursor: 'pointer' }}>
                                            <X size={12} />
                                        </button>
                                    </div>
                                ))}
                                <label className="deck-upload-area" style={{ width: '100px', height: '100px', padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Plus size={24} style={{ color: 'var(--color-gray-400)' }} />
                                    <input type="file" accept="image/*" onChange={(e) => handleCarouselImageUpload(idx, e.target.files?.[0])} style={{ display: 'none' }} />
                                </label>
                            </div>
                        </div>
                    )}

                    {stype === 'GRAPH' && (
                        <div className="graph-builder-container">
                            <div className="form-row" style={{ marginBottom: '1rem' }}>
                                <label className="form-label" style={{ textAlign: 'left', width: 'auto', marginRight: '1rem' }}>Graph Type</label>
                                <div className="form-content">
                                    <select
                                        value={section.graphType || 'BAR'}
                                        onChange={(e) => updateSection(idx, 'graphType', e.target.value)}
                                        className="input-field"
                                        style={{ width: '200px' }}
                                    >
                                        <option value="BAR">Bar Chart</option>
                                        <option value="LINE">Line Chart</option>
                                        <option value="PIE">Pie Chart</option>
                                    </select>
                                </div>
                            </div>

                            {section.graphType !== 'PIE' && (
                                <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
                                    <input
                                        type="text"
                                        value={section.xAxisLabel || ''}
                                        onChange={(e) => updateSection(idx, 'xAxisLabel', e.target.value)}
                                        className="input-field"
                                        placeholder="X-Axis Title (Optional)"
                                        style={{ flex: 1 }}
                                    />
                                    <input
                                        type="text"
                                        value={section.yAxisLabel || ''}
                                        onChange={(e) => updateSection(idx, 'yAxisLabel', e.target.value)}
                                        className="input-field"
                                        placeholder="Y-Axis Title (Optional)"
                                        style={{ flex: 1 }}
                                    />
                                </div>
                            )}

                            <div className="graph-data-points">
                                <p style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-gray-700)', marginBottom: '0.5rem' }}>Data Points</p>
                                {(section.dataPoints || []).map((point, pIndex) => (
                                    <div key={pIndex} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
                                        <GripVertical size={16} style={{ color: 'var(--color-gray-400)' }} />
                                        <input
                                            type="text"
                                            value={point.label}
                                            onChange={(e) => updateGraphDataPoint(idx, pIndex, 'label', e.target.value)}
                                            className="input-field"
                                            placeholder="Label (e.g. 2024)"
                                            style={{ flex: 1 }}
                                        />
                                        <input
                                            type="number"
                                            value={point.value}
                                            onChange={(e) => updateGraphDataPoint(idx, pIndex, 'value', e.target.value)}
                                            className="input-field"
                                            placeholder="Value"
                                            style={{ width: '120px' }}
                                        />
                                        <button type="button" className="team-remove" onClick={() => removeGraphDataPoint(idx, pIndex)}>
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                ))}
                                <button type="button" className="add-btn" onClick={() => addGraphDataPoint(idx)} style={{ marginTop: '0.25rem', padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}>
                                    <Plus size={14} /> Add Data Point
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderCustomSections = (placement) => {
        return form.customSections
            .map((s, idx) => ({ ...s, originalIdx: idx }))
            .filter(s => (placement === 'LEFT' ? (s.placement === 'LEFT' || !s.placement) : s.placement === 'RIGHT'))
            .map(s => renderSection(s, s.originalIdx));
    };

    return (
        <div className="project-edit-page">
            <div className="container py-8 max-w-6xl">

                {/* Page Header */}
                <div className="page-header">
                    <div>
                        <div className="back-head">
                            <BackButton fallback="/discover" />
                            <h1 className="h1-title">{editId ? 'Edit Project' : 'Create New Project'}</h1>
                        </div>
                        <p className="text-gray-500">Launch your venture on the Bitcoin network</p>
                    </div>
                </div>

                {error && <div className="error-banner">{error}</div>}

                {/* Cover Image Banner Card */}
                <div className="profile-card mb-8" style={{ padding: 0, overflow: 'hidden' }}>
                    <div className="cover-banner" style={{
                        backgroundImage: form.coverImage ? `url(${form.coverImage})` : 'none',
                    }}>
                        {imageUploading && (
                            <div className="upload-overlay">
                                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', color: 'white' }} />
                                <span style={{ color: 'white', fontWeight: 600, marginTop: '0.5rem' }}>Uploading...</span>
                            </div>
                        )}
                        <div className="banner-actions-left">
                            <label className="banner-btn" style={{ cursor: imageUploading ? 'not-allowed' : 'pointer' }}>
                                {imageUploading ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Camera size={16} />}
                                {form.coverImage ? 'Change Cover' : 'Add Cover Image'}
                                <input type="file" accept="image/*" onChange={handleImageUpload} style={{ display: 'none' }} disabled={imageUploading} />
                            </label>
                            {form.coverImage && !imageUploading && (
                                <button className="banner-btn danger" onClick={() => setForm(prev => ({ ...prev, coverImage: '' }))}>
                                    <X size={16} /> Remove
                                </button>
                            )}
                        </div>
                        <div className="banner-actions-right">
                            <button onClick={handleSubmit} type="button" disabled={isBusy} className="save-btn">
                                {loading ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={18} />}
                                {loading ? 'Saving...' : deckUploading ? 'Uploading Deck...' : (editId ? 'Save Changes' : 'Create Project')}
                            </button>
                        </div>
                    </div>
                </div>

                {/* ─── Main Form Layout ────────────────────────── */}
                <div className="pd-layout" style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start' }}>

                    {/* ─── Left Column (Main) ─────────────────── */}
                    <div className="pd-main" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2rem', minWidth: 0 }}>
                        {/* About Project */}
                        <div className="profile-card">
                            <div className="section-inner">
                                <h3 className="h3-title section-heading">About Project</h3>

                                <div className="form-row">
                                    <label className="form-label">Summary</label>
                                    <div className="form-content">
                                        <RichTextEditor
                                            value={form.description}
                                            onChange={(val) => setForm(prev => ({ ...prev, description: val }))}
                                            placeholder="Describe your project, goals, and team..."
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Left Custom Sections */}
                        {renderCustomSections('LEFT')}

                        <div className="add-section-buttons-container">
                            <p className="section-label-hint">Add Section to Left Column</p>
                            <div className="add-section-buttons">
                                <button type="button" className="add-btn sm" onClick={() => addSection('TEXT', 'LEFT')}>
                                    <AlignLeftIcon size={14} /> + Text
                                </button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('PHOTO', 'LEFT')}>
                                    <ImageIcon size={14} /> + Photo
                                </button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('CAROUSEL', 'LEFT')}>
                                    <LayoutIcon size={14} /> + Carousel
                                </button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('GRAPH', 'LEFT')}>
                                    <LineChartIcon size={14} /> + Graph
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* ─── Right Column (Sidebar) ─────────────────── */}
                    <div className="pd-sidebar" style={{ width: '380px', display: 'flex', flexDirection: 'column', gap: '2rem', flexShrink: 0 }}>

                        {/* Funding */}
                        <div className="profile-card">
                            <div className="section-inner" style={{ padding: '1.5rem' }}>
                                <h3 className="h3-title section-heading" style={{ fontSize: '1.1rem', marginBottom: '1.25rem' }}>Funding Status</h3>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label">Goal (USD)</label>
                                    <div className="input-with-prefix">
                                        <span className="prefix">$</span>
                                        <input type="number" value={form.fundingGoal} onChange={handleChange('fundingGoal')} className="input-field" style={{ paddingLeft: '2rem' }} placeholder="500000" />
                                    </div>
                                </div>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label">Raised (USD)</label>
                                    <div className="input-with-prefix">
                                        <span className="prefix">$</span>
                                        <input type="number" value={form.raisedAmount} onChange={handleChange('raisedAmount')} className="input-field" style={{ paddingLeft: '2rem' }} placeholder="0" />
                                    </div>
                                </div>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label">Website</label>
                                    <input type="url" value={form.website} onChange={handleChange('website')} className="input-field" placeholder="https://" />
                                </div>

                                <div className="sidebar-form-group" style={{ marginBottom: 0 }}>
                                    <label className="sidebar-label">Use of Funds</label>
                                    {form.useOfFunds.map((item, idx) => (
                                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                            <input
                                                type="text"
                                                value={item.label}
                                                onChange={(e) => updateUseOfFunds(idx, 'label', e.target.value)}
                                                className="input-field sm"
                                                placeholder="Label"
                                                style={{ flex: 1 }}
                                            />
                                            <input
                                                type="text"
                                                value={item.percentage}
                                                onChange={(e) => updateUseOfFunds(idx, 'percentage', e.target.value)}
                                                className="input-field sm"
                                                placeholder="%"
                                                style={{ width: '50px' }}
                                            />
                                            <button type="button" className="team-remove" onClick={() => removeUseOfFunds(idx)}>
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    ))}
                                    <button type="button" className="add-btn sm" onClick={addUseOfFunds} style={{ width: '100%', justifyContent: 'center' }}>
                                        <Plus size={14} /> Add Item
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Pitch Deck */}
                        <div className="profile-card">
                            <div className="section-inner" style={{ padding: '1.5rem' }}>
                                <h3 className="h3-title section-heading" style={{ fontSize: '1.1rem', marginBottom: '1.25rem' }}>Pitch Deck</h3>
                                {deckFile ? (
                                    <div className="deck-file-display sm">
                                        <FileText size={16} style={{ color: 'var(--color-primary)' }} />
                                        <span className="deck-name sm">{deckFile.name}</span>
                                        <button type="button" className="deck-remove" onClick={() => setDeckFile(null)}>
                                            <X size={14} />
                                        </button>
                                    </div>
                                ) : existingDeck ? (
                                    <div className="deck-file-display sm">
                                        <FileText size={16} style={{ color: 'var(--color-primary)' }} />
                                        <span className="deck-name sm">Deck uploaded</span>
                                        <label className="deck-replace-btn">
                                            Replace <input type="file" accept=".pdf,application/pdf" onChange={handleDeckUpload} style={{ display: 'none' }} />
                                        </label>
                                    </div>
                                ) : (
                                    <label className="deck-upload-area sm" style={{ padding: '1rem' }}>
                                        <Upload size={20} style={{ color: 'var(--color-gray-400)', marginBottom: '0.25rem' }} />
                                        <p style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-primary)' }}>Upload PDF</p>
                                        <input type="file" accept=".pdf,application/pdf" onChange={handleDeckUpload} style={{ display: 'none' }} />
                                    </label>
                                )}

                                <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--color-gray-100)' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                                        <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-gray-700)' }}>Requires Approval</div>
                                        <div
                                            onClick={() => setForm(prev => ({ ...prev, requiresDeckApproval: !prev.requiresDeckApproval }))}
                                            style={{
                                                width: '36px', height: '20px',
                                                background: form.requiresDeckApproval ? 'var(--color-primary)' : 'var(--color-gray-300)',
                                                borderRadius: '10px', transition: 'background 0.2s', position: 'relative'
                                            }}
                                        >
                                            <div style={{
                                                position: 'absolute', top: '2px', left: form.requiresDeckApproval ? '18px' : '2px',
                                                width: '16px', height: '16px', background: 'white', borderRadius: '50%',
                                                transition: 'left 0.2s'
                                            }} />
                                        </div>
                                    </label>
                                </div>
                            </div>
                        </div>

                        {/* Core Team */}
                        <div className="profile-card">
                            <div className="section-inner" style={{ padding: '1.5rem' }}>
                                <h3 className="h3-title section-heading" style={{ fontSize: '1.1rem', marginBottom: '1.25rem' }}>Core Team</h3>

                                <div className="team-entry sm" style={{ background: 'var(--color-blue-tint)', borderColor: '#bfdbfe', padding: '0.75rem' }}>
                                    <div className="team-fields">
                                        <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>Main Builder (You)</span>
                                        <input
                                            type="text"
                                            value={form.ownerRole}
                                            onChange={handleChange('ownerRole')}
                                            className="input-field sm"
                                            placeholder="Your Role"
                                        />
                                    </div>
                                </div>

                                {form.teamInfo.map((member, idx) => (
                                    <div key={idx} className="team-entry sm" style={{ padding: '0.75rem' }}>
                                        <div className="team-fields" style={{ position: 'relative' }}>
                                            <input
                                                type="text"
                                                value={member.name}
                                                onChange={(e) => handleMemberNameChange(idx, e.target.value)}
                                                onFocus={() => { if (member.name?.length >= 2) setMemberSearchIndex(idx); }}
                                                onBlur={() => setTimeout(() => setMemberSearchIndex(null), 200)}
                                                className="input-field sm"
                                                placeholder="Name"
                                            />
                                            {memberSearchIndex === idx && memberSearchResults.length > 0 && (
                                                <div className="member-dropdown">
                                                    {memberSearchResults.map((p) => (
                                                        <button key={p.id} type="button" className="member-dropdown-item sm" onMouseDown={(e) => { e.preventDefault(); selectBiesMember(idx, p); }}>
                                                            <div className="member-dropdown-avatar sm">
                                                                {p.avatar ? <img src={p.avatar} alt="" /> : <span>{p.name[0]}</span>}
                                                            </div>
                                                            <span>{p.name}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            <input
                                                type="text"
                                                value={member.position}
                                                onChange={(e) => updateTeamMember(idx, 'position', e.target.value)}
                                                className="input-field sm"
                                                placeholder="Role"
                                            />
                                        </div>
                                        <button type="button" className="team-remove" onClick={() => removeTeamMember(idx)}>
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                ))}

                                <button type="button" className="add-btn sm" onClick={addTeamMember} style={{ width: '100%', justifyContent: 'center' }}>
                                    <UserPlus size={14} /> Add Member
                                </button>
                            </div>
                        </div>

                        {/* Project Info */}
                        <div className="profile-card">
                            <div className="section-inner" style={{ padding: '1.5rem' }}>
                                <h3 className="h3-title section-heading" style={{ fontSize: '1.1rem', marginBottom: '1.25rem' }}>Project Info</h3>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label">Project Name</label>
                                    <input
                                        type="text"
                                        value={form.name}
                                        onChange={handleChange('name')}
                                        className="input-field sm"
                                        placeholder="Project Name"
                                        required
                                    />
                                </div>

                                <div className="sidebar-form-group">
                                    <label className="sidebar-label">Category</label>
                                    <select value={form.category} onChange={handleChange('category')} className="input-field sm" required>
                                        <option value="">Select Category</option>
                                        <option value="INFRASTRUCTURE">Infrastructure</option>
                                        <option value="FINTECH">Finance / DeFi</option>
                                        <option value="EDUCATION">Education</option>
                                        <option value="TOURISM">Tourism</option>
                                        <option value="TECHNOLOGY">Technology</option>
                                        <option value="FITNESS">Fitness / Sports</option>
                                        <option value="HEALTH">Healthcare / Wellness</option>
                                        <option value="SAAS">Software as a Service (SaaS)</option>
                                        <option value="ECOMMERCE">E-Commerce</option>
                                        <option value="WEB3">Web3 / Crypto</option>
                                        <option value="ENTERTAINMENT">Entertainment / Media</option>
                                        <option value="LOGISTICS">Logistics / Supply Chain</option>
                                        <option value="AGRICULTURE">Agriculture</option>
                                        <option value="ENERGY">Energy</option>
                                        <option value="REAL_ESTATE">Real Estate</option>
                                        <option value="OTHER">Other</option>
                                    </select>
                                </div>

                                <div className="sidebar-form-group" style={{ marginBottom: 0 }}>
                                    <label className="sidebar-label">Stage</label>
                                    <select value={form.stage} onChange={handleChange('stage')} className="input-field sm">
                                        <option value="IDEA">Idea</option>
                                        <option value="MVP">MVP</option>
                                        <option value="GROWTH">Growth</option>
                                        <option value="SCALING">Scaling</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        {/* Right Custom Sections */}
                        {renderCustomSections('RIGHT')}

                        <div className="add-section-buttons-container">
                            <p className="section-label-hint">Add Section to Right Column</p>
                            <div className="add-section-buttons">
                                <button type="button" className="add-btn sm" onClick={() => addSection('TEXT', 'RIGHT')}>
                                    <AlignLeftIcon size={14} /> + Text
                                </button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('PHOTO', 'RIGHT')}>
                                    <ImageIcon size={14} /> + Photo
                                </button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('CAROUSEL', 'RIGHT')}>
                                    <LayoutIcon size={14} /> + Carousel
                                </button>
                                <button type="button" className="add-btn sm" onClick={() => addSection('GRAPH', 'RIGHT')}>
                                    <LineChartIcon size={14} /> + Graph
                                </button>
                            </div>
                        </div>

                    </div>
                </div>

                <div className="bottom-actions" style={{ marginTop: '2.5rem', display: 'flex', justifyContent: 'flex-end', gap: '1rem', paddingBottom: '2rem' }}>
                    <button type="button" onClick={() => navigate(-1)} className="btn btn-outline">Cancel</button>
                    <button type="button" onClick={handleSubmit} className="btn btn-primary" disabled={isBusy}>
                        {loading ? (editId ? 'Saving...' : 'Creating...') : deckUploading ? 'Uploading deck...' : (editId ? 'Save Changes' : 'Create Project')}
                    </button>
                </div>

            </div>

            <style jsx>{`
                .project-edit-page {
                    background-color: var(--color-gray-100);
                    min-height: 100vh;
                    padding-bottom: 4rem;
                }
                .py-8 { padding-top: var(--page-top, 2rem); padding-bottom: 2rem; }
                .mb-8 { margin-bottom: 2rem; }

                .page-header { margin-bottom: 2rem; }

                .h1-title { font-size: 2rem; line-height: 2.25rem; font-weight: 700; font-family: var(--font-display); margin-bottom: 0.25rem; }
                .h3-title { font-size: 1.25rem; font-weight: 700; font-family: var(--font-display); }
                .text-gray-500 { color: var(--color-gray-500); margin: 0; }

                .error-banner {
                    background: var(--color-red-tint); color: #EF4444;
                    padding: 0.75rem 1rem; border-radius: 8px;
                    margin-bottom: 1rem; font-size: 0.875rem;
                }

                .profile-card {
                    background: var(--color-surface);
                    border-radius: var(--radius-xl, 16px);
                    box-shadow: var(--shadow-sm);
                    border: 1px solid var(--color-gray-200);
                }
                .section-inner { padding: 2rem; }
                .sections { display: flex; flex-direction: column; gap: 2rem; }
                .section-heading {
                    margin-bottom: 1.5rem; padding-bottom: 1rem;
                    border-bottom: 1px solid var(--color-gray-200);
                }

                .cover-banner {
                    position: relative; height: 220px;
                    background-color: #0a192f; background-size: cover; background-position: center;
                    display: flex; align-items: flex-end; justify-content: space-between;
                    padding: 1.25rem;
                }
                .cover-banner::before {
                    content: ''; position: absolute; inset: 0;
                    background: linear-gradient(transparent 40%, rgba(0,0,0,0.45));
                    pointer-events: none;
                }

                .upload-overlay {
                    position: absolute; inset: 0; background: rgba(0,0,0,0.5);
                    display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 15;
                }

                .banner-actions-left, .banner-actions-right {
                    position: relative; z-index: 20; display: flex; gap: 0.5rem;
                }

                .banner-btn {
                    display: flex; align-items: center; gap: 0.4rem;
                    background: var(--color-surface); color: var(--color-gray-900);
                    border-radius: var(--radius-md, 8px); height: 38px; padding: 0 16px;
                    font-weight: 600; font-size: 0.85rem; border: none; cursor: pointer;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.15); white-space: nowrap;
                }
                .banner-btn:hover { opacity: 0.9; }
                .banner-btn.danger { color: #EF4444; }

                .save-btn {
                    display: inline-flex; align-items: center; gap: 0.5rem;
                    background: var(--color-primary, #0052cc); color: white; border: none;
                    border-radius: var(--radius-md, 8px); height: 44px; padding: 0 24px;
                    font-weight: 700; font-family: var(--font-display); font-size: 1rem;
                    letter-spacing: 0.02em; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
                    cursor: pointer; white-space: nowrap;
                }
                .save-btn:disabled { opacity: 0.7; cursor: not-allowed; }

                .form-row {
                    display: grid; grid-template-columns: 160px 1fr;
                    gap: 2rem; align-items: start; margin-bottom: 2rem;
                }
                .form-label {
                    text-align: right; color: var(--color-gray-700);
                    font-weight: 600; font-size: 0.875rem; padding-top: 0.6rem;
                }
                .form-content { min-width: 0; }
                .form-hint { font-size: 0.78rem; color: var(--color-gray-400); margin-top: 0.4rem; }

                .input-field {
                    width: 100%; padding: 0.75rem 1rem;
                    border: 1px solid var(--color-gray-300); background: var(--color-surface);
                    border-radius: var(--radius-md, 8px); outline: none;
                    font-size: 0.95rem; transition: all 0.2s;
                }
                .input-field:focus {
                    border-color: var(--color-primary);
                    box-shadow: 0 0 0 3px rgba(0, 82, 204, 0.1);
                }
                select.input-field { appearance: auto; cursor: pointer; }

                .input-with-prefix { position: relative; }
                .input-with-prefix .prefix {
                    position: absolute; left: 1rem; top: 50%; transform: translateY(-50%);
                    color: var(--color-gray-500); pointer-events: none; font-weight: 500;
                }

                .empty-hint { color: var(--color-gray-400); font-size: 0.88rem; }

                /* Team Members */
                .team-entry {
                    display: flex; align-items: flex-start; gap: 1rem;
                    padding: 1rem; margin-bottom: 1rem;
                    background: var(--color-gray-50, #f9fafb);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 10px;
                }
                .team-avatar-upload { flex-shrink: 0; }
                .team-avatar-label {
                    width: 56px; height: 56px; border-radius: 50%;
                    background: var(--color-gray-100); border: 2px dashed var(--color-gray-300);
                    display: flex; align-items: center; justify-content: center;
                    cursor: pointer; overflow: hidden; color: var(--color-gray-400);
                    transition: border-color 0.15s;
                }
                .team-avatar-label:hover { border-color: var(--color-primary); }
                .team-avatar-img { width: 100%; height: 100%; object-fit: cover; }
                .team-fields { flex: 1; display: flex; flex-direction: column; gap: 0.5rem; }
                .team-remove {
                    background: none; border: none; cursor: pointer; padding: 0.35rem;
                    color: var(--color-gray-400); border-radius: 6px; transition: all 0.15s;
                }
                .team-remove:hover { color: #ef4444; background: var(--color-red-tint); }

                .member-dropdown {
                    position: absolute; z-index: 30; top: 100%; left: 0; right: 0;
                    margin-top: 4px; background: var(--color-surface); border: 1px solid var(--color-gray-200);
                    border-radius: var(--radius-md, 8px); box-shadow: 0 10px 25px rgba(0,0,0,0.1);
                    max-height: 200px; overflow-y: auto;
                }
                .member-dropdown-item {
                    width: 100%; padding: 0.6rem 0.75rem; display: flex; align-items: center;
                    gap: 0.6rem; border: none; background: none; cursor: pointer; text-align: left;
                }
                .member-dropdown-item:hover { background: var(--color-gray-50, #f9fafb); }
                .member-dropdown-avatar {
                    width: 32px; height: 32px; border-radius: 50%; overflow: hidden;
                    background: var(--color-gray-200); display: flex; align-items: center;
                    justify-content: center; flex-shrink: 0;
                }
                .member-dropdown-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .member-dropdown-avatar span { font-size: 0.75rem; font-weight: 600; color: var(--color-gray-500); }

                /* Custom Sections */
                .custom-section-entry {
                    margin-bottom: 1rem;
                    background: var(--color-surface);
                    border: 1px solid var(--color-gray-200);
                    border-radius: 12px;
                    overflow: hidden;
                    box-shadow: 0 1px 4px rgba(0,0,0,0.05);
                }
                .custom-section-header {
                    display: flex; justify-content: space-between; align-items: center;
                    padding: 0.6rem 1rem;
                    background: var(--color-gray-50);
                    border-bottom: 1px solid var(--color-gray-200);
                }
                .custom-section-type-badge {
                    display: inline-flex; align-items: center; gap: 0.35rem;
                    font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
                    letter-spacing: 0.06em; color: var(--color-primary);
                    background: var(--color-blue-tint); padding: 0.25rem 0.6rem;
                    border-radius: 99px;
                }
                .custom-section-body {
                    padding: 1rem 1.25rem 1.25rem;
                }
                .custom-section-title-input {
                    width: 100%; padding: 0.5rem 0;
                    border: none; border-bottom: 2px solid var(--color-gray-200);
                    background: transparent; outline: none;
                    font-size: 1rem; font-weight: 700; color: var(--color-gray-900);
                    font-family: var(--font-display);
                    margin-bottom: 1rem;
                    transition: border-color 0.2s;
                }
                .custom-section-title-input:focus { border-bottom-color: var(--color-primary); }
                .custom-section-title-input::placeholder { color: var(--color-gray-300); font-weight: 400; }

                /* Add buttons */
                .add-btn {
                    display: inline-flex; align-items: center; gap: 0.4rem;
                    padding: 0.6rem 1.25rem; border-radius: 8px;
                    border: 2px dashed var(--color-gray-300); background: none;
                    color: var(--color-primary); font-weight: 600; font-size: 0.88rem;
                    cursor: pointer; transition: all 0.15s;
                }
                .add-btn:hover { border-color: var(--color-primary); background: var(--color-blue-tint); }

                /* Deck */
                .deck-upload-area {
                    border: 2px dashed var(--color-gray-300);
                    border-radius: var(--radius-lg, 12px); padding: 1.5rem;
                    text-align: center; cursor: pointer; transition: all 0.2s;
                    background: var(--color-gray-50, #f9fafb);
                    display: flex; flex-direction: column; align-items: center; justify-content: center;
                }
                .deck-upload-area:hover { border-color: var(--color-primary); background: var(--color-orange-tint); }

                .deck-file-display {
                    display: flex; align-items: center; gap: 0.75rem;
                    padding: 0.75rem 1rem; background: var(--color-gray-50, #f9fafb);
                    border: 1px solid var(--color-gray-200); border-radius: var(--radius-md, 8px);
                }
                .deck-name { font-weight: 500; flex: 1; }
                .deck-size { color: var(--color-gray-400); font-size: 0.85rem; }
                .deck-remove {
                    padding: 4px; border-radius: 4px; color: var(--color-gray-400);
                    cursor: pointer; background: none; border: none;
                }
                .deck-remove:hover { color: var(--color-error, #EF4444); background: var(--color-gray-100); }
                .deck-replace-btn {
                    padding: 4px 12px; border-radius: var(--radius-md, 8px);
                    font-size: 0.8rem; font-weight: 600; color: var(--color-primary);
                    background: var(--color-surface); border: 1px solid var(--color-gray-200); cursor: pointer;
                }
                .deck-replace-btn:hover { background: var(--color-gray-50, #f9fafb); }

                .bottom-actions {
                    display: flex; justify-content: flex-end; gap: 1rem; margin-top: 0.5rem;
                }

                .sidebar-form-group { margin-bottom: 1.25rem; }
                .sidebar-label { 
                    display: block; font-size: 0.85rem; font-weight: 600; 
                    color: var(--color-gray-700); margin-bottom: 0.5rem; 
                }
                .input-field.sm { padding: 0.5rem 0.75rem; font-size: 0.85rem; border-radius: 6px; }
                .add-btn.sm { padding: 0.4rem 0.75rem; font-size: 0.8rem; border-radius: 6px; }
                .team-entry.sm { padding: 0.75rem; border-radius: 8px; }
                .deck-file-display.sm { padding: 0.5rem 0.75rem; }
                .deck-name.sm { font-size: 0.8rem; }
                .deck-upload-area.sm { padding: 1rem; border-radius: 8px; }
                .add-section-buttons-container { padding: 1.5rem; background: var(--color-gray-100); border: 1px dashed var(--color-gray-300); border-radius: 12px; }
                .section-label-hint { font-size: 0.75rem; font-weight: 600; color: var(--color-gray-500); margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
                .add-section-buttons { display: flex; gap: 0.5rem; flex-wrap: wrap; }
                
                @media (max-width: 1024px) {
                    .pd-layout { flex-direction: column; }
                    .pd-sidebar { width: 100% !important; }
                }

                @media (max-width: 768px) {
                    .form-row { grid-template-columns: 1fr; gap: 0.5rem; }
                    .form-label { text-align: left; padding-top: 0; }
                    .cover-banner { height: 180px; flex-direction: column; align-items: stretch; }
                    .banner-actions-left, .banner-actions-right { justify-content: center; }
                    .team-entry { flex-direction: column; align-items: center; }
                }

                .placement-toggle {
                    display: flex;
                    background: var(--color-gray-100);
                    padding: 2px;
                    border-radius: 6px;
                }
                .placement-toggle button {
                    padding: 2px 8px;
                    font-size: 0.75rem;
                    font-weight: 600;
                    border-radius: 4px;
                    border: none;
                    background: transparent;
                    color: var(--color-gray-500);
                    cursor: pointer;
                    transition: all 0.1s;
                }
                .placement-toggle button.active {
                    background: var(--color-surface);
                    color: var(--color-primary);
                    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
                }
                @keyframes spin { to { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

export default NewProject;
