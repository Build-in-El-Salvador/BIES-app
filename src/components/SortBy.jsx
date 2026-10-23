import { useTranslation } from 'react-i18next';

/**
 * "Sort by" and its menu, at the top of a list page's filters: a native
 * select, so a phone shows its own picker. `options` are [value, label]
 * pairs, the page's usual order ('') first (utils/listSorts.js).
 */
export default function SortBy({ id, value, options, onChange }) {
    const { t } = useTranslation();
    return (
        <div className="sort-by">
            <label htmlFor={id} className="sort-by-label">{t('sort.label')}</label>
            <select id={id} className="sort-by-select" value={value} onChange={(e) => onChange(e.target.value)}>
                {options.map(([option, label]) => <option key={option || 'usual'} value={option}>{label}</option>)}
            </select>
            <style jsx>{`
                .sort-by-label {
                    display: block;
                    font-size: 0.9rem;
                    font-weight: 600;
                    margin-bottom: 0.5rem;
                }
                .sort-by-select {
                    width: 100%;
                    padding: 0.55rem 0.75rem;
                    border-radius: var(--radius-md);
                    border: 1px solid var(--color-gray-300);
                    background: var(--color-surface);
                    color: inherit;
                    font-size: 0.9rem;
                    appearance: auto;
                    cursor: pointer;
                }
            `}</style>
        </div>
    );
}
