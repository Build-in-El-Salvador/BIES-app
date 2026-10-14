/**
 * The link fields of a member's Nostr profile (kind 0), as Settings → Privacy
 * → Links allows. Other members can read the BIES relay, so with "Only me"
 * the fields are sent empty, which removes them when nostrService merges with
 * the profile already there. Otherwise only the filled-in ones are sent, so
 * links a member set in another Nostr app stay. (The server does the same for
 * keys BIES holds: profilePrivacy.ts nostrProfileFor.)
 */
export function nostrLinkFields({ website, lightningAddress, bolt12Offer, nip05Name } = {}, privacy = null) {
    if (privacy?.links === 'ONLY_ME') return { website: '', lud16: '', lud06: '', bolt12: '', nip05: '' };
    const fields = {};
    if (website) fields.website = website;
    if (lightningAddress) {
        if (lightningAddress.toLowerCase().startsWith('lnurl1')) fields.lud06 = lightningAddress;
        else fields.lud16 = lightningAddress;
    }
    if (bolt12Offer) fields.bolt12 = bolt12Offer;
    if (nip05Name) fields.nip05 = `${nip05Name.toLowerCase()}@buildinelsalvador.com`;
    return fields;
}
