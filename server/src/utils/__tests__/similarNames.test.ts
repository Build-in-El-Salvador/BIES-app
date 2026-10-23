import { describe, expect, it } from 'vitest';
import { nameSimilarity, nameWords, SIMILAR } from '../similarNames';

const alike = (a: string, b: string) => nameSimilarity(a, b) >= SIMILAR;

describe('similar business names', () => {
    it('reads names without capitals, accents, punctuation or small words', () => {
        expect(nameWords("The Verdi's Café & Bar, S.A.")).toEqual(['verdis', 'cafe', 'bar', 's']);
        expect(nameWords('La Doña de la Casa')).toEqual(['dona', 'casa']);
    });

    it('finds the same place however it was typed', () => {
        expect(alike('CasaFuego', 'Casa Fuego')).toBe(true);           // a space missed
        expect(alike('Casa  Fuego!', 'casa fuego')).toBe(true);        // capitals, punctuation, spaces
        expect(alike('Cassa Fuego', 'Casa Fuego')).toBe(true);         // a typo
        expect(alike('Monarka', 'Monarca')).toBe(true);
        expect(alike('Panaderia Luma', 'LUMA Panadería')).toBe(true);  // accents, word order
        expect(alike('The Alquimia Coffee', 'Alquimia Coffee')).toBe(true);
        expect(alike('Gastroteca', 'La Gastroteca')).toBe(true);
        expect(alike('Brutto', 'Brutto Restaurante')).toBe(true);      // more words on one
        expect(alike('HolandesErrante', 'El Holandés Errante')).toBe(true);
        expect(alike('Casa Fue', 'Casa Fuego')).toBe(true);            // still typing
        expect(alike('Verdis', "Verdi's")).toBe(true);
    });

    it('tells different places apart', () => {
        expect(alike('Hotel 1', 'Hotel 12')).toBe(false);              // numbers differ
        expect(alike('Biz 12', 'Biz 120')).toBe(false);
        expect(alike('Casas', 'Cosas')).toBe(false);                   // short words a letter apart
        expect(alike('Roka', 'Rosa')).toBe(false);
        expect(alike('Viva Vino', 'La Viña Enoteca')).toBe(false);
        expect(alike("Verdi's", 'Pasos Verdes')).toBe(false);
        expect(alike('Coffee Lab', 'Alquimia Coffee')).toBe(false);
        expect(alike('Finca M', 'Finca Ana')).toBe(false);
        expect(alike('San Salvador Bakery', 'San Salvador Coffee Roasters')).toBe(false);
        expect(nameSimilarity('', 'Casa')).toBe(0);
        expect(nameSimilarity('!!!', 'Casa')).toBe(0);
    });

    it('scores the closest higher', () => {
        expect(nameSimilarity('Casa Fuego', 'Casa Fuego')).toBe(1);
        expect(nameSimilarity('Brutto', 'Brutto Restaurante')).toBeGreaterThan(nameSimilarity('Brutto', 'Brutto Restaurante y Bar en San Benito'));
    });
});
