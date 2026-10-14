import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { requireTerms, screenContent } from '../middleware/contentRules';
import {
    listAlbums,
    getAlbum,
    createAlbum,
    updateAlbum,
    deleteAlbum,
    addPhotos,
    updatePhoto,
    deletePhoto,
    createAlbumSchema,
    updateAlbumSchema,
    addPhotosSchema,
    updatePhotoSchema,
} from '../controllers/album.controller';

// Photo albums: a member's, or a farm's or business's (album.controller.ts).
const router = Router();

router.get('/', optionalAuth, listAlbums);
router.get('/:id', optionalAuth, getAlbum);
router.post('/', authenticate, requireTerms, validate(createAlbumSchema), screenContent(['title', 'description']), createAlbum);
router.patch('/:id', authenticate, requireTerms, validate(updateAlbumSchema), screenContent(['title', 'description']), updateAlbum);
router.delete('/:id', authenticate, deleteAlbum);
router.post('/:id/photos', authenticate, requireTerms, validate(addPhotosSchema), addPhotos);
router.patch('/:id/photos/:photoId', authenticate, requireTerms, validate(updatePhotoSchema), screenContent(['caption']), updatePhoto);
router.delete('/:id/photos/:photoId', authenticate, deletePhoto);

export default router;
