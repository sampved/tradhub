import { Router } from 'express';
import { reviews, notifications, profiles, jobs, uid } from '../db/store.js';
import { auth } from '../middleware/auth.js';

const router = Router();

router.get('/reviews/user/:userId', auth, (req, res) => {
  res.json(reviews.forReviewee(req.params.userId));
});

router.post('/reviews', auth, (req, res) => {
  const { jobId, revieweeId, rating, text } = req.body;
  if (!jobId || !revieweeId || !rating) return res.status(400).json({ error: 'Missing fields' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
  const job = jobs.findById(jobId);
  if (!job || job.status !== 'completed') return res.status(400).json({ error: 'Job must be completed' });
  if (reviews.exists(jobId, req.user.id)) return res.status(409).json({ error: 'Already reviewed' });
  const review = reviews.create({ id: uid('rv'), job_id: jobId, reviewer_id: req.user.id, reviewee_id: revieweeId, rating, text: text || null });
  profiles.updateRating(revieweeId);
  res.status(201).json(review);
});

router.get('/notifications', auth, (req, res) => {
  res.json(notifications.forUser(req.user.id));
});

router.patch('/notifications/read-all', auth, (req, res) => {
  notifications.markAllRead(req.user.id);
  res.json({ ok: true });
});

router.delete('/notifications', auth, (req, res) => {
  notifications.clearAll(req.user.id);
  res.json({ ok: true });
});

export default router;
