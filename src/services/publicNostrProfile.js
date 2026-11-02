import { settingsApi } from './api';
import { nostrSigner } from './nostrSigner';

/**
 * Publish the member's profile on public Nostr now (Settings → Nostr). The
 * server builds it from the one already on public relays, with the parts
 * the member ticked (server: services/publicNostrProfile.ts). For a key BIES
 * holds the server signs and sends it. For a key on this device the server
 * returns it to sign here, and sends the signed one to the public relays.
 * `seenAt`: when the public profile shown in the preview was made (null:
 * none was shown), so the server publishes nothing if it now finds less.
 * Resolves to the server's answer: the settings, with `publishedAt`.
 */
export async function publishPublicProfile(seenAt) {
    const extra = seenAt === undefined ? {} : { seenAt };
    const first = await settingsApi.publishNostr(extra);
    if (first.published || !first.template) return first;
    const signed = await nostrSigner.signEvent(first.template);
    return settingsApi.publishNostr({ ...extra, event: signed });
}

/**
 * Whether the member's key is on this device or in their signer, not held
 * by BIES. After a reload an extension or bunker session isn't restored
 * until it's used, so the stored sign-in method counts too.
 */
export function keyIsMembers() {
    return nostrSigner.signsOnDevice || (!!nostrSigner.storedMethod && nostrSigner.storedMethod !== 'hosted');
}
