import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth';
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
    postProjectUpdate,
    requestDeckAccess,
    deckRequestSchema,
    listDeckRequests,
    reviewDeckRequest,
    submitProject,
    expressInterest,
    listAllDeckRequests,
} from '../controllers/project.controller';

const router = Router();

const PROJECT_TEXT = ['title', 'description', 'tags', 'customSections', 'teamInfo', 'useOfFunds', 'ownerRole'];

// Public routes
router.get('/', optionalAuth, listProjects);

// Protected static routes (must come before /:id to avoid shadowing)
router.get('/builder/deck-requests', authenticate, listAllDeckRequests);

// Public single project
router.get('/:id', optionalAuth, getProject);
router.post('/', authenticate, requireTerms, validate(createProjectSchema), screenContent(PROJECT_TEXT), createProject);
router.put('/:id/submit', authenticate, submitProject);
router.put('/:id', authenticate, requireTerms, validate(updateProjectSchema), screenContent(PROJECT_TEXT), updateProject);
router.delete('/:id', authenticate, deleteProject);
router.get('/:id/deck', authenticate, getProjectDeck);
router.post('/:id/deck/request', authenticate, validate(deckRequestSchema), requestDeckAccess);
router.get('/:id/deck/requests', authenticate, listDeckRequests);
router.put('/:id/deck/requests/:requestId', authenticate, reviewDeckRequest);
router.post('/:id/interest', authenticate, expressInterest);
router.post('/:id/updates', authenticate, requireTerms, screenContent(['title', 'content']), postProjectUpdate);

export default router;
