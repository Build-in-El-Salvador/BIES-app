/** What to tell the member when an account request fails. */
export function accountErrorMessage(t, err) {
    const data = err?.data || {};
    switch (data.reason) {
        case 'rate_limited':
            return t('account.errors.rateLimited', { count: Math.max(1, Math.ceil((data.retryAfterSeconds || 60) / 60)) });
        case 'busy':
            return t('account.errors.busy');
        case 'send_failed':
            return t('account.errors.sendFailed');
        case 'invalid_code':
            return data.attemptsLeft > 0
                ? t('account.errors.wrongCode', { count: data.attemptsLeft })
                : t('account.errors.codeUsedUp');
        case 'code_expired':
            return t('account.errors.codeExpired');
        case 'challenge_expired':
            return t('account.errors.challengeExpired');
        case 'bad_signature':
            return t('account.errors.badSignature');
        case 'not_hosted':
            return t('account.errors.notHosted');
        case 'review_account':
            return t('account.errors.reviewAccount');
        default:
            return t('account.errors.generic');
    }
}
