import { useEffect, useMemo, useState } from 'react';
import { Clock, Gauge, Target, Wrench, ListChecks, FolderTree, FlaskConical, BadgeCheck, BookOpen, GraduationCap, Send, Scale, Lightbulb, Play } from 'lucide-react';

// Stage 09B — one readable view of a task, used by students (their assignment) and administrators (library preview).
// `task` is the stored task or template: { title, shortDescription, difficulty, estimatedHours, learningStage, content, learningObjectives, deliverables, resources, ... }.
// Older tasks (Stage 09A) have only some sections; a section with no content is simply not shown.
const STAGES = ['Beginner Foundation', 'Intermediate Implementation', 'Practical Internship Project'];
const List = ({ items, ordered }) => (ordered ? <ol className="td-list td-list--steps">{items.map((s, i) => <li key={i}>{s}</li>)}</ol> : <ul className="td-list">{items.map((s, i) => <li key={i}>{s}</li>)}</ul>);
const Concepts = ({ items }) => (
  <dl className="td-concepts">{items.map((c, i) => { const [term, ...rest] = c.split(/:\s(.+)/); return rest.length ? <div key={i}><dt>{term}</dt><dd>{rest[0].charAt(0).toUpperCase() + rest[0].slice(1)}</dd></div> : <div key={i}><dd>{c}</dd></div>; })}</dl>
);
const safeGet = (k) => { try { return JSON.parse(window.localStorage.getItem(k) ?? '[]'); } catch { return []; } };
const safeSet = (k, v) => { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable: progress is kept for this visit only */ } };

export function StageSteps({ current }) {
  const at = STAGES.indexOf(current);
  return (
    <ol className="td-stages" aria-label="Learning stages">
      {STAGES.map((s, i) => <li key={s} className={i === at ? 'is-current' : i < at ? 'is-done' : ''} aria-current={i === at ? 'step' : undefined}><span>{i + 1}</span>{s}</li>)}
    </ol>
  );
}

