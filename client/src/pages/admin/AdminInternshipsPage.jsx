import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Briefcase, Plus, Search, Pencil, Eye, EyeOff, Power, Archive, ArchiveRestore, Trash2, Star, TriangleAlert, RefreshCw } from 'lucide-react';
import Button from '../../components/ui/Button';
import Pagination from '../../components/applications/Pagination';
import Modal, { ConfirmDialog } from '../../components/admin/Modal';
import { TextField, TextAreaField, SkillsInput } from '../../components/forms/Field';
import { useToast } from '../../components/ui/Toast';
import { useAdminList } from '../../hooks/useAdminList';
import { usePageMeta } from '../../hooks/usePageMeta';
import { fmtDate } from '../../lib/format';
import * as api from '../../services/adminManagementService';

const FILTERS = [['all', 'All'], ['published', 'Published'], ['draft', 'Drafts'], ['active', 'Active'], ['inactive', 'Inactive'], ['archived', 'Archived']];
const EMPTY = { title: '', category: '', description: '', durationDays: '', skills: [], outcomes: '', who: '', academic: '', knowledge: '', type: '', difficulty: '', seats: '', deadline: '', status: 'open', featured: false };
const toForm = (i) => ({ title: i.title, category: i.category, description: i.description, durationDays: String(i.durationDays), skills: i.skills, outcomes: i.outcomes.join('\n'),
  who: i.eligibility?.who ?? '', academic: i.eligibility?.academic ?? '', knowledge: (i.eligibility?.knowledge ?? []).join('\n'), type: i.type, difficulty: i.difficulty,
  seats: i.seats ?? '', deadline: i.deadline ?? '', status: i.status, featured: i.featured });
const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
const toBody = (f) => ({ title: f.title, category: f.category, description: f.description, durationDays: f.durationDays === '' ? '' : Number(f.durationDays), skills: f.skills,
  outcomes: lines(f.outcomes), eligibility: { who: f.who, academic: f.academic, knowledge: lines(f.knowledge) }, type: f.type, difficulty: f.difficulty,
  seats: f.seats === '' ? null : f.seats, deadline: f.deadline || null, status: f.status, featured: f.featured });

// Frontend mirror of the server rules, for instant feedback only. The server is authoritative.
function validate(f, opts) {
  const e = {};
  if (!f.title.trim()) e.title = 'Title is required'; else if (f.title.trim().length < 3) e.title = 'Title is too short';
  if (!f.category) e.category = 'Choose a category';
  if (!f.description.trim()) e.description = 'Description is required'; else if (f.description.trim().length < 20) e.description = 'Write at least 20 characters';
  if (!f.durationDays) e.durationDays = 'Choose a duration';
  if (!f.skills.length) e.skills = 'Add at least one skill';
  if (!lines(f.outcomes).length) e.outcomes = 'Add at least one learning outcome (one per line)';
  if (!f.who.trim()) e.who = 'Describe who this internship is for';
  if (!f.type) e.type = 'Choose a type'; if (!f.difficulty) e.difficulty = 'Choose a difficulty';
  if (f.seats !== '' && (!/^\d+$/.test(String(f.seats)) || Number(f.seats) < 1)) e.seats = 'Enter a whole number of 1 or more, or leave blank';
  return e;
}

