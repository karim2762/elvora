import { verifySignature, processEvent } from '../github/webhook.js';
import { config } from '../config/index.js';

// Stage 09C — POST /api/v1/github/webhook. Mounted in app.js BEFORE express.json with express.raw, because the signature covers the exact bytes.
export default function githubWebhook(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!config.github.webhookSecret) return res.status(503).json({ error: { message: 'Webhook is not configured', code: 'GITHUB_NOT_CONFIGURED' } });
  if (!verifySignature(req.body, req.get('x-hub-signature-256'))) return res.status(401).json({ error: { message: 'Invalid signature', code: 'BAD_SIGNATURE' } });
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: { message: 'Invalid JSON body' } }); }
  const event = req.get('x-github-event') || '';
  if (!/^[a-z_]{1,60}$/.test(event)) return res.status(400).json({ error: { message: 'Missing event type' } });
  const r = processEvent({ deliveryId: req.get('x-github-delivery'), event, payload });
  res.status(r.status).json({ ok: r.status < 400, outcome: r.outcome });
}
