/**
 * What Android's Back button closes first. Something open on top of the page
 * (the side menu) adds a handler while it's open; Back runs the newest one
 * instead of leaving the page (BackButtonListener).
 *
 * Pure module (no browser globals) so it runs under `node --test`.
 */
const handlers = [];

/**
 * @param {() => void} handler - closes the thing that's open
 * @returns {() => void} removes the handler
 */
export function addBackHandler(handler) {
    handlers.push(handler);
    return () => {
        const i = handlers.lastIndexOf(handler);
        if (i !== -1) handlers.splice(i, 1);
    };
}

/** Runs the newest handler. False when nothing is open. */
export function runBackHandler() {
    const handler = handlers[handlers.length - 1];
    if (!handler) return false;
    handler();
    return true;
}
