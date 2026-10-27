import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireTerms, screenContent } from '../middleware/contentRules';
import { validate } from '../middleware/validate';
import { moneyLimiter } from '../middleware/rateLimit';
import {
    listEvents,
    getEvent,
    createEvent,
    createEventSchema,
    updateEvent,
    updateEventSchema,
    deleteEvent,
    listMyEvents,
    listAttendingEvents,
    endorseEvent,
    rsvpEvent,
    cancelRsvp,
    inviteToEvent,
    removePartner,
    callOffEvent,
} from '../controllers/events.controller';
import { importEventFromUrl } from '../controllers/eventImport.controller';
import {
    createTicket,
    getTicket,
    claimTicket,
    claimTicketSchema,
    payTicketWithWallet,
    payTicketSchema,
    listMyEventTickets,
    listEventTickets,
    checkinTicket,
    listMyTickets,
} from '../controllers/tickets.controller';

const router = Router();

const EVENT_TEXT = ['title', 'description', 'location', 'locationName', 'locationAddress', 'priceLabel', 'tags', 'customSections'];

// Members only, like the rest of the app. Signed out, a shared event's
// preview comes from /api/preview/events/:id (no guest list or links).
router.get('/', authenticate, listEvents);

// Protected: my events (must come before /:id to avoid shadowing)
router.get('/my', authenticate, listMyEvents);
router.get('/attending', authenticate, listAttendingEvents);
router.get('/tickets/mine', authenticate, listMyTickets);

router.get('/:id', authenticate, getEvent);

// Protected routes
router.post('/import-url', authenticate, importEventFromUrl);
router.post('/', authenticate, requireTerms, validate(createEventSchema), screenContent(EVENT_TEXT), createEvent);
router.put('/:id', authenticate, requireTerms, validate(updateEventSchema), screenContent(EVENT_TEXT), updateEvent);
router.delete('/:id', authenticate, deleteEvent);
router.put('/:id/endorse', authenticate, endorseEvent);
router.post('/:id/rsvp', authenticate, rsvpEvent);
router.delete('/:id/rsvp', authenticate, cancelRsvp);
// A proposed meetup's proposer calling it off (everyone in is told)
router.post('/:id/call-off', authenticate, callOffEvent);
router.post('/:id/invite', authenticate, inviteToEvent);
// A co-host or sponsor taking their name off (or whoever can edit it)
router.delete('/:id/partners/:partnerId', authenticate, removePartner);

// Ticketing (non-custodial Lightning payments straight to the event host)
// Invoice creation hits the host's LNURL server — strict-limit it to block
// invoice-spam (moneyLimiter, per-IP, alongside the general limiter).
router.post('/:id/tickets', moneyLimiter, authenticate, createTicket);
router.get('/:id/tickets/mine', authenticate, listMyEventTickets); // before /:ticketId
router.get('/:id/tickets', authenticate, listEventTickets);
router.get('/:id/tickets/:ticketId', authenticate, getTicket);
router.post('/:id/tickets/:ticketId/claim', authenticate, validate(claimTicketSchema), claimTicket);
// Server-side wallet payment (Coinos). Requests are serialized per ticket, and
// the server never pays an already-PAID ticket; the client must never
// auto-retry it (see payTicketWithWallet).
router.post('/:id/tickets/:ticketId/pay', moneyLimiter, authenticate, validate(payTicketSchema), payTicketWithWallet);
router.post('/:id/tickets/:ticketId/checkin', authenticate, checkinTicket);

export default router;
