// The story panel, shared by the board and the sky: one session turn by turn, read from its
// transcript when opened, with any prompt it's waiting on and a way to carry on in VS Code.

import type { MiraEvent } from '../../../contracts/src/index.ts';
import type { Story, StoryStep, StoryTurn, UsageTotals } from '../../src/sources.ts';
import { showDialog } from './dialog.ts';
import { removeThing, renameThing } from './manage.ts';
import { openTerminal, type TerminalState, type TerminalView } from './terminal.ts';
import { answerPrompt, cost, esc, folder, plural, short, STATUS_LABEL, sessionLabel, toast, tokens, when, type BoardSession, type PendingPrompt } from './format.ts';

export interface PanelOptions {
  session(id: string): BoardSession | undefined;
  pending(): PendingPrompt[];
  waitSeconds(): number;
  /** My name for a project, if I gave one. */
  projectLabel?(system: string): string;
  /** Called when a session opens or the panel closes, so the page can mark it. */
  onChange?(id: string | null): void;
}

export interface Panel {
  open(id: string): void;
  close(): void;
  current(): string | null;
  /** Redraws the title, the prompt card and the button after sessions or prompts change. */
  refresh(): void;
  /** Follows the open session live. */
  event(event: MiraEvent): void;
}

const TURNS_STEP = 30;
const STATE: Record<string, string> = { running: 'Running', quiet: 'Quiet', interrupted: 'Interrupted', failed: 'Failed' };
// A turn or subagent that stopped writing this long ago was cut off, not still at work.
const QUIET_MS = 30 * 60 * 1000;
const quiet = (iso?: string) => Boolean(iso) && Date.now() - Date.parse(iso as string) > QUIET_MS;
const markdown = () => (globalThis as { renderMarkdown?: (text: string) => string }).renderMarkdown;

interface EditorTarget {
  link: string;
  name: string;
}

