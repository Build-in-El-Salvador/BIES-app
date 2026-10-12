// Single source of truth for navigable pages — shared by the customizable
// mobile bottom navbar (MobileBottomNav / CustomizeNavbar) and the Cowork feature.
import {
  MessageSquare,
  Compass,
  Calendar,
  Play,
  User,
  Newspaper,
  Mail,
  Bell,
  Coffee,
  Store,
  Target,
  Trophy,
  GraduationCap,
  UserCircle,
  Settings,
  MessageCircle,
  Wallet,
  Leaf,
  ShieldCheck,
} from 'lucide-react';
import { MARKETPLACE_ENABLED, BOUNTIES_ENABLED } from './featureFlags';

// `flag:` marks a page as belonging to a runtime feature toggle (see
// FeatureFlagsContext). Consumers (MobileBottomNav, CustomizeNavbar) must
// exclude pages whose flag is disabled — even from user-customized tab sets.
// The stored preference keeps the id, so re-enabling the feature restores
// the user's tab untouched.
export const NAV_PAGES = [
  { id: 'feed', path: '/feed', icon: MessageSquare, labelKey: 'mobileNav.home' },
  { id: 'discover', path: '/discover', icon: Compass, labelKey: 'mobileNav.discover' },
  { id: 'farms', path: '/farms', icon: Leaf, labelKey: 'mobileNav.farms', auth: true, flag: 'directories' },
  { id: 'trusted', path: '/trusted', icon: ShieldCheck, labelKey: 'mobileNav.trusted', auth: true, flag: 'directories' },
  // Spread conditionally so the entry is absent (not just hidden) when the
  // build-time constant is off; the `flag:` key layers the runtime toggle on top.
  ...(MARKETPLACE_ENABLED
    ? [{ id: 'marketplace', path: '/market', icon: Store, labelKey: 'marketplace.navLabel', auth: true, flag: 'marketplace' }]
    : []),
  { id: 'events', path: '/events', icon: Calendar, labelKey: 'mobileNav.events', flag: 'events' },
  { id: 'media', path: '/media', icon: Play, labelKey: 'nav.media', flag: 'media' },
  { id: 'courses', path: '/courses', icon: GraduationCap, labelKey: 'courses.catalogTitle', auth: true },
  { id: 'dashboard', path: '/dashboard', icon: User, labelKey: 'mobileNav.dashboard', auth: true },
  { id: 'news', path: '/news', icon: Newspaper, labelKey: 'mobileNav.news', flag: 'news' },
  { id: 'messages', path: '/messages', icon: Mail, labelKey: 'nav.messages', auth: true, flag: 'messages' },
  { id: 'notifications', path: '/notifications', icon: Bell, labelKey: 'customNav.pages.notifications', auth: true },
  { id: 'cowork', path: '/cowork', icon: Coffee, labelKey: 'mobileNav.cowork', auth: true, flag: 'cowork' },
  { id: 'wallet', path: '/wallet', icon: Wallet, labelKey: 'nav.wallet', auth: true, flag: 'zaps' },
  ...(BOUNTIES_ENABLED
    ? [{ id: 'bounties', path: '/bounties', icon: Target, labelKey: 'nav.bounties', auth: true, flag: 'bounties' }]
    : []),
  { id: 'leaderboard', path: '/leaderboard', icon: Trophy, labelKey: 'nav.leaderboard', auth: true, flag: 'points' },
  { id: 'profile', path: '/profile', icon: UserCircle, labelKey: 'nav.profile', auth: true },
  { id: 'settings', path: '/settings', icon: Settings, labelKey: 'nav.settings', auth: true },
  { id: 'feedback', path: '/feedback', icon: MessageCircle, labelKey: 'customNav.pages.feedback', flag: 'feedback' },
];

export const NAV_PAGES_BY_ID = Object.fromEntries(NAV_PAGES.map((p) => [p.id, p]));

export const DEFAULT_BOTTOM_NAV = ['feed', 'discover', 'events', 'media', 'dashboard'];

export const MAX_TABS = 5;
export const MIN_TABS = 1;

/**
 * Sanitize a stored/received list of tab ids into a valid bottom-nav config.
 * Pure function: filters unknown ids, dedupes (first occurrence wins),
 * caps at MAX_TABS, and falls back to the defaults when invalid or empty.
 */
export function sanitizeTabs(ids) {
  if (!Array.isArray(ids)) return [...DEFAULT_BOTTOM_NAV];
  const seen = new Set();
  const result = [];
  for (const id of ids) {
    if (NAV_PAGES_BY_ID[id] && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  const sliced = result.slice(0, MAX_TABS);
  if (sliced.length < MIN_TABS) return [...DEFAULT_BOTTOM_NAV];
  return sliced;
}
