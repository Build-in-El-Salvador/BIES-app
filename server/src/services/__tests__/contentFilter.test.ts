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
        expect(findObjectionable('suicídate')).toBe('suicidate');
    });

    it('leaves alone words with everyday uses', () => {
        for (const text of [
            'Café negro', 'Rapé artesanal', 'Un proyecto vergón', 'No sea pendejo', '¡Qué mierda de tráfico!',
            'Tacos Don Kike', 'Enrique "Kike" López', 'Matate de pita', 'Cold storage retards ripening',
            'Tranny and clutch repair', 'Spic and span cleaning', 'A chink in the armor', 'Food porn burgers',
            'FAG bearings', 'F4G', 'Desde $500', 'Llame al 7777-1234', 'Open 24/7',
        ]) {
            expect(findObjectionable(text), text).toBeNull();
        }
    });

    it('sees through invisible characters, look-alike letters and tags inside a word', () => {
        expect(findObjectionable('nig\u200Bger')).toBe('nigger');
        expect(findObjectionable('sl\u00ADut')).toBe('slut');
        expect(findObjectionable('nіgger')).toBe('nigger'); // Cyrillic і
        expect(findObjectionable('рuta')).toBe('puta'); // Cyrillic р
        expect(findObjectionable('ｓｌｕｔ')).toBe('slut'); // full-width
        expect(findObjectionable('<b>nig</b>ger')).toBe('nigger');
        expect(findObjectionable('<p>hola</p><p>puta</p>')).toBe('puta');
        expect(findObjectionable('<p>hola</p><p>amigos</p>')).toBeNull();
    });

    it('ignores empty input', () => {
        expect(findObjectionable('')).toBeNull();
        expect(findObjectionable(null)).toBeNull();
        expect(findObjectionable('  !!! 123 ')).toBeNull();
    });

    it('normalizes to plain lower-case words', () => {
        expect(normalize('  Árbol, NIÑO & 4m1g0s ')).toBe('arbol nino amigos');
        // Numbers stay numbers: only words with letters get their swaps undone.
        expect(normalize('Desde $500, abierto 24/7, tel. 7777-1234')).toBe('desde abierto tel');
    });

    it('checks nested fields and names the first bad one', () => {
        expect(objectionableField({ name: 'Ana', skills: ['design', 'porno'], bio: 'slut' })).toBe('skills');
        expect(objectionableField({ experience: [{ title: 'CEO', description: 'cumshot' }] })).toBe('experience');
        expect(objectionableField({ name: 'Ana', minTicket: 5, isPublic: true })).toBeNull();
    });
});
