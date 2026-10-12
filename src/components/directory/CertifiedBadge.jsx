import React from 'react';
import { BadgeCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const SIZES = {
    sm: { font: '0.7rem', icon: 12, padding: '2px 8px', gap: 4 },
    md: { font: '0.82rem', icon: 15, padding: '4px 12px', gap: 6 },
};

/**
 * "BIES Trusted" pill, earned at 5 net vouches — orange accent (secondary) on a subtle
 * tinted background; both tokens are theme-aware so it reads in dark mode.
 *
 * Styles are inline: the styled-jsx babel plugin only scopes classes on
 * plain DOM elements, so this component must be fully self-styled to be
 * composable inside any styled-jsx parent. The `dir-certified-badge`
 * class is a stable hook for tests, not a style target.
 *
 * @param {'sm'|'md'} size - sm for list cards, md for detail pages
 */
const CertifiedBadge = ({ size = 'sm' }) => {
    const { t } = useTranslation();
    const s = SIZES[size] || SIZES.sm;

    return (
        <span
            className="dir-certified-badge"
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: s.gap,
                padding: s.padding,
                borderRadius: 'var(--radius-full)',
                background: 'var(--color-orange-tint)',
                border: '1px solid var(--color-secondary)',
                color: 'var(--color-orange-text)',
                fontSize: s.font,
                fontWeight: 700,
                lineHeight: 1.25,
                whiteSpace: 'nowrap',
            }}
        >
            <BadgeCheck size={s.icon} style={{ flexShrink: 0 }} />
            {t('directory.certifiedBadge')}
        </span>
    );
};

export default CertifiedBadge;
