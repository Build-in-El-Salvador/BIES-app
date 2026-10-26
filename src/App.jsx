import React, { Suspense, useEffect, useRef, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { UserModeProvider, useUserMode } from './context/UserModeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { ViewProvider, useViewPreference } from './context/ViewContext';
import { LightboxProvider } from './context/LightboxContext';
import { BottomNavProvider, useBottomNav } from './context/BottomNavContext';
import { FeatureFlagsProvider, useFeature } from './context/FeatureFlagsContext';
import { BOUNTIES_ENABLED, COWORK_ENABLED, CUSTOM_BOTTOM_NAV_ENABLED, COURSES_ENABLED, MARKETPLACE_ENABLED } from './config/featureFlags';
import { preferencesApi } from './services/api';
import useScrollMemory from './hooks/useScrollMemory';
import i18n from './i18n';
import Navbar from './components/Navbar';
import MobileBottomNav from './components/MobileBottomNav';
import ModeSelectionModal from './components/ModeSelectionModal';
import VersionIndicator from './components/VersionIndicator';
import GamificationToast from './components/GamificationToast';
import SignerToast from './components/SignerToast';
import AppLinkListener from './components/AppLinkListener';
import BackButtonListener from './components/BackButtonListener';
import SystemBarsSync from './components/SystemBarsSync';
import BootSplash from './components/BootSplash';
import { hideLaunchScreen } from './utils/launchScreen';
import { lazyPage } from './utils/lazyPage';
import { rememberPage } from './utils/lastPage';
import { Loader2 } from 'lucide-react';

// Pages. Home and signing in come with the app; every other page is
// fetched the first time it's opened (utils/lazyPage.js), so the app starts
// with about a third of the code. The bottom-bar pages are fetched in the
// background once Home is up (PRELOAD below).
import Landing from './pages/Landing';
const Feed = lazyPage(() => import('./pages/Feed'));
import Home from './pages/Home';
const Discover = lazyPage(() => import('./pages/Discover'));
const Members = lazyPage(() => import('./pages/Members'));
const Builders = lazyPage(() => import('./pages/Builders'));
const Investors = lazyPage(() => import('./pages/Investors'));
const Media = lazyPage(() => import('./pages/Media'));
const News = lazyPage(() => import('./pages/News'));
const Events = lazyPage(() => import('./pages/Events'));
const EventDetail = lazyPage(() => import('./pages/EventDetail'));
const EventForm = lazyPage(() => import('./pages/EventForm'));
const MyEvents = lazyPage(() => import('./pages/MyEvents'));
const Team = lazyPage(() => import('./pages/Team'));
const PublicProfile = lazyPage(() => import('./pages/PublicProfile'));
const FollowList = lazyPage(() => import('./pages/FollowList'));
const Profile = lazyPage(() => import('./pages/Profile'));
const ProfileEdit = lazyPage(() => import('./pages/ProfileEdit'));
const Messages = lazyPage(() => import('./pages/Messages'));
const Settings = lazyPage(() => import('./pages/Settings'));
const DeleteAccount = lazyPage(() => import('./pages/settings/DeleteAccount'));
const TakeYourKey = lazyPage(() => import('./pages/settings/TakeYourKey'));
const BlockedMembers = lazyPage(() => import('./pages/settings/BlockedMembers'));
const NotificationSettings = lazyPage(() => import('./pages/settings/NotificationSettings'));
const NostrKeys = lazyPage(() => import('./pages/settings/NostrKeys'));
const PrivacySettings = lazyPage(() => import('./pages/settings/PrivacySettings'));
const AlbumPage = lazyPage(() => import('./pages/AlbumPage'));
const CustomizeNavbar = lazyPage(() => import('./pages/CustomizeNavbar'));
const Cowork = lazyPage(() => import('./pages/Cowork'));
const Wallet = lazyPage(() => import('./pages/Wallet'));
const Bounties = lazyPage(() => import('./pages/Bounties'));
const BountyDetail = lazyPage(() => import('./pages/BountyDetail'));
const CreateBounty = lazyPage(() => import('./pages/CreateBounty'));
const Notifications = lazyPage(() => import('./pages/Notifications'));
const ArticleDetail = lazyPage(() => import('./pages/ArticleDetail'));
import Login from './pages/Login';
const Signup = lazyPage(() => import('./pages/Signup'));
const AmberCallback = lazyPage(() => import('./pages/AmberCallback'));
const VoucherRedeem = lazyPage(() => import('./pages/VoucherRedeem'));
const Join = lazyPage(() => import('./pages/Join'));
const Dashboard = lazyPage(() => import('./pages/Dashboard'));
const Leaderboard = lazyPage(() => import('./pages/Leaderboard'));
const Overview = lazyPage(() => import('./pages/Overview'));
const Following = lazyPage(() => import('./pages/Following'));
const NotFound = lazyPage(() => import('./pages/NotFound'));

const DirectoryList = lazyPage(() => import('./pages/directory/DirectoryList'));
const ListingDetail = lazyPage(() => import('./pages/directory/ListingDetail'));
const CreateListing = lazyPage(() => import('./pages/directory/CreateListing'));

const TalentList = lazyPage(() => import('./pages/talent/TalentList'));
const TalentDetail = lazyPage(() => import('./pages/talent/TalentDetail'));
const TalentForm = lazyPage(() => import('./pages/talent/TalentForm'));
const SharePreview = lazyPage(() => import('./pages/SharePreview'));
const OpportunityList = lazyPage(() => import('./pages/opportunities/OpportunityList'));
const OpportunityDetail = lazyPage(() => import('./pages/opportunities/OpportunityDetail'));
const OpportunityForm = lazyPage(() => import('./pages/opportunities/OpportunityForm'));

const MarketplaceList = lazyPage(() => import('./pages/marketplace/MarketplaceList'));
const MarketListingDetail = lazyPage(() => import('./pages/marketplace/MarketListingDetail'));
const CreateMarketListing = lazyPage(() => import('./pages/marketplace/CreateMarketListing'));

const Analytics = lazyPage(() => import('./pages/builder/Analytics'));
const MyCourses = lazyPage(() => import('./pages/educator/MyCourses'));
const NewCourse = lazyPage(() => import('./pages/educator/NewCourse'));
const CourseBuilder = lazyPage(() => import('./pages/educator/CourseBuilder'));
const LessonEditor = lazyPage(() => import('./pages/educator/LessonEditor'));
const CourseCatalog = lazyPage(() => import('./pages/courses/CourseCatalog'));
const CourseDetail = lazyPage(() => import('./pages/courses/CourseDetail'));
const LessonPlayer = lazyPage(() => import('./pages/courses/LessonPlayer'));

// Admin pages
const AdminDashboard = lazyPage(() => import('./pages/admin/AdminDashboard'));
const AdminOverview = lazyPage(() => import('./pages/admin/AdminOverview'));
const AdminProjects = lazyPage(() => import('./pages/admin/AdminProjects'));
const AdminEvents = lazyPage(() => import('./pages/admin/AdminEvents'));
const AdminDirectory = lazyPage(() => import('./pages/admin/AdminDirectory'));
const AdminUsers = lazyPage(() => import('./pages/admin/AdminUsers'));
const AdminPoints = lazyPage(() => import('./pages/admin/AdminPoints'));
const AdminAuditLog = lazyPage(() => import('./pages/admin/AdminAuditLog'));
const AdminNewsSettings = lazyPage(() => import('./pages/admin/AdminNewsSettings'));
const AdminInvestorVetting = lazyPage(() => import('./pages/admin/AdminInvestorVetting'));
const AdminVouchers = lazyPage(() => import('./pages/admin/AdminVouchers'));
const AdminFeedback = lazyPage(() => import('./pages/admin/AdminFeedback'));
const AdminReports = lazyPage(() => import('./pages/admin/AdminReports'));
const AdminCourses = lazyPage(() => import('./pages/admin/AdminCourses'));
const AdminBounties = lazyPage(() => import('./pages/admin/AdminBounties'));
const AdminFeatures = lazyPage(() => import('./pages/admin/AdminFeatures'));
const Feedback = lazyPage(() => import('./pages/Feedback'));

// While a page's code arrives: nothing for the first moment (it's usually
// instant), then a spinner, so a quick load doesn't flash.
const PageLoading = () => {
    const [show, setShow] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setShow(true), 300);
        return () => clearTimeout(timer);
    }, []);
    if (!show) return null;
    return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <Loader2 size={32} role="status" aria-label="Loading" style={{ animation: 'spin 1s linear infinite', color: 'var(--color-gray-400)' }} />
        </div>
    );
};

