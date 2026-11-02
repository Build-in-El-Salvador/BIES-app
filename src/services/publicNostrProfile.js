import { settingsApi } from './api';
import { nostrSigner } from './nostrSigner';

/**
 * Publish the member's profile on public Nostr now (Settings → Nostr). The
 * server builds it from the one already on public relays, with the parts
 * the member ticked (server: services/publicNostrProfile.ts). For a key BIES
 * holds the server signs and sends it. For a key on this device the server
 * returns it to sign here, and sends the signed one to the public relays.
 * Resolves to the server's answer: the settings, with `publishedAt`.
 */
export async function publishPublicProfile() {
    const first = await settingsApi.publishNostr();
    if (first.published || !first.template) return first;
    const signed = await nostrSigner.signEvent(first.template);
    return settingsApi.publishNostr(signed);
}
