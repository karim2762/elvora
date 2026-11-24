// Usage: node scripts/setup-payments.mjs <upiId> "<payee name>" "<support contact>" [verificationHours]
// Fills in the manual UPI payment settings and switches payments ON, so students no longer see "Payments are not available yet".
// Same checks as the admin page (valid UPI ID, no example IDs). Run it on the machine that hosts the database, then reload the student page.
import 'dotenv/config';
const { db } = await import('../server/src/db/index.js');
const { updateConfig, getAdminConfig } = await import('../server/src/services/payments.js');
const [upiId, payeeName, supportContact, hours] = process.argv.slice(2);
if (!upiId || !payeeName || !supportContact) {
  console.error('Usage: node scripts/setup-payments.mjs <upiId> "<payee name>" "<support contact>" [verificationHours]\nExample: node scripts/setup-payments.mjs elvora@okhdfcbank "ELVORA" "support@elvora.in" 24');
  process.exit(1);
}
try {
  const r = updateConfig({ id: null, fullName: 'Setup script', via: 'script' }, {
    confirm: true, upiId, payeeName, supportContact, verificationHours: Number(hours) || 24,
    instructions: 'Pay the exact amount shown, then enter the UTR (transaction reference) from your UPI app. Keep your payment screenshot.',
    manualEnabled: true, submissionsEnabled: true,
  });
  console.log(r.changed.length ? `Payments are ON. Updated: ${r.changed.join(', ')}` : 'Nothing to change: these settings were already saved.');
  console.log('Ready for students:', getAdminConfig().readiness ?? 'see /admin/priority-pricing');
} catch (e) { console.error('Could not save:', e.message, e.data?.error?.fields ? JSON.stringify(e.data.error.fields) : ''); process.exit(1); }
db.close?.();