// The pages most people open next, fetched quietly once the app is up.
const PRELOAD = [Feed, Discover, DirectoryList, ListingDetail, OpportunityList, OpportunityDetail,
    TalentList, TalentDetail, PublicProfile, Profile, Notifications, Messages, Settings];

function preloadPages() {
    const run = () => PRELOAD.forEach((page) => page.preload().catch(() => {}));
    if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 1500);
}

// Protected Route Wrapper
const ProtectedRoute = ({ children }) => {
    const { user, loading } = useAuth();
    const location = useLocation();

    if (loading) return <div className="p-10 text-center">Loading...</div>;

    if (!user) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    return children;
};

// A page members share (a business, farm, opportunity or talent): the page
// itself when signed in; for anyone else its public preview, whose "See all
// details" signs in and comes back here.
const MemberOrPreview = ({ section, children }) => {
    const { user, loading } = useAuth();

    if (loading) return <div className="p-10 text-center">Loading...</div>;
    if (!user) return <SharePreview section={section} />;

    return children;
};

// Public Route (redirects to dashboard if logged in)
const PublicRoute = ({ children }) => {
    const { user, loading } = useAuth();
    if (loading) return null;
    if (user) return <Navigate to="/home" replace />;
    return children;
};

// Admin/Mod Route Guard
const AdminRoute = ({ children }) => {
    const { user, loading, isStaff } = useAuth();
    const location = useLocation();

    if (loading) return <div className="p-10 text-center">Loading...</div>;
    if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
    if (!isStaff) return <Navigate to="/home" replace />;

    return children;
};

