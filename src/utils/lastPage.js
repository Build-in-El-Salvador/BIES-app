// The page a member was on before Report / Feedback: App.jsx tells it every
// page they open, and the form starts on the last one (config/feedbackPages.js).
let last = '';

/** A page the member opened (its path). Report / Feedback itself isn't kept. */
export function rememberPage(pathname) {
    if (typeof pathname === 'string' && !pathname.startsWith('/feedback')) last = pathname;
}

/** The path of the page before Report / Feedback, or '' if there wasn't one. */
export function lastPage() {
    return last;
}
