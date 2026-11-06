import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
    AlertCircle, Briefcase, Camera, Globe, GripVertical, ImagePlus, Instagram, LayoutTemplate, Link2, Linkedin,
    Loader2, MapPin, Move, Plus, Rocket, Search, Tag, Trash2, X, Zap,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useFeature } from '../context/FeatureFlagsContext';
import { isNativePlatform } from '../utils/platform';
import { profilesApi, uploadApi, projectsApi, settingsApi } from '../services/api';
import { nostrLinkFields } from '../services/nostrProfileLinks';
import { nostrSigner } from '../services/nostrSigner';
import { mediaService } from '../services/mediaService';
import { nostrService } from '../services/nostrService';
import { followUpPublicProfile, keyIsMembers } from '../services/publicNostrProfile';
import { objectionableMessage } from '../components/moderation/objectionable';
import { fieldErrorText } from '../utils/fieldErrors';
import BackButton from '../components/BackButton';
import ImageCropModal from '../components/ImageCropModal';
import CoverPhoto from '../components/CoverPhoto';
import { useCoverFramer } from '../components/CoverFramer';
import RichTextEditor from '../components/RichTextEditor';
import TagInput from '../components/TagInput';
import { Switch } from '../components/settings/SettingsUI';
import { COVER_ASPECT } from '../utils/coverFrame';
import { useSectionDrag, reorderArray } from '../hooks/useSectionDrag';
import { getAssetUrl } from '../utils/assets';
import { sectionHasContent } from '../utils/profileSections';
import { asWebLink } from '../components/talent/talentOptions';
import {
    SECTIONS, MAX_ROLES, MAX_CUSTOM_LINKS, joinName, namePartsOf, rolesOf, hiddenSectionsOf, profileStrength,
} from '../utils/profileFields';
import InitialAvatar from '../components/InitialAvatar';

/*
 * Edit profile, built like the newer forms (Opportunities, Events): a few
 * basics, then a card per extra section with a switch. Switched on, a
 * section's fields open; switched off, it's hidden from the profile and what
 * was in it is kept (server/src/services/profileFields.ts).
 */

const SECTION_LOOK = {
    links: { Icon: Link2, tone: 'blue' },
    experience: { Icon: Briefcase, tone: 'orange' },
    projects: { Icon: Rocket, tone: 'green' },
    custom: { Icon: LayoutTemplate, tone: 'purple' },
    tags: { Icon: Tag, tone: 'gray' },
};

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const EMPTY_ROLE = { title: '', company: '' };

/** Whether a section has anything in it (an empty one opens switched off). */
function sectionFilled(section, form, walletFields) {
    switch (section) {
        case 'links':
            return [form.website, form.twitter, form.linkedin, form.instagram, ...(walletFields ? [form.lightningAddress, form.bolt12Offer] : [])].some((v) => !!str(v))
                || form.customLinks.some((l) => str(l.url));
        case 'experience': return form.experience.some((e) => str(e.title) || str(e.company) || str(e.description));
        case 'projects': return form.biesProjects.length > 0;
        case 'custom': return form.customSections.length > 0;
        case 'tags': return form.tags.length > 0;
        default: return false;
    }
}

/** A text box that grows onto more lines as its text needs, and stays one entry (no Enter). */
function GrowingField({ value, onChange, inputRef, ...rest }) {
    const ref = useRef(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [value]);
    return (
        <textarea
            ref={(el) => { ref.current = el; if (inputRef) inputRef(el); }}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
            {...rest}
        />
    );
}

/** A custom section's photos: one (PHOTO) or several (CAROUSEL), edited the same way. */
const photosOf = (section) => (section.type === 'PHOTO' ? [section.imageUrl].filter(Boolean) : (section.images || []).filter(Boolean));
const withPhotos = (section, photos) => (section.type === 'PHOTO' && photos.length <= 1
    ? { ...section, imageUrl: photos[0] || '' }
    : { ...section, type: 'CAROUSEL', images: photos, imageUrl: undefined });

