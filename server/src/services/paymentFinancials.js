import * as Pay from '../db/payments.js';
import { record as audit } from '../db/audit.js';
import { can } from './payments.js';
import { formatInr } from './priorityCertificate.js';
import { HttpError, badRequest } from '../utils/errors.js';

// Stage 10C Part 1 — financial reporting and the admin-only CSV export.
//
//   Net Collections = Confirmed Gross Receipts − Completed Refunds
//
// "Confirmed gross receipts" is the sum of payment_transactions: one row per payment an administrator CONFIRMED against the real receiving account.
// Pending, awaiting, rejected, expired and unverified submissions have no such row, so they can never be counted as revenue. Free administrative corrections
// are stored in their own table (fee is constrained to 0) and never create a payment or a transaction. Requested/approved refunds are shown as "refund pending"
// and are NOT deducted from net collections until an administrator records the real transfer (REFUNDED).
// Nothing here is proof that money reached a bank account: the figures are the administrators' own confirmations. They must be reconciled against the real statement.
const fail = (status, code, message, details) => new HttpError(status, message, { code, details });
const need = (admin) => { if (admin?.via !== 'session' || !admin.id || !can(admin, 'payment.report')) throw fail(403, 'PERMISSION_REQUIRED', 'You do not have permission to view financial reports.'); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s); // an impossible date such as 2026-13-40 must be a 400, never a thrown RangeError
const money = (paise) => ({ paise, display: formatInr(paise) });
export const REPORT_NOTICE = 'Figures count only payments an administrator confirmed against the real receiving account. A student-entered UTR or screenshot is not proof of payment. Pending, rejected and unverified submissions are never revenue, and free corrections are never paid transactions. Net Collections = Confirmed Gross Receipts − Completed Refunds.';

function filters(query = {}) {
  const errors = {}; const one = (k) => (typeof query[k] === 'string' && query[k].trim() !== '' && query[k] !== 'All' ? query[k].trim().slice(0, 40) : null);
  const from = one('from'); const to = one('to'); const status = one('status') ?? 'all';
  if (from && !validDate(from)) errors.from = 'Use a date like 2026-11-01';
  if (to && !validDate(to)) errors.to = 'Use a date like 2026-11-30';
  if (from && to && !errors.from && !errors.to && from > to) errors.to = 'The end date can’t be before the start date';
  if (!Pay.TRANSACTION_STATUSES.includes(status)) errors.status = `Use one of: ${Pay.TRANSACTION_STATUSES.join(', ')}`;
  if (Object.keys(errors).length) throw badRequest('Invalid filter', errors);
  return { from, to, status };
}

export function summary(admin, query = {}) {
  need(admin);
  const { from, to } = filters({ from: query.from, to: query.to });
  const t = Pay.financialTotals({ from, to });
  const gross = t.gross.paise; const done = t.refundDone.paise; const net = gross - done;
  const integrity = Pay.financialIntegrity(); const clean = Object.values(integrity).every((n) => n === 0);
  audit({ admin, action: 'payment.report_view', targetType: 'report', targetId: 'financial', reason: `${from ?? 'start'}..${to ?? 'now'}` });
  return {
    notice: REPORT_NOTICE, period: { from, to }, currency: 'INR',
    submissions: { total: t.submissions.n, payments: t.submissions.payments, note: 'Every UTR submission, including corrections. A submission is a claim, not revenue.' },
    awaitingPayment: { count: t.awaiting.count ?? t.awaiting.n, amount: money(t.awaiting.paise) },
    pending: { count: t.pending.n, overdue: t.overdue, amount: money(t.pending.paise), note: 'Awaiting administrator verification. Not revenue.' },
    confirmedGrossReceipts: { count: t.gross.n, amount: money(gross) },
    rejected: { decisions: t.rejectedDecisions, paymentsCurrentlyRejected: t.rejectedNow.n, amount: money(t.rejectedNow.paise), note: 'Not revenue.' },
    refundPending: { count: t.refundOpen.count, requested: money(t.refundOpen.requestedPaise), approved: money(t.refundOpen.approvedPaise), amount: money(t.refundOpen.requestedPaise + t.refundOpen.approvedPaise),
      note: 'Requested or approved but not yet sent. Not deducted from net collections until the transfer is recorded.' },
    completedRefunds: { count: t.refundDone.n, amount: money(done) },
    refundsDeclined: t.refundRejected,
    netCollections: { amount: money(net), formula: 'Confirmed Gross Receipts − Completed Refunds', note: from || to ? 'For a date range this is receipts verified in the range minus refunds completed in the range; it can be negative when a refund in the range relates to a receipt from an earlier period.' : undefined },
    freeCorrections: { count: t.free.n, feesCollected: money(t.free.fees), note: 'Free administrative corrections are never paid transactions and are excluded from every figure above.' },
    integrity: { ok: clean, checks: integrity },
  };
}