export default function TaskDetail({ task, storageKey = null }) {
  const c = task.content ?? {};
  const stage = c.learningStage ?? task.learningStage;
  const checklist = c.completionChecklist ?? [];
  const [done, setDone] = useState([]);
  useEffect(() => { setDone(storageKey ? safeGet(`elv-checklist:${storageKey}`) : []); }, [storageKey]);
  const toggle = (i) => setDone((d) => { const n = d.includes(i) ? d.filter((x) => x !== i) : [...d, i]; if (storageKey) safeSet(`elv-checklist:${storageKey}`, n); return n; });
  const pct = checklist.length ? Math.round((done.filter((i) => i < checklist.length).length / checklist.length) * 100) : 0;

  const sections = useMemo(() => [
    ['overview', 'What you are building', Target, c.objective || c.problemStatement || c.background],
    ['concepts', 'Concepts to learn first', Lightbulb, c.concepts?.length],
    ['features', 'Required features', ListChecks, c.features?.length],
    ['tech', 'Technologies and requirements', Wrench, c.tools?.length || c.technicalRequirements?.length],
    ['structure', 'Code organisation', FolderTree, c.folderStructure],
    ['steps', 'Step-by-step plan', Play, c.steps?.length],
    ['behavior', 'Expected behaviour', BadgeCheck, c.expectedBehavior || c.expectedOutput],
    ['testing', 'How to test', FlaskConical, c.testingRequirements?.length],
    ['accept', 'Acceptance criteria', BadgeCheck, c.acceptanceCriteria?.length],
    ['submit', 'What to submit', Send, task.deliverables?.length || c.submissionRequirements],
    ['rubric', 'How you will be evaluated', Scale, c.rubric?.length || task.evaluationCriteria?.length],
    ['learn', 'Learning outcomes and resources', GraduationCap, task.learningObjectives?.length || task.resources?.length],
  ].filter((s) => s[3]), [task, c]);

  return (
    <article className="td">
      <header className="td__head card">
        {stage && <StageSteps current={stage} />}
        <h1>{task.title}</h1>
        {task.shortDescription && <p className="td__lead">{task.shortDescription}</p>}
        <ul className="td__facts" aria-label="Task facts">
          {stage && <li className="badge-sm badge-sm--blue">{stage}</li>}
          {task.difficulty && <li className="badge-sm"><Gauge size={14} aria-hidden="true" />{task.difficulty}</li>}
          {task.estimatedHours ? <li className="badge-sm"><Clock size={14} aria-hidden="true" />About {task.estimatedHours} hours</li> : null}
          {task.taskType && <li className="badge-sm">{task.taskType}</li>}
        </ul>
      </header>
      <div className="td__body">
        <nav className="td__toc card" aria-label="On this page"><strong>On this page</strong><ol>{sections.map(([id, label]) => <li key={id}><a href={`#td-${id}`}>{label}</a></li>)}</ol>
          {checklist.length > 0 && <div className="td__meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Checklist progress"><span style={{ width: `${pct}%` }} /><small>{pct}% of checklist done</small></div>}
        </nav>
        <div className="td__main">
          {sections.map(([id, label, Icon]) => (
            <section key={id} id={`td-${id}`} className="td__section card" aria-labelledby={`td-h-${id}`}>
              <h2 id={`td-h-${id}`}><Icon size={18} aria-hidden="true" />{label}</h2>
              {id === 'overview' && <>
                {c.objective && <p><strong>Objective. </strong>{c.objective}</p>}
                {c.problemStatement && <p><strong>The problem. </strong>{c.problemStatement}</p>}
                {!c.problemStatement && c.background && c.background !== c.objective && <p>{c.background}</p>}
              </>}
              {id === 'concepts' && <Concepts items={c.concepts} />}
              {id === 'features' && <List items={c.features} />}
              {id === 'tech' && <>
                {c.technicalRequirements?.length > 0 && <List items={c.technicalRequirements} />}
                {c.tools?.length > 0 && <><h3>Free tools</h3><p className="td__tags">{c.tools.map((t) => <span key={t} className="chip chip--muted">{t}</span>)}</p></>}
                {task.requiredSkills?.length > 0 && <><h3>You should already know</h3><p className="td__tags">{task.requiredSkills.map((t) => <span key={t} className="chip">{t}</span>)}</p></>}
              </>}
              {id === 'structure' && <pre className="td__code" tabIndex={0}><code>{c.folderStructure}</code></pre>}
              {id === 'steps' && <List items={c.steps} ordered />}
              {id === 'behavior' && <p>{c.expectedBehavior || c.expectedOutput}</p>}
              {id === 'testing' && <List items={c.testingRequirements} />}
              {id === 'accept' && <List items={c.acceptanceCriteria} />}
              {id === 'submit' && <>
                {task.deliverables?.length > 0 && <List items={task.deliverables} />}
                {c.submissionRequirements && <p>{c.submissionRequirements}</p>}
                {checklist.length > 0 && <><h3>Completion checklist</h3><ul className="td-check">{checklist.map((item, i) => (
                  <li key={i}><label><input type="checkbox" checked={done.includes(i)} onChange={() => toggle(i)} />{item}</label></li>))}</ul>
                  <p className="text-muted td__note">Your ticks are a personal reminder saved in this browser. They are not part of your submission.</p></>}
              </>}
              {id === 'rubric' && (c.rubric?.length
                ? <div className="td-rubric" role="table" aria-label="Evaluation rubric">{c.rubric.map((r) => (
                  <div key={r.criterion} role="row"><div role="cell"><strong>{r.criterion}</strong>{r.description && <small>{r.description}</small>}</div><div role="cell" className="td-rubric__w"><span style={{ width: `${r.weight}%` }} /><b>{r.weight}%</b></div></div>))}</div>
                : <List items={task.evaluationCriteria} />)}
              {id === 'learn' && <>
                {task.learningObjectives?.length > 0 && <List items={task.learningObjectives} />}
                {task.resources?.length > 0 && <><h3><BookOpen size={16} aria-hidden="true" /> Official learning resources</h3><ul className="td-list">{task.resources.map((r) => <li key={r.url}><a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a></li>)}</ul></>}
              </>}
            </section>
          ))}
        </div>
      </div>
    </article>
  );
}
