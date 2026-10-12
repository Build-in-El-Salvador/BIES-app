/**
 * BIES's legal and support pages on buildinelsalvador.com, in each language
 * the app speaks. The terms of use are what members accept (TermsGate).
 */
export const LEGAL_PAGES = {
    en: {
        terms: 'https://buildinelsalvador.com/terms',
        privacy: 'https://buildinelsalvador.com/privacy',
        support: 'https://buildinelsalvador.com/support',
    },
    es: {
        terms: 'https://buildinelsalvador.com/terminos',
        privacy: 'https://buildinelsalvador.com/privacidad',
        support: 'https://buildinelsalvador.com/soporte',
    },
};

export const SUPPORT_EMAIL = 'info@buildinelsalvador.com';

/** The page in the app's language: 'terms' | 'privacy' | 'support'. */
export function legalPage(i18nLanguage, page) {
    const lang = i18nLanguage?.startsWith('es') ? 'es' : 'en';
    return LEGAL_PAGES[lang][page];
}
