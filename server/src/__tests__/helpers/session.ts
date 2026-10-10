/**
 * Sessions for tests that mock Prisma: an access token for a fixture user,
 * in a session named `s-<userId>`, and a `prisma.session.findUnique` stand-in
 * that finds that session live for any user the test knows.
 */

import { signAccessToken } from '../../services/session.service';

type FixtureUser = Record<string, unknown> & { id: string; role?: unknown; isAdmin?: unknown };

export function testToken(user: FixtureUser): string {
    return signAccessToken(
        { id: user.id, role: String(user.role ?? 'MEMBER'), isAdmin: Boolean(user.isAdmin) },
        `s-${user.id}`,
    );
}

export function liveSessionLookup(findUser: (id: string) => FixtureUser | null | undefined) {
    return async ({ where }: { where: { id: string } }) => {
        const user = where.id.startsWith('s-') ? findUser(where.id.slice(2)) : null;
        if (!user) return null;
        const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
        return {
            userId: user.id,
            revokedAt: null,
            expiresAt: later,
            maxExpiresAt: later,
            user: {
                id: user.id,
                email: user.email ?? null,
                nostrPubkey: user.nostrPubkey,
                role: user.role ?? 'MEMBER',
                isAdmin: user.isAdmin ?? false,
                isBanned: user.isBanned ?? false,
                deletedAt: user.deletedAt ?? null,
            },
        };
    };
}
