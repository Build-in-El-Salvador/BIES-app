/**
 * The name a Nostr sign-in gets until the member chooses one ("nostr:1a2b3c4d",
 * server/src/controllers/auth.controller.ts).
 */
export const isPlaceholderName = (name) => {
    const clean = (name || '').trim();
    return !clean || clean.startsWith('nostr:');
};

/**
 * Whether a signed-in member still has to choose their BIES name. The app
 * asks before anything else (ProfileGate), so nobody shows up as
 * "nostr:1a2b3c4d"; a photo is offered there too, but optional.
 */
export const needsProfile = (user) => !!user && isPlaceholderName(user.profile?.name);
