/**
 * The server refuses objectionable words with reason `objectionable_content`
 * (server/src/services/contentFilter.ts). Its message is in English: say it
 * in the member's language. Null for any other error.
 */
export function objectionableMessage(t, err) {
    return err?.data?.reason === 'objectionable_content' ? t('moderation.objectionable') : null;
}
