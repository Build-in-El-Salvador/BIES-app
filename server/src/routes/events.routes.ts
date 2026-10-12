import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth';
import { requireTerms, screenContent } from '../middleware/contentRules';
import { validate } from '../middleware/validate';
import { moneyLimiter } from '../middleware/rateLimit';
import {
    listEvents,
    getEvent,
    getEventOG,
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

const EVENT_TEXT = ['title', 'description', 'location', 'locationName', 'locationAddress', 'tags', 'customSections'];

// Public routes
router.get('/', optionalAuth, listEvents);

// Protected: my events (must come before /:id to avoid shadowing)
router.get('/my', authenticate, listMyEvents);
router.get('/attending', authenticate, listAttendingEvents);
router.get('/tickets/mine', authenticate, listMyTickets);

// Public single event
router.get('/:id/og', getEventOG);
router.get('/:id', optionalAuth, getEvent);

// Protected routes
router.post('/import-url', authenticate, importEventFromUrl);
router.post('/', authenticate, requireTerms, validate(createEventSchema), screenContent(EVENT_TEXT), createEvent);
router.put('/:id', authenticate, requireTerms, validate(updateEventSchema), screenContent(EVENT_TEXT), updateEvent);
router.delete('/:id', authenticate, deleteEvent);
router.put('/:id/endorse', authenticate, endorseEvent);
router.post('/:id/rsvp', authenticate, rsvpEvent);
router.delete('/:id/rsvp', authenticate, cancelRsvp);
router.post('/:id/invite', authenticate, inviteToEvent);

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
