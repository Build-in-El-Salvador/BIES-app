import { Link } from 'react-router-dom';
import { ChevronRight, ChevronsUpDown, ExternalLink } from 'lucide-react';
import { openExternal } from '../../utils/openExternal';
import BackButton from '../BackButton';
import './SettingsUI.css';

/**
 * The pieces of Settings and its sub-pages, as iOS and most apps lay them
 * out: a title, then groups of one-line rows (label, value, chevron or
 * switch) on white cards, each group with a small heading and footnote.
 */

/** A settings page: a title, and a back chevron on a sub-page. */
export function SettingsPage({ title, back, children }) {
    return (
        <div className="set-page">
            <div className={`set-head back-head${back ? '' : ' main'}`}>
                {back && <BackButton to={back} />}
                <h1 className="set-title">{title}</h1>
            </div>
            {children}
        </div>
    );
}

/** A group of rows on one card, with an optional heading and footnote. */
export function SettingsGroup({ title, footer, children }) {
    return (
        <section className="set-group">
            {title && <h2 className="set-group-title">{title}</h2>}
            <div className="set-card">{children}</div>
            {footer && <p className="set-group-footer">{footer}</p>}
        </section>
    );
}

/**
 * One row. `to` opens a page in the app (chevron), `href` a page outside it
 * (`external`: in the browser), `onClick` runs something; `value` is grey
 * text on the right, `children` a control there (a Switch or SettingsSelect).
 */
export function SettingsRow({ icon: Icon, label, desc, value, to, href, external, onClick, danger, center, disabled, children, testId }) {
    const className = `set-row${danger ? ' danger' : ''}${center ? ' center' : ''}${disabled ? ' dim' : ''}`;
    const body = (
        <>
            {Icon && <span className="set-icon"><Icon size={20} aria-hidden="true" /></span>}
            <span className="set-text">
                <span className="set-label">{label}</span>
                {desc && <span className="set-desc">{desc}</span>}
            </span>
            {value != null && value !== '' && <span className="set-value">{value}</span>}
            {children}
            {to && <ChevronRight size={18} className="set-chevron" aria-hidden="true" />}
            {href && external && <ExternalLink size={16} className="set-chevron" aria-hidden="true" />}
        </>
    );
    if (to) return <Link to={to} className={className} data-testid={testId}>{body}</Link>;
    if (href) {
        return (
            <a
                href={href}
                className={className}
                data-testid={testId}
                onClick={external ? (e) => { e.preventDefault(); openExternal(href); } : undefined}
            >
                {body}
            </a>
        );
    }
    if (onClick) return <button type="button" className={className} onClick={onClick} disabled={disabled} data-testid={testId}>{body}</button>;
    return <div className={className} data-testid={testId}>{body}</div>;
}

/** An on/off switch, as iOS draws one. */
export function Switch({ checked, onChange, disabled, label, testId }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={!!checked}
            aria-label={label}
            className="set-switch"
            disabled={disabled}
            onClick={() => onChange(!checked)}
            data-testid={testId}
        />
    );
}

/** A choice shown as its value; tapping opens the system picker. */
export function SettingsSelect({ value, onChange, options, label, testId }) {
    return (
        <span className="set-select-wrap">
            <select className="set-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} data-testid={testId}>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <ChevronsUpDown size={14} className="set-select-icon" aria-hidden="true" />
        </span>
    );
}