export function transactions(admin, query = {}) {
  need(admin);
  const f = filters(query);
  const size = Math.min(200, Math.max(1, Number.isInteger(Number(query.pageSize)) ? Number(query.pageSize) : 50)); const page = Math.max(1, Number.isInteger(Number(query.page)) ? Number(query.page) : 1);
  const { total, rows } = Pay.transactionRows({ ...f, limit: size, offset: (page - 1) * size });
  return { filters: f, statuses: Pay.TRANSACTION_STATUSES, pagination: { page, pageSize: size, total }, transactions: rows.map((r) => ({ ...r, confirmedDisplay: formatInr(r.confirmedPaise), refundedDisplay: formatInr(r.refundedPaise), refundPendingDisplay: formatInr(r.refundPendingPaise) })) };
}

// ---------------- CSV ----------------
export const CSV_COLUMNS = Object.freeze(['transaction_id', 'payment_id', 'payment_reference', 'request_id', 'student_id', 'duration_days', 'confirmed_amount_inr', 'currency', 'confirmed_utr',
  'verified_at', 'verified_by_id', 'verified_by_name', 'payment_status', 'refunded_inr', 'refund_pending_inr', 'net_inr']);
const inr = (paise) => `${Math.trunc(paise / 100)}.${String(Math.abs(paise % 100)).padStart(2, '0')}`;
// Spreadsheet formula injection: a cell that begins with = + - @ (or tab / CR) would be executed by Excel; a leading apostrophe makes it plain text. Then RFC 4180 quoting.
export const csvCell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const MAX_EXPORT_ROWS = 20000;
// Only confirmed transaction records are exported. No student name, e-mail, phone, screenshot, proof file name, UPI destination, QR image or secret is ever included: the student is identified by ID only.
export function exportCsv(admin, query = {}) {
  need(admin);
  const f = filters(query);
  const { total, rows } = Pay.transactionRows({ ...f, limit: MAX_EXPORT_ROWS, offset: 0 });
  if (total > MAX_EXPORT_ROWS) throw fail(413, 'EXPORT_TOO_LARGE', `This export has ${total} rows; narrow the date range (the limit is ${MAX_EXPORT_ROWS}).`);
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push([r.id, r.paymentId, r.paymentReference, r.requestId, r.studentId, r.durationDays, inr(r.confirmedPaise), r.currency, r.confirmedUtr, r.verifiedAt, r.verifiedBy, r.verifiedByName, r.paymentStatus, inr(r.refundedPaise), inr(r.refundPendingPaise), inr(r.confirmedPaise - r.refundedPaise)].map(csvCell).join(','));
  audit({ admin, action: 'payment.export', targetType: 'report', targetId: 'transactions', reason: `rows ${rows.length}; status ${f.status}; ${f.from ?? 'start'}..${f.to ?? 'now'}` });
  return { filename: `elvora-transactions-${new Date().toISOString().slice(0, 10)}.csv`, body: `\uFEFF${lines.join('\r\n')}\r\n`, rows: rows.length };
}
