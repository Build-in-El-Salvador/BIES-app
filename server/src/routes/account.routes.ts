import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    confirmDeletion,
    deleteConfirmSchema,
    exportKeyHandler,
    keyExportSchema,
    keyReleaseSchema,
    langSchema,
    releaseKeyHandler,
    startDeletion,
    startKeyExport,
} from '../controllers/account.controller';

const router = Router();

router.use(authenticate);

// Delete the account (email code or Nostr signature, then gone for good).
router.post('/delete/start', validate(langSchema), startDeletion);
router.post('/delete', validate(deleteConfirmSchema), confirmDeletion);

// Take your key (email accounts): code, key, proof it was saved, release.
router.post('/key/start', validate(langSchema), startKeyExport);
router.post('/key/export', validate(keyExportSchema), exportKeyHandler);
router.post('/key/release', validate(keyReleaseSchema), releaseKeyHandler);

export default router;
