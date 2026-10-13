import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bell, Heart, MessageCircle, UserPlus, Eye, Mail, Zap, CalendarDays, Rocket } from 'lucide-react';
import { useFeature } from '../../context/FeatureFlagsContext';
import { settingsApi, notificationsApi } from '../../services/api';
import { nativePushPermission, enableNativePush, openNativeAppSettings, PERMISSION_EVENT } from '../../services/pushService';
import { requestNotificationPermission, subscribeToPush, getPushSubscriptionState } from '../../utils/notificationManager';
import { isNativePlatform } from '../../utils/platform';
import { SettingsPage, SettingsGroup, SettingsRow, Switch } from '../../components/settings/SettingsUI';

/**
 * This browser's push state: 'granted' (subscribed), 'denied', 'prompt'
 * (not asked, or asked but not subscribed) or 'unavailable'.
 */
async function webPushPermission() {
    if (!('PushManager' in window) || typeof Notification === 'undefined') return 'unavailable';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission === 'default') return 'prompt';
    const { subscribed } = await getPushSubscriptionState();
    return subscribed ? 'granted' : 'prompt';
}

/** Ask the browser, subscribe it, and say where that left it. */
async function enableWebPush() {
    if (Notification.permission === 'default' && (await requestNotificationPermission()) !== 'granted') {
        return webPushPermission();
    }
    try {
        const { publicKey } = await notificationsApi.getVapidKey();
        const subscription = await subscribeToPush(publicKey);
        if (subscription) await notificationsApi.pushSubscribe(subscription);
    } catch { /* stays 'prompt' */ }
    return webPushPermission();
}

/**
 * Settings → Notifications. Push on or off for the account (server:
 * UserSettings.pushNotifications), whether this phone or browser may show
 * them (iOS or browser permission), and what to be notified about, one
 * switch per kind (server: notification.service PUSH_CATEGORY). These
 * decide what reaches the phone; the bell lists everything regardless.
 */
const NotificationSettings = () => {
    const { t } = useTranslation();
    const native = isNativePlatform();
    const flags = {
        messages: useFeature('messages'),
        zaps: useFeature('zaps'),
        events: useFeature('events'),
        projects: useFeature('projects'),
    };
    const [settings, setSettings] = useState(null);
    const [device, setDevice] = useState('prompt');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const checkDevice = useCallback(async () => {
        setDevice(await (native ? nativePushPermission() : webPushPermission()));
    }, [native]);

    useEffect(() => {
        settingsApi.get().then(setSettings).catch(() => setError(t('notificationSettings.loadFailed')));
        checkDevice();
        // Back from iPhone Settings (or the browser's), it may have changed.
        // And when iOS's own prompt, shown at sign-in, is answered.
        const onVisible = () => { if (document.visibilityState === 'visible') checkDevice(); };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener(PERMISSION_EVENT, checkDevice);
        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener(PERMISSION_EVENT, checkDevice);
        };
    }, [checkDevice]);

    const save = async (changes) => {
        const before = settings;
        setSettings((s) => ({ ...s, ...changes }));
        setError('');
        try {
            await settingsApi.updateNotifications(changes);
        } catch {
            setSettings(before);
            setError(t('notificationSettings.saveFailed'));
        }
    };

    const pushOn = !!settings?.pushNotifications && device === 'granted';

    const togglePush = async (on) => {
        if (!on) { await save({ pushNotifications: false }); return; }
        if (device === 'denied') {
            if (native) openNativeAppSettings();
            return;
        }
        setBusy(true);
        const now = device === 'granted' ? 'granted' : await (native ? enableNativePush() : enableWebPush());
        setDevice(now);
        setBusy(false);
        if (now === 'granted' && !settings.pushNotifications) await save({ pushNotifications: true });
    };

    const kinds = [
        { key: 'notifyLikes', Icon: Heart, label: t('notificationSettings.likes'), desc: t('notificationSettings.likesDesc') },
        { key: 'notifyComments', Icon: MessageCircle, label: t('notificationSettings.comments'), desc: t('notificationSettings.commentsDesc') },
        { key: 'notifyFollows', Icon: UserPlus, label: t('notificationSettings.follows') },
        { key: 'notifyProfileViews', Icon: Eye, label: t('notificationSettings.profileViews'), desc: t('notificationSettings.profileViewsDesc') },
        flags.messages && { key: 'notifyMessages', Icon: Mail, label: t('notificationSettings.messages') },
        flags.zaps && { key: 'notifyZaps', Icon: Zap, label: t('notificationSettings.zaps') },
        flags.events && { key: 'notifyEvents', Icon: CalendarDays, label: t('notificationSettings.events'), desc: t('notificationSettings.eventsDesc') },
        // One switch for projects: interest and deck requests, and updates to ones you follow.
        flags.projects && { key: 'notifyInvestments', also: 'notifyProjectUpdates', Icon: Rocket, label: t('notificationSettings.projects'), desc: t('notificationSettings.projectsDesc') },
    ].filter(Boolean);

    const unavailable = device === 'unavailable';
    const pushDesc = unavailable
        ? t('notificationSettings.unavailable')
        : t(native ? 'notificationSettings.pushDescPhone' : 'notificationSettings.pushDescBrowser');

    return (
        <SettingsPage title={t('settings.notifications')} back="/settings">
            <SettingsGroup>
                <SettingsRow icon={Bell} label={t('notificationSettings.push')} desc={pushDesc}>
                    <Switch
                        checked={pushOn}
                        disabled={!settings || busy || unavailable || (device === 'denied' && !native)}
                        onChange={togglePush}
                        label={t('notificationSettings.push')}
                        testId="push-switch"
                    />
                </SettingsRow>
                {device === 'denied' && (
                    <div className="set-note" role="status">
                        <AlertTriangle size={18} aria-hidden="true" />
                        <div>
                            {t(native ? 'notificationSettings.deniedPhone' : 'notificationSettings.deniedBrowser')}
                            {native && (
                                <div>
                                    <button type="button" className="set-note-action" onClick={openNativeAppSettings}>
                                        {t('notificationSettings.openPhoneSettings')}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </SettingsGroup>
            {error && <p className="set-error" role="alert">{error}</p>}

            {settings && (
                <SettingsGroup title={t('notificationSettings.notifyMe')} footer={t('notificationSettings.footer')}>
                    {kinds.map(({ key, also, Icon, label, desc }) => (
                        <SettingsRow key={key} icon={Icon} label={label} desc={desc} disabled={!pushOn}>
                            <Switch
                                checked={pushOn && settings[key] !== false}
                                disabled={!pushOn}
                                onChange={(on) => save(also ? { [key]: on, [also]: on } : { [key]: on })}
                                label={label}
                                testId={`switch-${key}`}
                            />
                        </SettingsRow>
                    ))}
                </SettingsGroup>
            )}
        </SettingsPage>
    );
};

export default NotificationSettings;
