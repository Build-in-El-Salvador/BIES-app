import React from 'react';
import { useTranslation } from 'react-i18next';
import { Bitcoin } from 'lucide-react';

/**
 * A talent at a glance: taking on work or busy, the kinds of work, bitcoin
 * and the rate. On the Talents cards and the profile's Talents tab.
 */
const TalentPills = ({ talent }) => {
    const { t } = useTranslation();
    return (
        <div className="tal-pills">
            <span className={`tal-avail${talent.available ? '' : ' busy'}`}>
                {talent.available ? t('talent.available') : t('talent.busy')}
            </span>
            {(talent.workTypes || []).map((w) => (
                <span key={w} className="tal-pill">{t(`talent.workTypes.${w}`)}</span>
            ))}
            {talent.btcAccepted && <Bitcoin size={15} className="tal-btc" role="img" aria-label={t('talent.btc')} />}
            {talent.rate && <span className="tal-rate">{talent.rate}</span>}

            <style jsx>{`
                .tal-pills {
                    display: flex;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 6px;
                }
                .tal-avail,
                .tal-pill {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 0.75rem;
                    font-weight: 700;
                    padding: 2px 8px;
                    border-radius: var(--radius-full);
                    white-space: nowrap;
                }
                .tal-avail {
                    background: #ecfdf5;
                    color: var(--color-success-text, #047857);
                }
                .tal-avail::before {
                    content: '';
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: currentColor;
                }
                .tal-avail.busy {
                    background: var(--color-gray-100);
                    color: var(--color-gray-600);
                }
                .tal-pill {
                    background: var(--color-blue-tint);
                    color: var(--color-primary);
                }
                .tal-pills :global(.tal-btc) {
                    color: #f7931a;
                    flex-shrink: 0;
                }
                .tal-rate {
                    font-size: 0.75rem;
                    color: var(--color-gray-500);
                    overflow-wrap: anywhere;
                }
            `}</style>
        </div>
    );
};

export default TalentPills;
