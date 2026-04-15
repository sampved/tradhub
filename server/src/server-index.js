import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { setupWebSocket } from './ws.js';

import authRoutes    from './routes/auth.js';
import jobRoutes     from './routes/jobs.js';
import bidRoutes     from './routes/bids.js';
import messageRoutes from './routes/messages.js';
import reviewRoutes  from './routes/reviews.js';
import paymentRoutes from './routes/payments.js';
import adminRoutes   from './routes/admin.js';

const app = express();
const server = createServer(app);

const IS_PROD = process.env.NODE_ENV === 'production';

app.use(cors({
  origin: IS_PROD
    ? [
        'https://tradhub.ai',
        'https://www.tradhub.ai',
        'https://pro.tradhub.ai',
        'https://tradhub-server.onrender.com',
      ]
    : (origin, cb) => cb(null, true),
  credentials: true,
}));

// Raw body needed for Stripe webhook signature verification
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use((req, _res, next) => { console.log(`${req.method} ${req.path}`); next(); });

app.use('/api/auth',     authRoutes);
app.use('/api/jobs',     jobRoutes);
app.use('/api/bids',     bidRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api',          reviewRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin',    adminRoutes);
app.get('/api/health',   (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

setupWebSocket(server);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n TradHub API   →  http://localhost:${PORT}`);
  console.log(` WebSocket     →  ws://localhost:${PORT}/ws`);
  console.log(` Data file     →  tradhub-data.json\n`);
});
