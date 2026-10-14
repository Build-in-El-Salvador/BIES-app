import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlignLeft, Ban, Briefcase, Eye, Link2, MapPin, Newspaper, Users, UserSearch } from 'lucide-react';
import { settingsApi } from '../../services/api';
import { SettingsPage, SettingsGroup, SettingsRow, SettingsSelect, Switch } from '../../components/settings/SettingsUI';

// Who can see each part of a profile (server: services/profilePrivacy.ts).
const AUDIENCE_ROWS = [
    { key: 'bio', Icon: AlignLeft, choices: ['PUBLIC', 'MEMBERS'] },
    { key: 'location', Icon: MapPin, choices: ['MEMBERS', 'ONLY_ME'] },
    { key: 'links', Icon: Link2, choices: ['MEMBERS', 'ONLY_ME'] },
    { key: 'details', Icon: Briefcase, choices: ['MEMBERS', 'ONLY_ME'] },
    { key: 'network', Icon: Users, choices: ['MEMBERS', 'ONLY_ME'] },
];

/**
 * Settings → Privacy: who sees each part of your profile (your name, photos
 * and headline are public), whether you're in the Members directory,
 * whether your posts show on your profile, browsing privately, and the
 * members you blocked. Albums have their own audience, on each album.
 */
const PrivacySettings = () => {
    const { t } = useTranslation();
    const [privacy, setPrivacy] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        settingsApi.getPrivacy().then(setPrivacy).catch(() => setError(t('privacySettings.loadFailed')));
    }, []);

    const save = async (changes) => {
        const before = privacy;
        setPrivacy((p) => ({ ...p, ...changes }));
        setError('');
        try {
            setPrivacy(await settingsApi.updatePrivacy(changes));
        } catch {
            setPrivacy(before);
            setError(t('privacySettings.saveFailed'));
        }
    };

    return (
        <SettingsPage title={t('privacySettings.title')} back="/settings">
            {error && <p className="set-error" role="alert" style={{ margin: '0 14px 12px' }}>{error}</p>}
            {privacy && (
                <>
                    <SettingsGroup title={t('privacySettings.whoSees')} footer={t('privacySettings.whoSeesFooter')}>
                        {AUDIENCE_ROWS.map(({ key, Icon, choices }) => (
                            <SettingsRow key={key} icon={Icon} label={t(`privacySettings.parts.${key}`)} desc={t(`privacySettings.partsDesc.${key}`)}>
                                <SettingsSelect
                                    label={t(`privacySettings.parts.${key}`)}
                                    value={privacy[key]}
                                    onChange={(value) => save({ [key]: value })}
                                    options={choices.map((c) => ({ value: c, label: t(`privacySettings.audiences.${c}`) }))}
                                    testId={`privacy-${key}`}
                                />
                            </SettingsRow>
                        ))}
                    </SettingsGroup>

                    <SettingsGroup title={t('privacySettings.onBies')}>
                        <SettingsRow icon={UserSearch} label={t('privacySettings.directory')} desc={t('privacySettings.directoryDesc')}>
                            <Switch checked={privacy.showInDirectory} onChange={(on) => save({ showInDirectory: on })} label={t('privacySettings.directory')} testId="privacy-directory" />
                        </SettingsRow>
                        <SettingsRow icon={Newspaper} label={t('privacySettings.posts')} desc={t('privacySettings.postsDesc')}>
                            <Switch checked={privacy.postsOnProfile} onChange={(on) => save({ postsOnProfile: on })} label={t('privacySettings.posts')} testId="privacy-posts" />
                        </SettingsRow>
                        <SettingsRow icon={Eye} label={t('privacySettings.browsePrivately')} desc={t('privacySettings.browsePrivatelyDesc')}>
                            <Switch checked={privacy.browsePrivately} onChange={(on) => save({ browsePrivately: on })} label={t('privacySettings.browsePrivately')} testId="privacy-browse" />
                        </SettingsRow>
                    </SettingsGroup>

                    <SettingsGroup footer={t('privacySettings.nostrFooter')}>
                        <SettingsRow icon={Ban} label={t('moderation.settings.blockedLabel')} desc={t('moderation.settings.blockedDesc')} to="/settings/blocked" testId="settings-blocked" />
                    </SettingsGroup>
                </>
            )}
        </SettingsPage>
    );
};

export default PrivacySettings;