const ProfileEdit = () => {
    const { t } = useTranslation();
    const { user, refreshUser } = useAuth();
    const navigate = useNavigate();
    const projectsEnabled = useFeature('projects');
    // Lightning and Bolt12 receive addresses: on the website (a member's way
    // to be paid), not in the store app. Hidden, they're left as saved.
    const walletFields = !isNativePlatform();
    const searchRef = useRef(null);
    // Where "Next: add …" takes the member.
    const fieldRefs = useRef({});

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [fieldError, setFieldError] = useState(null); // { id, message }
    const [uploadingAvatar, setUploadingAvatar] = useState(false);
    const [uploadingBanner, setUploadingBanner] = useState(false);
    const [uploadingSection, setUploadingSection] = useState(null);
    const [cropImage, setCropImage] = useState(null); // { src } for the profile photo
    const [nostrProfile, setNostrProfile] = useState(null);
    // A custom section about to be removed (asked first when it has something in it).
    const [confirmRemove, setConfirmRemove] = useState(null);
    // The section being dragged by its handle (only the handle starts a drag,
    // so selecting text in its fields doesn't).
    const [dragArmed, setDragArmed] = useState(null);

    const [form, setForm] = useState({
        firstName: '', lastName: '', roles: [EMPTY_ROLE], location: '', bio: '',
        avatar: '', banner: '', coverFrame: '',
        website: '', twitter: '', linkedin: '', instagram: '', customLinks: [],
        lightningAddress: '', bolt12Offer: '',
        experience: [], biesProjects: [], customSections: [], tags: [],
        nostrName: '', nip05Name: '',
    });
    const [on, setOn] = useState({ links: false, experience: false, projects: false, custom: false, tags: false });

    // Working on: search BIES projects, and the member's own
    const [projectSearch, setProjectSearch] = useState('');
    const [projectResults, setProjectResults] = useState([]);
    const [showProjectDropdown, setShowProjectDropdown] = useState(false);
    const [newProjectRole, setNewProjectRole] = useState('');
    const [autoProjects, setAutoProjects] = useState([]);

    const set = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));
    const change = (field) => (e) => set(field, e.target.value);

    // ─── Loading ─────────────────────────────────────────────────────────────

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const profile = await profilesApi.me();
                if (cancelled || !profile) return;
                const roles = rolesOf(profile);
                const next = {
                    ...namePartsOf(profile),
                    roles: roles.length ? roles : [EMPTY_ROLE],
                    location: profile.location || '',
                    bio: profile.bio || '',
                    avatar: profile.avatar || '',
                    banner: profile.banner || '',
                    coverFrame: profile.coverFrame || '',
                    website: profile.website || '',
                    twitter: profile.twitter || '',
                    linkedin: profile.linkedin || '',
                    instagram: profile.instagram || '',
                    customLinks: Array.isArray(profile.customLinks) ? profile.customLinks.map((l) => ({ label: l.label || '', url: l.url || '' })) : [],
                    lightningAddress: profile.lightningAddress || '',
                    bolt12Offer: profile.bolt12Offer || '',
                    experience: (profile.experience || []).map((exp) => {
                        // Years from a date like "2020 - Present"
                        let fromYear = exp.fromYear || '';
                        let toYear = exp.toYear || '';
                        if (!fromYear && exp.date) {
                            const parts = exp.date.split(/\s*[-–]\s*/);
                            if (/^\d{4}$/.test(parts[0]?.trim() || '')) fromYear = parts[0].trim();
                            if (/^\d{4}$/.test(parts[1]?.trim() || '')) toYear = parts[1].trim();
                        }
                        return { title: exp.title || '', company: exp.company || '', description: exp.description || '', fromYear, toYear };
                    }),
                    biesProjects: profile.biesProjects || [],
                    customSections: Array.isArray(profile.customSections) ? profile.customSections : [],
                    tags: profile.tags || [],
                    nip05Name: profile.nip05Name || '',
                };
                const hidden = hiddenSectionsOf(profile);
                setForm((prev) => ({ ...prev, ...next }));
                // A section opens switched on when it has something and isn't switched off.
                setOn(Object.fromEntries(SECTIONS.map((s) => [s, !hidden.has(s) && sectionFilled(s, next, walletFields)])));
            } catch {
                // New member: the form starts empty
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [walletFields]);

    useEffect(() => {
        if (!user?.nostrPubkey) return;
        nostrService.getProfile(user.nostrPubkey)
            .then((profile) => setNostrProfile(profile))
            .catch((err) => console.error('Failed to fetch Nostr profile:', err));
    }, [user?.nostrPubkey]);

    // What their Nostr profile has that the BIES one doesn't yet.
    useEffect(() => {
        if (!nostrProfile || loading) return;
        setForm((prev) => {
            const updates = {};
            if (!prev.banner && nostrProfile.banner) updates.banner = nostrProfile.banner;
            if (!prev.avatar && nostrProfile.picture) updates.avatar = nostrProfile.picture;
            if (!prev.firstName && !prev.lastName && (nostrProfile.display_name || nostrProfile.name)) {
                Object.assign(updates, namePartsOf({ name: nostrProfile.display_name || nostrProfile.name }));
            }
            if (!prev.bio && nostrProfile.about) updates.bio = nostrProfile.about;
            if (!prev.website && nostrProfile.website) updates.website = nostrProfile.website;
            if (!prev.nostrName && nostrProfile.name) updates.nostrName = nostrProfile.name;
            if (!prev.lightningAddress && (nostrProfile.lud16 || nostrProfile.lud06)) updates.lightningAddress = nostrProfile.lud16 || nostrProfile.lud06;
            if (!prev.bolt12Offer && nostrProfile.bolt12) updates.bolt12Offer = nostrProfile.bolt12;
            return Object.keys(updates).length ? { ...prev, ...updates } : prev;
        });
    }, [nostrProfile, loading]);

    useEffect(() => {
        const close = (e) => { if (searchRef.current && !searchRef.current.contains(e.target)) setShowProjectDropdown(false); };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, []);

    useEffect(() => {
        if (!projectSearch.trim()) { setProjectResults([]); return undefined; }
        const timer = setTimeout(async () => {
            try {
                const res = await projectsApi.list({ search: projectSearch, limit: 5 });
                const list = res?.data || res || [];
                setProjectResults(list.map((p) => ({ ...p, name: p.title || p.name, image: p.thumbnail || p.coverImage || p.image })));
                setShowProjectDropdown(true);
            } catch (err) {
                console.error('Failed to search projects', err);
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [projectSearch]);

    useEffect(() => {
        if (!user?.id || !projectsEnabled) return;
        projectsApi.list({ ownerId: user.id, limit: 50 })
            .then((res) => setAutoProjects((res?.data || res || []).map((p) => ({
                id: p.id, name: p.title || p.name, role: 'Founder', status: p.stage || 'Active', image: p.thumbnail || p.coverImage || '',
            }))))
            .catch(() => {});
    }, [user?.id, projectsEnabled]);

    // ─── Photos ──────────────────────────────────────────────────────────────

    const pickAvatar = (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) setCropImage({ src: URL.createObjectURL(file) });
    };

    const cropDone = async (croppedFile) => {
        URL.revokeObjectURL(cropImage.src);
        setCropImage(null);
        setUploadingAvatar(true);
        setError('');
        try {
            const result = await mediaService.uploadFile(croppedFile);
            set('avatar', result.url);
        } catch (err) {
            console.error('avatar upload error:', err);
            setError(t('profileForm.errors.uploadAvatar'));
        } finally {
            setUploadingAvatar(false);
        }
    };

    const cropCancel = () => {
        if (cropImage) URL.revokeObjectURL(cropImage.src);
        setCropImage(null);
    };

    // The cover: positioned (the profile shows what's in the outline), then
    // uploaded whole; the one there can be positioned again.
    const banner = useCoverFramer(COVER_ASPECT.banner, async ({ file, frame }) => {
        if (!file) { set('coverFrame', frame); return; }
        setUploadingBanner(true);
        setError('');
        try {
            const result = await mediaService.uploadFile(file);
            setForm((prev) => ({ ...prev, banner: result.url, coverFrame: frame }));
        } catch (err) {
            console.error('banner upload error:', err);
            setError(t('profileForm.errors.uploadCover'));
        } finally {
            setUploadingBanner(false);
        }
    });

    // ─── Roles, links, experience ────────────────────────────────────────────

    const setRole = (i, field, value) => setForm((prev) => ({ ...prev, roles: prev.roles.map((r, j) => (j === i ? { ...r, [field]: value } : r)) }));
    const addRole = () => setForm((prev) => ({ ...prev, roles: [...prev.roles, EMPTY_ROLE] }));
    const removeRole = (i) => setForm((prev) => ({ ...prev, roles: prev.roles.filter((_, j) => j !== i) }));

    const setLink = (i, field, value) => setForm((prev) => ({ ...prev, customLinks: prev.customLinks.map((l, j) => (j === i ? { ...l, [field]: value } : l)) }));
    const addLink = () => setForm((prev) => ({ ...prev, customLinks: [...prev.customLinks, { label: '', url: '' }] }));
    const removeLink = (i) => setForm((prev) => ({ ...prev, customLinks: prev.customLinks.filter((_, j) => j !== i) }));

    const currentYear = new Date().getFullYear();
    const years = [];
    for (let y = currentYear; y >= 1970; y--) years.push(y);
    const setExp = (i, field, value) => setForm((prev) => ({ ...prev, experience: prev.experience.map((e, j) => (j === i ? { ...e, [field]: value } : e)) }));
    const addExp = () => setForm((prev) => ({ ...prev, experience: [...prev.experience, { title: '', company: '', fromYear: '', toYear: '', description: '' }] }));
    const removeExp = (i) => setForm((prev) => ({ ...prev, experience: prev.experience.filter((_, j) => j !== i) }));

    // ─── Working on ──────────────────────────────────────────────────────────

    const addProject = (project) => {
        if (!form.biesProjects.some((p) => p.id === project.id)) {
            set('biesProjects', [...form.biesProjects, {
                id: project.id,
                name: project.name,
                role: str(newProjectRole) || project.role || 'Contributor',
                status: project.status || 'Active',
                image: project.image || project.coverImage || '',
            }]);
        }
        setProjectSearch('');
        setNewProjectRole('');
        setShowProjectDropdown(false);
    };
    const removeProject = (id) => set('biesProjects', form.biesProjects.filter((p) => p.id !== id));

    // ─── Custom sections ─────────────────────────────────────────────────────

    const addSection = (type) => setForm((prev) => ({
        ...prev,
        customSections: [...prev.customSections, type === 'TEXT'
            ? { title: '', type: 'TEXT', placement: 'LEFT', body: '' }
            : { title: '', type: 'CAROUSEL', placement: 'LEFT', images: [] }],
    }));
    const updateSection = (i, patch) => setForm((prev) => ({ ...prev, customSections: prev.customSections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
    const removeSection = (i) => {
        setConfirmRemove(null);
        setForm((prev) => ({ ...prev, customSections: prev.customSections.filter((_, j) => j !== i) }));
    };
    const askRemoveSection = (i) => (sectionHasContent(form.customSections[i]) ? setConfirmRemove(i) : removeSection(i));
    const { draggingIdx, getSectionDragProps } = useSectionDrag((from, to) => setForm((prev) => ({ ...prev, customSections: reorderArray(prev.customSections, from, to) })));

    const addSectionPhotos = async (i, files) => {
        const list = [...(files || [])].filter(Boolean);
        if (!list.length) return;
        setUploadingSection(i);
        setError('');
        try {
            for (const file of list) {
                const result = await uploadApi.media(file);
                setForm((prev) => ({
                    ...prev,
                    customSections: prev.customSections.map((s, j) => (j === i ? withPhotos(s, [...photosOf(s), result.url]) : s)),
                }));
            }
        } catch {
            setError(t('profileForm.errors.uploadSection'));
        } finally {
            setUploadingSection(null);
        }
    };
    const removeSectionPhoto = (i, k) => setForm((prev) => ({
        ...prev,
        customSections: prev.customSections.map((s, j) => (j === i ? withPhotos(s, photosOf(s).filter((_, n) => n !== k)) : s)),
    }));

    const setPoint = (i, k, field, value) => {
        const section = form.customSections[i];
        updateSection(i, { dataPoints: (section.dataPoints || []).map((p, n) => (n === k ? { ...p, [field]: value } : p)) });
    };

    // ─── Saving ──────────────────────────────────────────────────────────────

    const strength = profileStrength(form);

    // "Next: add …" opens that part of the form.
    const goTo = (step) => {
        if (step === 'links' || step === 'experience') {
            setOn((prev) => ({ ...prev, [step]: true }));
            if (step === 'experience' && !form.experience.length) addExp();
        }
        setTimeout(() => {
            const el = fieldRefs.current[step];
            if (!el) return;
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (/INPUT|TEXTAREA/.test(el.tagName)) el.focus({ preventScroll: true });
        }, 80);
    };

    const handleSave = async () => {
        setError('');
        setFieldError(null);
        const firstName = str(form.firstName);
        if (!firstName) {
            setFieldError({ id: 'pf-first', message: t('profileForm.firstNameRequired') });
            fieldRefs.current.firstName?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        setSaving(true);

        const name = joinName(firstName, form.lastName);
        const roles = form.roles.map((r) => ({ title: str(r.title), company: str(r.company) })).filter((r) => r.title || r.company);
        const website = asWebLink(form.website);
        const customLinks = form.customLinks
            .map((l) => ({ label: str(l.label), url: asWebLink(l.url) }))
            .filter((l) => l.url);
        const experience = form.experience
            .filter((e) => str(e.title) || str(e.company) || str(e.description))
            .map((e) => ({
                title: str(e.title), company: str(e.company), description: str(e.description),
                date: e.fromYear || e.toYear ? `${e.fromYear || ''} - ${e.toYear || 'Present'}` : '',
            }));
        const saved = { ...form, website, customLinks, experience };
        // Off with something in it: hidden, and kept. Off and empty: nothing to hide.
        const hiddenSections = ['links', 'projects', 'custom', 'tags'].filter((s) => !on[s] && sectionFilled(s, saved, walletFields));
        const showExperience = on.experience || !sectionFilled('experience', saved, walletFields);

        try {
            const payload = {
                firstName,
                lastName: str(form.lastName),
                // The name, title and company too, for a server from before first and last names and roles.
                name,
                roles,
                title: roles[0]?.title || '',
                company: roles[0]?.company || '',
                location: str(form.location),
                bio: form.bio,
                website,
                twitter: str(form.twitter),
                linkedin: str(form.linkedin),
                instagram: str(form.instagram),
                customLinks,
                avatar: form.avatar || undefined,
                banner: form.banner || undefined,
                coverFrame: form.banner ? form.coverFrame : '',
                tags: form.tags,
                experience,
                biesProjects: form.biesProjects,
                customSections: form.customSections,
                showExperience,
                hiddenSections,
                lightningAddress: walletFields ? str(form.lightningAddress) : undefined,
                bolt12Offer: walletFields ? str(form.bolt12Offer) : undefined,
            };
            Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
            const result = await profilesApi.update(payload);

            // Email accounts skip this: the server publishes their kind:0 when the
            // profile is saved, and a second, different kind:0 would race it.
            if (keyIsMembers()) {
                try {
                    const nostrData = { display_name: name, name: form.nostrName || name };
                    if (form.bio) nostrData.about = form.bio;
                    if (form.avatar) nostrData.picture = form.avatar;
                    if (form.banner) nostrData.banner = form.banner;
                    // Links as Settings → Privacy allows, and only while Links & Social is on.
                    const privacy = await settingsApi.getPrivacy().catch(() => null);
                    Object.assign(nostrData, on.links
                        ? nostrLinkFields({ ...form, website }, privacy)
                        : { ...nostrLinkFields({ nip05Name: form.nip05Name }, privacy), website: '', lud16: '', lud06: '', bolt12: '' });
                    await nostrService.updateProfileToBiesRelay(nostrData);
                } catch (nostrErr) {
                    console.error('Relay profile sync failed (non-blocking):', nostrErr);
                }
                // A public profile the member published (Settings → Nostr) follows
                // when something on it changed. Not where each signature is an app switch.
                if (result?.publicNostrStale && nostrSigner.canSignSilently) {
                    followUpPublicProfile().catch((err) => console.error('Public profile sync failed (non-blocking):', err));
                }
            }

            await refreshUser();
            navigate('/profile');
        } catch (err) {
            console.error('Save profile error:', err);
            setError(objectionableMessage(t, err) || (err.data?.details ? fieldErrorText(t, err.data.details) : '') || err.message || t('profileForm.errors.save'));
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } finally {
            setSaving(false);
        }
    };

    // ─── Render ──────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
                <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-gray-500)' }} />
            </div>
        );
    }

    const avatar = form.avatar || nostrProfile?.picture || '';
    const nostrBanner = !form.banner && nostrProfile?.banner ? nostrProfile.banner : '';
    const saveLabel = saving ? t('profileForm.saving') : t('profileForm.save');

    const sectionBody = {
        links: (
            <>
                <div className="pf-group">
                    <label className="pf-label" htmlFor="pf-website">{t('profileForm.website')}</label>
                    <div className="pf-icon-input">
                        <Globe size={17} aria-hidden="true" />
                        <input id="pf-website" ref={(el) => { fieldRefs.current.links = el; }} type="text" inputMode="url" autoCapitalize="none" className="pf-input" value={form.website} onChange={change('website')} placeholder={t('profileForm.websitePlaceholder')} maxLength={2000} />
                    </div>
                </div>
                <div className="pf-group">
                    <label className="pf-label" htmlFor="pf-instagram">Instagram</label>
                    <div className="pf-icon-input">
                        <Instagram size={17} aria-hidden="true" />
                        <input id="pf-instagram" type="text" className="pf-input" value={form.instagram} onChange={change('instagram')} placeholder="@handle" maxLength={200} autoCapitalize="none" />
                    </div>
                </div>
                <div className="pf-group">
                    <label className="pf-label" htmlFor="pf-x">X</label>
                    <div className="pf-icon-input">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                        <input id="pf-x" type="text" className="pf-input" value={form.twitter} onChange={change('twitter')} placeholder="@handle" maxLength={200} autoCapitalize="none" />
                    </div>
                </div>
                <div className="pf-group">
                    <label className="pf-label" htmlFor="pf-linkedin">LinkedIn</label>
                    <div className="pf-icon-input">
                        <Linkedin size={17} aria-hidden="true" />
                        <input id="pf-linkedin" type="text" inputMode="url" className="pf-input" value={form.linkedin} onChange={change('linkedin')} placeholder="linkedin.com/in/…" maxLength={2000} autoCapitalize="none" />
                    </div>
                </div>
                <div className="pf-group">
                    <span className="pf-label">{t('profileForm.otherLinks')} <span className="pf-label-note">{t('profileForm.otherLinksNote')}</span></span>
                    {form.customLinks.map((link, i) => (
                        <div key={i} className="pf-link-row">
                            <input type="text" className="pf-input" value={link.label} onChange={(e) => setLink(i, 'label', e.target.value)} placeholder={t('profileForm.linkLabel')} maxLength={40} aria-label={t('profileForm.linkLabel')} />
                            <input type="text" inputMode="url" className="pf-input" value={link.url} onChange={(e) => setLink(i, 'url', e.target.value)} placeholder="https://" maxLength={2000} autoCapitalize="none" aria-label={t('profileForm.linkUrl')} />
                            <button type="button" className="x-remove pf-x" onClick={() => removeLink(i)} aria-label={t('profileForm.removeLink')}><X size={15} /></button>
                        </div>
                    ))}
                    {form.customLinks.length < MAX_CUSTOM_LINKS && (
                        <button type="button" className="pf-add-link" onClick={addLink}><Plus size={16} /> {t('profileForm.addLink')}</button>
                    )}
                </div>
                {walletFields && (
                    <>
                        <div className="pf-group">
                            <label className="pf-label" htmlFor="pf-ln">{t('profileForm.lightning')}</label>
                            <div className="pf-icon-input">
                                <Zap size={17} aria-hidden="true" />
                                <input id="pf-ln" type="text" className="pf-input" value={form.lightningAddress} onChange={change('lightningAddress')} placeholder="you@getalby.com" maxLength={320} autoCapitalize="none" />
                            </div>
                            <p className="pf-hint">{t('profileForm.lightningHint')}</p>
                        </div>
                        <div className="pf-group">
                            <label className="pf-label" htmlFor="pf-b12">{t('profileForm.bolt12')}</label>
                            <div className="pf-icon-input">
                                <Zap size={17} aria-hidden="true" />
                                <input id="pf-b12" type="text" className="pf-input" value={form.bolt12Offer} onChange={change('bolt12Offer')} placeholder="lno1…" maxLength={2000} autoCapitalize="none" />
                            </div>
                            <p className="pf-hint">{t('profileForm.bolt12Hint')}</p>
                        </div>
                    </>
                )}
            </>
        ),
        experience: (
            <>
                {form.experience.map((exp, i) => (
                    <div key={i} className="pf-box">
                        <button type="button" className="x-remove pf-x pf-box-x" onClick={() => removeExp(i)} aria-label={t('profileForm.removeExperience')}><X size={15} /></button>
                        <div className="pf-group pf-box-first">
                            <label className="pf-label-sm" htmlFor={`pf-exp-title-${i}`}>{t('profileForm.role')}</label>
                            <input id={`pf-exp-title-${i}`} ref={i === 0 ? (el) => { fieldRefs.current.experience = el; } : undefined} type="text" className="pf-input" value={exp.title} onChange={(e) => setExp(i, 'title', e.target.value)} maxLength={200} />
                        </div>
                        <div className="pf-group">
                            <label className="pf-label-sm" htmlFor={`pf-exp-co-${i}`}>{t('profileForm.company')}</label>
                            <input id={`pf-exp-co-${i}`} type="text" className="pf-input" value={exp.company} onChange={(e) => setExp(i, 'company', e.target.value)} maxLength={200} />
                        </div>
                        <div className="pf-row pf-group">
                            <div>
                                <label className="pf-label-sm" htmlFor={`pf-exp-from-${i}`}>{t('profileForm.from')}</label>
                                <select id={`pf-exp-from-${i}`} className="pf-input" value={exp.fromYear || ''} onChange={(e) => setExp(i, 'fromYear', e.target.value)}>
                                    <option value="">—</option>
                                    {years.map((y) => <option key={y} value={y}>{y}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="pf-label-sm" htmlFor={`pf-exp-to-${i}`}>{t('profileForm.to')}</label>
                                <select id={`pf-exp-to-${i}`} className="pf-input" value={exp.toYear || ''} onChange={(e) => setExp(i, 'toYear', e.target.value)}>
                                    <option value="">{t('profileForm.present')}</option>
                                    {years.map((y) => <option key={y} value={y}>{y}</option>)}
                                </select>
                            </div>
                        </div>
                        <div className="pf-group">
                            <label className="pf-label-sm" htmlFor={`pf-exp-desc-${i}`}>{t('profileForm.whatYouDid')}</label>
                            <textarea id={`pf-exp-desc-${i}`} className="pf-input" rows={3} value={exp.description} onChange={(e) => setExp(i, 'description', e.target.value)} maxLength={10000} />
                        </div>
                    </div>
                ))}
                <button type="button" className="pf-dashed" onClick={addExp}><Plus size={16} /> {t('profileForm.addExperience')}</button>
            </>
        ),
        projects: (
            <>
                {autoProjects.length > 0 && (
                    <div className="pf-group">
                        <span className="pf-label">{t('profileForm.yourProjects')}</span>
                        <div className="pf-projects">
                            {autoProjects.map((project) => {
                                const added = form.biesProjects.some((p) => p.id === project.id);
                                return (
                                    <div key={project.id} className="pf-project">
                                        {project.image ? <img src={getAssetUrl(project.image)} alt="" /> : <span className="pf-project-ph">{project.name.charAt(0)}</span>}
                                        <span className="pf-project-name">{project.name}</span>
                                        {added
                                            ? <span className="pf-project-added">{t('profileForm.added')}</span>
                                            : <button type="button" className="pf-chip-btn" onClick={() => addProject({ ...project, coverImage: project.image })}>{t('profileForm.add')}</button>}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
                <div className="pf-group">
                    <label className="pf-label" htmlFor="pf-project-search">{t('profileForm.otherProjects')}</label>
                    <div ref={searchRef} className="pf-search">
                        <div className="pf-icon-input">
                            <Search size={17} aria-hidden="true" />
                            <input
                                id="pf-project-search" type="text" className="pf-input" value={projectSearch}
                                placeholder={t('profileForm.searchProjects')}
                                onChange={(e) => { setProjectSearch(e.target.value); setShowProjectDropdown(true); }}
                                onFocus={() => setShowProjectDropdown(true)}
                            />
                        </div>
                        {showProjectDropdown && projectSearch.trim() && (
                            <div className="pf-dropdown">
                                {projectResults.filter((p) => !form.biesProjects.some((bp) => bp.id === p.id)).map((project) => (
                                    <button key={project.id} type="button" className="pf-dropdown-item" onClick={() => addProject(project)}>
                                        {project.image && <img src={getAssetUrl(project.image)} alt="" />}
                                        <span>{project.name}</span>
                                    </button>
                                ))}
                                {projectResults.length === 0 && <div className="pf-dropdown-empty">{t('profileForm.noProjects')}</div>}
                            </div>
                        )}
                    </div>
                    <input type="text" className="pf-input pf-mt" value={newProjectRole} onChange={(e) => setNewProjectRole(e.target.value)} placeholder={t('profileForm.yourRolePlaceholder')} maxLength={200} aria-label={t('profileForm.yourRole')} />
                </div>
                {form.biesProjects.length > 0 && (
                    <div className="pf-projects">
                        {form.biesProjects.map((project) => (
                            <div key={project.id} className="pf-project">
                                {project.image ? <img src={getAssetUrl(project.image)} alt="" /> : <span className="pf-project-ph">{(project.name || '?').charAt(0)}</span>}
                                <span className="pf-project-name">{project.name}{project.role && <span className="pf-project-role"> · {project.role}</span>}</span>
                                <button type="button" className="x-remove pf-x" onClick={() => removeProject(project.id)} aria-label={t('profileForm.removeProject', { name: project.name })}><X size={15} /></button>
                            </div>
                        ))}
                    </div>
                )}
            </>
        ),
        custom: (
            <>
                <p className="pf-hint pf-hint-top">{t('profileForm.customHint')}</p>
                {form.customSections.map((section, i) => {
                    const type = section.type || 'TEXT';
                    const isPhotos = type === 'PHOTO' || type === 'CAROUSEL';
                    const photos = isPhotos ? photosOf(section) : [];
                    return (
                        <div
                            key={i}
                            {...getSectionDragProps(i)}
                            draggable={dragArmed === i}
                            onDragEnd={(e) => { getSectionDragProps(i).onDragEnd(e); setDragArmed(null); }}
                            className={`pf-box pf-custom${draggingIdx === i ? ' dragging' : ''}`}
                        >
                            <div className="pf-custom-head">
                                <span className="pf-grip" title={t('profileForm.dragHint')} onMouseDown={() => setDragArmed(i)} onMouseUp={() => setDragArmed(null)} onTouchStart={() => setDragArmed(i)}>
                                    <GripVertical size={16} aria-hidden="true" />
                                </span>
                                <span className="pf-custom-type">{t(`profileForm.types.${isPhotos ? 'photos' : type === 'GRAPH' ? 'chart' : 'text'}`)}</span>
                                {confirmRemove === i ? (
                                    <span className="pf-confirm" role="alert">
                                        <span>{t('profileForm.removeSectionAsk')}</span>
                                        <button type="button" className="pf-confirm-keep" onClick={() => setConfirmRemove(null)}>{t('profileForm.keep')}</button>
                                        <button type="button" className="pf-confirm-remove" onClick={() => removeSection(i)}>{t('profileForm.remove')}</button>
                                    </span>
                                ) : (
                                    <button type="button" className="pf-icon-btn" onClick={() => askRemoveSection(i)} aria-label={t('profileForm.removeSection')}><Trash2 size={16} /></button>
                                )}
                            </div>
                            <input type="text" className="pf-input pf-custom-title" value={section.title || ''} onChange={(e) => updateSection(i, { title: e.target.value })} placeholder={t('profileForm.sectionTitlePlaceholder')} maxLength={200} aria-label={t('profileForm.sectionTitle')} />
                            {type === 'TEXT' && (
                                <RichTextEditor value={section.body || section.content || ''} onChange={(val) => updateSection(i, { body: val })} placeholder={t('profileForm.bodyPlaceholder')} minHeight="90px" />
                            )}
                            {isPhotos && (
                                <div className="pf-photo-grid">
                                    {photos.map((url, k) => (
                                        <div key={`${url}-${k}`} className="pf-photo">
                                            <img src={getAssetUrl(url)} alt="" />
                                            <button type="button" className="x-remove pf-photo-x" onClick={() => removeSectionPhoto(i, k)} aria-label={t('profileForm.removePhoto')}><X size={15} /></button>
                                        </div>
                                    ))}
                                    <label className="pf-photo-add" style={{ cursor: uploadingSection === i ? 'default' : 'pointer' }}>
                                        {uploadingSection === i ? <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /> : <ImagePlus size={22} />}
                                        <span>{uploadingSection === i ? t('profileForm.uploading') : t('profileForm.addPhotos')}</span>
                                        <input type="file" accept="image/*" multiple className="pf-file" disabled={uploadingSection === i} onChange={(e) => { addSectionPhotos(i, e.target.files); e.target.value = ''; }} />
                                    </label>
                                </div>
                            )}
                            {type === 'GRAPH' && (
                                // Charts can't be added any more; one already there can still be edited.
                                <div className="pf-chart">
                                    <select className="pf-input" value={section.graphType || 'BAR'} onChange={(e) => updateSection(i, { graphType: e.target.value })} aria-label={t('profileForm.chart.type')}>
                                        <option value="BAR">{t('profileForm.chart.bar')}</option>
                                        <option value="LINE">{t('profileForm.chart.line')}</option>
                                        <option value="PIE">{t('profileForm.chart.pie')}</option>
                                    </select>
                                    {(section.dataPoints || []).map((point, k) => (
                                        <div key={k} className="pf-point">
                                            <input type="text" className="pf-input" value={point.label} onChange={(e) => setPoint(i, k, 'label', e.target.value)} placeholder={t('profileForm.chart.label')} maxLength={200} />
                                            <input type="number" className="pf-input" value={point.value} onChange={(e) => setPoint(i, k, 'value', e.target.value)} placeholder={t('profileForm.chart.value')} />
                                            <button type="button" className="x-remove pf-x" onClick={() => updateSection(i, { dataPoints: section.dataPoints.filter((_, n) => n !== k) })} aria-label={t('profileForm.chart.remove')}><X size={15} /></button>
                                        </div>
                                    ))}
                                    <button type="button" className="pf-add-link" onClick={() => updateSection(i, { dataPoints: [...(section.dataPoints || []), { label: '', value: '' }] })}><Plus size={16} /> {t('profileForm.chart.add')}</button>
                                </div>
                            )}
                        </div>
                    );
                })}
                <div className="pf-chips">
                    <button type="button" className="pf-chip-btn" onClick={() => addSection('TEXT')}><Plus size={15} /> {t('profileForm.types.text')}</button>
                    <button type="button" className="pf-chip-btn" onClick={() => addSection('PHOTOS')}><Plus size={15} /> {t('profileForm.types.photos')}</button>
                </div>
            </>
        ),
        tags: (
            <div className="pf-group">
                <TagInput tags={form.tags} onChange={(tags) => set('tags', tags)} placeholder={t('profileForm.tagsPlaceholder')} id="pf-tags" />
            </div>
        ),
    };

    return (
        <div className="profile-form-page">
            <div className="container">
                <div className="pf-content">
                    <div className="pf-header back-head">
                        <BackButton fallback="/profile" />
                        <h1 className="pf-title">{t('profileForm.title')}</h1>
                        <button type="button" className="pf-head-save" onClick={handleSave} disabled={saving}>{saveLabel}</button>
                    </div>

                    {error && <div className="pf-error-banner" role="alert"><AlertCircle size={16} /> {error}</div>}

                    {strength.next && (
                        <div className="pf-card pf-strength">
                            <span className="pf-ring" style={{ '--p': strength.percent }} aria-hidden="true"><b>{strength.percent}%</b></span>
                            <p>
                                <strong>{t('profileForm.strength', { percent: strength.percent })}</strong>
                                <button type="button" className="pf-next" onClick={() => goTo(strength.next)}>{t(`profileForm.next.${strength.next}`)}</button>
                            </p>
                        </div>
                    )}

                    {/* The photo and cover, as the profile shows them */}
                    <div className="pf-card pf-photos">
                        <div className="pf-cover" style={nostrBanner ? { background: `url(${getAssetUrl(nostrBanner)}) center/cover no-repeat` } : undefined}>
                            {form.banner && <CoverPhoto src={form.banner} frame={form.coverFrame} />}
                            {uploadingBanner && <div className="pf-cover-busy"><Loader2 size={26} style={{ animation: 'spin 1s linear infinite' }} /> {t('profileForm.uploading')}</div>}
                            <div className="pf-cover-tools">
                                <label className="pf-cover-btn">
                                    <Camera size={15} /> {t('profileForm.cover')}
                                    <input type="file" accept="image/*" className="pf-file" onChange={banner.choose} disabled={uploadingBanner} />
                                </label>
                                {form.banner && !uploadingBanner && (
                                    <button type="button" className="pf-cover-btn" onClick={() => banner.adjust(form.banner, form.coverFrame)}>
                                        <Move size={15} /> {t('coverPhoto.position')}
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className="pf-avatar-row">
                            <div ref={(el) => { fieldRefs.current.photo = el; }} className="pf-avatar">
                                {avatar ? <img src={getAssetUrl(avatar)} alt="" /> : <InitialAvatar name={form.firstName} />}
                                {uploadingAvatar && <span className="pf-avatar-busy"><Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /></span>}
                                <label className="pf-avatar-btn" aria-label={t('profileForm.changePhoto')}>
                                    <Camera size={15} />
                                    <input type="file" accept="image/*" className="pf-file" onChange={pickAvatar} />
                                </label>
                            </div>
                        </div>
                        <p className="pf-hint pf-photos-hint">{t('profileForm.photosHint')}</p>
                    </div>

                    {/* Basic info */}
                    <div className="pf-card">
                        <h3 className="pf-card-heading">{t('profileForm.basicInfo')}</h3>
                        <div className="pf-row pf-group">
                            <div>
                                <label className="pf-label" htmlFor="pf-first">{t('profileForm.firstName')} *</label>
                                <input
                                    id="pf-first" ref={(el) => { fieldRefs.current.firstName = el; }} type="text" className="pf-input"
                                    value={form.firstName} onChange={change('firstName')} maxLength={50} autoComplete="given-name"
                                    aria-invalid={fieldError?.id === 'pf-first' || undefined} aria-describedby={fieldError?.id === 'pf-first' ? 'pf-first-error' : undefined}
                                />
                                {fieldError?.id === 'pf-first' && <p className="pf-field-error" id="pf-first-error">{fieldError.message}</p>}
                            </div>
                            <div>
                                <label className="pf-label" htmlFor="pf-last">{t('profileForm.lastName')}</label>
                                <input id="pf-last" type="text" className="pf-input" value={form.lastName} onChange={change('lastName')} maxLength={50} autoComplete="family-name" />
                            </div>
                        </div>

                        <div className="pf-group">
                            <p className="pf-roles-head"><span className="pf-label">{t('profileForm.whatYouDo')}</span><small>{t('profileForm.firstShows')}</small></p>
                            {form.roles.map((role, i) => (
                                <div key={i} className={`pf-pair${i > 0 ? ' has-x' : ''}`}>
                                    {i > 0 && <button type="button" className="x-remove pf-x pf-pair-x" onClick={() => removeRole(i)} aria-label={t('profileForm.removeRole')}><X size={15} /></button>}
                                    <GrowingField
                                        className="pf-pair-role" value={role.title} onChange={(v) => setRole(i, 'title', v)} maxLength={200}
                                        placeholder={t('profileForm.rolePlaceholder')} aria-label={t('profileForm.role')}
                                        inputRef={i === 0 ? (el) => { fieldRefs.current.role = el; } : undefined}
                                    />
                                    <GrowingField
                                        className="pf-pair-co" value={role.company} onChange={(v) => setRole(i, 'company', v)} maxLength={200}
                                        placeholder={t('profileForm.companyPlaceholder')} aria-label={t('profileForm.company')}
                                    />
                                </div>
                            ))}
                            {form.roles.length < MAX_ROLES && (
                                <button type="button" className="pf-add-link" onClick={addRole}><Plus size={16} /> {t('profileForm.addRole')}</button>
                            )}
                        </div>

                        <div className="pf-group">
                            <label className="pf-label" htmlFor="pf-location">{t('profileForm.location')}</label>
                            <div className="pf-icon-input">
                                <MapPin size={17} aria-hidden="true" />
                                <input id="pf-location" ref={(el) => { fieldRefs.current.location = el; }} type="text" className="pf-input" value={form.location} onChange={change('location')} placeholder={t('profileForm.locationPlaceholder')} maxLength={200} />
                            </div>
                        </div>

                        <div className="pf-group pf-last">
                            <label className="pf-label" htmlFor="pf-about">{t('profileForm.about')}</label>
                            <textarea id="pf-about" ref={(el) => { fieldRefs.current.about = el; }} className="pf-input" rows={4} value={form.bio} onChange={change('bio')} placeholder={t('profileForm.aboutPlaceholder')} maxLength={10000} />
                            <p className="pf-hint">{t('profileForm.aboutHint')}</p>
                        </div>
                    </div>

                    {/* The extra sections, each with its switch */}
                    {SECTIONS.filter((s) => s !== 'projects' || projectsEnabled).map((s) => {
                        const { Icon, tone } = SECTION_LOOK[s];
                        const title = t(`profileForm.sections.${s}.title`);
                        return (
                            <div key={s} className="pf-card pf-section" data-section={s}>
                                <div className="pf-section-head">
                                    <span className={`pf-section-icon tone-${tone}`} aria-hidden="true"><Icon size={18} /></span>
                                    <span className="pf-section-text">
                                        <h3 className="pf-section-title">{title}</h3>
                                        <span className="pf-section-sub">{t(`profileForm.sections.${s}.sub`)}</span>
                                    </span>
                                    <Switch checked={on[s]} onChange={(v) => setOn((prev) => ({ ...prev, [s]: v }))} label={t('profileForm.showOnProfile', { section: title })} />
                                </div>
                                {on[s] && <div className="pf-section-body">{sectionBody[s]}</div>}
                            </div>
                        );
                    })}
                    <p className="pf-hint pf-off-hint">{t('profileForm.offHint')}</p>

                    <div className="pf-actions">
                        <button type="button" className="btn btn-outline" onClick={() => navigate(-1)} disabled={saving}>{t('common.cancel')}</button>
                        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
                            {saving && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', marginRight: 6, verticalAlign: '-3px' }} />}
                            {saveLabel}
                        </button>
                    </div>
                </div>
            </div>

            {banner.framer}
            {cropImage && <ImageCropModal imageSrc={cropImage.src} aspect={1} shape="round" onCrop={cropDone} onCancel={cropCancel} />}
            <FormStyles />
        </div>
    );
};

// Global, under the page's class: some parts are other components (styled-jsx scoping doesn't reach them).
const FormStyles = () => (
    <style jsx global>{`
        .profile-form-page { padding-top: var(--page-top, 1.5rem); padding-bottom: 4rem; }
        .profile-form-page .pf-content { max-width: 760px; margin: 0 auto; }
        .profile-form-page .pf-header { margin-bottom: 1.25rem; }
        .profile-form-page .pf-title { flex: 1; font-size: 1.6rem; font-weight: 700; color: var(--color-gray-900); }
        .profile-form-page .pf-head-save {
            flex: none; min-height: 0; height: 36px; padding: 0 18px; border: none; border-radius: var(--radius-full);
            background: var(--color-primary); color: white; font-weight: 700; font-size: 0.9rem; cursor: pointer;
        }
        .profile-form-page .pf-head-save:disabled { opacity: 0.6; cursor: default; }
        .profile-form-page .pf-error-banner {
            display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1rem; margin-bottom: 1.25rem;
            background: var(--color-red-tint); color: var(--color-error, #B91C1C); border-radius: var(--radius-md); font-size: 0.9rem;
        }
        .profile-form-page .pf-card {
            background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: var(--radius-lg);
            box-shadow: var(--shadow-sm); padding: 1.5rem; margin-bottom: 1.25rem; min-width: 0;
        }
        .profile-form-page .pf-card-heading {
            font-size: 1.15rem; font-weight: 700; margin: 0 0 1.25rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--color-gray-200);
        }
        .profile-form-page .pf-group { margin-bottom: 1.1rem; position: relative; min-width: 0; }
        .profile-form-page .pf-group:last-child, .profile-form-page .pf-last { margin-bottom: 0; }
        .profile-form-page .pf-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.75rem; }
        .profile-form-page .pf-label { display: block; font-size: 0.85rem; font-weight: 600; color: var(--color-gray-700); margin-bottom: 0.4rem; }
        .profile-form-page .pf-label-note { font-weight: 500; color: var(--color-gray-500); }
        .profile-form-page .pf-label-sm { display: block; font-size: 0.78rem; font-weight: 600; color: var(--color-gray-500); margin-bottom: 0.3rem; }
        .profile-form-page .pf-input {
            width: 100%; padding: 0.65rem 0.9rem; border: 1px solid var(--color-gray-300); background: var(--color-surface); color: inherit;
            border-radius: var(--radius-md); outline: none; font-size: 0.95rem; font-family: inherit; box-sizing: border-box;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        .profile-form-page .pf-input:focus { border-color: var(--color-primary); box-shadow: 0 0 0 3px rgba(0, 82, 204, 0.1); }
        .profile-form-page .pf-input[aria-invalid="true"] { border-color: #b91c1c; }
        .profile-form-page textarea.pf-input { resize: vertical; line-height: 1.45; }
        .profile-form-page select.pf-input { appearance: auto; cursor: pointer; }
        .profile-form-page .pf-mt { margin-top: 0.5rem; }
        .profile-form-page .pf-hint { margin: 0.4rem 0 0; font-size: 0.78rem; line-height: 1.45; color: var(--color-gray-500); }
        .profile-form-page .pf-hint-top { margin: 0 0 0.9rem; }
        .profile-form-page .pf-field-error { margin: 0.4rem 0 0; font-size: 0.82rem; font-weight: 600; color: #b91c1c; }
        .profile-form-page .pf-icon-input { position: relative; }
        .profile-form-page .pf-icon-input > svg { position: absolute; left: 0.8rem; top: 50%; transform: translateY(-50%); color: var(--color-gray-400); pointer-events: none; }
        .profile-form-page .pf-icon-input .pf-input { padding-left: 2.4rem; }
        .profile-form-page .pf-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
        .profile-form-page .pf-x { width: 28px; height: 28px; border: none; background: var(--color-gray-100); color: var(--color-gray-600); cursor: pointer; }

        /* Profile strength */
        .profile-form-page .pf-strength { display: flex; align-items: center; gap: 0.9rem; padding: 1rem 1.25rem; }
        .profile-form-page .pf-ring {
            --p: 0; flex: none; width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
            background: conic-gradient(var(--color-primary) calc(var(--p) * 1%), var(--color-gray-200) 0);
        }
        .profile-form-page .pf-ring b {
            width: 38px; height: 38px; border-radius: 50%; background: var(--color-surface); color: var(--color-primary);
            display: flex; align-items: center; justify-content: center; font-size: 0.75rem;
        }
        .profile-form-page .pf-strength p { margin: 0; font-size: 0.92rem; line-height: 1.4; min-width: 0; }
        .profile-form-page .pf-strength strong { display: block; color: var(--color-gray-900); }
        .profile-form-page .pf-next {
            display: inline; min-height: 0; padding: 0; border: none; background: none; text-align: left; font: inherit;
            color: var(--color-gray-500); font-size: 0.85rem; cursor: pointer; text-decoration: underline; text-decoration-color: var(--color-gray-300);
        }

        /* Photo and cover */
        .profile-form-page .pf-card.pf-photos { padding: 0; overflow: hidden; }
        .profile-form-page .pf-cover { position: relative; height: 150px; background: linear-gradient(135deg, #0047AB, #0a192f); overflow: hidden; }
        .profile-form-page .pf-cover-busy {
            position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; gap: 0.5rem;
            background: rgba(0, 0, 0, 0.45); color: white; font-weight: 600; font-size: 0.85rem;
        }
        .profile-form-page .pf-cover-tools { position: absolute; top: 0.75rem; left: 0.75rem; z-index: 3; display: flex; gap: 0.4rem; }
        .profile-form-page .pf-cover-btn {
            position: relative; display: inline-flex; align-items: center; gap: 0.4rem; height: 34px; min-height: 0; padding: 0 12px;
            border: none; border-radius: var(--radius-md); background: #ffffff; color: #0f172a; font-weight: 600; font-size: 0.82rem;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18); cursor: pointer;
        }
        .profile-form-page .pf-avatar-row { position: relative; height: 56px; }
        .profile-form-page .pf-avatar {
            position: absolute; left: 1.25rem; top: -48px; width: 96px; height: 96px; border-radius: 50%;
            border: 4px solid var(--color-surface); background: var(--color-gray-100); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
        }
        .profile-form-page .pf-avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
        .profile-form-page .pf-avatar-busy {
            position: absolute; inset: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center;
            background: rgba(255, 255, 255, 0.7); color: var(--color-primary);
        }
        .profile-form-page .pf-avatar-btn {
            position: absolute; right: -4px; bottom: -4px; width: 32px; height: 32px; border-radius: 50%;
            background: #ffffff; color: #334155; border: 1px solid var(--color-gray-200); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
            display: flex; align-items: center; justify-content: center; cursor: pointer;
        }
        .profile-form-page .pf-photos-hint { margin: 0; padding: 0 1.25rem 1rem; }

        /* What you do: one box per role, the role over the company */
        .profile-form-page .pf-roles-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; margin: 0 0 0.4rem; }
        .profile-form-page .pf-roles-head .pf-label { margin: 0; }
        .profile-form-page .pf-roles-head small { font-size: 0.78rem; color: var(--color-gray-500); }
        .profile-form-page .pf-pair {
            position: relative; border: 1px solid var(--color-gray-300); border-radius: var(--radius-md); background: var(--color-surface);
            margin-bottom: 0.5rem; transition: border-color 0.2s, box-shadow 0.2s;
        }
        .profile-form-page .pf-pair:focus-within { border-color: var(--color-primary); box-shadow: 0 0 0 3px rgba(0, 82, 204, 0.1); }
        .profile-form-page .pf-pair textarea {
            display: block; width: 100%; margin: 0; border: 0; background: transparent; resize: none; overflow: hidden; outline: none;
            font: inherit; font-size: 0.95rem; line-height: 1.35; color: inherit; padding: 0.65rem 0.9rem; box-sizing: border-box;
        }
        .profile-form-page .pf-pair textarea::placeholder { font-weight: 400; }
        .profile-form-page .pf-pair .pf-pair-role { font-weight: 600; }
        .profile-form-page .pf-pair .pf-pair-co { border-top: 1px solid var(--color-gray-200); color: var(--color-gray-700); }
        .profile-form-page .pf-pair.has-x .pf-pair-role { padding-right: 2.8rem; }
        .profile-form-page .pf-pair-x { position: absolute; top: 6px; right: 6px; z-index: 1; }
        .profile-form-page .pf-add-link {
            display: inline-flex; align-items: center; gap: 0.35rem; min-height: 0; padding: 0.35rem 0; border: none; background: none;
            color: var(--color-primary); font-weight: 700; font-size: 0.9rem; cursor: pointer;
        }

        /* Sections with a switch */
        .profile-form-page .pf-section { padding: 1.1rem 1.25rem; }
        .profile-form-page .pf-section-head { display: flex; align-items: center; gap: 0.75rem; }
        .profile-form-page .pf-section-icon { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex: none; }
        .profile-form-page .tone-blue { background: var(--color-blue-tint); color: var(--color-primary); }
        .profile-form-page .tone-orange { background: var(--color-orange-tint); color: var(--color-orange-text, #C2410C); }
        .profile-form-page .tone-green { background: rgba(16, 185, 129, 0.12); color: #047857; }
        .profile-form-page .tone-purple { background: rgba(124, 58, 237, 0.1); color: #6D28D9; }
        .profile-form-page .tone-gray { background: var(--color-gray-100); color: var(--color-gray-600); }
        .profile-form-page .pf-section-text { flex: 1; min-width: 0; }
        .profile-form-page .pf-section-title { font-size: 1.15rem; font-weight: 700; margin: 0; line-height: 1.15; }
        .profile-form-page .pf-section-sub { display: block; margin-top: 2px; font-size: 0.8rem; line-height: 1.35; color: var(--color-gray-500); }
        .profile-form-page .pf-section-body { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--color-gray-200); }
        .profile-form-page .pf-off-hint { margin: -0.5rem 0.25rem 1.25rem; }

        .profile-form-page .pf-link-row { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.6fr) 28px; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
        .profile-form-page .pf-box {
            position: relative; padding: 0.9rem; border: 1px solid var(--color-gray-200); border-radius: var(--radius-md);
            background: var(--color-gray-50); margin-bottom: 0.75rem;
        }
        .profile-form-page .pf-box-x { position: absolute; top: 8px; right: 8px; z-index: 1; }
        .profile-form-page .pf-box .pf-group { margin-bottom: 0.75rem; }
        .profile-form-page .pf-box .pf-group:last-child { margin-bottom: 0; }
        .profile-form-page .pf-box-first { padding-right: 2.25rem; }
        .profile-form-page .pf-dashed {
            width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.35rem; padding: 0.7rem;
            border: 1.5px dashed var(--color-gray-300); border-radius: var(--radius-md); background: none;
            color: var(--color-gray-600); font-weight: 600; font-size: 0.9rem; cursor: pointer;
        }

        .profile-form-page .pf-projects { display: flex; flex-direction: column; gap: 0.5rem; }
        .profile-form-page .pf-project {
            display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 0.7rem; border: 1px solid var(--color-gray-200);
            border-radius: var(--radius-md); background: var(--color-surface); min-width: 0;
        }
        .profile-form-page .pf-project img, .profile-form-page .pf-project-ph {
            width: 34px; height: 34px; border-radius: 8px; object-fit: cover; flex: none; background: var(--color-gray-100);
            display: flex; align-items: center; justify-content: center; font-weight: 700; color: var(--color-gray-500);
        }
        .profile-form-page .pf-project-name { flex: 1; min-width: 0; font-weight: 600; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .profile-form-page .pf-project-role { font-weight: 500; color: var(--color-gray-500); }
        .profile-form-page .pf-project-added { font-size: 0.8rem; font-weight: 700; color: var(--color-primary); }
        .profile-form-page .pf-search { position: relative; }
        .profile-form-page .pf-dropdown {
            position: absolute; z-index: 20; left: 0; right: 0; margin-top: 0.35rem; max-height: 220px; overflow-y: auto;
            background: var(--color-surface); border: 1px solid var(--color-gray-200); border-radius: var(--radius-md); box-shadow: 0 8px 20px rgba(0, 0, 0, 0.1);
        }
        .profile-form-page .pf-dropdown-item {
            width: 100%; display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.8rem; border: none; background: none;
            text-align: left; color: inherit; font-size: 0.9rem; cursor: pointer;
        }
        .profile-form-page .pf-dropdown-item img { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; }
        .profile-form-page .pf-dropdown-empty { padding: 0.9rem; text-align: center; color: var(--color-gray-500); font-size: 0.85rem; }

        .profile-form-page .pf-chips { display: flex; flex-wrap: wrap; gap: 8px; }
        .profile-form-page .pf-chip-btn {
            display: inline-flex; align-items: center; gap: 0.3rem; flex: none; min-height: 0; padding: 0.45rem 0.9rem;
            border-radius: var(--radius-full); border: 1px solid var(--color-gray-300); background: var(--color-surface);
            color: var(--color-gray-700); font-size: 0.88rem; font-weight: 600; cursor: pointer;
        }
        .profile-form-page .pf-custom.dragging { opacity: 0.5; }
        .profile-form-page .pf-custom-head { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.6rem; }
        .profile-form-page .pf-grip { color: var(--color-gray-400); cursor: grab; flex: none; display: inline-flex; padding: 4px 2px; }
        .profile-form-page .pf-confirm { display: inline-flex; align-items: center; gap: 6px; font-size: 0.82rem; font-weight: 600; color: var(--color-gray-700); }
        .profile-form-page .pf-confirm button { min-height: 0; height: 30px; padding: 0 12px; border-radius: var(--radius-full); font-size: 0.82rem; font-weight: 700; cursor: pointer; }
        .profile-form-page .pf-confirm-keep { border: 1px solid var(--color-gray-300); background: var(--color-surface); color: var(--color-gray-700); }
        .profile-form-page .pf-confirm-remove { border: none; background: #b91c1c; color: white; }
        .profile-form-page .pf-custom-type { flex: 1; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-gray-500); }
        .profile-form-page .pf-icon-btn {
            width: 32px; height: 32px; min-height: 0; padding: 0; border: none; border-radius: 50%; background: none;
            color: var(--color-gray-500); display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
        }
        .profile-form-page .pf-custom-title { font-weight: 700; margin-bottom: 0.6rem; }
        .profile-form-page .pf-photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 0.5rem; }
        .profile-form-page .pf-photo, .profile-form-page .pf-photo-add { position: relative; aspect-ratio: 4 / 3; border-radius: 10px; overflow: hidden; }
        .profile-form-page .pf-photo { background: var(--color-gray-100); }
        .profile-form-page .pf-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .profile-form-page .pf-photo-x { position: absolute; top: 4px; right: 4px; width: 30px; height: 30px; border: none; background: rgba(0, 0, 0, 0.6); color: white; cursor: pointer; }
        .profile-form-page .pf-photo-add {
            border: 1.5px dashed var(--color-gray-300); display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 4px; color: var(--color-gray-500); font-size: 0.78rem; font-weight: 600; text-align: center; padding: 0.25rem;
        }
        .profile-form-page .pf-chart { display: flex; flex-direction: column; gap: 0.5rem; }
        .profile-form-page .pf-point { display: grid; grid-template-columns: minmax(0, 1fr) 90px 28px; gap: 0.5rem; align-items: center; }

        .profile-form-page .pf-actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 0.5rem; }

        @media (max-width: 560px) {
            .profile-form-page .pf-card { padding: 1.15rem; }
            .profile-form-page .pf-section { padding: 1rem 1.1rem; }
            .profile-form-page .pf-strength { padding: 0.9rem 1.1rem; }
            .profile-form-page .pf-cover { height: 128px; }
            .profile-form-page .pf-avatar { width: 88px; height: 88px; top: -44px; left: 1.1rem; }
            .profile-form-page .pf-avatar-row { height: 52px; }
            .profile-form-page .pf-photos-hint { padding: 0 1.1rem 0.9rem; }
            .profile-form-page .pf-title { font-size: 1.45rem; }
            .profile-form-page .pf-link-row { grid-template-columns: minmax(0, 0.75fr) minmax(0, 1.4fr) 28px; }
        }
    `}</style>
);

export default ProfileEdit;