// Runtime feature gate — renders the 404 page while an admin has the
// feature toggled off (matching the catch-all's ProtectedRoute + NotFound,
// so the URL is indistinguishable from a route that never existed).
// Admin routes are never wrapped: staff must always reach the toggles.
const FeatureRoute = ({ flag, children }) => {
    const enabled = useFeature(flag);
    if (!enabled) {
        return <ProtectedRoute><NotFound /></ProtectedRoute>;
    }
    return children;
};

/**
 * A link from before the directories and the marketplace had their own pages
 * (/discover/farms/…, /discover/certified/…): the same place at its new path.
 */
const Moved = ({ to }) => {
    const { '*': rest } = useParams();
    const { search } = useLocation();
    return <Navigate to={`${to}${rest ? `/${rest}` : ''}${search}`} replace />;
};

/** The old "add a listing" link, /discover/directory/new?type=farm|provider. */
const LegacyNewListing = () => {
    const { search } = useLocation();
    return <Navigate to={new URLSearchParams(search).get('type') === 'provider' ? '/trusted/new' : '/farms/new'} replace />;
};

/** A project's old page, /project/:id: it's an opportunity now. */
const ProjectMoved = () => {
    const { id } = useParams();
    return <Navigate to={`/opportunities/${id}`} replace />;
};

/** The old "new project" form (?edit=<id> to edit one): the opportunity form. */
const LegacyNewProject = () => {
    const edit = new URLSearchParams(useLocation().search).get('edit');
    return <Navigate to={edit ? `/opportunities/${edit}/edit` : '/opportunities/new?type=investment'} replace />;
};

