import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireTerms, screenContent } from '../middleware/contentRules';
import { validate } from '../middleware/validate';
import {
    listProjects,
    getProject,
    createProject,
    createProjectSchema,
    updateProject,
    updateProjectSchema,
    deleteProject,
    getProjectDeck,
    requestDeckAccess,
    deckRequestSchema,
    listDeckRequests,
    reviewDeckRequest,
} from '../controllers/project.controller';

const router = Router();

// Opportunities (the API keeps the name it had when they were all projects).
const PROJECT_TEXT = ['title', 'description', 'location', 'pay'];

// Members only: a member's WhatsApp and email are on it.
router.get('/', authenticate, listProjects);

router.get('/:id', authenticate, getProject);
router.post('/', authenticate, requireTerms, validate(createProjectSchema), screenContent(PROJECT_TEXT), createProject);
router.put('/:id', authenticate, requireTerms, validate(updateProjectSchema), screenContent(PROJECT_TEXT), updateProject);
router.delete('/:id', authenticate, deleteProject);
router.get('/:id/deck', authenticate, getProjectDeck);
router.post('/:id/deck/request', authenticate, validate(deckRequestSchema), requestDeckAccess);
router.get('/:id/deck/requests', authenticate, listDeckRequests);
router.put('/:id/deck/requests/:requestId', authenticate, reviewDeckRequest);

export default router;
