import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlignLeft, Ban, Briefcase, Eye, Link2, MapPin, Newspaper, Users, UserSearch } from 'lucide-react';
import { profilesApi, settingsApi } from '../../services/api';
import { nostrSigner } from '../../services/nostrSigner';
import { nostrService } from '../../services/nostrService';
import { nostrLinkFields } from '../../services/nostrProfileLinks';
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

    // Saves go one after another, and only the last one's answer (the whole
    // setting as saved) replaces what's shown, so quick changes can't undo
    // each other. After a failure the page shows what is actually saved.
    const queue = useRef(Promise.resolve());
    const waiting = useRef(0);
    const save = (changes) => {
        setPrivacy((p) => ({ ...p, ...changes }));
        setError('');
        waiting.current += 1;
        queue.current = queue.current.then(async () => {
            let saved = null;
            let ok = false;
            try {
                saved = await settingsApi.updatePrivacy(changes);
                ok = true;
            } catch {
                setError(t('privacySettings.saveFailed'));
                saved = await settingsApi.getPrivacy().catch(() => null);
            }
            waiting.current -= 1;
            if (saved && waiting.current === 0) setPrivacy(saved);
            // With a key on this device, the app updates the Nostr profile on
            // the BIES relay (the server does it for keys BIES holds).
            if (ok && changes.links !== undefined && nostrSigner.signsOnDevice) {
                profilesApi.me()
                    .then((me) => nostrService.updateProfileToBiesRelay(nostrLinkFields(me, { links: changes.links })))
                    .catch((err) => console.error('Relay profile sync failed (non-blocking):', err));
            }
        });
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
