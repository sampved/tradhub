import { Router } from 'express';
import Stripe from 'stripe';
import { jobs, bids, payments, notifications, users, uid } from '../db/store.js';
import { auth } from '../middleware/auth.js';
import { notifyUser } from '../ws.js';

const router = Router();

// ── Stripe setup ─────────────────────────────────────────────────────────────
// In production: set STRIPE_SECRET_KEY in your environment variables
// Get your keys from https://dashboard.stripe.com/apikeys
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || '10');
const STRIPE_ENABLED = STRIPE_SECRET !== 'sk_test_placeholder';

let stripe = null;
if (STRIPE_ENABLED) {
  stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-04-10' });
  console.log('💳 Stripe payments enabled');
} else {
  console.log('💳 Stripe in SIMULATION mode (set STRIPE_SECRET_KEY to go live)');
}

// ── POST /api/payments/create-intent ─────────────────────────────────────────
// Called when homeowner accepts a bid — creates a payment intent (holds funds)
router.post('/create-intent', auth, async (req, res) => {
  try {
    if (req.user.role !== 'homeowner') {
      return res.status(403).json({ error: 'Only homeowners can initiate payments' });
    }

    const { jobId, bidId } = req.body;
    const job = jobs.findById(jobId);
    const bid = bids.findById(bidId);

    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!bid)  return res.status(404).json({ error: 'Bid not found' });
    if (job.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });

    const amountCents = Math.round(bid.price * 100);
    const feeCents    = Math.round(amountCents * (PLATFORM_FEE_PERCENT / 100));

    let clientSecret = null;
    let paymentIntentId = null;

    if (STRIPE_ENABLED) {
      // Real Stripe — create a PaymentIntent
      const intent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        capture_method: 'manual',  // hold funds, capture on completion
        metadata: {
          job_id:       job.id,
          bid_id:       bid.id,
          homeowner_id: req.user.id,
          tradesman_id: bid.bidder_id,
          job_title:    job.title,
          platform_fee_cents: feeCents,
        },
        description: `Herfeh AI — ${job.title}`,
      });
      clientSecret     = intent.client_secret;
      paymentIntentId  = intent.id;
    } else {
      // Simulation mode — fake intent ID
      paymentIntentId = 'pi_sim_' + uid('p');
      clientSecret    = 'seti_sim_secret_' + Date.now();
    }

    // Record in our DB
    const payment = payments.create({
      id:              uid('pay'),
      job_id:          job.id,
      bid_id:          bid.id,
      homeowner_id:    req.user.id,
      tradesman_id:    bid.bidder_id,
      amount:          bid.price,
      amount_cents:    amountCents,
      platform_fee:    feeCents / 100,
      platform_fee_cents: feeCents,
      stripe_intent_id: paymentIntentId,
      status:          'pending',
    });

    res.json({
      clientSecret,
      paymentId:   payment.id,
      amount:      bid.price,
      fee:         feeCents / 100,
      netToTrade:  (amountCents - feeCents) / 100,
      simulated:   !STRIPE_ENABLED,
    });
  } catch (err) {
    console.error('Payment intent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/confirm ────────────────────────────────────────────────
// Called after card details collected — confirms the hold
router.post('/confirm', auth, async (req, res) => {
  try {
    const { paymentId } = req.body;
    const payment = payments.findById(paymentId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    if (STRIPE_ENABLED) {
      // In production the frontend confirms via Stripe.js — we just verify here
      const intent = await stripe.paymentIntents.retrieve(payment.stripe_intent_id);
      if (intent.status !== 'requires_capture' && intent.status !== 'succeeded') {
        return res.status(400).json({ error: `Payment not ready: ${intent.status}` });
      }
    }

    // Mark as held (funds are reserved)
    payments.update(payment.id, { status: 'held', held_at: Date.now() });

    // Now accept the bid and update job status
    const job = jobs.findById(payment.job_id);
    const bid = bids.findById(payment.bid_id);
    jobs.update(job.id, { status: 'inprogress', accepted_bid_id: bid.id });
    bids.update(bid.id, { status: 'accepted' });
    bids.byJob(job.id).forEach(b => {
      if (b.id !== bid.id) bids.update(b.id, { status: 'rejected' });
    });

    // Notify tradesman
    const n = notifications.create({
      id: uid('n'), user_id: bid.bidder_id, type: 'accept',
      title: 'Bid accepted — Payment secured 💳',
      body: `Your $${bid.price} bid on "${job.title}" was accepted. Payment is held securely.`,
      link: 'active-jobs-t',
    });
    notifyUser(bid.bidder_id, { type: 'notification', notification: n });

    res.json({ ok: true, payment: payments.findById(payment.id) });
  } catch (err) {
    console.error('Confirm error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/capture ────────────────────────────────────────────────
// Called when job is marked complete — releases funds to tradesman
router.post('/capture', auth, async (req, res) => {
  try {
    const { jobId } = req.body;
    const job = jobs.findById(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Only homeowner can release payment
    if (job.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the homeowner can release payment' });
    }

    const payment = payments.byJob(jobId).find(p => p.status === 'held');
    if (!payment) return res.status(404).json({ error: 'No held payment found for this job' });

    if (STRIPE_ENABLED) {
      // Capture the held funds
      await stripe.paymentIntents.capture(payment.stripe_intent_id, {
        amount_to_capture: payment.amount_cents,
      });

      // In a real app you'd also do a transfer to the tradesman's Stripe Connect account here
    }

    // Update payment record
    payments.update(payment.id, {
      status: 'captured',
      captured_at: Date.now(),
    });

    // Mark job complete
    jobs.update(jobId, { status: 'completed', completed_at: Date.now() });

    // Notify tradesman of payout
    const tradesman = users.findById(payment.tradesman_id);
    const payoutAmount = (payment.amount_cents - payment.platform_fee_cents) / 100;
    const n = notifications.create({
      id: uid('n'), user_id: payment.tradesman_id, type: 'payment',
      title: 'Payment released! 💰',
      body: `$${payoutAmount.toFixed(2)} has been released for "${job.title}".`,
      link: 'earnings',
    });
    notifyUser(payment.tradesman_id, { type: 'notification', notification: n });

    res.json({
      ok: true,
      captured: payment.amount,
      platform_fee: payment.platform_fee,
      payout_to_trade: payoutAmount,
      simulated: !STRIPE_ENABLED,
    });
  } catch (err) {
    console.error('Capture error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/refund ─────────────────────────────────────────────────
// Refund a payment (admin or homeowner within dispute window)
router.post('/refund', auth, async (req, res) => {
  try {
    const { paymentId, reason } = req.body;
    const payment = payments.findById(paymentId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.homeowner_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    if (!['held','captured'].includes(payment.status)) {
      return res.status(400).json({ error: 'Payment cannot be refunded in its current state' });
    }

    if (STRIPE_ENABLED) {
      await stripe.refunds.create({
        payment_intent: payment.stripe_intent_id,
        reason: reason || 'requested_by_customer',
      });
    }

    payments.update(paymentId, { status: 'refunded', refunded_at: Date.now(), refund_reason: reason });
    jobs.update(payment.job_id, { status: 'cancelled' });

    res.json({ ok: true, refunded: payment.amount });
  } catch (err) {
    console.error('Refund error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/payments/job/:jobId ──────────────────────────────────────────────
router.get('/job/:jobId', auth, (req, res) => {
  const jobPayments = payments.byJob(req.params.jobId);
  res.json(jobPayments);
});

// ── GET /api/payments/mine ────────────────────────────────────────────────────
router.get('/mine', auth, (req, res) => {
  const mine = payments.byUser(req.user.id).map(p => {
    const job = jobs.findById(p.job_id);
    return { ...p, job_title: job?.title, job_trade: job?.trade };
  });
  res.json(mine);
});

// ── Stripe webhook ────────────────────────────────────────────────────────────
// Register this URL in your Stripe dashboard: /api/payments/webhook
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!STRIPE_ENABLED || !webhookSecret) {
    return res.json({ received: true });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
  }

  switch (event.type) {
    case 'payment_intent.payment_failed': {
      const intent = event.data.object;
      const payment = payments.all().find(p => p.stripe_intent_id === intent.id);
      if (payment) {
        payments.update(payment.id, { status: 'failed' });
        const n = notifications.create({
          id: uid('n'), user_id: payment.homeowner_id, type: 'payment',
          title: 'Payment failed',
          body: 'Your payment could not be processed. Please try again.',
          link: 'my-jobs',
        });
        notifyUser(payment.homeowner_id, { type: 'notification', notification: n });
      }
      break;
    }
  }

  res.json({ received: true });
});

export default router;
