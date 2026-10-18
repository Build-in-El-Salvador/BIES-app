import React from 'react';
import { useTranslation } from 'react-i18next';
import { TrendingUp, Store, Briefcase, HeartHandshake, Award } from 'lucide-react';
import { OPPORTUNITY_TYPES, typeLine } from './opportunityOptions';

/** Each type's icon and colours (text on its tint passes WCAG AA). */
export const TYPE_STYLE = {
    investment: { Icon: TrendingUp, color: '#047857', tint: '#ecfdf5' },
    'business-for-sale': { Icon: Store, color: '#c2410c', tint: '#fff7ed' },
    job: { Icon: Briefcase, color: '#0047ab', tint: '#eef4fc' },
    partnership: { Icon: HeartHandshake, color: '#6d28d9', tint: '#f5f3ff' },
    program: { Icon: Award, color: '#0f766e', tint: '#f0fdfa' },
};

export const styleOf = (type) => TYPE_STYLE[type] || TYPE_STYLE.investment;

/**
 * Its type ("Job") in the type's colour, with its icon; "Job · Full-time"
 * with `withKind`, where there's room (its own page).
 *
 * @param {object} opportunity - with type and kind
 */
const TypeBadge = ({ opportunity, size = 'sm', withKind = false }) => {
    const { t } = useTranslation();
    const { Icon, color, tint } = styleOf(opportunity?.type);
    const type = OPPORTUNITY_TYPES.includes(opportunity?.type) ? opportunity.type : 'investment';
    const big = size === 'md';
    return (
        <span
            className="opp-type-badge"
            style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start', minWidth: 0, maxWidth: '100%',
                padding: big ? '4px 12px' : '2px 9px', borderRadius: 999,
                background: tint, color, fontSize: big ? '0.85rem' : '0.75rem', fontWeight: 700, lineHeight: 1.5,
            }}
        >
            <Icon size={big ? 15 : 13} aria-hidden="true" style={{ flexShrink: 0 }} />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {withKind ? typeLine(opportunity, t) : t(`opportunities.types.${type}`)}
            </span>
        </span>
    );
};

export default TypeBadge;
