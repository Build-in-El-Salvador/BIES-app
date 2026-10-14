import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    Bell, Moon, Globe, Smartphone, LayoutGrid, Users, Play, CalendarDays, Mail, AtSign, Key, Lock, Trash2, LogOut,
    Wallet, FileText, Shield, LifeBuoy, User, ChevronRight,
} from 'lucide-react';
import WalletConnect from '../components/WalletConnect';
import { SettingsPage, SettingsGroup, SettingsRow, SettingsSelect } from '../components/settings/SettingsUI';
import { useTheme } from '../context/ThemeContext';
import { useViewPreference } from '../context/ViewContext';
import { useAuth } from '../context/AuthContext';
import { useUserMode } from '../context/UserModeContext';
import { useFeature } from '../context/FeatureFlagsContext';
import { preferencesApi } from '../services/api';
import { CUSTOM_BOTTOM_NAV_ENABLED } from '../config/featureFlags';
import { legalPage, SUPPORT_EMAIL } from '../config/legal';
import { getAssetUrl } from '../utils/assets';
import { isPlaceholderName } from '../utils/profileComplete';

/**
 * Settings, as one list: you at the top (to Edit profile), then Account,
 * the app (notifications, appearance, language, the bottom bar), the wallet
 * where zaps are on, help and legal, and Log out. Longer settings have
 * their own pages: Privacy (with Blocked members), Notifications, Nostr key,
 * Delete account.
 */
