'use client';

// Ask questions about the open project with the visitor's own Anthropic API key.
// The key and the questions go straight from this browser to api.anthropic.com.
import Anthropic from '@anthropic-ai/sdk';
import { ASK_MODELS, DEFAULT_ASK_MODEL, askProject, describeAskError, type AskModel, type AskResult, type AskStep } from '@rea-studio/ask';
import type { StudioProject } from '@rea-studio/schema';
import { useMemo, useRef, useState } from 'react';
import type { Tour } from '../lib/project';
import { AnswerMarkdown } from './AnswerMarkdown';

const KEY_STORAGE = 'rea-studio:anthropic-api-key';

/** USD per million tokens: [input, output, cache read]. Cache writes bill at 1.25× input. */
const PRICES: Record<AskModel, [number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
};

function readStoredKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? sessionStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

function storeKey(key: string, remember: boolean) {
  try {
    sessionStorage.setItem(KEY_STORAGE, key);
    if (remember) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Storage unavailable (private mode): the key just lives for this page.
  }
}

function forgetKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    // ignore
  }
}

function suggestions(p: StudioProject): string[] {
  const found = (c: string) => p.findings.find((f) => f.category === c)?.status === 'found';
  const out = ['Give me a quick tour of how this app is put together.'];
  if (found('ipc')) out.push('How do the renderer and the main process talk to each other?');
  if (found('bridge-apis')) out.push('What does the preload expose to the web page, and what does each part do?');
  if (found('storage')) out.push('What does the app store locally, and which code writes it?');
  if (found('native-addons')) out.push('What native code does it load, and from where?');
  if (found('windows')) out.push('What windows does it create, and how are they configured?');
  return out.slice(0, 4);
}

function stepLabel(s: AskStep): string {
  if (s.type === 'answering') return 'Writing the answer';
  const input = (s.input ?? {}) as Record<string, string>;
  switch (s.name) {
    case 'project_overview':
      return 'Reading the project overview';
    case 'search_nodes':
      return `Searching for “${input['query'] ?? ''}”${input['kind'] && input['kind'] !== 'any' ? ` (${input['kind']})` : ''}`;
    case 'get_node':
      return 'Reading a node’s evidence';
    case 'get_neighbors':
      return 'Following its links';
    case 'find_path':
      return 'Tracing a path between two nodes';
    default:
      return s.name;
  }
}

interface Props {
  project: StudioProject;
  /** Pre-generated answers, readable without a key. */
  tours?: Tour[];
  onSelect: (id: string) => void;
  /** Show the answer's cited nodes in the graph. */
  onShowNodes: (ids: string[]) => void;
}

