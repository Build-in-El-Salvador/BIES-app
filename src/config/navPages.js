// Single source of truth for navigable pages — shared by the customizable
// mobile bottom navbar (MobileBottomNav / CustomizeNavbar) and the Cowork feature.
import {
  Home,
  MessageSquare,
  Lightbulb,
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
  Settings,
  MessageCircle,
  Wallet,
  Leaf,
  Building2,
  Users,
  Briefcase,
  CircleUser,
} from 'lucide-react';
import { MARKETPLACE_ENABLED, BOUNTIES_ENABLED } from './featureFlags.js';

// `flag:` marks a page as belonging to a runtime feature toggle (see
// FeatureFlagsContext). Consumers (MobileBottomNav, CustomizeNavbar) must
// exclude pages whose flag is disabled — even from user-customized tab sets.
// The stored preference keeps the id, so re-enabling the feature restores
// the user's tab untouched.
export const NAV_PAGES = [
  { id: 'home', path: '/home', icon: Home, labelKey: 'mobileNav.homePage', auth: true },
  { id: 'feed', path: '/feed', icon: MessageSquare, labelKey: 'mobileNav.home' },
  // Opportunities: investments, businesses for sale, jobs, partnerships, programs.
  { id: 'opportunities', path: '/opportunities', icon: Lightbulb, labelKey: 'mobileNav.opportunities', auth: true, flag: 'projects' },
  { id: 'members', path: '/members', icon: Users, labelKey: 'mobileNav.members', auth: true },
  // Your own profile: in the side menu, and a tab members can add.
  { id: 'profile', path: '/profile', icon: CircleUser, labelKey: 'nav.profile', auth: true },
  { id: 'farms', path: '/farms', icon: Leaf, labelKey: 'mobileNav.farms', auth: true, flag: 'directories' },
  // Businesses (route /trusted): "BIES Trusted" is the badge a listing earns there.
  { id: 'trusted', path: '/trusted', icon: Building2, labelKey: 'mobileNav.trusted', auth: true, flag: 'directories' },
  // BIES Talents: members' skills and services, with their proof of work.
  { id: 'talent', path: '/talents', icon: Briefcase, labelKey: 'mobileNav.talent', auth: true, flag: 'talent' },
  // Spread conditionally so the entry is absent (not just hidden) when the
  // build-time constant is off; the `flag:` key layers the runtime toggle on top.
  ...(MARKETPLACE_ENABLED
    ? [{ id: 'marketplace', path: '/market', icon: Store, labelKey: 'marketplace.navLabel', auth: true, flag: 'marketplace' }]
    : []),
  { id: 'events', path: '/events', icon: Calendar, labelKey: 'mobileNav.events', flag: 'events' },
  { id: 'media', path: '/media', icon: Play, labelKey: 'nav.media', flag: 'media' },
  { id: 'courses', path: '/courses', icon: GraduationCap, labelKey: 'courses.catalogTitle', auth: true, flag: 'courses' },
  { id: 'dashboard', path: '/dashboard', icon: User, labelKey: 'mobileNav.dashboard', auth: true, flag: 'dashboard' },
  { id: 'news', path: '/news', icon: Newspaper, labelKey: 'mobileNav.news', flag: 'news' },
  { id: 'messages', path: '/messages', icon: Mail, labelKey: 'nav.messages', auth: true, flag: 'messages' },
  { id: 'notifications', path: '/notifications', icon: Bell, labelKey: 'customNav.pages.notifications', auth: true },
  { id: 'cowork', path: '/cowork', icon: Coffee, labelKey: 'mobileNav.cowork', auth: true, flag: 'cowork' },
  { id: 'wallet', path: '/wallet', icon: Wallet, labelKey: 'nav.wallet', auth: true, flag: 'zaps' },
  ...(BOUNTIES_ENABLED
    ? [{ id: 'bounties', path: '/bounties', icon: Target, labelKey: 'nav.bounties', auth: true, flag: 'bounties' }]
    : []),
  { id: 'leaderboard', path: '/leaderboard', icon: Trophy, labelKey: 'nav.leaderboard', auth: true, flag: 'points' },
  { id: 'settings', path: '/settings', icon: Settings, labelKey: 'nav.settings', auth: true },
  // "Feedback" as a tab; the side menu gives its full name (menuLabelKey).
  { id: 'feedback', path: '/feedback', icon: MessageCircle, labelKey: 'customNav.pages.feedback', menuLabelKey: 'feedback.title', flag: 'feedback' },
];

