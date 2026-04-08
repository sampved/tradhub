import { Router } from 'express';
import { jobs, bids, users, notifications, uid } from '../db/store.js';
import { auth } from '../middleware/auth.js';
import { notifyUser } from '../ws.js';

const router = Router();

// GET /api/jobs — open jobs for tradesman map/list
router.get('/', auth, (req, res) => {
  const { trade, lat, lng, radius } = req.query;
  const list = jobs.open(trade, lat ? parseFloat(lat) : null, lng ? parseFloat(lng) : null, radius ? parseFloat(radius) : 50);
  res.json(list.map(j => jobs.withBids(j)));
});

// GET /api/jobs/mine — homeowner's jobs
router.get('/mine', auth, (req, res) => {
  res.json(jobs.byOwner(req.user.id).map(j => jobs.withBids(j)));
});

// GET /api/jobs/:id
router.get('/:id', auth, (req, res) => {
  const job = jobs.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(jobs.withBids(job));
});

// POST /api/jobs
router.post('/', auth, (req, res) => {
  if (req.user.role !== 'homeowner') return res.status(403).json({ error: 'Only homeowners can post jobs' });
  const { trade, title, description, urgency, budgetMin, budgetMax, address, city, zip, lat, lng } = req.body;
  if (!trade || !title || !description || !urgency || !address)
    return res.status(400).json({ error: 'Missing required fields' });
  const job = jobs.create({
    id: uid('j'), owner_id: req.user.id, trade, title, description, urgency,
    budget_min: budgetMin || 0, budget_max: budgetMax || 9999,
    address, city: city || null, zip: zip || null, lat: lat || null, lng: lng || null,
  });
  res.status(201).json(jobs.withBids(job));
});

// PATCH /api/jobs/:id/coords — store geocoded coordinates
router.patch('/:id/coords', auth, (req, res) => {
  jobs.update(req.params.id, { lat: req.body.lat, lng: req.body.lng });
  res.json({ ok: true });
});

// PATCH /api/jobs/:id/accept — accept a bid
router.patch('/:id/accept', auth, (req, res) => {
  const job = jobs.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
  const bid = bids.findById(req.body.bidId);
  if (!bid || bid.job_id !== job.id) return res.status(404).json({ error: 'Bid not found' });

  jobs.update(job.id, { status: 'inprogress', accepted_bid_id: bid.id });
  bids.update(bid.id, { status: 'accepted' });
  // Reject all other bids on this job
  bids.byJob(job.id).forEach(b => { if (b.id !== bid.id) bids.update(b.id, { status: 'rejected' }); });

  // Notify winning tradesman
  const n = notifications.create({ id: uid('n'), user_id: bid.bidder_id, type: 'accept',
    title: 'Bid accepted! 🎉', body: `Your bid of $${bid.price} on "${job.title}" was accepted.`, link: 'active-jobs-t' });
  notifyUser(bid.bidder_id, { type: 'notification', notification: n });

  res.json(jobs.withBids(jobs.findById(job.id)));
});

// PATCH /api/jobs/:id/complete
router.patch('/:id/complete', auth, (req, res) => {
  const job = jobs.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const acceptedBid = job.accepted_bid_id ? bids.findById(job.accepted_bid_id) : null;
  const isOwner = job.owner_id === req.user.id;
  const isTradesman = acceptedBid?.bidder_id === req.user.id;
  if (!isOwner && !isTradesman) return res.status(403).json({ error: 'Not authorized' });

  jobs.update(job.id, { status: 'completed', completed_at: Date.now() });

  if (isTradesman) {
    const n = notifications.create({ id: uid('n'), user_id: job.owner_id, type: 'complete',
      title: 'Job completed ✓', body: `"${job.title}" is done. Please leave a review.`, link: 'my-jobs' });
    notifyUser(job.owner_id, { type: 'notification', notification: n });
  }
  res.json({ ok: true });
});

// DELETE /api/jobs/:id
router.delete('/:id', auth, (req, res) => {
  const job = jobs.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
  jobs.update(req.params.id, { status: 'cancelled' });
  res.json({ ok: true });
});

export default router;