function Select({ label, name, value, onChange, error, options, placeholder = 'Select…' }) {
  const id = `f-${name}`;
  return (
    <div className={`field ${error ? 'field--error' : ''}`}>
      <label className="field__label" htmlFor={id}>{label}</label>
      <div className="field__control">
        <select id={id} value={value} onChange={(e) => onChange(name, e.target.value)} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-m` : undefined}>
          <option value="">{placeholder}</option>
          {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {error && <p className="field__error" id={`${id}-m`}>{error}</p>}
    </div>
  );
}

function ListingForm({ initial, opts, editing, onClose, onSaved }) {
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const set = (k, v) => { setF((s) => ({ ...s, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  const lockedCategory = editing && editing.applicationCount > 0;

  const submit = async (ev) => {
    ev.preventDefault();
    const e = validate(f, opts); setErrors(e); setFormError('');
    if (Object.keys(e).length) { setFormError('Please fix the highlighted fields.'); return; }
    setBusy(true);
    try { onSaved(editing ? await api.updateListing(editing.id, toBody(f)) : await api.createListing(toBody(f)), !editing); }
    catch (err) {
      const fields = err.data?.error?.fields ?? {};
      setErrors({ ...fields, who: fields.eligibility });
      setFormError(err.status === 0 ? err.message : err.message || 'Could not save.');
      setBusy(false);
    }
  };
  return (
    <Modal title={editing ? `Edit ${editing.id}` : 'Create internship'} onClose={onClose} wide busy={busy}>
      <form onSubmit={submit} noValidate>
        <div className="adm-modal__body adm-form">
          {!editing && <p className="text-muted adm-form__note">New internships are saved as <strong>drafts</strong>. Publish them from the list when they are ready.</p>}
          <TextField label="Title" name="title" value={f.title} onChange={set} error={errors.title} maxLength={120} />
          <div className="adm-form__row">
            <Select label="Category" name="category" value={f.category} onChange={set} error={errors.category} options={opts.categories.map((c) => [c.slug, c.label])} />
            <Select label="Duration" name="durationDays" value={f.durationDays} onChange={set} error={errors.durationDays} options={opts.durations.map((d) => [String(d.days), d.label])} />
          </div>
          {lockedCategory && <p className="field__hint">The category is locked because students have already applied.</p>}
          <TextAreaField label="Description" name="description" value={f.description} onChange={set} error={errors.description} maxLength={600} rows={3} />
          <SkillsInput label="Skills required" name="skills" value={f.skills} onChange={set} error={errors.skills} optional={false} />
          <TextAreaField label="Learning outcomes" name="outcomes" value={f.outcomes} onChange={set} error={errors.outcomes} rows={4} hint="One outcome per line." />
          <TextAreaField label="Eligibility: who is it for?" name="who" value={f.who} onChange={set} error={errors.who} maxLength={300} rows={2} />
          <div className="adm-form__row">
            <TextField label="Academic requirement" name="academic" value={f.academic} onChange={set} error={errors.academic} optional maxLength={300} />
            <TextAreaField label="Prerequisites" name="knowledge" value={f.knowledge} onChange={set} rows={2} hint="One per line (optional)." />
          </div>
          <div className="adm-form__row">
            <Select label="Internship type" name="type" value={f.type} onChange={set} error={errors.type} options={opts.types.map((t) => [t, t])} />
            <Select label="Difficulty" name="difficulty" value={f.difficulty} onChange={set} error={errors.difficulty} options={opts.difficulties.map((d) => [d, d])} />
          </div>
          <div className="adm-form__row">
            <TextField label="Available seats" name="seats" value={f.seats} onChange={set} error={errors.seats} optional inputMode="numeric" hint="Leave blank for no limit." />
            <TextField label="Application deadline" name="deadline" type="date" value={f.deadline} onChange={set} error={errors.deadline} optional />
          </div>
          <div className="adm-form__row">
            <Select label="Application window" name="status" value={f.status} onChange={set} error={errors.status} options={[['open', 'Open'], ['upcoming', 'Opens soon']]} placeholder="Choose…" />
            <label className="adm-check"><input type="checkbox" checked={f.featured} onChange={(e) => set('featured', e.target.checked)} /> Featured on the public site</label>
          </div>
          {formError && <p className="field__error" role="alert">{formError}</p>}
        </div>
        <footer className="adm-modal__foot">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <button type="submit" className="btn btn--primary" disabled={busy} aria-busy={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create internship'}</button>
        </footer>
      </form>
    </Modal>
  );
}

function StateBadges({ i }) {
  if (i.archivedAt) return <span className="status status--slate"><Archive size={14} aria-hidden="true" />Archived</span>;
  return (
    <span className="adm-badges">
      <span className={`status ${i.published ? 'status--teal' : 'status--amber'}`}>{i.published ? 'Published' : 'Draft'}</span>
      <span className={`status ${i.active ? 'status--blue' : 'status--slate'}`}>{i.active ? 'Active' : 'Inactive'}</span>
      {i.featured && <span className="status status--indigo"><Star size={13} aria-hidden="true" />Featured</span>}
    </span>
  );
}

export default function AdminInternshipsPage() {
  usePageMeta('Internships · Admin');
  const toast = useToast();
  const [opts, setOpts] = useState(null);
  const [optsError, setOptsError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState(null); // { editing? }
  const [confirm, setConfirm] = useState(null); // { item, action }
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');

  const loadOpts = useCallback(() => { setOptsError(null); api.getListingOptions().then(setOpts).catch(setOptsError); }, []);
  useEffect(() => { loadOpts(); }, [loadOpts]);
  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);

  const { loading, error, data, reload } = useAdminList(api.listListings, { state: filter, category, q, page, pageSize: 10 });
  const catLabel = (slug) => opts?.categories.find((c) => c.slug === slug)?.label ?? slug;
  const durLabel = (d) => opts?.durations.find((x) => x.days === d)?.label ?? `${d} days`;

  const ACTIONS = {
    publish: { title: 'Publish internship', verb: 'Publish', text: 'It will appear on the public internships pages and students can apply (if it is active and the window is open).' },
    unpublish: { title: 'Unpublish internship', verb: 'Unpublish', text: 'It disappears from the public site. Existing applications are kept.' },
    activate: { title: 'Activate internship', verb: 'Activate', text: 'Students can apply again, within the deadline.' },
    deactivate: { title: 'Deactivate internship', verb: 'Deactivate', text: 'It stays visible but shows as closed, and new applications are refused. Existing applications are kept.', danger: true },
    archive: { title: 'Archive internship', verb: 'Archive', text: 'It is hidden from students and closed to applications. The record and every application that references it are kept. You can restore it later.', danger: true },
    restore: { title: 'Restore internship', verb: 'Restore', text: 'It comes back as an unpublished, inactive draft. Publish and activate it again when ready.' },
    delete: { title: 'Delete internship', verb: 'Delete permanently', text: 'This cannot be undone. Only unpublished internships with no applications can be deleted; otherwise archive it.', danger: true },
  };
  const run = async () => {
    const { item, action } = confirm;
    setBusy(true); setConfirmError('');
    try {
      if (action === 'delete') await api.deleteListing(item.id); else await api.listingAction(item.id, action);
      setConfirm(null); toast.success(`${ACTIONS[action].verb === 'Delete permanently' ? 'Deleted' : `${ACTIONS[action].verb}${action.endsWith('e') ? 'd' : 'ed'}`}: ${item.title}`);
      reload();
    } catch (err) { setConfirmError(err.status === 0 ? err.message : err.message || 'That did not work.'); } // shown only after the server refused or failed
    finally { setBusy(false); }
  };

  const rows = data?.internships ?? [];
  const counts = data?.counts;
  const ask = (item, action) => { setConfirmError(''); setConfirm({ item, action }); };

  const rowButtons = (i) => (
    <div className="adm-rowact">
      {!i.archivedAt && <button type="button" className="btn btn--secondary btn--sm" onClick={() => setForm({ editing: i })} aria-label={`Edit ${i.title}`}><Pencil size={14} aria-hidden="true" />Edit</button>}
      {!i.archivedAt && (i.published
        ? <button type="button" className="btn btn--secondary btn--sm" onClick={() => ask(i, 'unpublish')} aria-label={`Unpublish ${i.title}`}><EyeOff size={14} aria-hidden="true" />Unpublish</button>
        : <button type="button" className="btn btn--secondary btn--sm" onClick={() => ask(i, 'publish')} aria-label={`Publish ${i.title}`}><Eye size={14} aria-hidden="true" />Publish</button>)}
      {!i.archivedAt && <button type="button" className="btn btn--secondary btn--sm" onClick={() => ask(i, i.active ? 'deactivate' : 'activate')} aria-label={`${i.active ? 'Deactivate' : 'Activate'} ${i.title}`}><Power size={14} aria-hidden="true" />{i.active ? 'Deactivate' : 'Activate'}</button>}
      {i.archivedAt
        ? <button type="button" className="btn btn--secondary btn--sm" onClick={() => ask(i, 'restore')} aria-label={`Restore ${i.title}`}><ArchiveRestore size={14} aria-hidden="true" />Restore</button>
        : <button type="button" className="btn btn--secondary btn--sm" onClick={() => ask(i, 'archive')} aria-label={`Archive ${i.title}`}><Archive size={14} aria-hidden="true" />Archive</button>}
      {i.canDelete && !i.published && <button type="button" className="btn btn--secondary btn--sm adm-danger" onClick={() => ask(i, 'delete')} aria-label={`Delete ${i.title}`}><Trash2 size={14} aria-hidden="true" />Delete</button>}
    </div>
  );

  return (
    <div className="adm-page">
      <header className="adm-page__head">
        <div><h1>Internships</h1><p className="text-muted">Create and manage the internships students can see and apply to.</p></div>
        <Button icon={Plus} onClick={() => setForm({})} disabled={!opts}>Create internship</Button>
      </header>

      <div className="adm-tools card">
        <div className="adm-searchbox"><Search size={16} aria-hidden="true" /><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title or ID" aria-label="Search internships" maxLength={80} /></div>
        <label className="sr-only" htmlFor="adm-cat">Category</label>
        <select id="adm-cat" className="adm-select" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
          <option value="">All categories</option>
          {opts?.categories.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
        </select>
      </div>
      <div className="adm-chips" role="group" aria-label="Filter internships">
        {FILTERS.map(([v, l]) => (
          <button key={v} type="button" className={`adm-chip ${filter === v ? 'is-on' : ''}`} aria-pressed={filter === v} onClick={() => { setFilter(v); setPage(1); }}>
            {l}{counts && <span className="adm-chip__n">{counts[v === 'draft' ? 'draft' : v]}</span>}
          </button>
        ))}
      </div>

      {optsError && <div className="empty" role="alert"><h3>Couldn’t load form options</h3><p className="text-muted">{optsError.status === 401 || optsError.status === 403 ? 'Your administrator session has ended. Sign in again.' : optsError.message}</p><Button onClick={loadOpts}>Try again</Button></div>}

      {error && !data ? (
        <div className="empty" role="alert">
          <span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span>
          <h3>Couldn’t load internships</h3>
          <p className="text-muted">{error.status === 401 || error.status === 403 ? 'Your administrator session has ended. Sign in again.' : error.status === 0 ? error.message : 'Something went wrong. Please try again.'}</p>
          {error.status === 401 || error.status === 403 ? <Button to="/admin/login">Sign in</Button> : <Button icon={RefreshCw} onClick={reload}>Try again</Button>}
        </div>
      ) : loading && !data ? (
        <div className="card asks" aria-hidden="true">{[0, 1, 2, 3].map((n) => <i key={n} className="sk sk--line" />)}</div>
      ) : rows.length === 0 ? (
        <div className="empty" role="status">
          <span className="empty__icon"><Briefcase size={28} aria-hidden="true" /></span>
          <h3>{q || category || filter !== 'all' ? 'No internships match' : 'No internships yet'}</h3>
          <p className="text-muted">{q || category || filter !== 'all' ? 'Try a different search or filter.' : 'Create your first internship to get started.'}</p>
          {!(q || category || filter !== 'all') && <Button icon={Plus} onClick={() => setForm({})} disabled={!opts}>Create internship</Button>}
        </div>
      ) : (
        <div className={loading ? 'adm-loading' : ''} aria-busy={loading}>
          <div className="atable card">
            <table>
              <caption className="sr-only">Internships</caption>
              <thead><tr><th scope="col">ID</th><th scope="col">Internship</th><th scope="col">Duration</th><th scope="col">Deadline</th><th scope="col">Seats</th><th scope="col">Apps</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.id}</td>
                    <td><span className="atable__title">{i.title}</span><span className="atable__cat">{catLabel(i.category)} · {i.type} · {i.difficulty}</span></td>
                    <td>{durLabel(i.durationDays)}</td>
                    <td>{i.deadline ? fmtDate(i.deadline) : '—'}</td>
                    <td>{i.seats ?? '—'}</td>
                    <td>{i.applicationCount}</td>
                    <td><StateBadges i={i} /></td>
                    <td className="atable__act">{rowButtons(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="acards">
            {rows.map((i) => (
              <li key={i.id} className="acards__item card">
                <div className="acards__top"><div><p className="acards__cat">{catLabel(i.category)}</p><h2 className="acards__title">{i.title}</h2></div></div>
                <StateBadges i={i} />
                <dl className="acards__facts">
                  <div><dt>ID</dt><dd className="mono">{i.id}</dd></div><div><dt>Duration</dt><dd>{durLabel(i.durationDays)}</dd></div>
                  <div><dt>Deadline</dt><dd>{i.deadline ? fmtDate(i.deadline) : '—'}</dd></div><div><dt>Applications</dt><dd>{i.applicationCount}</dd></div>
                </dl>
                {rowButtons(i)}
              </li>
            ))}
          </ul>
          <Pagination {...data.pagination} onChange={setPage} />
        </div>
      )}

      {form && opts && (
        <ListingForm initial={form.editing ? toForm(form.editing) : EMPTY} opts={opts} editing={form.editing} onClose={() => setForm(null)}
          onSaved={(saved, created) => { setForm(null); toast.success(created ? `Created ${saved.id} as a draft` : `Saved ${saved.id}`); reload(); }} />
      )}
      {confirm && (
        <ConfirmDialog title={ACTIONS[confirm.action].title} confirmLabel={ACTIONS[confirm.action].verb} danger={ACTIONS[confirm.action].danger} busy={busy} error={confirmError} onConfirm={run} onClose={() => setConfirm(null)}>
          <p><strong>{confirm.item.title}</strong> <span className="mono text-muted">({confirm.item.id})</span></p>
          <p className="text-muted">{ACTIONS[confirm.action].text}</p>
          {confirm.action === 'archive' && confirm.item.applicationCount > 0 && <p className="text-muted">{confirm.item.applicationCount} application{confirm.item.applicationCount === 1 ? '' : 's'} will be preserved.</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}
