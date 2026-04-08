import { Router } from 'express';
import { users, jobs, bids, messages, payments, reviews, profiles } from '../db/store.js';

const router = Router();

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'herfeh-admin-dev';
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Admin access required' });
  next();
}

router.get('/stats', adminAuth, (req, res) => {
  const allUsers = users.all(), allJobs = jobs.all(), allBids = bids.all();
  const allRevs  = reviews.all(), allPayments = payments.all();
  const now = Date.now(), day = 86400000;
  const payStats = payments.stats();
  res.json({
    users: {
      total: allUsers.length,
      homeowners: allUsers.filter(u=>u.role==='homeowner').length,
      tradesmen:  allUsers.filter(u=>u.role==='tradesman').length,
      new_today:  allUsers.filter(u=>u.created_at > now-day).length,
      new_week:   allUsers.filter(u=>u.created_at > now-7*day).length,
    },
    jobs: {
      total:        allJobs.length,
      bidding:      allJobs.filter(j=>j.status==='bidding').length,
      inprogress:   allJobs.filter(j=>j.status==='inprogress').length,
      completed:    allJobs.filter(j=>j.status==='completed').length,
      cancelled:    allJobs.filter(j=>j.status==='cancelled').length,
      posted_today: allJobs.filter(j=>j.created_at > now-day).length,
    },
    bids: {
      total:    allBids.length,
      pending:  allBids.filter(b=>b.status==='pending').length,
      accepted: allBids.filter(b=>b.status==='accepted').length,
    },
    messages: { total: messages.all().length },
    reviews:  {
      total: allRevs.length,
      avg_rating: allRevs.length
        ? Math.round(allRevs.reduce((s,r)=>s+r.rating,0)/allRevs.length*10)/10
        : 0,
    },
    payments: payStats,
  });
});

router.get('/users', adminAuth, (req, res) => {
  const result = users.all().map(u => {
    const { password, ...safe } = u;
    const profile  = u.role==='tradesman' ? profiles.get(u.id) : null;
    const jobCount = u.role==='homeowner'
      ? jobs.byOwner(u.id).length
      : bids.byBidder(u.id).filter(b=>b.status==='accepted').length;
    return { ...safe, profile, job_count: jobCount };
  });
  res.json(result);
});

router.get('/jobs', adminAuth, (req, res) => {
  const result = jobs.all().map(j => {
    const { password: _, ...owner } = users.findById(j.owner_id) || {};
    const jobBids   = bids.all().filter(b=>b.job_id===j.id);
    const payment   = payments.byJob(j.id)[0] || null;
    return { ...j, owner, bid_count: jobBids.length,
      payment_status: payment?.status||null, payment_amount: payment?.amount||null };
  }).sort((a,b)=>b.created_at-a.created_at);
  res.json(result);
});

router.get('/transactions', adminAuth, (req, res) => {
  const result = payments.all().map(p => {
    const job = jobs.findById(p.job_id);
    const ho  = users.findById(p.homeowner_id);
    const tr  = users.findById(p.tradesman_id);
    return { ...p,
      job_title: job?.title, job_trade: job?.trade,
      homeowner_name: ho?.name, homeowner_email: ho?.email,
      tradesman_name: tr?.name, tradesman_email: tr?.email,
    };
  }).sort((a,b)=>b.created_at-a.created_at);
  res.json(result);
});

router.get('/activity', adminAuth, (req, res) => {
  const events = [];
  users.all().forEach(u =>
    events.push({type:'user', time:u.created_at, text:`New ${u.role}: ${u.name}`, icon:'👤', id:u.id}));
  jobs.all().forEach(j =>
    events.push({type:'job', time:j.created_at, text:`Job posted: "${j.title}"`, icon:'📋', id:j.id}));
  bids.all().filter(b=>b.status==='accepted').forEach(b => {
    const j=jobs.findById(b.job_id);
    events.push({type:'accept', time:b.created_at, text:`Bid accepted on "${j?.title||'job'}" — $${b.price}`, icon:'✅', id:b.id});
  });
  payments.all().filter(p=>p.status==='captured').forEach(p => {
    const j=jobs.findById(p.job_id);
    events.push({type:'payment', time:p.captured_at||p.created_at,
      text:`Payment captured: $${p.amount} for "${j?.title||'job'}"`, icon:'💳', id:p.id});
  });
  reviews.all().forEach(r => {
    const j=jobs.findById(r.job_id);
    events.push({type:'review', time:r.created_at, text:`${r.rating}★ review on "${j?.title||'job'}"`, icon:'⭐', id:r.id});
  });
  events.sort((a,b)=>b.time-a.time);
  res.json(events.slice(0,100));
});

router.get('/conversation/:jobId/:userA/:userB', adminAuth, (req, res) => {
  const {jobId,userA,userB} = req.params;
  const job     = jobs.findById(jobId);
  const uA      = users.safe(users.findById(userA));
  const uB      = users.safe(users.findById(userB));
  const msgs    = messages.forConversation(jobId, userA, userB);
  const payment = payments.byJob(jobId)[0]||null;
  res.json({job, userA:uA, userB:uB, messages:msgs, payment});
});

// GET all conversations for a job
router.get('/conversations/:jobId', adminAuth, (req, res) => {
  const job   = jobs.findById(req.params.jobId);
  const jobBids = bids.all().filter(b=>b.job_id===req.params.jobId);
  const convos = jobBids.map(b => {
    const tr   = users.safe(users.findById(b.bidder_id));
    const ho   = users.safe(users.findById(job?.owner_id));
    const msgs = messages.forConversation(req.params.jobId, job?.owner_id, b.bidder_id);
    return { bidder: tr, homeowner: ho, bid: b, message_count: msgs.length, messages: msgs };
  });
  res.json({ job, conversations: convos });
});

export default router;
