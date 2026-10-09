import React, { useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { UserModeProvider, useUserMode } from './context/UserModeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { ViewProvider, useViewPreference } from './context/ViewContext';
import { LightboxProvider } from './context/LightboxContext';
import { BottomNavProvider, useBottomNav } from './context/BottomNavContext';
import { FeatureFlagsProvider, useFeature } from './context/FeatureFlagsContext';
import { BOUNTIES_ENABLED, COWORK_ENABLED, CUSTOM_BOTTOM_NAV_ENABLED, COURSES_ENABLED, MARKETPLACE_ENABLED } from './config/featureFlags';
import { preferencesApi } from './services/api';
import i18n from './i18n';
import Navbar from './components/Navbar';
import MobileBottomNav from './components/MobileBottomNav';
import ModeSelectionModal from './components/ModeSelectionModal';
import VersionIndicator from './components/VersionIndicator';
import GamificationToast from './components/GamificationToast';
import SignerToast from './components/SignerToast';

// Pages
import Landing from './pages/Landing';
import Feed from './pages/Feed';
import Discover from './pages/Discover';
import Members from './pages/Members';
import Builders from './pages/Builders';
import Investors from './pages/Investors';
import Media from './pages/Media';
import News from './pages/News';
import Events from './pages/Events';
import EventDetail from './pages/EventDetail';
import CreateEvent from './pages/CreateEvent';
import EditEvent from './pages/EditEvent';
import MyEvents from './pages/MyEvents';
import Team from './pages/Team';
import PublicProfile from './pages/PublicProfile';
import Profile from './pages/Profile';
import ProfileEdit from './pages/ProfileEdit';
import Messages from './pages/Messages';
import Settings from './pages/Settings';
import CustomizeNavbar from './pages/CustomizeNavbar';
import Cowork from './pages/Cowork';
import Wallet from './pages/Wallet';
import Bounties from './pages/Bounties';
import BountyDetail from './pages/BountyDetail';
import CreateBounty from './pages/CreateBounty';
import ProjectDetails from './pages/ProjectDetails';
import Notifications from './pages/Notifications';
import ArticleDetail from './pages/ArticleDetail';
import Login from './pages/Login';
import Signup from './pages/Signup';
import AmberCallback from './pages/AmberCallback';
import VoucherRedeem from './pages/VoucherRedeem';
import Join from './pages/Join';
import ProfileSetup from './pages/ProfileSetup';
import Dashboard from './pages/Dashboard';
import Leaderboard from './pages/Leaderboard';
import Overview from './pages/Overview';
import Following from './pages/Following';
import NotFound from './pages/NotFound';

import DirectoryList from './pages/directory/DirectoryList';
import ListingDetail from './pages/directory/ListingDetail';
import CreateListing from './pages/directory/CreateListing';

import MarketplaceList from './pages/marketplace/MarketplaceList';
import MarketListingDetail from './pages/marketplace/MarketListingDetail';
import CreateMarketListing from './pages/marketplace/CreateMarketListing';

import MyProjects from './pages/builder/MyProjects';
import Analytics from './pages/builder/Analytics';
import NewProject from './pages/builder/NewProject';
import MyCourses from './pages/educator/MyCourses';
import NewCourse from './pages/educator/NewCourse';
import CourseBuilder from './pages/educator/CourseBuilder';
import LessonEditor from './pages/educator/LessonEditor';
import CourseCatalog from './pages/courses/CourseCatalog';
import CourseDetail from './pages/courses/CourseDetail';
import LessonPlayer from './pages/courses/LessonPlayer';

// Admin pages
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminOverview from './pages/admin/AdminOverview';
import AdminProjects from './pages/admin/AdminProjects';
import AdminEvents from './pages/admin/AdminEvents';
import AdminDirectory from './pages/admin/AdminDirectory';
import AdminUsers from './pages/admin/AdminUsers';
import AdminPoints from './pages/admin/AdminPoints';
import AdminAuditLog from './pages/admin/AdminAuditLog';
import AdminNewsSettings from './pages/admin/AdminNewsSettings';
import AdminInvestorVetting from './pages/admin/AdminInvestorVetting';
import AdminVouchers from './pages/admin/AdminVouchers';
import AdminFeedback from './pages/admin/AdminFeedback';
import AdminCourses from './pages/admin/AdminCourses';
import AdminBounties from './pages/admin/AdminBounties';
import AdminFeatures from './pages/admin/AdminFeatures';
import Feedback from './pages/Feedback';

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

// Public Route (redirects to dashboard if logged in)
const PublicRoute = ({ children }) => {
    const { user, loading } = useAuth();
    if (loading) return null;
    if (user) return <Navigate to="/feed" replace />;
    return children;
};

// Admin/Mod Route Guard
const AdminRoute = ({ children }) => {
    const { user, loading, isStaff } = useAuth();
    const location = useLocation();

    if (loading) return <div className="p-10 text-center">Loading...</div>;
    if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
    if (!isStaff) return <Navigate to="/dashboard" replace />;

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

const AppContent = () => {
    const { user } = useAuth();
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

    // Scroll to top on route change (bottom nav, links, etc.)
    useEffect(() => {
        window.scrollTo(0, 0);
    }, [location.pathname]);

    return (
        <>
            {user && <Navbar />}
            <div className="app-content">
                <Routes>
                    {/* Public Routes */}
                    <Route path="/" element={user ? <Navigate to="/feed" replace /> : <Navigate to="/login" replace />} />
                    <Route path="/feed" element={
                        <ProtectedRoute><Feed /></ProtectedRoute>
                    } />
                    <Route path="/login" element={<Login />} />
                    <Route path="/signup" element={<Signup />} />
                    {/* NIP-55 Amber intent callback (public — used mid-login) */}
                    <Route path="/amber-callback" element={<AmberCallback />} />
                    {/* Relay-access voucher redemption + onboarding invite landing (public) */}
                    <Route path="/access/:code" element={<VoucherRedeem />} />
                    <Route path="/join/:code" element={<Join />} />

                    {/* Directories (declared before the generic /discover route) */}
                    <Route path="/discover/farms" element={<FeatureRoute flag="directories"><ProtectedRoute><DirectoryList type="FARM" /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/discover/farms/:id" element={<FeatureRoute flag="directories"><ProtectedRoute><ListingDetail /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/discover/certified" element={<FeatureRoute flag="directories"><ProtectedRoute><DirectoryList type="PROVIDER" /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/discover/certified/:id" element={<FeatureRoute flag="directories"><ProtectedRoute><ListingDetail /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/discover/directory/new" element={<FeatureRoute flag="directories"><ProtectedRoute><CreateListing /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/discover/directory/:id/edit" element={<FeatureRoute flag="directories"><ProtectedRoute><CreateListing editMode /></ProtectedRoute></FeatureRoute>} />
                    {/* Marketplace (declared before the generic /discover route) */}
                    {MARKETPLACE_ENABLED && (
                        <>
                            <Route path="/discover/market" element={<FeatureRoute flag="marketplace"><ProtectedRoute><MarketplaceList /></ProtectedRoute></FeatureRoute>} />
                            <Route path="/discover/market/new" element={<FeatureRoute flag="marketplace"><ProtectedRoute><CreateMarketListing /></ProtectedRoute></FeatureRoute>} />
                            <Route path="/discover/market/:naddr/edit" element={<FeatureRoute flag="marketplace"><ProtectedRoute><CreateMarketListing editMode /></ProtectedRoute></FeatureRoute>} />
                            <Route path="/discover/market/:naddr" element={<FeatureRoute flag="marketplace"><ProtectedRoute><MarketListingDetail /></ProtectedRoute></FeatureRoute>} />
                        </>
                    )}
                    <Route path="/discover" element={<ProtectedRoute><Discover /></ProtectedRoute>} />
                    <Route path="/events" element={<FeatureRoute flag="events"><ProtectedRoute><Events /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/events/create" element={
                        <FeatureRoute flag="events"><ProtectedRoute><CreateEvent /></ProtectedRoute></FeatureRoute>
                    } />
                    <Route path="/events/my" element={
                        <FeatureRoute flag="events"><ProtectedRoute><MyEvents /></ProtectedRoute></FeatureRoute>
                    } />
                    <Route path="/events/edit/:id" element={
                        <FeatureRoute flag="events"><ProtectedRoute><EditEvent /></ProtectedRoute></FeatureRoute>
                    } />
                    <Route path="/events/:id" element={<FeatureRoute flag="events"><ProtectedRoute><EventDetail /></ProtectedRoute></FeatureRoute>} />
                    <Route path="/members" element={<Navigate to="/discover" replace />} />
                    <Route path="/builders" element={<Navigate to="/discover" replace />} />
                    <Route path="/builder/:id" element={<ProtectedRoute><PublicProfile type="builder" /></ProtectedRoute>} />
                    <Route path="/investors" element={<Navigate to="/discover" replace />} />
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
                            <Route path="/courses" element={<ProtectedRoute><CourseCatalog /></ProtectedRoute>} />
                            <Route path="/courses/:id" element={<ProtectedRoute><CourseDetail /></ProtectedRoute>} />
                            <Route path="/courses/:id/lesson/:lessonId" element={<ProtectedRoute><LessonPlayer /></ProtectedRoute>} />
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
                        <ProtectedRoute>
                            <Dashboard />
                        </ProtectedRoute>
                    }>
                        <Route index element={<Overview />} />
                        <Route path="projects" element={<FeatureRoute flag="projects"><MyProjects /></FeatureRoute>} />
                        <Route path="events" element={<FeatureRoute flag="events"><MyEvents /></FeatureRoute>} />
                        <Route path="courses" element={<MyCourses />} />
                        <Route path="following" element={<Following />} />
                        <Route path="messages" element={<FeatureRoute flag="messages"><Messages /></FeatureRoute>} />
                        <Route path="analytics" element={<Analytics />} />
                        <Route path="settings" element={<Settings />} />
                        {/* Sub-routes */}
                        <Route path="builder/new-project" element={<FeatureRoute flag="projects"><NewProject /></FeatureRoute>} />
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
                        <Route path="feedback" element={<AdminFeedback />} />
                        <Route path="features" element={<AdminFeatures />} />
                        {COURSES_ENABLED && <Route path="courses" element={<AdminCourses />} />}
                        <Route path="bounties" element={<AdminBounties />} />
                    </Route>

                    <Route path="/project/:id" element={
                        <FeatureRoute flag="projects">
                            <ProtectedRoute>
                                <ProjectDetails />
                            </ProtectedRoute>
                        </FeatureRoute>
                    } />

                    <Route path="/profile-setup" element={
                        <ProtectedRoute>
                            <ProfileSetup />
                        </ProtectedRoute>
                    } />
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