export function AskPanel({ project, tours = [], onSelect, onShowNodes }: Props) {
  const [apiKey, setApiKey] = useState(readStoredKey);
  const [draftKey, setDraftKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [model, setModel] = useState<AskModel>(DEFAULT_ASK_MODEL);
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [steps, setSteps] = useState<AskStep[]>([]);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const ids = useMemo(() => new Set(project.nodes.map((n) => n.id)), [project]);
  const ideas = useMemo(() => suggestions(project), [project]);
  const [tour, setTour] = useState<Tour | null>(null);

  function openTour(t: Tour) {
    setTour(t);
    setAsked('');
    setSteps([]);
    setResult(null);
    setError(null);
    if (t.citedNodeIds.length) onShowNodes(t.citedNodeIds.filter((id) => ids.has(id)));
  }

  const toursBlock = tours.length > 0 && (
    <section className="ask__tours">
      <h4>
        Guided tours <span className="muted">· no key needed</span>
      </h4>
      <ul className="ask__ideas">
        {tours.map((t) => (
          <li key={t.question}>
            <button type="button" className={`link ${tour === t ? 'is-on' : ''}`} onClick={() => openTour(t)}>
              {t.question}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  const tourBlock = tour && (
    <div className="ask__tour">
      <p className="ask__asked">{tour.question}</p>
      {tour.steps.length > 0 && (
        <ol className="ask__steps">
          {tour.steps.map((s, i) => (
            <li key={i}>{stepLabel({ type: 'tool', name: s.name, input: s.input })}</li>
          ))}
        </ol>
      )}
      <AnswerMarkdown text={tour.answer} onNode={onSelect} known={(id) => ids.has(id)} />
      {tour.citedNodeIds.length > 0 && (
        <button type="button" className="chip" onClick={() => onShowNodes(tour.citedNodeIds.filter((id) => ids.has(id)))}>
          Show the cited nodes in the graph
        </button>
      )}
      <p className="muted ask__fine">Pre-generated answer ({tour.model}). Add an API key to ask your own questions.</p>
    </div>
  );

  async function run(q: string) {
    const text = q.trim();
    if (!text || !apiKey || running) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setAsked(text);
    setTour(null);
    setSteps([]);
    setResult(null);
    setError(null);
    try {
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      const r = await askProject({ client, project, question: text, model, signal: controller.signal, onStep: (s) => setSteps((prev) => [...prev, s]) });
      setResult(r);
      if (r.citedNodeIds.length) onShowNodes(r.citedNodeIds);
    } catch (e) {
      setError(describeAskError(e));
    } finally {
      setRunning(false);
      abort.current = null;
    }
  }

  if (!apiKey) {
    return (
      <div className="ask">
        {toursBlock}
        {tourBlock}
        <h4>Ask your own question</h4>
        <p className="muted">
          Ask questions in plain English and get answers grounded in REA’s evidence, with every step linked to the graph.
          It uses your own Anthropic API key, which goes only from this browser to Anthropic.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const k = draftKey.trim();
            if (!k) return;
            storeKey(k, remember);
            setApiKey(k);
            setDraftKey('');
          }}
        >
          <input className="search" type="password" placeholder="sk-ant-…" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} aria-label="Anthropic API key" autoComplete="off" />
          <label className="ask__remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device
          </label>
          <button type="submit" className="chip chip--on">
            Use this key
          </button>
        </form>
        <p className="muted ask__fine">
          Get a key at console.anthropic.com. Questions are billed to your account; each one shows its token cost.
        </p>
      </div>
    );
  }

  const cost = result ? (() => {
    const [inP, outP, readP] = PRICES[model];
    const u = result.usage;
    return (u.inputTokens * inP + u.cacheWriteTokens * inP * 1.25 + u.cacheReadTokens * readP + u.outputTokens * outP) / 1e6;
  })() : 0;

  return (
    <div className="ask">
      <div className="ask__bar">
        <select className="ask__model" value={model} onChange={(e) => setModel(e.target.value as AskModel)} aria-label="Model" disabled={running}>
          {ASK_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.note})
            </option>
          ))}
        </select>
        <button type="button" className="link muted" onClick={() => { forgetKey(); setApiKey(''); }}>
          Forget key
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(question);
        }}
      >
        <textarea
          className="search ask__input"
          rows={2}
          placeholder="e.g. How does the app save notes?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void run(question);
            }
          }}
          aria-label="Question"
        />
        {running ? (
          <button type="button" className="chip" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="chip chip--on" disabled={!question.trim()}>
            Ask
          </button>
        )}
      </form>

      {!asked && (
        <ul className="ask__ideas">
          {ideas.map((idea) => (
            <li key={idea}>
              <button type="button" className="link" onClick={() => { setQuestion(idea); void run(idea); }}>
                {idea}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!asked && !tour && toursBlock}
      {tourBlock}
      {asked && <p className="ask__asked">{asked}</p>}
      {steps.length > 0 && (
        <ol className={`ask__steps ${running ? 'is-running' : ''}`}>
          {steps.map((s, i) => (
            <li key={i}>{stepLabel(s)}</li>
          ))}
        </ol>
      )}
      {running && steps.length === 0 && <p className="muted">Thinking…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <AnswerMarkdown text={result.answer} onNode={onSelect} known={(id) => ids.has(id)} />
          {result.citedNodeIds.length > 0 && (
            <button type="button" className="chip" onClick={() => onShowNodes(result.citedNodeIds)}>
              Show the {result.citedNodeIds.length} cited nodes in the graph
            </button>
          )}
          <p className="muted ask__fine">
            {result.model} · {result.toolCalls} lookups · {(result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens).toLocaleString()} in /{' '}
            {result.usage.outputTokens.toLocaleString()} out tokens · ≈ ${cost.toFixed(cost < 0.01 ? 4 : 3)} (estimate)
          </p>
        </>
      )}
    </div>
  );
}
