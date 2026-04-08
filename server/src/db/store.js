/**
 * Herfeh AI — In-memory database with JSON file persistence.
 * When you move to production, swap this module out for PostgreSQL or SQLite.
 * Every function here has the same interface a real DB layer would expose.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
// On Render free tier, use /tmp so data survives restarts within the same instance
// On local dev, use the project root
const IS_RENDER = process.env.RENDER === 'true' || process.env.NODE_ENV === 'production';
const DB_FILE = IS_RENDER
  ? '/tmp/tradhub-data.json'
  : join(__dir, '../../tradhub-data.json');

// ── Default empty store ──────────────────────────────────────────────────────
const EMPTY = {
  users: [],
  tradesman_profiles: [],
  jobs: [],
  bids: [],
  messages: [],
  notifications: [],
  reviews: [],
  payments: [],
};

// ── Load / Save ──────────────────────────────────────────────────────────────
function load() {
  try {
    if (existsSync(DB_FILE)) return JSON.parse(readFileSync(DB_FILE, 'utf8'));
  } catch {}
  return JSON.parse(JSON.stringify(EMPTY));
}

let store = load();

function save() {
  try { writeFileSync(DB_FILE, JSON.stringify(store, null, 2)); } catch (e) { console.error('DB save error', e); }
}

// ── ID generator ─────────────────────────────────────────────────────────────
export function uid(prefix = 'x') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── USERS ────────────────────────────────────────────────────────────────────
export const users = {
  all:         ()      => store.users,
  findByEmail: (email) => store.users.find(u => u.email === email.toLowerCase()),
  findById:    (id)    => store.users.find(u => u.id === id),

  create(data) {
    const u = { ...data, email: data.email.toLowerCase(), created_at: Date.now() };
    store.users.push(u);
    save();
    return u;
  },

  update(id, fields) {
    const u = store.users.find(u => u.id === id);
    if (!u) return null;
    Object.assign(u, fields);
    save();
    return u;
  },

  safe(u) {
    if (!u) return null;
    const { password, ...rest } = u;
    return rest;
  },
};

// ── TRADESMAN PROFILES ───────────────────────────────────────────────────────
export const profiles = {
  get: (userId) => store.tradesman_profiles.find(p => p.user_id === userId),

  upsert(userId, data) {
    const idx = store.tradesman_profiles.findIndex(p => p.user_id === userId);
    if (idx >= 0) {
      Object.assign(store.tradesman_profiles[idx], data);
    } else {
      store.tradesman_profiles.push({ user_id: userId, avg_rating: 0, review_count: 0, ...data });
    }
    save();
    return store.tradesman_profiles.find(p => p.user_id === userId);
  },

  updateRating(userId) {
    const userReviews = store.reviews.filter(r => r.reviewee_id === userId);
    const avg = userReviews.length
      ? Math.round((userReviews.reduce((s, r) => s + r.rating, 0) / userReviews.length) * 10) / 10
      : 0;
    this.upsert(userId, { avg_rating: avg, review_count: userReviews.length });
  },
};

// ── JOBS ─────────────────────────────────────────────────────────────────────
export const jobs = {
  all:        ()   => store.jobs,
  findById:   (id) => store.jobs.find(j => j.id === id),
  byOwner:    (id) => store.jobs.filter(j => j.owner_id === id),

  open(trade, lat, lng, radiusMi = 50) {
    let list = store.jobs.filter(j => j.status === 'bidding');
    if (trade && trade !== 'all') list = list.filter(j => j.trade === trade);
    if (lat && lng) {
      list = list.map(j => {
        if (!j.lat || !j.lng) return { ...j, distance_miles: null };
        const dLat = (j.lat - lat) * Math.PI / 180;
        const dLng = (j.lng - lng) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat*Math.PI/180)*Math.cos(j.lat*Math.PI/180)*Math.sin(dLng/2)**2;
        const dist = Math.round(3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 10) / 10;
        return { ...j, distance_miles: dist };
      }).filter(j => j.distance_miles === null || j.distance_miles <= radiusMi);
    }
    return list.sort((a, b) => b.created_at - a.created_at);
  },

  create(data) {
    const j = { ...data, status: 'bidding', created_at: Date.now(), completed_at: null, accepted_bid_id: null };
    store.jobs.push(j);
    save();
    return j;
  },

  update(id, fields) {
    const j = store.jobs.find(j => j.id === id);
    if (!j) return null;
    Object.assign(j, fields);
    save();
    return j;
  },

  withBids(job) {
    if (!job) return null;
    const jobBids = store.bids
      .filter(b => b.job_id === job.id && b.status !== 'withdrawn')
      .map(b => {
        const bidder = users.safe(users.findById(b.bidder_id));
        const profile = profiles.get(b.bidder_id);
        return { ...b, bidder_name: bidder?.name, bidder_ini: bidder?.ini, ...profile };
      })
      .sort((a, b) => a.created_at - b.created_at);
    const owner = users.safe(users.findById(job.owner_id));
    return { ...job, bids: jobBids, owner_name: owner?.name, owner_ini: owner?.ini, bid_count: jobBids.length };
  },
};

// ── BIDS ─────────────────────────────────────────────────────────────────────
export const bids = {
  all:        ()       => store.bids,
  findById:   (id)     => store.bids.find(b => b.id === id),
  byJob:      (jobId)  => store.bids.filter(b => b.job_id === jobId && b.status !== 'withdrawn'),
  byBidder:   (userId) => store.bids.filter(b => b.bidder_id === userId),
  existsActive: (jobId, bidderId) =>
    store.bids.some(b => b.job_id === jobId && b.bidder_id === bidderId && b.status !== 'withdrawn'),

  create(data) {
    const b = { ...data, status: 'pending', created_at: Date.now() };
    store.bids.push(b);
    save();
    return b;
  },

  update(id, fields) {
    const b = store.bids.find(b => b.id === id);
    if (!b) return null;
    Object.assign(b, fields);
    save();
    return b;
  },

  withJob(bid) {
    const job = jobs.findById(bid.job_id);
    const allBids = bids.byJob(bid.job_id);
    return {
      ...bid,
      job_title: job?.title,
      trade: job?.trade,
      address: job?.address,
      city: job?.city,
      job_status: job?.status,
      budget_min: job?.budget_min,
      budget_max: job?.budget_max,
      owner_id: job?.owner_id,
      total_bids: allBids.length,
    };
  },
};

// ── MESSAGES ─────────────────────────────────────────────────────────────────
export const messages = {
  all: () => store.messages,
  forConversation(jobId, userA, userB) {
    return store.messages
      .filter(m => m.job_id === jobId &&
        ((m.sender_id === userA && m.receiver_id === userB) ||
         (m.sender_id === userB && m.receiver_id === userA)))
      .sort((a, b) => a.created_at - b.created_at)
      .map(m => {
        const sender = users.safe(users.findById(m.sender_id));
        return { ...m, sender_name: sender?.name, sender_ini: sender?.ini };
      });
  },

  conversations(userId) {
    const seen = new Map();
    store.messages
      .filter(m => m.sender_id === userId || m.receiver_id === userId)
      .sort((a, b) => b.created_at - a.created_at)
      .forEach(m => {
        const otherId = m.sender_id === userId ? m.receiver_id : m.sender_id;
        const key = `${m.job_id}::${otherId}`;
        if (!seen.has(key)) {
          const other = users.safe(users.findById(otherId));
          const job = jobs.findById(m.job_id);
          const unread = store.messages.filter(x =>
            x.job_id === m.job_id && x.sender_id === otherId && x.receiver_id === userId && !x.read
          ).length;
          seen.set(key, {
            job_id: m.job_id,
            job_title: job?.title,
            job_trade: job?.trade,
            other_user_id: otherId,
            other_user_name: other?.name,
            other_user_ini: other?.ini,
            last_message: m.text,
            last_at: m.created_at,
            unread_count: unread,
          });
        }
      });
    return [...seen.values()];
  },

  markRead(jobId, senderId, receiverId) {
    store.messages.forEach(m => {
      if (m.job_id === jobId && m.sender_id === senderId && m.receiver_id === receiverId) m.read = true;
    });
    save();
  },

  create(data) {
    const m = { ...data, read: false, created_at: Date.now() };
    store.messages.push(m);
    save();
    const sender = users.safe(users.findById(m.sender_id));
    return { ...m, sender_name: sender?.name, sender_ini: sender?.ini };
  },
};

// ── NOTIFICATIONS ────────────────────────────────────────────────────────────
export const notifications = {
  forUser: (userId) => store.notifications
    .filter(n => n.user_id === userId)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50),

  unreadCount: (userId) => store.notifications.filter(n => n.user_id === userId && !n.read).length,

  create(data) {
    const n = { ...data, read: false, created_at: Date.now() };
    store.notifications.push(n);
    save();
    return n;
  },

  markAllRead(userId) {
    store.notifications.filter(n => n.user_id === userId).forEach(n => n.read = true);
    save();
  },

  clearAll(userId) {
    store.notifications = store.notifications.filter(n => n.user_id !== userId);
    save();
  },
};

// ── REVIEWS ──────────────────────────────────────────────────────────────────
export const reviews = {
  all: () => store.reviews,
  forReviewee: (userId) => store.reviews
    .filter(r => r.reviewee_id === userId)
    .sort((a, b) => b.created_at - a.created_at)
    .map(r => {
      const reviewer = users.safe(users.findById(r.reviewer_id));
      const job = jobs.findById(r.job_id);
      return { ...r, reviewer_name: reviewer?.name, reviewer_ini: reviewer?.ini, job_title: job?.title };
    }),

  exists: (jobId, reviewerId) => store.reviews.some(r => r.job_id === jobId && r.reviewer_id === reviewerId),

  create(data) {
    const r = { ...data, created_at: Date.now() };
    store.reviews.push(r);
    save();
    return r;
  },
};

// ── PAYMENTS ─────────────────────────────────────────────────────────────────
export const payments = {
  all:        ()     => store.payments,
  findById:   (id)   => store.payments.find(p => p.id === id),
  byJob:      (jid)  => store.payments.filter(p => p.job_id === jid),
  byUser:     (uid)  => store.payments.filter(p => p.homeowner_id === uid || p.tradesman_id === uid),

  create(data) {
    const p = { ...data, created_at: Date.now() };
    store.payments.push(p);
    save();
    return p;
  },

  update(id, fields) {
    const p = store.payments.find(p => p.id === id);
    if (!p) return null;
    Object.assign(p, fields);
    save();
    return p;
  },

  stats() {
    const all = store.payments;
    const captured = all.filter(p => p.status === 'captured');
    const gross = captured.reduce((s, p) => s + p.amount, 0);
    const fees  = captured.reduce((s, p) => s + (p.platform_fee || 0), 0);
    const now   = Date.now();
    const day   = 86400000;
    return {
      total_transactions: captured.length,
      gross_volume:   gross,
      platform_fees:  fees,
      net_to_trades:  gross - fees,
      today:          captured.filter(p => p.captured_at > now - day).reduce((s,p)=>s+p.platform_fee,0),
      this_week:      captured.filter(p => p.captured_at > now - 7*day).reduce((s,p)=>s+p.platform_fee,0),
      this_month:     captured.filter(p => p.captured_at > now - 30*day).reduce((s,p)=>s+p.platform_fee,0),
      pending:        all.filter(p => p.status === 'held').reduce((s,p)=>s+p.amount,0),
    };
  },
};

export default { users, profiles, jobs, bids, messages, notifications, reviews, payments, uid };