export function createPanel(options: PanelOptions): Panel {
  const root = document.createElement('aside');
  root.className = 'panel';
  root.hidden = true;
  root.setAttribute('aria-labelledby', 'panel-title');
  root.innerHTML = `
    <header class="panel-head">
      <div>
        <button type="button" class="ghost small" data-back hidden>← Back to session</button>
        <h2 id="panel-title"></h2>
        <div class="meta" data-sub></div>
      </div>
      <div class="panel-actions">
        <a class="go small" data-editor hidden>Continue in VS Code</a>
        <button type="button" class="ghost small" data-terminal hidden>Terminal</button>
        <button type="button" class="ghost small" data-rename>Rename</button>
        <button type="button" class="ghost small" data-remove>Remove</button>
        <button type="button" class="ghost small" data-close aria-label="Close the story">Close</button>
      </div>
    </header>
    <div data-prompt></div>
    <div class="totals" data-totals></div>
    <div class="turns" data-turns></div>
    <div class="term-view" data-term hidden>
      <div class="term-bar"><span class="term-state" data-term-state></span><button type="button" class="ghost small" data-term-zoom="-1" title="Smaller text" aria-label="Smaller text">A−</button><button type="button" class="ghost small" data-term-zoom="1" title="Larger text" aria-label="Larger text">A+</button><button type="button" class="go small" data-term-start hidden>Resume here</button><button type="button" class="stop small" data-term-stop hidden>Stop</button></div>
      <div class="term-host" data-term-host></div>
    </div>`;
  document.body.append(root);
  const $ = (name: string) => root.querySelector(`[data-${name}]`) as HTMLElement;
  const title = root.querySelector('#panel-title') as HTMLElement;

  const state = {
    id: null as string | null,
    helper: null as string | null,
    helperName: '',
    turns: TURNS_STEP,
    story: null as Story | null,
    error: '',
    open: new Set<string>(),
    auto: null as string | null,
    timer: 0,
    editor: null as EditorTarget | null,
    busy: new Set<string>(),
    // The terminal (decision 36): whether the session can have one, which view shows, and the live one.
    terminal: { available: false, running: false },
    view: 'story' as 'story' | 'terminal',
    term: null as { id: string; view: TerminalView | null; state: TerminalState | null } | null,
  };

  function reset(extra: Partial<typeof state> = {}) {
    Object.assign(state, { helper: null, helperName: '', turns: TURNS_STEP, story: null, error: '', open: new Set<string>(), auto: null }, extra);
  }

  function open(id: string) {
    if (state.id !== id) {
      closeTerminal();
      reset({ editor: null, terminal: { available: false, running: false }, view: 'story' });
      void loadEditor(id);
      void loadTerminal(id);
    }
    state.id = id;
    root.hidden = false;
    try { history.replaceState(null, '', `#session=${encodeURIComponent(id)}`); } catch { /* not remembered */ }
    options.onChange?.(id);
    refresh();
    void load('first');
  }

  function close() {
    closeTerminal();
    state.view = 'story';
    clearTimeout(state.timer);
    Object.assign(state, { id: null, helper: null, story: null, timer: 0 });
    root.hidden = true;
    try { history.replaceState(null, '', location.pathname); } catch { /* fine */ }
    options.onChange?.(null);
  }

  function openHelper(id: string, name: string) {
    reset({ helper: id, helperName: name });
    refresh();
    void load('first');
  }

  async function load(mode: 'first' | 'live' | 'earlier') {
    const { id, helper } = state;
    if (!id) return;
    const params = new URLSearchParams({ turns: String(state.turns) });
    if (helper) params.set('helper', helper);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/story?${params}`);
      if (state.id !== id || state.helper !== helper) return;
      if (res.ok) Object.assign(state, { story: (await res.json()) as Story, error: '' });
      else Object.assign(state, { story: null, error: res.status === 404 ? "This session's transcript can't be read here." : `The hub couldn't read it (${res.status}).` });
    } catch {
      if (state.id === id) state.error = "The hub isn't reachable.";
    }
    renderBody(mode);
  }

  async function loadEditor(id: string) {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/editor`);
      if (res.ok && state.id === id) state.editor = (await res.json()) as EditorTarget;
    } catch { /* no button */ }
    if (state.id === id) refresh();
  }

  // The link itself brings the right VS Code window forward, since a click may hand VS Code the
  // focus; the hub then opens the conversation, which VS Code gives to the window now in front.
  function continueInEditor() {
    const { id, editor } = state;
    if (!id || !editor) return;
    fetch(`/api/sessions/${encodeURIComponent(id)}/editor`, { method: 'POST' })
      .then((res) => { if (!res.ok) toast(`The hub couldn't open it (${res.status}).`); })
      .catch(() => toast("The hub isn't reachable."));
    toast(`Opening the conversation in VS Code, in ${editor.name}…`);
  }

  async function loadTerminal(id: string) {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/terminal`);
      if (res.ok && state.id === id) state.terminal = (await res.json()) as { available: boolean; running: boolean };
    } catch { /* no button */ }
    if (state.id === id) refresh();
  }

  // The terminal keeps its connection while I flip back to the story; it closes with the panel,
  // and the program carries on in the hub.
  async function showTerminal(show: boolean) {
    const id = state.id;
    state.view = show ? 'terminal' : 'story';
    refresh();
    if (!show || !id || state.term?.id === id) return state.term?.view?.focus();
    closeTerminal();
    const term: NonNullable<typeof state.term> = { id, view: null, state: null };
    state.term = term;
    renderTermBar();
    try {
      term.view = await openTerminal($('term-host'), id, (next) => {
        term.state = next;
        if (state.term !== term) return;
        state.terminal.running = next.running;
        renderTermBar();
        refresh();
      });
      if (state.term !== term) term.view.dispose();
      else term.view.focus();
    } catch {
      $('term-state').textContent = "The terminal couldn't load. Run npm install in the Mira folder and reload.";
    }
  }

  function closeTerminal() {
    state.term?.view?.dispose();
    state.term = null;
    $('term-host').replaceChildren();
  }

  function renderTermBar() {
    const t = state.term?.state;
    const session = state.id ? options.session(state.id) : undefined;
    const what = t?.title ? `<code>${esc(t.title)}</code>` : 'the session';
    let text = 'Connecting…';
    if (t && !t.connected) text = "Not connected to the hub. Close the story and open it again.";
    else if (t?.running) text = `Running ${what}. Closing the story leaves it running.`;
    else if (t && t.exitCode !== null && t.exitCode !== undefined) text = `${what} ended (exit code ${t.exitCode}).`;
    else if (t) text = `Carries this conversation on here with ${what}${session?.cwd ? `, in ${esc(folder(session.cwd))}` : ''}. If it's open in VS Code or another terminal, close it there first.`;
    $('term-state').innerHTML = text;
    const start = $('term-start');
    start.hidden = !t?.connected || t.running;
    start.textContent = t?.exitCode !== null && t?.exitCode !== undefined ? 'Resume again' : 'Resume here';
    $('term-stop').hidden = !t?.connected || !t.running;
  }

  // At most one refresh every couple of seconds while the session is busy.
  function event(e: MiraEvent) {
    if (!state.id || (e.actor.id !== state.id && e.actor.parent !== state.id) || state.timer) return;
    state.timer = window.setTimeout(() => { state.timer = 0; void load('live'); }, 2000);
  }

  function refresh() {
    if (!state.id) return;
    const session = options.session(state.id);
    const name = session ? sessionLabel(session) : short(state.id);
    title.textContent = state.helper ? state.helperName || 'Subagent' : name;
    $('sub').textContent = state.helper ? `Subagent of ${name}`
      : session ? [...new Set([options.projectLabel?.(session.system) ?? session.system, folder(session.cwd)])].concat(STATUS_LABEL[session.status ?? ''] ?? []).filter(Boolean).join(' · ') : '';
    $('back').hidden = !state.helper;
    const terminal = $('terminal');
    terminal.hidden = Boolean(state.helper) || !state.terminal.available;
    terminal.textContent = state.view === 'terminal' ? 'Story' : state.terminal.running ? 'Terminal ●' : 'Terminal';
    terminal.title = state.view === 'terminal' ? 'Back to the story' : state.terminal.running ? 'A terminal is running this session' : 'Carry this session on in a terminal here';
    const inTerminal = state.view === 'terminal' && !state.helper;
    $('term').hidden = !inTerminal;
    $('totals').hidden = inTerminal;
    $('turns').hidden = inTerminal;
    $('rename').hidden = Boolean(state.helper) || !session;
    $('remove').hidden = Boolean(state.helper) || !session;
    const editor = $('editor') as HTMLAnchorElement;
    editor.hidden = !state.editor;
    if (state.editor) {
      editor.href = state.editor.link;
      editor.title = `Opens this conversation in Claude Code, in the VS Code window for ${state.editor.name}`;
    }
    renderPrompt();
  }

  function renderPrompt() {
    const prompt = options.pending().find((p) => p.sessionId === state.id);
    const box = $('prompt');
    if (!prompt) {
      box.innerHTML = '';
      return;
    }
    const off = state.busy.has(prompt.id) ? ' disabled' : '';
    box.innerHTML = `<div class="prompt box" data-prompt-id="${esc(prompt.id)}">
      <div class="prompt-head"><span class="pill" data-status="needs-me">Needs you</span><span class="countdown" data-asked="${esc(prompt.askedAt)}"></span></div>
      <p class="prompt-title">Wants to use <b>${esc(prompt.tool || 'a tool')}</b></p>
      ${prompt.summary ? `<pre class="cmd">${esc(prompt.summary)}</pre>` : ''}
      <div class="actions">
        <button type="button" class="go" data-answer="allow"${off}>Allow</button>
        <button type="button" class="stop" data-answer="deny"${off}>Deny</button>
        <button type="button" class="ghost" data-answer="terminal"${off}>Answer in terminal</button>
      </div>
    </div>`;
    tick();
  }

  function tick() {
    const el = root.querySelector('[data-asked]') as HTMLElement | null;
    if (!el?.dataset.asked) return;
    const wait = options.waitSeconds();
    el.textContent = `${Math.ceil(Math.max(0, wait - (Date.now() - Date.parse(el.dataset.asked)) / 1000))}s left`;
  }
  window.setInterval(tick, 1000);

  function renderBody(mode: 'first' | 'live' | 'earlier' | 'keep') {
    const box = $('turns');
    const fromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    const top = box.scrollTop;
    const story = state.story;
    if (!story) {
      $('totals').innerHTML = '';
      box.innerHTML = `<p class="panel-msg">${esc(state.error || 'Reading the transcript…')}</p>`;
      return;
    }
    const last = story.turns.at(-1);
    if (last && state.auto !== last.id) {
      state.open.add(last.id); // the latest turn starts unfolded
      state.auto = last.id;
    }
    $('totals').innerHTML = totalsHTML(story);
    const earlier = story.earlier ? `<button type="button" class="ghost small earlier" data-earlier>Show ${plural(Math.min(TURNS_STEP, story.earlier), 'earlier turn')} (${story.earlier} in all)</button>` : '';
    box.innerHTML = earlier + (story.turns.map(turnHTML).join('') || '<p class="panel-msg">Nothing has happened in this session yet.</p>');
    if (mode === 'first' || (mode === 'live' && fromBottom < 48)) box.scrollTop = box.scrollHeight;
    else if (mode === 'earlier') box.scrollTop = box.scrollHeight - box.clientHeight - fromBottom;
    else box.scrollTop = top;
  }

  function totalsHTML(story: Story): string {
    const u: UsageTotals = story.usage;
    const items: Array<[string, string, string]> = [
      ['cost', 'Estimated cost', cost(u.costUsd)],
      ['', 'Output', tokens(u.output)],
      ['', 'Input', tokens(u.input)],
      ['', 'Cache reads', tokens(u.cacheRead)],
      ['', 'Cache writes', tokens(u.cacheWrite)],
    ];
    if (story.contextTokens != null) items.push(['', 'In context now', tokens(story.contextTokens)]);
    if (story.model) items.push(['', 'Model', story.model]);
    const unpriced = u.unpriced?.length ? `<p class="hint">The cost leaves out ${esc(u.unpriced.join(', '))}, which ${u.unpriced.length === 1 ? 'has' : 'have'} no price set.</p>` : '';
    return items.map(([cls, label, value]) => `<div class="${cls}">${esc(label)}<b>${esc(value)}</b></div>`).join('') + unpriced;
  }

  function turnHTML(t: StoryTurn): string {
    const unfolded = state.open.has(t.id);
    const tools = t.steps.filter((s) => s.kind === 'tool').length;
    const meta = [tools ? plural(tools, 'tool') : '', t.usage.costUsd ? cost(t.usage.costUsd) : ''].filter(Boolean).join(' · ');
    const shown = t.state === 'running' && quiet(t.endedAt) ? 'quiet' : t.state;
    const badge = STATE[shown] ? `<span class="state" data-state="${esc(shown)}" title="${shown === 'quiet' ? `Nothing since ${esc(when(t.endedAt))}` : ''}">${STATE[shown]}</span>` : '';
    const first = (t.prompt || 'Carried on by itself').split('\n').find((line) => line.trim()) || '…';
    return `<article class="turn" data-from="${esc(t.from)}">
      <button type="button" class="turn-head" data-turn="${esc(t.id)}" aria-expanded="${unfolded}">
        <span class="t">${esc(when(t.at))}</span><span class="turn-prompt">${esc(first)}</span><span class="turn-meta">${badge}${esc(meta)}</span>
      </button>
      ${unfolded ? `<div class="turn-body">${t.prompt ? `<p class="you">${esc(t.prompt)}</p>` : ''}${t.steps.map(stepHTML).join('')}</div>` : ''}
    </article>`;
  }

  function stepHTML(s: StoryStep): string {
    const render = markdown();
    if (s.kind === 'text') return render ? `<div class="reply md">${render(s.text)}</div>` : `<p class="reply">${esc(s.text)}</p>`;
    if (s.kind === 'note') return `<p class="note">${esc(s.text)}</p>`;
    const line = `<div class="tool${s.failed ? ' failed' : ''}"><span class="tool-name">${esc(s.name)}</span>${s.summary ? `<span class="tool-sum" title="${esc(s.summary)}">${esc(s.summary)}</span>` : ''}${s.failed ? '<span class="failed-tag">failed</span>' : ''}</div>`;
    const h = s.helper;
    if (!h) return line;
    const doing = h.state === 'done' ? 'done' : quiet(h.lastAt) ? `quiet since ${esc(when(h.lastAt as string))}` : 'working';
    return `${line}<div class="helper-card"><span class="helper">${esc(h.name || 'subagent')}</span><span>${plural(h.tools, 'tool')}</span><span>${esc(cost(h.usage.costUsd))}</span><span>${doing}</span>
      <button type="button" class="ghost small" data-helper="${esc(h.id)}" data-helper-name="${esc([h.name, h.description].filter(Boolean).join(': '))}">Open</button></div>`;
  }

  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const answer = target.closest('[data-answer]') as HTMLElement | null;
    const promptId = (target.closest('[data-prompt-id]') as HTMLElement | null)?.dataset.promptId;
    if (answer && promptId) {
      state.busy.add(promptId);
      renderPrompt();
      void answerPrompt(promptId, answer.dataset.answer as 'allow' | 'deny' | 'terminal').finally(() => { state.busy.delete(promptId); renderPrompt(); });
      return;
    }
    const turn = target.closest('[data-turn]') as HTMLElement | null;
    if (turn?.dataset.turn) {
      if (!state.open.delete(turn.dataset.turn)) state.open.add(turn.dataset.turn);
      return renderBody('keep');
    }
    if (target.closest('[data-earlier]')) {
      state.turns += TURNS_STEP;
      return void load('earlier');
    }
    const helper = target.closest('[data-helper]') as HTMLElement | null;
    if (helper?.dataset.helper) return openHelper(helper.dataset.helper, helper.dataset.helperName ?? '');
    if (target.closest('[data-close]')) return close();
    const session = state.id ? options.session(state.id) : undefined;
    if (session && target.closest('[data-rename]')) return void renameThing('session', session.id, sessionLabel(session));
    if (session && target.closest('[data-remove]')) return void removeThing('session', session.id, sessionLabel(session)).then((done) => { if (done) close(); });
    if (target.closest('[data-editor]')) return continueInEditor();
    if (target.closest('[data-terminal]')) return void showTerminal(state.view !== 'terminal');
    if (target.closest('[data-term-start]')) return state.term?.view?.start();
    const zoom = (target.closest('[data-term-zoom]') as HTMLElement | null)?.dataset.termZoom;
    if (zoom) return state.term?.view?.zoom(Number(zoom));
    if (target.closest('[data-term-stop]')) {
      const title = state.term?.state?.title ?? 'the program';
      return void confirmStop(title).then((yes) => { if (yes) state.term?.view?.stop(); });
    }
    if (target.closest('[data-back]')) {
      reset();
      refresh();
      void load('first');
    }
  });
  document.addEventListener('keydown', (e) => {
    // Escape inside the terminal belongs to the program (Claude Code uses it to interrupt).
    if (e.key === 'Escape' && state.id && !(e.target as HTMLElement | null)?.closest?.('.term-host')) close();
  });

  return { open, close, current: () => state.id, refresh, event };
}

/** The session named in the page's `#session=<id>`, if any. */
export const linkedSession = () => location.hash.match(/^#session=([\w-]+)$/)?.[1];

function confirmStop(title: string): Promise<boolean> {
  const box = showDialog('Stop the terminal', `<form method="dialog" class="dialog-body">
    <header class="dialog-head"><h2>Stop ${esc(title)}?</h2></header>
    <p class="hint">It ends the program running in the terminal, even mid-turn. The conversation itself is kept, and can be resumed again.</p>
    <div class="actions"><button type="submit" class="stop" value="stop">Stop</button><button type="submit" class="ghost" value="cancel">Cancel</button></div>
  </form>`);
  (box.querySelector('[value="cancel"]') as HTMLButtonElement).focus();
  return new Promise((done) => box.addEventListener('close', () => done(box.returnValue === 'stop'), { once: true }));
}
