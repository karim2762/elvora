import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index.js';
import routes from './routes/index.js';
import { purgeExpiredSessions } from './db/sessions.js';
import { purgeOldResets } from './db/passwordResets.js';
import githubWebhook from './routes/githubWebhook.js';

const app = express();
if (config.trustProxy) app.set('trust proxy', config.trustProxy); // needed for correct client IPs behind a proxy
app.use(helmet());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
// Stage 09C: the GitHub webhook signature covers the exact bytes, so this route reads the RAW body and must come before express.json.
app.post('/api/v1/github/webhook', express.raw({ type: () => true, limit: '1mb' }), githubWebhook);
app.use(express.json({ limit: '100kb' }));

// CSRF defence in depth (cookies are also SameSite): browsers always send Origin on cross-site writes.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && !config.corsOrigins.includes(origin)) {
    return res.status(403).json({ error: { message: 'Request blocked', code: 'BAD_ORIGIN' } });
  }
  // Stage 10C: a state-changing request that carries no Origin but that the browser itself marks as cross-site (Sec-Fetch-Site) is refused too.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origin && req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({ error: { message: 'Request blocked', code: 'BAD_ORIGIN' } });
  }
  next();
});

app.use('/api/v1', routes);

app.use((_req, res) => res.status(404).json({ error: { message: 'Not found' } }));
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { message: 'Invalid JSON body' } });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: { message: 'Request too large' } });
  if (err.expose) return res.status(err.status).json({ error: { message: err.message, code: err.code, fields: err.fields, details: err.details } });
  console.error(err);
  res.status(500).json({ error: { message: config.isProd ? 'Server error' : err.message } });
});

// Housekeeping for expired sessions and old reset tokens.
const sweep = () => { try { purgeExpiredSessions(); purgeOldResets(); } catch (e) { console.error('[cleanup]', e.message); } };
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

export default app;
