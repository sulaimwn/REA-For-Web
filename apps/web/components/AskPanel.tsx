'use client';

// Ask questions about the open project. Free by default (T030): an open model the site runs on Cloudflare
// Workers AI, limited per visitor and per day; the tool loop stays in this browser and only the conversation
// goes to /api/ask/free. With the visitor's own Anthropic key, Claude answers instead, straight from this
// browser to api.anthropic.com.
import Anthropic from '@anthropic-ai/sdk';
import {
  ASK_MODELS, DEFAULT_ASK_MODEL, FREE_ASK_MODEL_LABEL, FreeAskUnavailableError, askProject, askProjectFree, describeAskError,
  type AskModel, type AskResult, type AskStep, type FreeChat,
} from '@rea-studio/ask';
import type { StudioProject } from '@rea-studio/schema';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Tour } from '../lib/project';
import { AnswerMarkdown } from './AnswerMarkdown';

const KEY_STORAGE = 'rea-studio:anthropic-api-key';

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

/** One free-tier model call through this site's route. */
const freeChat: FreeChat = async (request, signal) => {
  const response = await fetch('/api/ask/free', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), ...(signal ? { signal } : {}),
  });
  const body = (await response.json().catch(() => ({}))) as { message?: string; response?: string; tool_calls?: [] };
  if (!response.ok) {
    const message = body.message ?? `Free questions failed (${response.status}).`;
    if ([403, 429, 503].includes(response.status)) throw new FreeAskUnavailableError(message);
    throw new Error(message);
  }
  return { response: body.response ?? '', tool_calls: body.tool_calls ?? [] };
};

type Answer = { answer: string; citedNodeIds: string[]; toolCalls: number; footnote: string; truncated: boolean };

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
  // 'free' or a Claude model; a visitor who saved a key keeps Claude as the default.
  const [model, setModel] = useState<AskModel | 'free'>(() => (readStoredKey() ? DEFAULT_ASK_MODEL : 'free'));
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [steps, setSteps] = useState<AskStep[]>([]);
  const [result, setResult] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const ids = useMemo(() => new Set(project.nodes.map((n) => n.id)), [project]);
  const ideas = useMemo(() => suggestions(project), [project]);
  const [tour, setTour] = useState<Tour | null>(null);

  function openTour(t: Tour) {
    stop();
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
        <button type="button" className="btn" onClick={() => onShowNodes(tour.citedNodeIds.filter((id) => ids.has(id)))}>
          Show the cited nodes in the graph
        </button>
      )}
      <p className="muted ask__fine">Pre-generated answer ({tour.model}). Ask your own questions below.</p>
    </div>
  );

  useEffect(() => {
    setResult(null);
    setAsked('');
    setSteps([]);
    setRunning(false);
    return () => {
      abort.current?.abort();
      abort.current = null;
    };
  }, [project]);

  function stop() {
    abort.current?.abort();
    abort.current = null;
    setRunning(false);
    setError('Stopped.');
  }

  async function run(q: string) {
    const text = q.trim();
    if (!text || running || (model !== 'free' && !apiKey)) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setAsked(text);
    setTour(null);
    setSteps([]);
    setResult(null);
    setError(null);
    const onStep = (s: AskStep) => {
      if (!controller.signal.aborted && abort.current === controller) setSteps((prev) => [...prev, s]);
    };
    try {
      let answer: Answer;
      if (model === 'free') {
        const r = await askProjectFree({ chat: freeChat, project, question: text, signal: controller.signal, onStep });
        answer = { ...r, footnote: `${FREE_ASK_MODEL_LABEL} · ${r.toolCalls} lookups · free tier`, truncated: false };
      } else {
        const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
        const r: AskResult = await askProject({ client, project, question: text, model, signal: controller.signal, onStep });
        const cost = r.estimatedCostUsd;
        const tokens = r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens;
        answer = {
          ...r,
          truncated: r.stopReason === 'max_tokens',
          footnote: `${r.model} · ${r.toolCalls} lookups · ${tokens.toLocaleString()} in / ${r.usage.outputTokens.toLocaleString()} out tokens · `
            + (cost === null ? 'cost estimate unavailable' : `≈ $${cost.toFixed(cost < 0.01 ? 4 : 3)} (estimate)`),
        };
      }
      if (controller.signal.aborted || abort.current !== controller) return;
      setResult(answer);
      if (answer.citedNodeIds.length) onShowNodes(answer.citedNodeIds);
    } catch (e) {
      if (!controller.signal.aborted && abort.current === controller) {
        setError(e instanceof FreeAskUnavailableError ? e.message : describeAskError(e));
        if (e instanceof FreeAskUnavailableError && !apiKey) setShowKeyForm(true);
      }
    } finally {
      if (abort.current === controller) {
        setRunning(false);
        abort.current = null;
      }
    }
  }

  const keyForm = (
    <form
      className="ask__key"
      onSubmit={(e) => {
        e.preventDefault();
        const k = draftKey.trim();
        if (!k) return;
        storeKey(k, remember);
        setApiKey(k);
        setDraftKey('');
        setShowKeyForm(false);
        setModel(DEFAULT_ASK_MODEL);
      }}
    >
      <p className="muted">
        Claude gives better answers. Your question and the relevant analysis details go from this browser to Anthropic,
        billed to your own key (get one at console.anthropic.com); each answer shows its token cost.
      </p>
      <input className="search" type="password" placeholder="sk-ant-…" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} aria-label="Anthropic API key" autoComplete="off" />
      <label className="ask__remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device
      </label>
      <button type="submit" className="btn btn--primary">Use this key</button>
    </form>
  );

  return (
    <div className="ask">
      <div className="ask__bar">
        <select className="ask__model" value={model} onChange={(e) => setModel(e.target.value as AskModel | 'free')} aria-label="Who answers" disabled={running}>
          <option value="free">Free: {FREE_ASK_MODEL_LABEL}</option>
          {apiKey && ASK_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.note}, your key)
            </option>
          ))}
        </select>
        {apiKey ? (
          <button type="button" className="link muted" onClick={() => { stop(); forgetKey(); setApiKey(''); setModel('free'); }}>
            Forget key
          </button>
        ) : (
          <button type="button" className="link muted" onClick={() => setShowKeyForm((v) => !v)} aria-expanded={showKeyForm}>
            Use your Claude key
          </button>
        )}
      </div>
      {!apiKey && showKeyForm && keyForm}
      {model === 'free' && !asked && (
        <p className="muted ask__fine">
          Free questions use an open model this site runs on Cloudflare, limited per visitor and per day. Your question and
          the analysis details it looks up are sent to this site and Cloudflare; nothing is stored.
        </p>
      )}

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
          <button type="button" className="btn" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn--primary" disabled={!question.trim()}>
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
          {result.truncated && <p role="note" className="muted">The answer reached its length limit and may be incomplete.</p>}
          {result.citedNodeIds.length > 0 && (
            <button type="button" className="btn" onClick={() => onShowNodes(result.citedNodeIds)}>
              Show the {result.citedNodeIds.length} cited nodes in the graph
            </button>
          )}
          <p className="muted ask__fine">{result.footnote}</p>
        </>
      )}
    </div>
  );
}
