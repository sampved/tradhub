import { Router } from 'express';
import { messages, uid } from '../db/store.js';
import { auth } from '../middleware/auth.js';
import { notifyUser } from '../ws.js';

const router = Router();

router.get('/', auth, (req, res) => {
  res.json(messages.conversations(req.user.id));
});

router.get('/:jobId/:otherId', auth, (req, res) => {
  messages.markRead(req.params.jobId, req.params.otherId, req.user.id);
  res.json(messages.forConversation(req.params.jobId, req.user.id, req.params.otherId));
});

router.post('/', auth, (req, res) => {
  const { jobId, receiverId, text } = req.body;
  if (!jobId || !receiverId || !text?.trim()) return res.status(400).json({ error: 'Missing fields' });
  const msg = messages.create({ id: uid('m'), job_id: jobId, sender_id: req.user.id, receiver_id: receiverId, text: text.trim() });
  notifyUser(receiverId, { type: 'message', message: msg });
  res.status(201).json(msg);
});

export default router;
