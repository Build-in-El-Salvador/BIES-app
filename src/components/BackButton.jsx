import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import './BackButton.css';

/**
 * The app's one back button: a chevron in a round 40px button, as in
 * Settings. Beside a page's title, put both in a `.back-head` row. On a
 * photo (a cover, a listing's hero), `overlay` gives it a white circle so it
 * shows, at the photo's top left (the photo needs position: relative).
 *
 * `to` goes to that page. `onClick` does something else (back to a list in
 * the same page). Otherwise it goes back in history, or to `fallback` when
 * there is none (the page was opened from a link or a notification).
 */
export default function BackButton({ to, onClick, fallback = '/', label, overlay = false, className = '', testId }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const cls = `bies-back${overlay ? ' overlay' : ''}${className ? ` ${className}` : ''}`;
    const aria = label || t('common.back', 'Back');
    const icon = <ChevronLeft size={26} strokeWidth={2.25} aria-hidden="true" />;

    if (to) return <Link to={to} className={cls} aria-label={aria} data-testid={testId}>{icon}</Link>;
    const goBack = (e) => {
        e.stopPropagation();
        if (onClick) onClick(e);
        // React Router counts this tab's entries in history.state.idx, and
        // keeps it through a redirect that replaces the page (sign-in from a
        // link), which the location key doesn't. The fallback replaces this
        // page, so the system back doesn't bounce between the two.
        else if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
        else navigate(fallback, { replace: true });
    };
    return <button type="button" className={cls} aria-label={aria} onClick={goBack} data-testid={testId}>{icon}</button>;
}
