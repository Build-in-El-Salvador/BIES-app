import { BadgeCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The tick beside a verified member's name: they claimed a BIES address
 * (name@buildinelsalvador.com) in Settings → Nostr. The profile API sends
 * `verified` (server: services/profilePrivacy.ts).
 */
const VerifiedTick = ({ size = 18 }) => {
    const { t } = useTranslation();
    const label = t('nostrSettings.verifiedTick');
    return (
        <BadgeCheck
            size={size}
            role="img"
            aria-label={label}
            style={{ color: 'var(--color-primary)', flexShrink: 0, verticalAlign: 'middle', marginLeft: '0.3em', marginBottom: '0.1em' }}
        >
            <title>{label}</title>
        </BadgeCheck>
    );
};

export default VerifiedTick;
