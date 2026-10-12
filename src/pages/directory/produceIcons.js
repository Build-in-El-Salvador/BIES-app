import {
    Beef, Egg, Milk, Droplets, Carrot, Coffee, Hexagon, Drumstick, Leaf,
} from 'lucide-react';

/**
 * Produce icon mapping for directory listings.
 *
 * Products are stored as [{ label, icon }] where `icon` is an optional key
 * from PRODUCE_ICONS. When no key is set (or it is unknown), the label is
 * matched against keywords (EN + ES) so free-text products still get a
 * sensible icon. Falls back to Leaf.
 */

export const PRODUCE_ICONS = {
    beef: Beef,
    egg: Egg,
    milk: Milk,
    tallow: Droplets,
    vegetable: Carrot,
    coffee: Coffee,
    honey: Hexagon,
    chicken: Drumstick,
    leaf: Leaf,
};

export const PRODUCE_ICON_KEYS = Object.keys(PRODUCE_ICONS);

/** What a farm sells, for the farm directory's chips (labels: directory.produce.*). */
export const PRODUCE_KINDS = ['vegetable', 'egg', 'chicken', 'beef', 'milk', 'coffee', 'honey'];

const KEYWORD_RULES = [
    { key: 'beef', keywords: ['beef', 'meat', 'steak', 'pork', 'lamb', 'carne', 'res', 'cerdo'] },
    { key: 'egg', keywords: ['egg', 'huevo'] },
    { key: 'milk', keywords: ['milk', 'dairy', 'cheese', 'yogurt', 'leche', 'queso', 'lacteo'] },
    { key: 'tallow', keywords: ['tallow', 'oil', 'fat', 'ghee', 'sebo', 'aceite', 'manteca'] },
    { key: 'vegetable', keywords: ['vegetable', 'veggie', 'herb', 'greens', 'produce', 'fruit', 'verdura', 'hortaliza', 'hierba', 'fruta'] },
    { key: 'coffee', keywords: ['coffee', 'cafe'] },
    { key: 'honey', keywords: ['honey', 'miel'] },
    { key: 'chicken', keywords: ['chicken', 'poultry', 'turkey', 'pollo', 'ave', 'pavo'] },
];

// A keyword matches a whole word, its plural, or (4+ letters) the start of
// one: "huevos" and "cafetal" match, "fresas" isn't "res" and "avena" isn't "ave".
const matches = (word, k) =>
    word === k || word === `${k}s` || word === `${k}es` || (k.length >= 4 && word.startsWith(k));

/**
 * The PRODUCE_ICONS key for a product: its chosen icon, else the first
 * keyword its label matches; null for anything else.
 * @param {string|{label?: string, icon?: string}} product
 * @returns {string|null}
 */
export function produceKind(product) {
    if (!product) return null;

    const iconKey = typeof product === 'object' ? String(product.icon || '').toLowerCase() : '';
    if (PRODUCE_ICONS[iconKey]) return iconKey === 'leaf' ? null : iconKey; // 'leaf': chosen as "other"

    const words = (typeof product === 'string' ? product : product.label || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // strip accents so "café" matches "cafe"
        .split(/[^a-z]+/)
        .filter(Boolean);

    const rule = KEYWORD_RULES.find((r) => r.keywords.some((k) => words.some((w) => matches(w, k))));
    return rule ? rule.key : null;
}

/**
 * Resolve the lucide icon component for a product.
 * @param {string|{label?: string, icon?: string}} product
 * @returns {import('lucide-react').LucideIcon}
 */
export function getProduceIcon(product) {
    return PRODUCE_ICONS[produceKind(product)] || Leaf;
}
