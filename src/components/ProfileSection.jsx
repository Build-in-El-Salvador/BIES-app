import TranslatableText from './TranslatableText';
import { getAssetUrl } from '../utils/assets';
import { useLightbox } from '../context/LightboxContext';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Label } from 'recharts';

const PIE_COLORS = ['#0052cc', '#16a34a', '#7c3aed', '#ea580c', '#dc2626', '#0891b2', '#ca8a04', '#be185d'];

/**
 * A section's photos as small thumbnails; tapped, they open full size and
 * can be swiped through (the lightbox). One photo (PHOTO) or several (CAROUSEL).
 */
const SectionPhotos = ({ section }) => {
    const lightbox = useLightbox();
    const urls = (section.type === 'PHOTO' ? [section.imageUrl] : section.images || []).filter(Boolean).map(getAssetUrl);
    if (!urls.length) return null;
    return (
        <div className="ps-photos">
            {urls.map((src, i) => (
                <button key={`${src}-${i}`} type="button" className="ps-photo" onClick={() => lightbox?.open(src, urls)} aria-label={section.title || undefined}>
                    <img src={src} alt="" loading="lazy" />
                </button>
            ))}
            <style>{`
                .ps-photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; max-width: 520px; }
                .ps-photo { padding: 0; min-height: 0; border: none; border-radius: 8px; aspect-ratio: 1; overflow: hidden; background: var(--color-gray-100); cursor: zoom-in; }
                .ps-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
            `}</style>
        </div>
    );
};

const ProfileSection = ({ section, isSidebar }) => {
    const stype = section.type || 'TEXT';
    return (
        <div style={{ background: 'var(--color-surface, white)', border: '1px solid var(--color-gray-200, #e5e7eb)', borderRadius: '12px', padding: isSidebar ? '1.25rem' : '1.75rem', marginBottom: '1.5rem' }}>
            {stype === 'TEXT' ? (
                <TranslatableText
                    title={section.title}
                    titleTag="h3"
                    titleStyle={{ fontSize: isSidebar ? '1rem' : '1.25rem', fontWeight: 700, color: 'var(--color-gray-900, #111827)', margin: '0 0 0.75rem', fontFamily: 'var(--font-display)' }}
                    text={section.body || section.content || ''}
                    isHtml={true}
                    className="rich-text-content"
                    style={{ color: 'var(--color-gray-600, #4b5563)', fontSize: '0.95rem', lineHeight: 1.75 }}
                />
            ) : (
                <>
                    {section.title && (
                        <h3 style={{ fontSize: isSidebar ? '1rem' : '1.25rem', fontWeight: 700, color: 'var(--color-gray-900, #111827)', margin: '0 0 0.75rem', fontFamily: 'var(--font-display)' }}>{section.title}</h3>
                    )}
                </>
            )}
            {(stype === 'PHOTO' || stype === 'CAROUSEL') && <SectionPhotos section={section} />}
            {stype === 'GRAPH' && section.dataPoints?.length > 0 && (
                <div style={{ width: '100%', height: isSidebar ? '240px' : '340px', marginTop: section.title ? '0.5rem' : '0' }}>
                    <ResponsiveContainer width="100%" height="100%">
                        {section.graphType === 'BAR' ? (
                            <BarChart data={section.dataPoints} margin={{ top: 10, right: 20, left: 10, bottom: 20 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-gray-200, #e5e7eb)" />
                                <XAxis dataKey="label" tick={{ fill: 'var(--color-gray-500, #6b7280)', fontSize: 12 }} axisLine={false} tickLine={false}>
                                    {section.xAxisLabel && <Label value={section.xAxisLabel} offset={-10} position="insideBottom" fill="var(--color-gray-600, #4b5563)" fontSize={12} fontWeight={600} />}
                                </XAxis>
                                <YAxis tick={{ fill: 'var(--color-gray-500, #6b7280)', fontSize: 12 }} axisLine={false} tickLine={false} />
                                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }} />
                                <Bar dataKey="value" fill="var(--color-primary, #0052cc)" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        ) : section.graphType === 'LINE' ? (
                            <LineChart data={section.dataPoints} margin={{ top: 10, right: 20, left: 10, bottom: 20 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-gray-200, #e5e7eb)" />
                                <XAxis dataKey="label" tick={{ fill: 'var(--color-gray-500, #6b7280)', fontSize: 12 }} axisLine={false} tickLine={false} />
                                <YAxis tick={{ fill: 'var(--color-gray-500, #6b7280)', fontSize: 12 }} axisLine={false} tickLine={false} />
                                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }} />
                                <Line type="monotone" dataKey="value" stroke="var(--color-primary, #0052cc)" strokeWidth={3} dot={{ fill: 'var(--color-primary, #0052cc)', r: 4 }} />
                            </LineChart>
                        ) : (
                            <PieChart>
                                <Pie data={section.dataPoints} dataKey="value" nameKey="label" cx="50%" cy="50%" outerRadius={isSidebar ? 70 : 110} label>
                                    {section.dataPoints.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                                </Pie>
                                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }} />
                                <Legend />
                            </PieChart>
                        )}
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
};

export default ProfileSection;
