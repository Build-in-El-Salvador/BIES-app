import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import TranslatableText from './TranslatableText';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Label } from 'recharts';

const PIE_COLORS = ['#0052cc', '#16a34a', '#7c3aed', '#ea580c', '#dc2626', '#0891b2', '#ca8a04', '#be185d'];

const SectionCarousel = ({ images }) => {
    const [idx, setIdx] = useState(0);
    if (!images?.length) return null;
    return (
        <div style={{ position: 'relative' }}>
            <img
                src={images[idx]}
                alt={`Slide ${idx + 1}`}
                style={{ width: '100%', borderRadius: '10px', objectFit: 'cover', maxHeight: '400px' }}
            />
            {images.length > 1 && (
                <>
                    <button
                        onClick={() => setIdx((idx - 1 + images.length) % images.length)}
                        style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', background: 'rgba(0,0,0,0.5)', color: 'white', border: 'none', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                    >
                        <ChevronLeft size={18} />
                    </button>
                    <button
                        onClick={() => setIdx((idx + 1) % images.length)}
                        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'rgba(0,0,0,0.5)', color: 'white', border: 'none', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                    >
                        <ChevronRight size={18} />
                    </button>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginTop: '0.5rem' }}>
                        {images.map((_, i) => (
                            <button key={i} onClick={() => setIdx(i)} style={{ width: 8, height: 8, borderRadius: '50%', border: 'none', background: i === idx ? 'var(--color-primary, #0052cc)' : '#d1d5db', cursor: 'pointer', padding: 0 }} />
                        ))}
                    </div>
                </>
            )}
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
            {stype === 'PHOTO' && section.imageUrl && (
                <img src={section.imageUrl} alt={section.title || ''} style={{ width: '100%', borderRadius: '10px', objectFit: 'cover' }} />
            )}
            {stype === 'CAROUSEL' && section.images?.length > 0 && (
                <SectionCarousel images={section.images} />
            )}
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
