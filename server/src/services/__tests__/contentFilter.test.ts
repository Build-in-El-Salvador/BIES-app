import { describe, it, expect } from 'vitest';
import { findObjectionable, normalize, objectionableField } from '../contentFilter';

describe('content filter', () => {
    it('finds slurs however they are cased, accented or spelled around', () => {
        expect(findObjectionable('You FAGGOT')).toBe('faggot');
        expect(findObjectionable('n1gg3r')).toBe('nigger');
        expect(findObjectionable('$lut')).toBe('slut');
        expect(findObjectionable('Maricón')).toBe('maricon');
        expect(findObjectionable('p.u.t.a')).toBeNull(); // letters split apart are words of one letter
        expect(findObjectionable('puta!!')).toBe('puta');
    });

    it('matches whole words and whole phrases only', () => {
        expect(findObjectionable('Scunthorpe skills, a fagot of firewood')).toBeNull();
        expect(findObjectionable('Computadora')).toBeNull();
        expect(findObjectionable('Please kill yourself')).toBe('kill yourself');
        expect(findObjectionable('skill yourselves up')).toBeNull();
        expect(findObjectionable('Hijo de PUTA')).toBe('puta'); // the word is caught first
        expect(findObjectionable('mátate')).toBe('matate');
    });

    it('leaves alone words with everyday uses in El Salvador', () => {
        for (const text of ['Café negro', 'Rapé artesanal', 'Un proyecto vergón', 'No sea pendejo', '¡Qué mierda de tráfico!']) {
            expect(findObjectionable(text)).toBeNull();
        }
    });

    it('ignores empty input', () => {
        expect(findObjectionable('')).toBeNull();
        expect(findObjectionable(null)).toBeNull();
        expect(findObjectionable('  !!! 123 ')).toBeNull();
    });

    it('normalizes to plain lower-case words', () => {
        expect(normalize('  Árbol, NIÑO & 4m1g0s ')).toBe('arbol nino amigos');
    });

    it('checks nested fields and names the first bad one', () => {
        expect(objectionableField({ name: 'Ana', skills: ['design', 'porn'], bio: 'slut' })).toBe('skills');
        expect(objectionableField({ experience: [{ title: 'CEO', description: 'cumshot' }] })).toBe('experience');
        expect(objectionableField({ name: 'Ana', minTicket: 5, isPublic: true })).toBeNull();
    });
});
