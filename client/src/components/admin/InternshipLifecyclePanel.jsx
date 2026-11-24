import { useCallback, useEffect, useState } from 'react';
import { Play, Pause, BadgeCheck, Ban, Gauge, CircleCheck, Circle, RefreshCw, History, Clock, Award, ListChecks, ListPlus, CalendarRange, CalendarDays, CalendarCheck, ChevronRight } from 'lucide-react';
import Button from '../ui/Button';
import { ConfirmDialog } from './Modal';
import { TextField, TextAreaField } from '../forms/Field';
import { useToast } from '../ui/Toast';
import InternshipStatusBadge from '../internships/InternshipStatusBadge';
import { fmtDate, fmtDateTime } from '../../lib/format';
import * as api from '../../services/adminManagementService';

const today = () => new Date().toISOString().slice(0, 10);
const MAX_BACK_DAYS = 90; // the server enforces the same limit
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const addDaysTo = (v, n) => { const d = new Date(`${v}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TEXT = {
  activate: { title: 'Activate internship', confirm: 'Activate', done: 'Internship activated. The student was notified.' },
  resume: { title: 'Resume internship', confirm: 'Resume', done: 'Internship resumed. The student was notified.' },
  suspend: { title: 'Suspend internship', confirm: 'Suspend', done: 'Internship suspended. The student was notified.', danger: true },
  cancel: { title: 'Cancel internship', confirm: 'Cancel internship', done: 'Internship cancelled. The student was notified.', danger: true },
  complete: { title: 'Mark as completed', confirm: 'Mark completed', done: 'Internship marked as completed. The student was notified.' },
  schedule: { title: 'Set dates', confirm: 'Save dates', done: 'Dates saved. The student was notified.' },
  progress: { title: 'Update progress', confirm: 'Save progress', done: 'Progress saved. The student was notified.' },
};

// Icon-only control (label lives in title + aria-label so screen readers and long-press still say what it does).
function IconBtn({ icon: Icon, label, tone = '', onClick, busy = false }) {
  return <button type="button" className={`adm-ib ${tone ? `adm-ib--${tone}` : ''}`} title={label} aria-label={label} onClick={onClick} disabled={busy}><Icon size={20} aria-hidden="true" /></button>;
}
const STEPS = [['Awaiting Start', Clock], ['Active', Play], ['Completed', Award]];
function Stepper({ status }) {
  if (status === 'Suspended' || status === 'Cancelled') return <div className="adm-steps"><InternshipStatusBadge status={status} /></div>;
  const at = STEPS.findIndex(([k]) => k === status);
  return (
    <ol className="adm-steps" aria-label={`Status: ${status}`}>
      {STEPS.map(([k, Icon], n) => (
        <li key={k} className={n < at ? 'is-done' : n === at ? 'is-now' : ''} title={k} aria-current={n === at ? 'step' : undefined}>
          <span className="adm-steps__dot"><Icon size={16} aria-hidden="true" /></span><span className="sr-only">{k}</span>
          {n < STEPS.length - 1 && <ChevronRight size={14} className="adm-steps__arrow" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

// Lifecycle controls for ONE internship record. Nothing is shown as done until the server confirms; the server re-validates every rule.
export default function InternshipLifecyclePanel({ internshipId, onChanged }) {
  const toast = useToast();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [action, setAction] = useState(null); // key of TEXT
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState({ message: '', fields: {} });

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    api.getLifecycle(internshipId).then((data) => setState({ loading: false, error: null, data })).catch((error) => setState((s) => ({ ...s, loading: false, error })));
  }, [internshipId]);
  useEffect(() => { load(); }, [load]);

  const open = (key) => {
    const i = state.data.internship;
    setErr({ message: '', fields: {} });
    setForm({ startDate: i.startDate ?? today(), expectedEndDate: i.expectedEndDate ?? '', assignedProject: i.assignedProject ?? '', reason: '', progress: i.progressPercent ?? 0, note: '', confirm: false });
    setAction(key);
  };
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setErr((e) => ({ ...e, fields: { ...e.fields, [k]: '' } })); };

  const assign = async () => {
    setBusy(true);
    try {
      const r = await api.assignTasks(internshipId);
      if (r.assigned) toast.success(`${r.assigned} task${r.assigned === 1 ? '' : 's'} assigned to the student.`);
      else if (r.total) toast.success('The student already has every task.');
      else toast.error('No tasks are available for this internship yet. Publish tasks for it in the task library.');
      load(); onChanged?.();
    } catch (e) { toast.error(e.message || 'Could not assign tasks.'); } finally { setBusy(false); }
  };

  const submit = async () => {
    // Light client checks for instant feedback only; the server is the authority.
    const fields = {};
    if ((action === 'suspend' || action === 'cancel') && form.reason.trim().length < 5) fields.reason = 'Give a reason (at least 5 characters)';
    if (action === 'progress' && (!/^\d{1,3}$/.test(String(form.progress)) || Number(form.progress) > 100)) fields.progressPercent = 'Enter a whole number from 0 to 100';
    if (action === 'complete' && !form.confirm) fields.confirmReviewed = 'Confirm that you reviewed the conditions';
    if (action === 'activate' && form.startDate > today()) fields.startDate = 'Pick today or an earlier date';
    if ((action === 'activate' || action === 'schedule') && form.startDate && form.startDate < daysAgo(MAX_BACK_DAYS)) fields.startDate = `You can go back at most ${MAX_BACK_DAYS} days (earliest ${daysAgo(MAX_BACK_DAYS)})`;
    if (action === 'schedule' && !form.startDate) fields.startDate = 'Choose a start date';
    if (form.expectedEndDate && form.startDate && form.expectedEndDate < form.startDate) fields.expectedEndDate = 'The end date can’t be before the start date';
    if (Object.keys(fields).length) { setErr({ message: '', fields }); return; }
    const body = {
      activate: { startDate: form.startDate, ...(form.expectedEndDate ? { expectedEndDate: form.expectedEndDate } : {}) }, resume: {},
      suspend: { reason: form.reason }, cancel: { reason: form.reason }, progress: { progressPercent: Number(form.progress), note: form.note },
      complete: { confirmReviewed: form.confirm, note: form.note },
      schedule: { startDate: form.startDate, expectedEndDate: form.expectedEndDate || null, assignedProject: form.assignedProject },
    }[action];
    setBusy(true);
    try {
      if (action === 'schedule') await api.setSchedule(internshipId, body); else await api.lifecycleAction(internshipId, action === 'resume' ? 'activate' : action, body);
      toast.success(TEXT[action].done); // only after the server confirmed
      setAction(null); load(); onChanged?.();
    } catch (e) {
      setErr({ message: e.status === 0 ? e.message : e.message || 'Could not complete this action.', fields: e.data?.error?.fields ?? {} });
      if (e.data?.error?.code === 'INVALID_TRANSITION' || e.data?.error?.code === 'COMPLETION_CHECKS_FAILED') load(); // show the real current state
    } finally { setBusy(false); }
  };

  if (state.error && !state.data) return <div role="alert"><p className="text-muted">Couldn’t load the internship controls. {state.error.message}</p><Button icon={RefreshCw} variant="secondary" size="sm" onClick={load}>Try again</Button></div>;
  if (!state.data) return <div className="asks" aria-hidden="true"><i className="sk sk--line" /><i className="sk sk--line" /></div>;
  const { internship: i, events, completionChecks, allowedActions: a, tasks = { total: 0, approved: 0 } } = state.data;
  const t = action && TEXT[action];

  return (
    <div className={`adm-life ${state.loading ? 'adm-loading' : ''}`}>
      <div className="adm-life__top">
        <Stepper status={i.status} />
        <span className="mono adm-life__id">{i.id}</span>
      </div>
      <p className="adm-life__dates text-muted">
        <span title="Start date"><CalendarDays size={14} aria-hidden="true" /> {i.startDate ? fmtDate(i.startDate) : '—'}</span>
        <span title="Expected end"><CalendarCheck size={14} aria-hidden="true" /> {i.expectedEndDate ? fmtDate(i.expectedEndDate) : '—'}</span>
      </p>
      {i.status === 'Awaiting Start' && !i.startDate && <p className="adm-life__needs" role="status"><CalendarRange size={14} aria-hidden="true" /> Dates not set yet. Use “Set dates” to start this internship.</p>}
      <div className="adm-progress" role="img" aria-label={i.progressPercent === null ? 'Progress not recorded' : `Progress ${i.progressPercent}%`} title="Progress">
        <Gauge size={16} aria-hidden="true" />
        <div className="adm-progress__bar"><i style={{ width: `${i.progressPercent ?? 0}%` }} /></div>
        <span>{i.progressPercent === null ? '—' : `${i.progressPercent}%`}</span>
      </div>
      <div className={`adm-tasks ${tasks.total === 0 ? 'is-empty' : ''}`} title="Tasks given to the student">
        <ListChecks size={16} aria-hidden="true" /><span>{tasks.approved}/{tasks.total}</span>
      </div>
      <div className="adm-iconrow" role="toolbar" aria-label="Internship actions">
        {a.activate && <IconBtn icon={Play} tone="go" label="Activate" onClick={() => open('activate')} />}
        {a.resume && <IconBtn icon={Play} tone="go" label="Resume" onClick={() => open('resume')} />}
        {['Awaiting Start', 'Active', 'Suspended'].includes(i.status) && <IconBtn icon={CalendarRange} label="Set dates" onClick={() => open('schedule')} />}
        {a.progress && <IconBtn icon={Gauge} label="Update progress" onClick={() => open('progress')} />}
        {a.complete && <IconBtn icon={BadgeCheck} tone="go" label="Mark completed" onClick={() => open('complete')} />}
        {a.suspend && <IconBtn icon={Pause} tone="warn" label="Suspend" onClick={() => open('suspend')} />}
        {a.cancel && <IconBtn icon={Ban} tone="bad" label="Cancel internship" onClick={() => open('cancel')} />}
        {['Awaiting Start', 'Active'].includes(i.status) && <IconBtn icon={ListPlus} label="Give tasks to the student" onClick={assign} busy={busy} />}
      </div>

      {a.complete && (
        <details className="adm-fold">
          <summary title="Completion conditions"><CircleCheck size={16} aria-hidden="true" /> {completionChecks.filter((c) => c.passed).length}/{completionChecks.length}</summary>
          <ul className="adm-checks">{completionChecks.map((c) => (
            <li key={c.key} className={c.passed ? 'is-ok' : ''}>{c.passed ? <CircleCheck size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}<span>{c.label}</span></li>
          ))}</ul>
        </details>
      )}

      <details className="adm-fold">
        <summary title="History"><History size={16} aria-hidden="true" /> {events.length}</summary>
        {events.length === 0 ? <p className="text-muted">—</p> : (
        <ol className="adm-timeline">{[...events].reverse().map((e) => (
          <li key={e.id}>
            <p>{e.kind === 'status' ? <><strong>{e.from}</strong> → <strong>{e.to}</strong></> : e.kind === 'progress' ? <>Progress {e.detail}</> : 'Details updated'}</p>
            <p className="adm-timeline__meta">{fmtDateTime(e.at)} · by {e.by}</p>
            {e.kind === 'status' && e.detail && <p className="adm-timeline__note">“{e.detail}”</p>}
          </li>
        ))}</ol>
        )}
      </details>

      {t && (
        <ConfirmDialog title={t.title} confirmLabel={t.confirm} danger={t.danger} busy={busy} error={err.message} onConfirm={submit} onClose={() => setAction(null)}>
          {action === 'activate' && (<>
            <p>Confirm the start date. The student is notified.</p>
            <TextField label="Start date" name="startDate" type="date" min={daysAgo(MAX_BACK_DAYS)} max={today()} value={form.startDate} onChange={(_, v) => set('startDate', v)} error={err.fields.startDate} />
            <TextField label="Expected completion date (optional)" name="expectedEndDate" type="date" min={form.startDate} value={form.expectedEndDate} onChange={(_, v) => set('expectedEndDate', v)} error={err.fields.expectedEndDate} hint="Left empty, it is the start date plus the internship duration." optional />
          </>)}
          {action === 'schedule' && (<>
            <p>Choose when this internship runs. You can go back at most {MAX_BACK_DAYS} days. A start date of today or earlier starts it now; a later date starts it on that day.</p>
            <TextField label="Start date" name="startDate" type="date" min={daysAgo(MAX_BACK_DAYS)} value={form.startDate} onChange={(_, v) => set('startDate', v)} error={err.fields.startDate} />
            <TextField label="End date (optional)" name="expectedEndDate" type="date" min={form.startDate} value={form.expectedEndDate} onChange={(_, v) => set('expectedEndDate', v)} error={err.fields.expectedEndDate} hint={form.startDate ? `Left empty: ${addDaysTo(form.startDate, i.internship?.durationDays ?? 30)}` : 'Left empty, it is the start date plus the internship length.'} optional />
            <TextField label="Project for the student (optional)" name="assignedProject" value={form.assignedProject} maxLength={200} onChange={(_, v) => set('assignedProject', v)} error={err.fields.assignedProject} optional />
          </>)}
          {action === 'resume' && <p>Resume this internship? The student is notified.</p>}
          {(action === 'suspend' || action === 'cancel') && (<>
            <p>{action === 'suspend' ? 'The internship pauses and the student is notified.' : 'This ends the internship permanently. History is kept.'} The reason is saved and shown to the student.</p>
            <TextAreaField label="Reason" name="reason" rows={3} maxLength={500} value={form.reason} onChange={(_, v) => set('reason', v)} error={err.fields.reason} />
          </>)}
          {action === 'progress' && (<>
            <TextField label="Progress (%)" name="progress" type="number" inputMode="numeric" min={0} max={100} value={String(form.progress)} onChange={(_, v) => set('progress', v)} error={err.fields.progressPercent} />
            <TextAreaField label="Note (optional, internal)" name="note" rows={2} maxLength={300} value={form.note} onChange={(_, v) => set('note', v)} error={err.fields.note} />
          </>)}
          {action === 'complete' && (<>
            <ul className="adm-checks">{completionChecks.map((c) => <li key={c.key} className={c.passed ? 'is-ok' : ''}>{c.passed ? <CircleCheck size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}<span>{c.label}</span></li>)}</ul>
            <TextAreaField label="Completion note (optional)" name="note" rows={2} maxLength={300} value={form.note} onChange={(_, v) => set('note', v)} error={err.fields.note} />
            <label className="adm-check"><input type="checkbox" checked={form.confirm} onChange={(e) => set('confirm', e.target.checked)} /> I reviewed the conditions above and confirm this internship is complete.</label>
            {err.fields.confirmReviewed && <p className="field__error" role="alert">{err.fields.confirmReviewed}</p>}
          </>)}
        </ConfirmDialog>
      )}
    </div>
  );
}
