# TradHub

Home services marketplace connecting homeowners with vetted local tradesmen.

## Stack
- **Frontend** — single HTML file (`tradhub.html`), hosted on GoDaddy
- **Backend** — Node.js + Express API, deployed on Render
- **Database** — in-memory JSON store (persisted to `tradhub-data.json`)
- **Real-time** — WebSockets for messaging + live tradesman tracking
- **Payments** — Stripe (simulation mode until `STRIPE_SECRET_KEY` is set)

## Local Development

```bash
cd server
npm install
npm run dev
```

API runs at `http://localhost:4000`

Open `tradhub.html` in your browser — it auto-detects localhost.

## Deployment

### Server (Render)
1. Push to GitHub
2. Render → New → Blueprint → select this repo
3. Set environment variables (see below)

### Frontend (GoDaddy)
1. Edit `tradhub.html` — set `RENDER_URL` to your Render URL
2. Upload to GoDaddy `public_html` as `index.html`

## Environment Variables (Render)

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | Set to `production` |
| `JWT_SECRET` | Long random string — Render can auto-generate |
| `ADMIN_KEY` | Secret key for admin dashboard |
| `PLATFORM_FEE_PERCENT` | Platform fee % (default: 10) |
| `STRIPE_SECRET_KEY` | Stripe live key (optional — runs in simulation without it) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret (optional) |

## Admin Dashboard

Open `tradhub-admin.html` in your browser.
Default admin key: set via `ADMIN_KEY` environment variable on Render.

## Domain
- Frontend: https://tradhub.ai
- API: https://api.tradhub.ai
