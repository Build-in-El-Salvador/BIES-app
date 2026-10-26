/**
 * An edit changes only what it sends. zod 4's .partial() fills in .default()
 * values for fields left out, so an update schema built from a create schema
 * must not, or a one-field edit (an event's visibility) resets the rest.
 */
import { describe, it, expect } from 'vitest';
import { updateDirectoryListingSchema } from '../controllers/directory.controller';
import { updateProjectSchema } from '../controllers/project.controller';
import { updateTalentSchema } from '../controllers/talent.controller';
import { updateCourseSchema } from '../controllers/courses.controller';
import { updateArticleSchema } from '../controllers/content.controller';
import { updateEventSchema } from '../controllers/events.controller';

const UPDATE_SCHEMAS = {
    updateDirectoryListingSchema, updateProjectSchema, updateTalentSchema,
    updateCourseSchema, updateArticleSchema, updateEventSchema,
};

describe('update schemas', () => {
    it.each(Object.entries(UPDATE_SCHEMAS))('%s adds nothing that was not sent', (_name, schema) => {
        expect(schema.parse({})).toEqual({});
    });

    it('keep what was sent, and still check it', () => {
        expect(updateEventSchema.parse({ visibility: 'DRAFT' })).toEqual({ visibility: 'DRAFT' });
        expect(updateEventSchema.safeParse({ visibility: 'SECRET' }).success).toBe(false);
        expect(updateCourseSchema.parse({ level: 'ADVANCED' })).toEqual({ level: 'ADVANCED' });
        expect(updateArticleSchema.parse({ category: 'GUIDE' })).toEqual({ category: 'GUIDE' });
    });
});
