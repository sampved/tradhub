import { Router } from 'express';
import { bids, jobs, profiles, notifications, uid } from '../db/store.js';
import { auth } from '../middleware/auth.js';
import { notifyUser } from '../ws.js';

const router = Router();

router.get('/mine', auth, (req, res) => {
  res.json(bids.byBidder(req.user.id).map(b => bids.withJob(b)));
});

router.post('/', auth, (req, res) => {
  if (req.user.role !== 'tradesman') return res.status(403).json({ error: 'Only tradesmen can bid' });
  const { jobId, price, bidType = 'flat', availability = 'today', message } = req.body;
  if (!jobId || !price) return res.status(400).json({ error: 'jobId and price required' });

  const job = jobs.findById(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'bidding') return res.status(400).json({ error: 'Job is no longer accepting bids' });
  if (bids.existsActive(jobId, req.user.id)) return res.status(409).json({ error: 'You already bid on this job' });

  // Credential gate for $500+ jobs
  if (price >= 500) {
    const p = profiles.get(req.user.id);
    const missing = [];
    if (!p?.license) missing.push('License number');
    if (!p?.insured) missing.push('Insurance');
    if (!p?.bonded) missing.push('Surety bond');
    if (missing.length) return res.status(403).json({ error: 'Missing credentials for $500+ bid', missing });
  }

  const bid = bids.create({ id: uid('b'), job_id: jobId, bidder_id: req.user.id, price, bid_type: bidType, availability, message });

  const n = notifications.create({ id: uid('n'), user_id: job.owner_id, type: 'bid',
    title: 'New bid received 📋', body: `${req.user.name} bid $${price} on "${job.title}"`, link: 'review-bids' });
  notifyUser(job.owner_id, { type: 'notification', notification: n });

  res.status(201).json(bids.withJob(bid));
});

router.patch('/:id/withdraw', auth, (req, res) => {
  const bid = bids.findById(req.params.id);
  if (!bid) return res.status(404).json({ error: 'Not found' });
  if (bid.bidder_id !== req.user.id) return res.status(403).json({ error: 'Not your bid' });
  bids.update(req.params.id, { status: 'withdrawn' });
  res.json({ ok: true });
});

export default router;