const Settings = () => {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const { user, logout } = useAuth();
    const { clearMode } = useUserMode();
    const { theme, setTheme } = useTheme();
    const { defaultView, setDefaultView } = useViewPreference();
    const zapsOn = useFeature('zaps');
    const projectsOn = useFeature('projects');
    const eventsOn = useFeature('events');
    const mediaOn = useFeature('media');

    const [views, setViews] = useState(() => ({
        projectsView: localStorage.getItem('bies_projects_view') || defaultView || 'list',
        membersView: localStorage.getItem('bies_members_view') || defaultView || 'list',
        eventsView: localStorage.getItem('bies_events_view') || defaultView || 'list',
        mediaView: localStorage.getItem('bies_media_view') || 'card',
    }));

    // Load preferences from backend on mount (restores after logout/login)
    useEffect(() => {
        preferencesApi.get().then((prefs) => {
            if (prefs.theme && prefs.theme !== theme) setTheme(prefs.theme);
            if (prefs.language && prefs.language !== i18n.language) i18n.changeLanguage(prefs.language);
            const saved = {};
            for (const key of ['projectsView', 'membersView', 'eventsView', 'mediaView']) {
                if (prefs[key]) {
                    saved[key] = prefs[key];
                    localStorage.setItem(`bies_${key.replace('View', '')}_view`, prefs[key]);
                }
            }
            if (prefs.projectsView) setDefaultView(prefs.projectsView);
            setViews((v) => ({ ...v, ...saved }));
        }).catch(() => {});
    }, []);

    // A layout choice: kept on this device and in the account.
    const setView = useCallback((key, value) => {
        setViews((v) => ({ ...v, [key]: value }));
        localStorage.setItem(`bies_${key.replace('View', '')}_view`, value);
        preferencesApi.save({ [key]: value }).catch(() => {});
        if (key === 'projectsView') setDefaultView(value);
    }, [setDefaultView]);

    const changeTheme = (value) => {
        setTheme(value);
        preferencesApi.save({ theme: value }).catch(() => {});
    };
    const changeLanguage = (value) => {
        i18n.changeLanguage(value);
        preferencesApi.save({ language: value }).catch(() => {});
    };
    const signOut = () => {
        logout();
        clearMode();
        navigate('/');
    };

    const name = user?.profile?.name && !isPlaceholderName(user.profile.name) ? user.profile.name : t('settings.yourProfile');
    const avatar = user?.profile?.avatar;
    const layouts = [
        projectsOn && { key: 'projectsView', Icon: LayoutGrid, label: t('settings.projectsLayout'), options: [['list', t('settings.layoutList')], ['standard', t('settings.layoutGrid')]] },
        { key: 'membersView', Icon: Users, label: t('settings.membersLayout'), options: [['list', t('settings.layoutList')], ['standard', t('settings.layoutCards')], ['icons', t('settings.layoutIcons')]] },
        eventsOn && { key: 'eventsView', Icon: CalendarDays, label: t('settings.eventsLayout'), options: [['list', t('settings.layoutList')], ['standard', t('settings.layoutGrid')]] },
        mediaOn && { key: 'mediaView', Icon: Play, label: t('settings.mediaLayout'), options: [['card', t('settings.layoutCards')], ['list', t('settings.layoutList')], ['icon', t('settings.layoutIcons')]] },
    ].filter(Boolean);

    return (
        <SettingsPage title={t('settings.title')}>
            <SettingsGroup>
                <Link to="/profile/edit" className="set-row set-profile" data-testid="settings-profile">
                    <span className="set-avatar">
                        {avatar ? <img src={getAssetUrl(avatar)} alt="" /> : <User size={28} />}
                    </span>
                    <span className="set-text">
                        <span className="set-label">{name}</span>
                        <span className="set-desc">{t('settings.editProfile')}</span>
                    </span>
                    <ChevronRight size={18} className="set-chevron" aria-hidden="true" />
                </Link>
            </SettingsGroup>

            <SettingsGroup title={t('account.sectionTitle')}>
                <SettingsRow icon={AtSign} label={t('settings.email')} value={user?.email || t('settings.noEmail')} />
                {user?.nostrPubkey && <SettingsRow icon={Key} label={t('settings.nostrKey')} to="/settings/nostr" testId="settings-nostr" />}
                <SettingsRow icon={Lock} label={t('settings.privacy')} to="/settings/privacy" testId="settings-privacy" />
                <SettingsRow icon={Trash2} label={t('account.deleteLabel')} to="/settings/delete-account" danger testId="settings-delete-account" />
            </SettingsGroup>

            <SettingsGroup title={t('settings.app')}>
                <SettingsRow icon={Bell} label={t('settings.notifications')} to="/settings/notifications" testId="settings-notifications" />
                <SettingsRow icon={Moon} label={t('settings.appearance')}>
                    <SettingsSelect
                        label={t('settings.appearance')}
                        value={theme}
                        onChange={changeTheme}
                        options={[
                            { value: 'light', label: t('settings.light') },
                            { value: 'dark', label: t('settings.dark') },
                            { value: 'system', label: t('settings.system') },
                        ]}
                    />
                </SettingsRow>
                <SettingsRow icon={Globe} label={t('settings.language')}>
                    <SettingsSelect
                        label={t('settings.language')}
                        value={i18n.language?.startsWith('es') ? 'es' : 'en'}
                        onChange={changeLanguage}
                        options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]}
                    />
                </SettingsRow>
                {CUSTOM_BOTTOM_NAV_ENABLED && (
                    <SettingsRow icon={Smartphone} label={t('settings.bottomBar')} to="/settings/navbar" testId="customize-nav-link" />
                )}
                {layouts.map(({ key, Icon, label, options }) => (
                    <SettingsRow key={key} icon={Icon} label={label}>
                        <SettingsSelect
                            label={label}
                            value={views[key]}
                            onChange={(value) => setView(key, value)}
                            options={options.map(([value, text]) => ({ value, label: text }))}
                        />
                    </SettingsRow>
                ))}
            </SettingsGroup>

            {zapsOn && (
                <SettingsGroup title={t('settings.lightningWallet')}>
                    <SettingsRow icon={Wallet} label={t('settings.openWalletLabel', 'BIES Wallet')} to="/wallet" testId="settings-open-wallet" />
                    <div className="set-pad"><WalletConnect /></div>
                </SettingsGroup>
            )}

            {/* Terms, privacy and help: on buildinelsalvador.com, in the app's language. */}
            <SettingsGroup title={t('moderation.settings.legalTitle')}>
                <SettingsRow icon={LifeBuoy} label={t('moderation.settings.support')} href={legalPage(i18n.language, 'support')} external />
                <SettingsRow icon={Mail} label={t('moderation.settings.email')} desc={SUPPORT_EMAIL} href={`mailto:${SUPPORT_EMAIL}`} />
                <SettingsRow icon={FileText} label={t('moderation.settings.terms')} href={legalPage(i18n.language, 'terms')} external />
                <SettingsRow icon={Shield} label={t('moderation.settings.privacy')} href={legalPage(i18n.language, 'privacy')} external />
            </SettingsGroup>

            <SettingsGroup>
                <SettingsRow icon={LogOut} label={t('settings.logOut')} onClick={signOut} danger center testId="settings-log-out" />
            </SettingsGroup>

            <p className="set-version">BIES v{__APP_VERSION__}</p>
        </SettingsPage>
    );
};

export default Settings;
