// The pages a report can be about (Report / Feedback, src/pages/Feedback.jsx),
// in the order the form lists them, with the paths that are part of each. The
// form starts on the page the member came from (pageFromPath); admins see
// the page by the same name (AdminFeedback.jsx). Labels: feedback.pages.<id>.
// `flag:` pages show only while their feature is on (in this copy of the app).
// The server takes any id of this shape (feedback.controller.ts), so a page
// added here needs nothing there.
export const FEEDBACK_PAGES = [
    { id: 'home', paths: ['/home'] },
    { id: 'feed', paths: ['/feed'] },
    { id: 'members', paths: ['/members', '/discover', '/builder', '/builders', '/investor', '/investors'] },
    { id: 'profile', paths: ['/profile', '/albums'] },
    { id: 'farms', paths: ['/farms', '/discover/farms'], flag: 'directories' },
    { id: 'trusted', paths: ['/trusted', '/discover/trusted', '/discover/certified'], flag: 'directories' },
    { id: 'talent', paths: ['/talents'], flag: 'talent' },
    { id: 'opportunities', paths: ['/opportunities', '/project'], flag: 'projects' },
    { id: 'events', paths: ['/events'], flag: 'events' },
    { id: 'messages', paths: ['/messages'], flag: 'messages' },
    { id: 'notifications', paths: ['/notifications'] },
    { id: 'settings', paths: ['/settings'] },
    { id: 'signin', paths: ['/login', '/signup', '/join', '/access'] },
    { id: 'other', paths: [] },
];

export const FEEDBACK_PAGE_IDS = FEEDBACK_PAGES.map((page) => page.id);

/**
 * The page a path is part of (the longest path that matches), or '' when it
 * isn't one of them (the form then asks).
 * @param {string} pathname
 */
export function pageFromPath(pathname) {
    if (typeof pathname !== 'string' || !pathname) return '';
    let best = { id: '', length: 0 };
    for (const page of FEEDBACK_PAGES) {
        for (const path of page.paths) {
            const matches = pathname === path || pathname.startsWith(`${path}/`);
            if (matches && path.length > best.length) best = { id: page.id, length: path.length };
        }
    }
    return best.id;
}
