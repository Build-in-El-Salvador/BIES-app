/**
 * A project as viewers get it: its pitch deck's storage key stays on the
 * server (decks are opened through getProjectDeck, which checks access);
 * `hasDeck` says whether there is one.
 */
export function withoutDeckKey<T extends { deckKey?: string | null }>(project: T): Omit<T, 'deckKey'> & { hasDeck: boolean } {
    const { deckKey, ...rest } = project;
    return { ...rest, hasDeck: !!deckKey };
}