export const NAV_PAGES_BY_ID = Object.fromEntries(NAV_PAGES.map((p) => [p.id, p]));

// The side menu: every page a member can put in the bottom bar is in it too
// (Mike, 2026-10-20), in this order, then Feedback and Settings in its bottom
// section. A page whose feature is off, or that this copy of the app leaves
// out, isn't shown.
export const MENU_PAGES = [
  'profile', 'home', 'feed', 'members', 'trusted', 'farms', 'talent', 'opportunities', 'marketplace',
  'events', 'media', 'courses', 'news', 'messages', 'notifications', 'cowork', 'wallet', 'bounties',
  'leaderboard', 'dashboard',
];
export const MENU_BOTTOM_PAGES = ['feedback', 'settings'];

/** The side menu's pages from a list of ids: those in this copy of the app whose feature is on (`isOn(page)`). */
export function menuPages(ids, isOn) {
  return ids.map((id) => NAV_PAGES_BY_ID[id]).filter((page) => page && isOn(page));
}

// A new member's bar (Mike, 2026-10-19); members change theirs in Settings.
// Profile is in the side menu, not the default bar; members can add it.
export const DEFAULT_BOTTOM_NAV = ['home', 'trusted', 'farms', 'opportunities', 'feed'];

// What fills a slot a switched-off page leaves (Opportunities, before its
// switch is on): the default bar's pages, then these.
const SPARE_TABS = [...DEFAULT_BOTTOM_NAV, 'members', 'talent'];

// Bars saved before Home: the old default becomes the new one. A bar saved
// since ends with SAVED_MARK (savedTabs), so a member who picks those same
// tabs again keeps them: only an unmarked one is the old default.
const PREVIOUS_DEFAULT = ['feed', 'members', 'farms', 'trusted', 'profile'];
export const SAVED_MARK = 'v2';

// Tabs that became another page: Discover (projects and members) is Opportunities.
const RENAMED = { discover: 'opportunities' };

export const MAX_TABS = 5;
export const MIN_TABS = 1;

/**
 * Sanitize a stored/received list of tab ids into a valid bottom-nav config.
 * Pure function: renames a tab whose page was renamed (RENAMED), filters
 * unknown ids (SAVED_MARK among them), dedupes (first occurrence wins), caps
 * at MAX_TABS, and falls back to the defaults when invalid or empty.
 */
export function sanitizeTabs(ids) {
  if (!Array.isArray(ids)) return [...DEFAULT_BOTTOM_NAV];
  const seen = new Set();
  const result = [];
  for (const saved of ids) {
    const id = RENAMED[saved] || saved;
    if (NAV_PAGES_BY_ID[id] && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  const sliced = result.slice(0, MAX_TABS);
  if (sliced.length < MIN_TABS) return [...DEFAULT_BOTTOM_NAV];
  return sliced;
}

/** A bar read back from this device or the server: an old saved default becomes today's. */
export function restoreTabs(stored) {
  if (Array.isArray(stored) && stored.join() === PREVIOUS_DEFAULT.join()) return [...DEFAULT_BOTTOM_NAV];
  return sanitizeTabs(stored);
}

/** A bar as it's saved, marked as chosen now (see SAVED_MARK). */
export function savedTabs(ids) {
  return [...sanitizeTabs(ids), SAVED_MARK];
}

/**
 * The tabs the bar shows: the member's tabs whose feature is on, with any
 * slots that switched-off features leave empty refilled from the default
 * bar, then Members and Talents (so a bar never shrinks to one tab because
 * features are off in this copy of the app). Pure: `isOn(page)` says whether a page's feature is on.
 */
export function visibleTabs(ids, isOn) {
  const pages = ids.map((id) => NAV_PAGES_BY_ID[id]).filter(Boolean);
  const shown = pages.filter(isOn);
  const spare = SPARE_TABS
    .map((id) => NAV_PAGES_BY_ID[id])
    .filter((p) => p && isOn(p) && !shown.includes(p));
  return [...shown, ...spare.slice(0, pages.length - shown.length)];
}
