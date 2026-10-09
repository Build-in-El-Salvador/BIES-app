// Feature flags — flip these to enable/disable features without removing code.
export const PASSKEY_ENABLED = true;
export const NIP46_ENABLED = true;
export const AMBER_NIP55_ENABLED = true; // "Sign in with Amber (app)" via nostrsigner: intents (Android only)
export const COINOS_SIGNUP_WALLET = false; // Auto-provision Coinos custodial wallet on signup
export const COINOS_ENABLED = true;        // Built-in wallet switch — Coinos custodial wallet (create/connect) in Settings + /wallet
export const COWORK_ENABLED = true; // Cowork check-in page (/cowork)
export const CUSTOM_BOTTOM_NAV_ENABLED = true; // Customizable mobile bottom navbar
export const COURSES_ENABLED = true; // Courses/LMS (catalog, authoring, enrollment)
export const MARKETPLACE_ENABLED = true; // Shopstr-compatible NIP-99 marketplace (/discover/market)
export const BOUNTIES_ENABLED = true; // Bounty board (/bounties)
export const ANDROID_PUSH_ENABLED = false; // Native push on Android (FCM). Leave off until android/app/google-services.json exists and the server can send FCM; registering without Firebase can crash the app.