const AppContent = () => {
    const { user, loading } = useAuth();
    const location = useLocation();
    const { setTheme } = useTheme();
    const { setDefaultView } = useViewPreference();
    const { applyServerTabs } = useBottomNav();
    const pointsEnabled = useFeature('points');
    const prefsLoaded = useRef(null); // id of the user whose server prefs were applied this session

    // Restore user preferences from backend on login. Keyed to the user id so
    // switching accounts without a full reload restores the right user's prefs.
    useEffect(() => {
        if (!user) {
            prefsLoaded.current = null;
            return;
        }
        if (prefsLoaded.current === user.id) return;
        prefsLoaded.current = user.id;
        preferencesApi.get().then(prefs => {
            if (prefs.theme) setTheme(prefs.theme);
            if (prefs.language) i18n.changeLanguage(prefs.language);
            if (prefs.projectsView) { localStorage.setItem('bies_projects_view', prefs.projectsView); setDefaultView(prefs.projectsView); }
            if (prefs.membersView) localStorage.setItem('bies_members_view', prefs.membersView);
            if (prefs.eventsView) localStorage.setItem('bies_events_view', prefs.eventsView);
            if (prefs.mediaView) localStorage.setItem('bies_media_view', prefs.mediaView);
            if (Array.isArray(prefs.bottomNavTabs)) applyServerTabs(prefs.bottomNavTabs);
        }).catch(() => {});
    }, [user?.id]);

    // Back returns to the same place on the page, a list included; any other
    // move starts at the top.
    useScrollMemory();

    // Report / Feedback starts on the page the member was on (utils/lastPage.js).
    useEffect(() => { rememberPage(location.pathname); }, [location.pathname]);

    // The phone app's launch screen (the BIES logo) goes once it's known who's
    // signed in and their first page has drawn: Home, or signing in, with
    // nothing in between. "/" only sends them on, so it waits for that page.
    useEffect(() => {
        if (loading || location.pathname === '/') return undefined;
        const frame = requestAnimationFrame(hideLaunchScreen);
        return () => cancelAnimationFrame(frame);
    }, [loading, location.pathname]);

    // Once someone is signed in and their first page is up, fetch the pages
    // they're likely to open next, so those open without waiting.
    const preloaded = useRef(false);
    useEffect(() => {
        if (loading || !user || preloaded.current) return;
        preloaded.current = true;
        preloadPages();
    }, [loading, user]);

    // Until it's known who's signed in, no page: the logo (in a browser too,
    // where there's no launch screen). It stays over "/" while that sends
    // them on to Home or to sign in.
    if (loading) return <BootSplash />;

    return (
        <>
            {location.pathname === '/' && <BootSplash />}
            <AppLinkListener />
            <BackButtonListener />
            <SystemBarsSync />
            {user && <Navbar />}
            <div className="app-content">
                <Suspense fallback={<PageLoading />}>
                <Routes>
                    {/* Public Routes */}
                    <Route path="/" element={user ? <Navigate to="/home" replace /> : <Navigate to="/login" replace />} />
                    <Route path="/home" element={
                        <ProtectedRoute><Home /></ProtectedRoute>
                    } />
                    <Route path="/feed" element={
                        <ProtectedRoute><Feed /></ProtectedRoute>
                    } />
                    <Route path="/login" element={<Login />} />
                    <Route path="/login/nostr" element={<Login nostr />} />
                    <Route path="/signup" element={<Signup />} />
                    {/* NIP-55 Amber intent callback (public — used mid-login) */}
                    <Route path="/amber-callback" element={<AmberCallback />} />
                    {/* Relay-access voucher redemption + onboarding invite landing (public) */}
                    <Route path="/access/:code" element={<VoucherRedeem />} />
                    <Route path="/join/:code" element={<Join />} />

                    {/* Farm Directory and BIES Trusted: pages of their own, so members can put them in their bottom bar */}
                    <Route path="/farms" element={<FeatureRoute flag="directories"><ProtectedRoute><DirectoryList type="FARM" /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/farms/new" element={<FeatureRoute flag="directories"><ProtectedRoute><CreateListing key="new-farm" type="FARM" /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/farms/:id" element={<FeatureRoute flag="directories"><MemberOrPreview section="farms"><ListingDetail /></MemberOrPreview></FeatureRoute>} />
                    <Route path="/farms/:id/edit" element={<FeatureRoute flag="directories"><ProtectedRoute><CreateListing editMode /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/trusted" element={<FeatureRoute flag="directories"><ProtectedRoute><DirectoryList type="PROVIDER" /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/trusted/new" element={<FeatureRoute flag="directories"><ProtectedRoute><CreateListing key="new-business" type="PROVIDER" /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/trusted/:id" element={<FeatureRoute flag="directories"><MemberOrPreview section="trusted"><ListingDetail /></MemberOrPreview></FeatureRoute>} />
                    <Route path="/trusted/:id/edit" element={<FeatureRoute flag="directories"><ProtectedRoute><CreateListing editMode /></ProtectedRoute></FeatureRoute>} />
                    {/* BIES Talents: members' skills and services, with their proof of work */}
                    <Route path="/talents" element={<FeatureRoute flag="talent"><ProtectedRoute><TalentList /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/talents/new" element={<FeatureRoute flag="talent"><ProtectedRoute><TalentForm key="new-talent" /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/talents/:id" element={<FeatureRoute flag="talent"><MemberOrPreview section="talents"><TalentDetail /></MemberOrPreview></FeatureRoute>} />
                    <Route path="/talents/:id/edit" element={<FeatureRoute flag="talent"><ProtectedRoute><TalentForm editMode /></ProtectedRoute></FeatureRoute>} />
                    {/* Opportunities: investments, businesses for sale, jobs, partnerships, programs (the projects flag) */}
                    <Route path="/opportunities" element={<FeatureRoute flag="projects"><ProtectedRoute><OpportunityList /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/opportunities/new" element={<FeatureRoute flag="projects"><ProtectedRoute><OpportunityForm key="new-opportunity" /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/opportunities/:id" element={<FeatureRoute flag="projects"><MemberOrPreview section="opportunities"><OpportunityDetail /></MemberOrPreview></FeatureRoute>} />
                    <Route path="/opportunities/:id/edit" element={<FeatureRoute flag="projects"><ProtectedRoute><OpportunityForm editMode /></ProtectedRoute></FeatureRoute>} />
                    {/* Marketplace: its own page too */}
                    {MARKETPLACE_ENABLED && (
                        <>
                            <Route path="/market" element={<FeatureRoute flag="marketplace"><ProtectedRoute><MarketplaceList /></ProtectedRoute></FeatureRoute>} />
                            <Route path="/market/new" element={<FeatureRoute flag="marketplace"><ProtectedRoute><CreateMarketListing /></ProtectedRoute></FeatureRoute>} />
                            <Route path="/market/:naddr/edit" element={<FeatureRoute flag="marketplace"><ProtectedRoute><CreateMarketListing editMode /></ProtectedRoute></FeatureRoute>} />
                            <Route path="/market/:naddr" element={<FeatureRoute flag="marketplace"><ProtectedRoute><MarketListingDetail /></ProtectedRoute></FeatureRoute>} />
                        </>
                    )}
                    {/* Their old paths under /discover (and "Certified", BIES Trusted's old name) still work */}
                    <Route path="/discover/farms/*" element={<Moved to="/farms" />} />
                    <Route path="/discover/trusted/*" element={<Moved to="/trusted" />} />
                    <Route path="/discover/certified/*" element={<Moved to="/trusted" />} />
                    <Route path="/discover/market/*" element={<Moved to="/market" />} />
                    <Route path="/discover/directory/new" element={<LegacyNewListing />} />
                    <Route path="/discover/directory/:id/edit" element={<FeatureRoute flag="directories"><ProtectedRoute><CreateListing editMode /></ProtectedRoute></FeatureRoute>} />
                    {/* Discover was projects and members: now Opportunities and Members (a search goes along) */}
                    <Route path="/discover" element={<Moved to="/members" />} />
                    <Route path="/events" element={<FeatureRoute flag="events"><ProtectedRoute><Events /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/events/create" element={
                        <FeatureRoute flag="events"><ProtectedRoute><EventForm key="new" /></ProtectedRoute></FeatureRoute>
                    } />
                    <Route path="/events/my" element={
                        <FeatureRoute flag="events"><ProtectedRoute><MyEvents /></ProtectedRoute></FeatureRoute>
                    } />
                    <Route path="/events/edit/:id" element={
                        <FeatureRoute flag="events"><ProtectedRoute><EventForm key="edit" /></ProtectedRoute></FeatureRoute>
                    } />
                    <Route path="/events/:id" element={<FeatureRoute flag="events"><MemberOrPreview section="events"><EventDetail /></MemberOrPreview></FeatureRoute>} />
                    <Route path="/members" element={<ProtectedRoute><Discover key="members" /></ProtectedRoute>} />
                    <Route path="/members/:userId/followers" element={<ProtectedRoute><FollowList key="followers" kind="followers" /></ProtectedRoute>} />
                    <Route path="/members/:userId/following" element={<ProtectedRoute><FollowList key="following" kind="following" /></ProtectedRoute>} />
                    <Route path="/members/:userId/network" element={<ProtectedRoute><FollowList key="network" kind="network" /></ProtectedRoute>} />
                    <Route path="/builders" element={<Navigate to="/members" replace />} />
                    <Route path="/builder/:id" element={<ProtectedRoute><PublicProfile type="builder" /></ProtectedRoute>} />
                    <Route path="/investors" element={<Navigate to="/members" replace />} />
                    <Route path="/investor/:id" element={<ProtectedRoute><PublicProfile type="investor" /></ProtectedRoute>} />
                    <Route path="/leaderboard" element={<FeatureRoute flag="points"><ProtectedRoute><Leaderboard /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/media" element={<FeatureRoute flag="media"><ProtectedRoute><Media /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/news" element={<FeatureRoute flag="news"><ProtectedRoute><News /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/news/:slug" element={<FeatureRoute flag="news"><ProtectedRoute><ArticleDetail /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/about" element={<ProtectedRoute><Team /></ProtectedRoute>} />
                    <Route path="/feedback" element={<FeatureRoute flag="feedback"><ProtectedRoute><Feedback /></ProtectedRoute></FeatureRoute>} />
                    {COWORK_ENABLED && (
                        <Route path="/cowork" element={<FeatureRoute flag="cowork"><ProtectedRoute><Cowork /></ProtectedRoute></FeatureRoute>} />
                    )}
                    {/* No build-time gate: the wallet page must stay reachable for
                        NWC-only users even if Coinos were re-disabled. Runtime-gated
                        by the 'zaps' slug only. */}
                    <Route path="/wallet" element={<FeatureRoute flag="zaps"><ProtectedRoute><Wallet /></ProtectedRoute></FeatureRoute>} />
                    {COURSES_ENABLED && (
                        <>
                            <Route path="/courses" element={<FeatureRoute flag="courses"><ProtectedRoute><CourseCatalog /></ProtectedRoute></FeatureRoute>} />
                            <Route path="/courses/:id" element={<FeatureRoute flag="courses"><ProtectedRoute><CourseDetail /></ProtectedRoute></FeatureRoute>} />
                            <Route path="/courses/:id/lesson/:lessonId" element={<FeatureRoute flag="courses"><ProtectedRoute><LessonPlayer /></ProtectedRoute></FeatureRoute>} />
                        </>
                    )}
                    {BOUNTIES_ENABLED && (
                        <>
                            <Route path="/bounties" element={<FeatureRoute flag="bounties"><ProtectedRoute><Bounties /></ProtectedRoute></FeatureRoute>} />
                            {/* /new must be declared before /:id */}
                            <Route path="/bounties/new" element={<FeatureRoute flag="bounties"><ProtectedRoute><CreateBounty /></ProtectedRoute></FeatureRoute>} />
                            <Route path="/bounties/:id" element={<FeatureRoute flag="bounties"><ProtectedRoute><BountyDetail /></ProtectedRoute></FeatureRoute>} />
                        </>
                    )}

                    {/* Protected Routes */}
                    {/* Specific Dashboard Routes */}
                    <Route path="/dashboard" element={
                        <FeatureRoute flag="dashboard">
                            <ProtectedRoute>
                                <Dashboard />
                            </ProtectedRoute>
                        </FeatureRoute>
                    }>
                        <Route index element={<Overview />} />
                        <Route path="projects" element={<Navigate to="/opportunities?mine=1" replace />} />
                        <Route path="events" element={<FeatureRoute flag="events"><MyEvents /></FeatureRoute>} />
                        <Route path="courses" element={<MyCourses />} />
                        <Route path="following" element={<Following />} />
                        <Route path="messages" element={<FeatureRoute flag="messages"><Messages /></FeatureRoute>} />
                        <Route path="analytics" element={<Analytics />} />
                        <Route path="settings" element={<Settings />} />
                        {/* Sub-routes */}
                        <Route path="builder/new-project" element={<LegacyNewProject />} />
                        {COURSES_ENABLED && (
                            <>
                                <Route path="builder/new-course" element={<NewCourse />} />
                                <Route path="builder/course/:id" element={<CourseBuilder />} />
                                <Route path="builder/course/:courseId/lesson/new" element={<LessonEditor />} />
                                <Route path="builder/course/:courseId/lesson/:lessonId" element={<LessonEditor />} />
                            </>
                        )}
                    </Route>

                    {/* Admin Routes */}
                    <Route path="/admin" element={
                        <AdminRoute>
                            <AdminDashboard />
                        </AdminRoute>
                    }>
                        <Route index element={<AdminOverview />} />
                        <Route path="projects" element={<AdminProjects />} />
                        <Route path="events" element={<AdminEvents />} />
                        <Route path="directory" element={<AdminDirectory />} />
                        <Route path="users" element={<AdminUsers />} />
                        <Route path="points" element={<AdminPoints />} />
                        <Route path="audit-log" element={<AdminAuditLog />} />
                        <Route path="news-settings" element={<AdminNewsSettings />} />
                        <Route path="investor-vetting" element={<AdminInvestorVetting />} />
                        <Route path="vouchers" element={<AdminVouchers />} />
                        <Route path="reports" element={<AdminReports />} />
                        <Route path="feedback" element={<AdminFeedback />} />
                        <Route path="features" element={<AdminFeatures />} />
                        {COURSES_ENABLED && <Route path="courses" element={<AdminCourses />} />}
                        <Route path="bounties" element={<AdminBounties />} />
                    </Route>

                    <Route path="/project/:id" element={<ProjectMoved />} />

                    {/* Old link: the name-and-photo step now opens over the app (ProfileGate). */}
                    <Route path="/profile-setup" element={<Navigate to="/home" replace />} />
                    <Route path="/profile" element={
                        <ProtectedRoute>
                            <Profile />
                        </ProtectedRoute>
                    } />
                    <Route path="/profile/edit" element={
                        <ProtectedRoute>
                            <ProfileEdit />
                        </ProtectedRoute>
                    } />
                    <Route path="/messages" element={
                        <FeatureRoute flag="messages">
                            <ProtectedRoute>
                                <Messages />
                            </ProtectedRoute>
                        </FeatureRoute>
                    } />
                    <Route path="/settings" element={
                        <ProtectedRoute>
                            <Settings />
                        </ProtectedRoute>
                    } />
                    {/* Guards itself: the session ends mid-way, and the page stays to say so. */}
                    <Route path="/settings/delete-account" element={<DeleteAccount />} />
                    <Route path="/settings/your-key" element={
                        <ProtectedRoute>
                            <TakeYourKey />
                        </ProtectedRoute>
                    } />
                    <Route path="/settings/blocked" element={
                        <ProtectedRoute>
                            <BlockedMembers />
                        </ProtectedRoute>
                    } />
                    <Route path="/settings/notifications" element={
                        <ProtectedRoute>
                            <NotificationSettings />
                        </ProtectedRoute>
                    } />
                    <Route path="/settings/nostr" element={
                        <ProtectedRoute>
                            <NostrKeys />
                        </ProtectedRoute>
                    } />
                    <Route path="/settings/privacy" element={
                        <ProtectedRoute>
                            <PrivacySettings />
                        </ProtectedRoute>
                    } />
                    <Route path="/albums/:id" element={<ProtectedRoute><AlbumPage /></ProtectedRoute>} />
                    {CUSTOM_BOTTOM_NAV_ENABLED && (
                        <Route path="/settings/navbar" element={
                            <ProtectedRoute>
                                <CustomizeNavbar />
                            </ProtectedRoute>
                        } />
                    )}
                    <Route path="/notifications" element={
                        <ProtectedRoute>
                            <Notifications />
                        </ProtectedRoute>
                    } />

                    {/* 404 Catch-all */}
                    <Route path="*" element={
                        <ProtectedRoute><NotFound /></ProtectedRoute>
                    } />
                </Routes>
                </Suspense>
            </div>
            {user && location.pathname !== '/settings/navbar' && <MobileBottomNav />}
            {/* Gamification toasts are part of the `points` feature */}
            {user && pointsEnabled && <GamificationToast />}
            {/* Unconditional: NIP-46 auth-url toasts must show during login, pre-auth */}
            <SignerToast />
            <VersionIndicator />
        </>
    );
};

function App() {
    return (
        <AuthProvider>
            <ThemeProvider>
                <ViewProvider>
                    <BottomNavProvider>
                        <UserModeProvider>
                            <LightboxProvider>
                                <FeatureFlagsProvider>
                                    <Router basename="/">
                                        <AppContent />
                                    </Router>
                                </FeatureFlagsProvider>
                            </LightboxProvider>
                        </UserModeProvider>
                    </BottomNavProvider>
                </ViewProvider>
            </ThemeProvider>
        </AuthProvider>
    );
}

export default App;
