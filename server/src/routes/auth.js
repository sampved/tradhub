import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { users, profiles, uid } from '../db/store.js';
import { signToken, auth } from '../middleware/auth.js';

const router = Router();

function makeToken(user) {
  return signToken({ id: user.id, email: user.email, role: user.role, name: user.name });
}
function safeUser(user) {
  const profile = user.role === 'tradesman' ? profiles.get(user.id) : null;
  return { ...users.safe(user), profile };
}

// ── Standard register ─────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, phone, address, city, zip, state,
            trades, experience, bizName, license, insured, bonded, radius,
            rate, dayRate, googleId } = req.body;

    if (!name || !email || !role)
      return res.status(400).json({ error: 'Name, email and role are required.' });
    if (!googleId && (!password || password.length < 8))
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const emailLower = email.toLowerCase();
    if (users.findByEmail(emailLower))
      return res.status(409).json({ error: 'An account with this email already exists.' });

    const hash = await bcrypt.hash(googleId ? (googleId + Date.now()) : password, 10);
    const ini  = name.split(' ').map(w => w[0] || '').join('').substring(0, 2).toUpperCase();
    const id   = uid('u');
    const user = users.create({ id, email: emailLower, password: hash, name, role, phone, address, city, zip, state, ini, googleId: googleId || null });

    if (role === 'tradesman') {
      profiles.upsert(id, { bio: bizName || null, license: license || null, insured: !!insured, bonded: !!bonded, experience: experience || null, radius: radius || 10, rate: rate || null, day_rate: dayRate || null, trades: trades || [], avg_rating: 0, review_count: 0 });
    }

    res.json({ token: makeToken(user), user: safeUser(user) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Registration error.' }); }
});

// ── Standard login ─────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    const user = users.findByEmail(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'No account found with this email.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });
    res.json({ token: makeToken(user), user: safeUser(user) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Login error.' }); }
});

// ── Google login — ALWAYS succeeds, never throws "already exists" ─────────────
// This single endpoint handles first-time signup AND all future logins.
// It finds existing user by email OR googleId and logs them in,
// or creates a new account if they've never signed up before.
router.post('/google-login', async (req, res) => {
  try {
    const { email, name, googleId, role } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const emailLower = email.toLowerCase();

    // 1. Try to find by email first
    let user = users.findByEmail(emailLower);

    // 2. Try to find by googleId if email lookup missed
    if (!user && googleId) {
      user = users.all().find(u => u.googleId === googleId);
    }

    // 3. Found existing user — just log them in
    if (user) {
      // Attach googleId if they didn't have one (e.g. they registered with email before)
      if (!user.googleId && googleId) {
        users.update(user.id, { googleId });
      }
      console.log(`Google login: existing user ${user.email} (${user.role})`);
      return res.json({ token: makeToken(user), user: safeUser(user) });
    }

    // 4. Brand new user — create account automatically
    const userRole = role || 'homeowner';
    const displayName = name || emailLower.split('@')[0];
    const ini  = displayName.split(' ').map(w => w[0] || '').join('').substring(0, 2).toUpperCase();
    const id   = uid('u');
    const hash = await bcrypt.hash((googleId || 'google') + id + Date.now(), 10);

    user = users.create({
      id,
      email: emailLower,
      password: hash,
      name: displayName,
      role: userRole,
      ini,
      googleId: googleId || null,
    });

    if (userRole === 'tradesman') {
      profiles.upsert(id, {
        bio: null, license: null, insured: false, bonded: false,
        experience: null, radius: 10, rate: null, day_rate: null,
        trades: [], avg_rating: 0, review_count: 0,
      });
    }

    console.log(`Google login: new user created ${user.email} (${userRole})`);
    res.json({ token: makeToken(user), user: safeUser(user) });

  } catch (err) {
    console.error('Google login error:', err);
    res.status(500).json({ error: 'Sign in failed. Please try again.' });
  }
});

// ── Get current user ──────────────────────────────────────────────────────────
router.get('/me', auth, (req, res) => {
  const user = users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: safeUser(user) });
});

// ── Update profile ─────────────────────────────────────────────────────────────
router.patch('/profile', auth, (req, res) => {
  const { name, phone, address, city, zip, bio, license, insured, bonded,
          experience, radius, rate, dayRate, trades } = req.body;
  users.update(req.user.id, { name, phone, address, city, zip });
  if (req.user.role === 'tradesman') {
    profiles.upsert(req.user.id, {
      bio, license, insured: !!insured, bonded: !!bonded,
      experience, radius, rate, day_rate: dayRate, trades: trades || [],
    });
  }
  const user = users.findById(req.user.id);
  res.json({ user: safeUser(user) });
});

export default router;
