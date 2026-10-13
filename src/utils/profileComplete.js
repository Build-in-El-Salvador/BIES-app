/**
 * The name a Nostr sign-in gets until the member chooses one ("nostr:1a2b3c4d",
 * server/src/controllers/auth.controller.ts).
 */
export const isPlaceholderName = (name) => {
    const clean = (name || '').trim();
    return !clean || clean.startsWith('nostr:');
};

/**
 * Whether a signed-in member still has to choose their BIES name and photo.
 * The app asks for both before anything else (ProfileGate), so nobody shows
 * up as "nostr:1a2b3c4d" or a blank avatar.
 */
export const needsProfile = (user) =>
    !!user && (isPlaceholderName(user.profile?.name) || !user.profile?.avatar);
