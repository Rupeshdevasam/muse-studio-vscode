// Chat panel UI. Receives UiEvents (see src/view.ts) from the extension and renders them.
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { icons, logo, toolIcon } from './icons';

const vscode = acquireVsCodeApi();
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(code, lang) {
    // Highlighting very large blocks on every streamed chunk would make typing feel slow.
    if (code.length > 20_000) return '';
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      if (!lang && code.length > 40) return hljs.highlightAuto(code).value;
    } catch {}
    return '';
  },
});

const $ = (id) => document.getElementById(id);
const $messages = $('messages');
const $form = $('composer');
const $input = $('input');
const $send = $('send');
const $stop = $('stop');
const $setup = $('setup');
const $todos = $('todos');
const $model = $('model');
const $effort = $('effort');
const $mode = $('mode');
const $meter = $('meter');
const $mentions = $('mentions');
const $editorChip = $('editor-chip');
const $images = $('images');
const $fileInput = $('file-input');
const $attach = $('attach');
const $mentionBtn = $('mention');

$attach.innerHTML = icons.attach;
$mentionBtn.innerHTML = icons.at;
$send.innerHTML = icons.send;
$stop.innerHTML = icons.stop;

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const PROFILE_HINTS = {
  ':ask-me': 'Muse can edit files in this folder. You approve anything restricted: protected files, new network targets, and actions outside the sandbox.',
  ':auto-review': "Same access as Ask me, but Muse's AI reviewer approves what it judges safe and only asks you when it's unsure.",
  ':read-only': 'Muse can only read files.',
  ':unrestricted': 'No sandbox and no approval prompts. Use only in a disposable or version-controlled folder.',
};
const EDIT_TOOLS = /^(write_file|edit_file|edit|str_replace|apply_patch|create_file|multi_edit|replace_in_file|insert)/i;

let busy = false;
let ready = true;
/** itemId -> rendered block. */
const items = new Map();
/** approvalId -> card element. */
const approvals = new Map();
/** userInputId -> card element. */
const questions = new Map();
let usage = {};
let context = {};
let renderQueued = new Set();
/** Images waiting to be sent: { mediaType, base64, width, height, thumb, name } */
let pendingImages = [];
let editorCtx = null;
let includeEditor = true;
/** @-mention popup state. */
const mention = { open: false, start: -1, items: [], index: 0, requestId: 0 };
/** changes id -> { el, ev } */
const changeCards = new Map();

// ---------- helpers ----------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function button(label, className, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function scrollToBottom(force) {
  const nearBottom = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 160;
  if (force || nearBottom) $messages.scrollTop = $messages.scrollHeight;
}

function renderMarkdown(block) {
  block.el.innerHTML = md.render(block.raw || '');
  for (const pre of block.el.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const lang = (code?.className.match(/language-([\w+#-]+)/) || [])[1] || '';
    const wrap = el('div', 'code-block');
    const head = el('div', 'code-head');
    head.append(el('span', 'code-lang', lang || 'text'));
    const btn = button('', 'code-copy', () => {
      navigator.clipboard.writeText((code ?? pre).textContent.trimEnd());
      btn.innerHTML = icons.check + '<span>Copied</span>';
      setTimeout(() => (btn.innerHTML = icons.copy + '<span>Copy</span>'), 1200);
    });
    btn.innerHTML = icons.copy + '<span>Copy</span>';
    btn.title = 'Copy code';
    head.append(btn);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}

function queueRender(block) {
  renderQueued.add(block);
  if (renderQueued.size === 1) {
    requestAnimationFrame(() => {
      const blocks = renderQueued;
      renderQueued = new Set();
      for (const b of blocks) renderMarkdown(b);
      scrollToBottom(false);
    });
  }
}

function append(node, force) {
  $messages.querySelector('.empty')?.remove();
  $messages.append(node);
  if (busy) $messages.append($working); // keep the "thinking" row at the end
  scrollToBottom(force);
}

function firstLine(s, max = 90) {
  const line = String(s ?? '').trim().split('\n')[0] || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function parseArgs(args) {
  if (!args) return {};
  try {
    const v = JSON.parse(args);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function compact(n) {
  if (typeof n !== 'number') return '?';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

const STARTERS = [
  { label: 'Explain this project', text: 'Give me a quick tour of this project: what it does, how it is organized, and where to start reading.' },
  { label: 'Review the open file', text: 'Review the file I have open for bugs, edge cases and readability problems. Suggest fixes, but do not change anything yet.' },
  { label: 'Write tests for…', text: 'Write tests for @', mention: true },
  { label: 'Summarize my changes', text: 'Summarize my uncommitted changes (git diff) and point out anything that looks risky.' },
];

function showEmptyState() {
  $messages.replaceChildren();
  const empty = el('div', 'empty');
  const mark = el('div', 'logo');
  mark.innerHTML = logo;
  const starters = el('div', 'starters');
  for (const st of STARTERS) {
    starters.append(
      button(st.label, 'starter', () => {
        $input.value = st.text;
        $input.focus();
        $input.setSelectionRange(st.text.length, st.text.length);
        autosize();
        updateSendButton();
        if (st.mention) updateMention();
      }),
    );
  }
  empty.append(
    mark,
    el('h2', '', 'Muse Studio'),
    el('p', 'muted', 'Ask Muse to read, write, run and fix code in this workspace.'),
    starters,
    el('p', 'muted small tips', '@ to mention files  ·  paste screenshots  ·  Esc to stop'),
  );
  $messages.append(empty);
}

// ---------- items ----------

function setState(card, status) {
  card.classList.remove('running', 'ok', 'failed', 'cancelled');
  card.classList.add(
    status === 'inProgress' ? 'running' : status === 'completed' ? 'ok' : status === 'failed' || status === 'timedOut' ? 'failed' : 'cancelled',
  );
}

function toolTitle(it) {
  const l = it.label;
  if (l) return (it.status === 'inProgress' ? l.active : it.status === 'completed' ? l.done : l.neutral) || l.neutral || it.tool;
  return (it.tool || 'tool').replace(/_/g, ' ');
}

function toolDetail(it, a) {
  return a.command || a.cmd || a.path || a.file_path || a.filePath || a.pattern || a.query || a.url || a.description || it.statusLine || '';
}

function renderUserBubble(text, ev) {
  const b = el('div', 'msg user');
  if (text) b.append(el('div', '', text));
  if (ev?.images?.length) {
    const row = el('div', 'thumbs');
    for (const im of ev.images) {
      if (!im.thumb) continue;
      const img = el('img');
      img.src = im.thumb;
      img.alt = im.name || 'attached image';
      row.append(img);
    }
    b.append(row);
  }
  if (ev?.attached?.length) {
    const row = el('div', 'sent-context');
    for (const a of ev.attached) row.append(el('span', 'chip small', a));
    b.append(row);
  }
  append(b, true);
}

function renderItem(it) {
  if (it.kind === 'userMessage') {
    if (!items.has(it.itemId)) {
      items.set(it.itemId, { kind: 'userMessage' });
      renderUserBubble(it.text ?? '');
    }
    return;
  }
  if (it.kind === 'agentMessage') return renderAgentMessage(it);
  if (it.kind === 'reasoning') return renderReasoning(it);
  if (it.kind === 'compaction') {
    if (!items.has(it.itemId) && it.status !== 'inProgress') {
      items.set(it.itemId, { kind: 'compaction' });
      append(el('div', 'msg notice', 'Muse summarized earlier messages to free up context.'));
    }
    return;
  }
  renderCard(it);
}

function renderAgentMessage(it) {
  let b = items.get(it.itemId);
  if (!b) {
    b = { kind: 'agentMessage', el: el('div', 'msg assistant markdown'), raw: '' };
    items.set(it.itemId, b);
    append(b.el);
  }
  b.el.classList.toggle('commentary', it.messagePhase === 'commentary');
  if (it.text && it.text.length >= b.raw.length) b.raw = it.text;
  if (it.cutOff) b.raw += '\n\n*(Reply cut off.)*';
  queueRender(b);
}

function renderReasoning(it) {
  let b = items.get(it.itemId);
  if (!b) {
    const det = el('details', 'reasoning');
    const sum = el('summary', 'muted', 'Thinking…');
    const body = el('div', 'markdown muted');
    det.append(sum, body);
    b = { kind: 'reasoning', el: det, sum, body: { el: body, raw: '' }, parts: [] };
    items.set(it.itemId, b);
    append(det);
  }
  if (Array.isArray(it.summary)) b.parts = [...it.summary];
  else if (it.text && !b.parts.length) b.parts = [it.text];
  b.body.raw = b.parts.filter(Boolean).join('\n\n');
  b.sum.textContent = it.status === 'inProgress' ? 'Thinking…' : 'Thought';
  b.el.hidden = !b.body.raw && it.status !== 'inProgress';
  queueRender(b.body);
}

function renderCard(it) {
  let b = items.get(it.itemId);
  if (!b) {
    // The card's details collapse; the action row below them always stays visible.
    const card = el('div', 'tool running');
    const det = el('details');
    const summary = el('summary');
    const kindIcon = el('span', 'tool-icon');
    kindIcon.innerHTML = it.kind === 'subagent' ? icons.agent : it.kind === 'webSearch' ? icons.globe : toolIcon(it.tool);
    const name = el('span', 'tool-name');
    const detail = el('span', 'tool-detail muted');
    const counts = el('span', 'counts');
    const status = el('span', 'status-icon');
    summary.append(kindIcon, name, detail, counts, status);
    const output = el('pre', 'tool-output');
    output.hidden = true;
    det.append(summary, output);
    const actions = el('div', 'tool-actions');
    actions.hidden = true;
    card.append(det, actions);
    b = { kind: it.kind, el: card, det, name, detail, counts, status, actions, output, revision: -1 };
    items.set(it.itemId, b);
    append(card);
  }
  if (it.revision < b.revision) return;
  b.revision = it.revision;
  setState(b.el, it.status);
  if (it.kind === 'toolCall') setWorkingText(it.status === 'inProgress' ? `${toolTitle(it)}…` : 'Thinking…');
  b.status.innerHTML = it.status === 'inProgress' ? '<span class="spinner"></span>' : it.status === 'completed' ? icons.check : it.status === 'failed' || it.status === 'timedOut' ? icons.x : icons.minus;

  const a = parseArgs(it.args);
  if (it.kind === 'toolCall') {
    b.name.textContent = toolTitle(it);
    let d = firstLine(toolDetail(it, a));
    // Long absolute paths would hide the file name behind the ellipsis.
    if (/^\/\S+$/.test(d) && d.split('/').length > 4) d = '…/' + d.split('/').slice(-3).join('/');
    b.detail.textContent = d;
    b.detail.title = toolDetail(it, a);
  } else if (it.kind === 'subagent') {
    b.name.textContent = `Subagent${it.role ? ': ' + it.role : ''}`;
    b.detail.textContent = firstLine(it.objective);
  } else {
    b.name.textContent = it.kind.replace(/([A-Z])/g, ' $1').toLowerCase();
    b.detail.textContent = firstLine(it.fallbackText || it.statusLine);
  }

  const ps = it.patchSummary;
  b.counts.textContent = ps ? [ps.added ? `+${ps.added}` : '', ps.removed ? `−${ps.removed}` : ''].filter(Boolean).join(' ') : '';
  // A shell command that ran but failed: show its exit code instead of line counts.
  const badExit = typeof it.exitCode === 'number' && it.exitCode !== 0;
  if (badExit) b.counts.textContent = `exit ${it.exitCode}`;
  b.counts.classList.toggle('bad-exit', badExit);
  b.counts.hidden = !b.counts.textContent;

  // Open / diff buttons for file edits.
  const path = a.path || a.file_path || a.filePath;
  if (it.kind === 'toolCall' && path && (ps || EDIT_TOOLS.test(it.tool || '')) && it.status === 'completed') {
    b.actions.replaceChildren(
      button('Open file', 'link', () => vscode.postMessage({ type: 'openFile', path })),
      Object.assign(button('Show diff', 'link', () => vscode.postMessage({ type: 'openDiff', path })), { title: 'Compare with the last git commit' }),
    );
    b.actions.hidden = false;
  }

  let out = it.output || '';
  if (it.kind === 'subagent' && it.objective) out = it.objective + (out ? '\n\n' + out : '');
  if (it.failureReason) out += (out ? '\n\n' : '') + it.failureReason;
  if (!out && it.args && it.kind === 'toolCall' && it.status !== 'inProgress' && typeof it.exitCode !== 'number') out = prettyArgs(it.args);
  b.output.textContent = out;
  b.output.hidden = !out;
  if (it.status === 'failed') b.det.open = true;
}

function prettyArgs(args) {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

function applyDelta(ev) {
  const b = items.get(ev.itemId);
  if (!b) return;
  if (b.kind === 'agentMessage' && ev.field === 'text') {
    b.raw += ev.delta;
    queueRender(b);
  } else if (b.kind === 'reasoning' && ev.field.startsWith('summary.')) {
    const n = Number(ev.field.slice(8));
    b.parts[n] = (b.parts[n] || '') + ev.delta;
    b.body.raw = b.parts.filter(Boolean).join('\n\n');
    b.el.hidden = false;
    queueRender(b.body);
  } else if (b.kind !== 'agentMessage' && b.output && /output/i.test(ev.field)) {
    b.output.textContent += ev.delta;
    b.output.hidden = false;
  }
}

// ---------- approvals ----------

function approvalTitle(a) {
  const k = a.subject?.kind;
  if (k === 'shell') return 'Muse wants to run a command';
  if (a.subject?.path) return a.protectedWrite ? 'Muse wants to change a protected file' : 'Muse wants to change a file';
  if (a.subject?.host) return 'Muse wants to use the network';
  return `Muse wants to use ${a.toolName || a.subject?.toolName || 'a tool'}`;
}

function approvalSubject(a) {
  const s = a.subject || {};
  if (s.command) return s.command;
  if (s.path) return (s.access ? s.access + ' ' : '') + s.path;
  if (s.host) return `${s.protocol || ''} ${s.host}${s.port ? ':' + s.port : ''}`.trim();
  return s.target || prettyArgs(a.rawArgs || '') || a.toolName || '';
}

function renderReviewing(a) {
  let card = approvals.get(a.approvalId);
  if (card) return;
  card = el('div', 'approval reviewing');
  const line = el('div', 'approval-line');
  line.append(el('span', 'spinner'), el('span', '', "Muse's reviewer is checking: "), el('code', '', firstLine(approvalSubject(a), 120)));
  card.append(line);
  approvals.set(a.approvalId, card);
  append(card);
}

function renderApproval(a) {
  const old = approvals.get(a.approvalId);
  const card = el('div', 'approval pending');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', approvalTitle(a));
  card.append(el('div', 'approval-title', approvalTitle(a)));
  const subj = el('pre', 'approval-subject', approvalSubject(a));
  card.append(subj);
  if (a.reviewerReason) card.append(el('p', 'muted small', `Reviewer: ${a.reviewerReason}`));
  if (a.protectedWrite) card.append(el('p', 'muted small', 'This file is protected, so only one-time choices are offered.'));

  const wantsFeedback = (a.choices || []).some((c) => c.acceptsFeedback);
  let feedback;
  if (wantsFeedback) {
    feedback = el('textarea', 'feedback');
    feedback.rows = 1;
    feedback.placeholder = 'Optional: tell Muse what to do instead (sent if you reject)';
    card.append(feedback);
  }

  const row = el('div', 'approval-actions');
  for (const c of a.choices || []) {
    const allow = String(c.decision).startsWith('approved');
    const b = button(c.label, allow ? '' : 'secondary', () => {
      for (const x of row.querySelectorAll('button')) x.disabled = true;
      b.textContent = 'Sending…';
      vscode.postMessage({
        type: 'decide',
        approvalId: a.approvalId,
        choiceId: c.choiceId,
        feedback: c.acceptsFeedback && feedback ? feedback.value : undefined,
      });
    });
    if (c.rulePreview) b.title = c.rulePreview;
    row.append(b);
  }
  card.append(row);

  if (old) old.replaceWith(card);
  else append(card, true);
  approvals.set(a.approvalId, card);
  if (!old) row.querySelector('button')?.focus({ preventScroll: true });
}

function renderApprovalResolved(ev) {
  const allowed = ev.decision.startsWith('approved');
  const who = ev.resolvedBy === 'user' ? 'by you' : ev.resolvedBy === 'llmJudge' ? "by Muse's reviewer" : ev.resolvedBy === 'policy' ? 'by your rules' : '';
  const line = el('div', `approval resolved ${allowed ? 'allowed' : 'rejected'}`);
  line.append(el('span', 'icon'), el('span', '', `${allowed ? 'Allowed' : 'Rejected'}${who ? ' ' + who : ''}`));
  if (ev.summary) line.append(el('code', '', firstLine(ev.summary, 120)));
  const old = approvals.get(ev.approvalId);
  if (old) old.replaceWith(line);
  else append(line);
  approvals.set(ev.approvalId, line);
}

// ---------- changed files ----------

function renderChanges(ev) {
  const old = changeCards.get(ev.id);
  const reverted = new Set(ev.reverted || []);
  const remaining = ev.files.filter((f) => !reverted.has(f.path));
  const card = el('div', 'changes');
  const head = el('div', 'changes-head');
  const n = ev.files.length;
  head.append(
    el('span', 'changes-title', remaining.length ? `Muse changed ${n} file${n === 1 ? '' : 's'}` : `Undid Muse's changes to ${n} file${n === 1 ? '' : 's'}`),
  );
  if (remaining.length > 1) {
    head.append(
      button('Undo all', 'link danger-link', (e) => {
        e.target.disabled = true;
        vscode.postMessage({ type: 'undoChanges', id: ev.id });
      }),
    );
  }
  card.append(head);
  const list = el('ul', 'changes-list');
  for (const f of ev.files) {
    const li = el('li', reverted.has(f.path) ? 'reverted' : '');
    const badge = el('span', `badge-${f.status}`, f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M');
    badge.title = f.status;
    const name = el('span', 'change-path', f.path);
    name.title = f.path;
    const counts = el('span', 'counts');
    if (f.binary) counts.textContent = 'binary';
    else counts.textContent = [f.added ? `+${f.added}` : '', f.removed ? `−${f.removed}` : ''].filter(Boolean).join(' ');
    li.append(badge, name, counts);
    if (reverted.has(f.path)) li.append(el('span', 'muted small', 'undone'));
    else {
      li.append(
        button('Diff', 'link', () => vscode.postMessage({ type: 'changeDiff', id: ev.id, path: f.path })),
        button('Undo', 'link', (e) => {
          e.target.disabled = true;
          vscode.postMessage({ type: 'undoChanges', id: ev.id, paths: [f.path] });
        }),
      );
    }
    list.append(li);
  }
  card.append(list);
  if (old) old.el.replaceWith(card);
  else append(card);
  changeCards.set(ev.id, { el: card, ev: { ...ev } });
}

// ---------- questions ----------

function renderQuestion(q) {
  const card = el('div', 'question');
  const inputs = [];
  for (const item of q.questions) {
    const box = el('fieldset', 'q');
    box.append(el('legend', '', item.header || 'Question'));
    box.append(el('p', '', item.question));
    const multi = item.mode === 'multiple';
    const name = `${q.userInputId}-${item.id}`;
    for (const o of item.options) {
      const lab = el('label', 'opt');
      const input = el('input');
      input.type = multi ? 'checkbox' : 'radio';
      input.name = name;
      input.value = o.label;
      lab.append(input, el('span', '', o.label));
      if (o.description) lab.append(el('span', 'muted small', ' — ' + o.description));
      box.append(lab);
    }
    const other = el('input', 'other');
    other.type = 'text';
    other.maxLength = 500;
    other.placeholder = 'Or type your own answer';
    box.append(other);
    card.append(box);
    inputs.push({ item, box, other, multi, name });
  }
  const row = el('div', 'approval-actions');
  const submit = button('Submit', '', () => {
    const answers = [];
    for (const { item, box, other, multi, name } of inputs) {
      const picked = [...box.querySelectorAll(`input[name="${CSS.escape(name)}"]:checked`)].map((i) => i.value);
      if (other.value.trim()) answers.push({ questionId: item.id, freeText: other.value.trim() });
      else if (multi) answers.push({ questionId: item.id, selectedLabels: picked });
      else if (picked[0]) answers.push({ questionId: item.id, selectedLabel: picked[0] });
      else {
        other.focus();
        return;
      }
    }
    for (const x of card.querySelectorAll('button, input')) x.disabled = true;
    vscode.postMessage({ type: 'answer', userInputId: q.userInputId, answers });
  });
  const skip = button('Skip', 'secondary', () => {
    for (const x of card.querySelectorAll('button, input')) x.disabled = true;
    vscode.postMessage({ type: 'cancelQuestion', userInputId: q.userInputId });
  });
  row.append(submit, skip);
  card.append(row);
  const old = questions.get(q.userInputId);
  if (old) old.replaceWith(card);
  else append(card, true);
  questions.set(q.userInputId, card);
}

function settleQuestion(ev) {
  const card = questions.get(ev.userInputId);
  if (!card) return;
  const line = el('div', 'msg notice', ev.outcome === 'cancelled' ? 'Question skipped.' : ev.outcome === 'timedOut' ? 'Question timed out.' : 'Answered.');
  card.replaceWith(line);
  questions.set(ev.userInputId, line);
}

// ---------- status ----------

function renderTodos(list) {
  if (!list || !list.length) {
    $todos.hidden = true;
    $todos.replaceChildren();
    return;
  }
  const done = list.filter((t) => t.status === 'completed').length;
  const det = el('details', 'todo-list');
  det.open = $todos.querySelector('details')?.open ?? true;
  det.append(el('summary', '', `Tasks ${done}/${list.length}`));
  const ul = el('ul');
  for (const t of list) {
    const li = el('li', `todo ${t.status}`);
    li.append(el('span', 'icon'), el('span', '', t.status === 'inProgress' && t.activeForm ? t.activeForm : t.text));
    ul.append(li);
  }
  det.append(ul);
  $todos.replaceChildren(det);
  $todos.hidden = false;
}

function renderMeter() {
  const parts = [];
  const tips = [];
  if (typeof context.used === 'number') {
    parts.push(`${compact(context.used)}${context.window ? '/' + compact(context.window) : ''}`);
    tips.push(`Context: ${context.used.toLocaleString()} of ${context.window ? context.window.toLocaleString() : '?'} tokens`);
  }
  if (typeof usage.windowPct === 'number') {
    parts.push(`5h ${usage.windowPct}%`);
    const reset = usage.resetsAtMs ? ` (resets ${new Date(usage.resetsAtMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : '';
    tips.push(`5-hour allowance used: ${usage.windowPct}%${reset}`);
  }
  if (typeof usage.weeklyPct === 'number') {
    parts.push(`wk ${usage.weeklyPct}%`);
    tips.push(`Weekly allowance used: ${usage.weeklyPct}%`);
  }
  $meter.textContent = parts.join(' · ');
  $meter.title = tips.join('\n');
  $meter.classList.toggle('warn', context.pressure === 'warning' || usage.windowPct >= 80);
}

const $working = el('div', 'working');
const $dots = el('span', 'dots');
$dots.append(el('i'), el('i'), el('i'));
$working.append($dots, el('span', 'shimmer', 'Thinking…'));

function setBusy(on) {
  busy = on;
  if (on) {
    $messages.querySelector('.empty')?.remove();
    $messages.append($working);
    scrollToBottom(false);
  } else $working.remove();
  updateSendButton();
  $input.placeholder = !ready
    ? 'Finish setting up Muse above to start chatting'
    : on
      ? 'Type to queue a message…'
      : 'Ask Muse… (@ for files)';
}

function setWorkingText(text) {
  $working.lastChild.textContent = text;
}

/** While busy with an empty box, the round button stops Muse; with text, it queues a message. */
function updateSendButton() {
  const hasContent = !!$input.value.trim() || pendingImages.length > 0;
  $stop.hidden = !(busy && !hasContent);
  $send.hidden = !$stop.hidden;
  $send.disabled = !ready || !hasContent;
  $send.title = busy ? 'Queue message (Enter)' : 'Send (Enter)';
}

// ---------- event dispatch ----------

function apply(ev) {
  switch (ev.type) {
    case 'user':
      renderUserBubble(ev.text, ev);
      break;
    case 'changes':
      renderChanges(ev);
      break;
    case 'changes-updated': {
      const c = changeCards.get(ev.id);
      if (c) renderChanges({ ...c.ev, reverted: ev.reverted });
      break;
    }
    case 'item':
      renderItem(ev.item);
      break;
    case 'delta':
      applyDelta(ev);
      break;
    case 'approval-reviewing':
      renderReviewing(ev.approval);
      break;
    case 'approval':
      renderApproval(ev.approval);
      setWorkingText('Waiting for your approval…');
      break;
    case 'approval-resolved':
      renderApprovalResolved(ev);
      setWorkingText('Thinking…');
      break;
    case 'question':
      renderQuestion(ev.question);
      setWorkingText('Waiting for your answer…');
      break;
    case 'question-settled':
      settleQuestion(ev);
      setWorkingText('Thinking…');
      break;
    case 'turn':
      if (ev.phase === 'completed') {
        for (const card of approvals.values()) if (card.classList.contains('reviewing')) card.remove();
        if (ev.error) {
          const b = { el: el('div', 'msg error markdown'), raw: ev.error.message || `Muse stopped (${ev.error.kind}).` };
          append(b.el, true);
          renderMarkdown(b);
        } else if (ev.terminal === 'cancelled') append(el('div', 'msg notice', 'Stopped.'));
        else if (ev.terminal && ev.terminal !== 'completed') append(el('div', 'msg notice', `Turn ${ev.terminal}.`));
      }
      break;
    case 'context':
      context = ev;
      renderMeter();
      break;
    case 'usage':
      usage = ev;
      renderMeter();
      break;
    case 'todos':
      renderTodos(ev.items);
      break;
    case 'notice':
      append(el('div', 'msg notice', ev.message));
      break;
    case 'error': {
      const b = { el: el('div', 'msg error markdown'), raw: ev.message };
      append(b.el, true);
      renderMarkdown(b);
      break;
    }
  }
}

function reset(events, isBusy) {
  $messages.replaceChildren();
  items.clear();
  approvals.clear();
  questions.clear();
  changeCards.clear();
  renderTodos([]);
  if (!events.length) showEmptyState();
  for (const ev of events) apply(ev);
  for (const b of renderQueued) renderMarkdown(b);
  renderQueued.clear();
  setBusy(isBusy);
  scrollToBottom(true);
}

// ---------- controls ----------

function fillSelect(select, options, value) {
  select.replaceChildren(
    ...options.map(([v, label, title]) => {
      const o = el('option', '', label);
      o.value = v;
      if (title) o.title = title;
      return o;
    }),
  );
  select.value = value;
}

function renderControls(c) {
  const models = c.models.length ? c.models.map((m) => [m.id, m.label, m.description || '']) : [[c.modelId || '', c.modelLabel || 'Default model']];
  if (c.modelId && !models.some(([id]) => id === c.modelId)) models.unshift([c.modelId, c.modelLabel || c.modelId]);
  fillSelect($model, models, c.modelId || models[0][0]);
  $model.disabled = c.models.length < 2;

  const effortOpts = [['', `${c.defaultEffort ? c.defaultEffort[0].toUpperCase() + c.defaultEffort.slice(1) : 'Default'} effort`, 'The model\'s default reasoning effort']].concat(
    c.efforts.map((e) => [e, `${e[0].toUpperCase()}${e.slice(1)} effort`]),
  );
  fillSelect($effort, effortOpts, c.effort || '');

  fillSelect(
    $mode,
    c.profiles.map((p) => [p.id, p.label, PROFILE_HINTS[p.id] || p.description]),
    c.profile,
  );
  $mode.title = PROFILE_HINTS[c.profile] || c.profiles.find((p) => p.id === c.profile)?.description || '';
  $mode.classList.toggle('danger-text', c.profile === ':unrestricted');
}

$model.addEventListener('change', () => vscode.postMessage({ type: 'setModel', modelId: $model.value }));
$effort.addEventListener('change', () => vscode.postMessage({ type: 'setEffort', effort: $effort.value }));
$mode.addEventListener('change', () => vscode.postMessage({ type: 'setProfile', profileId: $mode.value }));

// ---------- setup card ----------

function renderSetup(status, platform, remote) {
  ready = status.state === 'ready';
  $input.disabled = !ready;
  setBusy(busy);
  if (ready) {
    $setup.hidden = true;
    $setup.replaceChildren();
    return;
  }
  const card = el('div', 'setup-card');
  const actions = el('div', 'setup-actions');
  const act = (label, type, primary) =>
    button(label, primary ? '' : 'secondary', (e) => {
      if (type === 'checkSetup') e.target.textContent = 'Checking…';
      vscode.postMessage({ type });
    });
  const where = remote ? el('p', 'remote-note small', `You're connected to a remote machine (${remote}). Muse has to be installed and signed in there, not on this computer.`) : null;
  if (status.state === 'missing') {
    card.append(el('h3', '', 'Install Muse Code'));
    if (where) card.append(where);
    card.append(el('p', '', "This panel needs the Muse Code CLI, and it isn't installed (or VS Code can't find it)."));
    if (platform === 'win32') {
      card.append(el('p', 'muted small', "Install opens Meta's Muse Code page with the Windows instructions. Come back and click Check again when it's done."));
      actions.append(act('Open install page', 'install', true));
    } else {
      card.append(
        el('p', 'muted small', "Install runs Meta's installer in a terminal you can watch:"),
        el('code', 'cmd', 'curl -fsSL https://dev.meta.ai/install.sh | bash'),
      );
      actions.append(act('Install Muse Code', 'install', true));
    }
    actions.append(act('Choose the muse file…', 'choosePath'), act('Check again', 'checkSetup'));
  } else {
    if (where) card.append(where);
    card.append(
      el('h3', '', 'Sign in to Muse'),
      el('p', '', `Muse is installed${status.version ? ` (${status.version})` : ''}, but you're not signed in yet.`),
      el('p', 'muted small', 'Sign in opens a terminal running "muse login". Approve the code it shows in your browser, and this panel will continue automatically.'),
    );
    actions.append(act('Sign in', 'signIn', true), act('Use an API key', 'apiKey'), act('Check again', 'checkSetup'));
  }
  card.append(actions);
  $setup.replaceChildren(card);
  $setup.hidden = false;
}

// ---------- input ----------

function autosize() {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 240) + 'px';
}

$input.addEventListener('input', () => {
  autosize();
  updateMention();
  updateSendButton();
});

$input.addEventListener('keydown', (e) => {
  if (mention.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = mention.items.length;
      if (n) mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderMentions();
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && mention.items.length) {
      e.preventDefault();
      pickMention(mention.items[mention.index]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMentions();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $form.requestSubmit();
  }
  if (e.key === 'Escape' && busy) vscode.postMessage({ type: 'stop' });
});

$input.addEventListener('blur', () => setTimeout(closeMentions, 150));

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $input.value.trim();
  if ((!text && !pendingImages.length) || !ready) return;
  const cmd = text.match(/^\/(\w+)$/);
  if (cmd && SLASH_COMMANDS.some((c) => c.name === cmd[1].toLowerCase()) && !pendingImages.length) return runSlash(cmd[1].toLowerCase());
  vscode.postMessage({ type: 'send', text, images: pendingImages, includeEditor });
  $input.value = '';
  pendingImages = [];
  includeEditor = true;
  renderPendingImages();
  renderEditorChip();
  closeMentions();
  autosize();
  updateSendButton();
});

// ---------- @-mentions ----------

function mentionQuery() {
  const caret = $input.selectionStart;
  if (caret !== $input.selectionEnd) return null;
  const before = $input.value.slice(0, caret);
  const m = before.match(/(?:^|[\s(])@([^\s@]*)$/);
  return m ? { query: m[1], start: caret - m[1].length - 1 } : null;
}

const SLASH_COMMANDS = [
  { name: 'new', desc: 'Start a new chat' },
  { name: 'compact', desc: 'Summarize earlier messages to free up context' },
  { name: 'model', desc: 'Switch model' },
  { name: 'effort', desc: 'Change reasoning effort' },
  { name: 'permissions', desc: 'Change what Muse may do without asking' },
  { name: 'history', desc: 'Open an earlier chat' },
  { name: 'stop', desc: 'Stop Muse' },
];

function updateMention() {
  // "/command" at the very start of the box opens the command list.
  const caret = $input.selectionStart;
  const slash = $input.value.slice(0, caret).match(/^\/(\w*)$/);
  if (slash && caret === $input.selectionEnd) {
    mention.open = true;
    mention.mode = 'slash';
    mention.items = SLASH_COMMANDS.filter((c) => c.name.startsWith(slash[1].toLowerCase()));
    mention.index = 0;
    return renderMentions();
  }
  const q = mentionQuery();
  if (!q) return closeMentions();
  mention.open = true;
  mention.mode = 'file';
  mention.start = q.start;
  vscode.postMessage({ type: 'searchFiles', query: q.query, requestId: ++mention.requestId });
}

function runSlash(name) {
  $input.value = '';
  autosize();
  updateSendButton();
  closeMentions();
  vscode.postMessage({ type: 'slash', name });
}

function renderMentions() {
  if (!mention.open) return;
  $mentions.replaceChildren();
  if (!mention.items.length) {
    $mentions.append(el('div', 'mention-empty muted', mention.mode === 'slash' ? 'No matching command' : 'No matching files'));
  }
  mention.items.forEach((p, i) => {
    const row = el('div', 'mention' + (i === mention.index ? ' active' : ''));
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === mention.index));
    if (mention.mode === 'slash') {
      row.append(el('span', 'mention-name', '/' + p.name), el('span', 'mention-dir muted', p.desc));
    } else {
      const slash = p.lastIndexOf('/', p.length - 2);
      row.append(el('span', 'mention-name', p.slice(slash + 1)), el('span', 'mention-dir muted', slash > 0 ? p.slice(0, slash) : ''));
    }
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickMention(p);
    });
    $mentions.append(row);
  });
  $mentions.hidden = false;
  $mentions.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function pickMention(p) {
  if (mention.mode === 'slash') return runSlash(p.name);
  const caret = $input.selectionStart;
  const before = $input.value.slice(0, mention.start);
  const after = $input.value.slice(caret);
  const insert = '@' + p + (p.endsWith('/') ? '' : ' ');
  $input.value = before + insert + after;
  const pos = before.length + insert.length;
  $input.setSelectionRange(pos, pos);
  closeMentions();
  autosize();
  $input.focus();
  if (p.endsWith('/')) updateMention(); // keep browsing inside the folder
}

function closeMentions() {
  mention.open = false;
  mention.items = [];
  $mentions.hidden = true;
}

$mentionBtn.addEventListener('click', () => {
  const pos = $input.selectionStart;
  const v = $input.value;
  const pad = pos > 0 && !/\s$/.test(v.slice(0, pos)) ? ' ' : '';
  $input.value = v.slice(0, pos) + pad + '@' + v.slice(pos);
  const caret = pos + pad.length + 1;
  $input.focus();
  $input.setSelectionRange(caret, caret);
  updateMention();
});

// ---------- editor context chip ----------

function renderEditorChip() {
  if (!editorCtx) {
    $editorChip.hidden = true;
    return;
  }
  const c = editorCtx;
  const lines = c.hasSelection ? (c.startLine === c.endLine ? `:${c.startLine}` : `:${c.startLine}-${c.endLine}`) : '';
  $editorChip.replaceChildren();
  const label = el('span', includeEditor ? '' : 'excluded', `${c.hasSelection ? '✂' : '📄'} ${c.name}${lines}`);
  $editorChip.title = includeEditor
    ? `Sent with your message: ${c.hasSelection ? 'the selected code in ' : 'the name of '}${c.rel}. Click × to leave it out of this message.`
    : 'Not sent with this message. Click to include it again.';
  const x = button(includeEditor ? '×' : '+', 'chip-x', () => {
    includeEditor = !includeEditor;
    renderEditorChip();
  });
  x.setAttribute('aria-label', includeEditor ? 'Leave out of this message' : 'Include in this message');
  $editorChip.append(label, x);
  $editorChip.classList.toggle('off', !includeEditor);
  $editorChip.hidden = false;
}

// ---------- images ----------

function renderPendingImages() {
  queueMicrotask(updateSendButton);
  $images.replaceChildren(
    ...pendingImages.map((im, i) => {
      const chip = el('span', 'chip image-chip');
      const img = el('img');
      img.src = im.thumb;
      img.alt = im.name || 'image';
      chip.title = `${im.name || 'image'} (${im.width}×${im.height})`;
      const x = button('×', 'chip-x', () => {
        pendingImages.splice(i, 1);
        renderPendingImages();
      });
      x.setAttribute('aria-label', 'Remove image');
      chip.append(img, x);
      return chip;
    }),
  );
}

function readImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 160 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve({
          mediaType: file.type,
          base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
          width: img.width,
          height: img.height,
          thumb: c.toDataURL('image/jpeg', 0.75),
          name: file.name || 'pasted image',
        });
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(files) {
  for (const f of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) continue;
    if (pendingImages.length >= MAX_IMAGES) {
      apply({ type: 'notice', message: `You can attach up to ${MAX_IMAGES} images per message.` });
      break;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      apply({ type: 'notice', message: `${f.name || 'Image'} is larger than 5 MB, so it wasn't attached.` });
      continue;
    }
    const im = await readImage(f);
    if (im) pendingImages.push(im);
  }
  renderPendingImages();
}

$attach.addEventListener('click', () => $fileInput.click());
$fileInput.addEventListener('change', () => {
  addImageFiles([...$fileInput.files]);
  $fileInput.value = '';
});
$input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    addImageFiles(files);
  }
});
for (const target of [$form, $messages]) {
  target.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.type.startsWith('image/'))) {
      e.preventDefault();
      $form.classList.add('dropping');
    }
  });
  target.addEventListener('dragleave', () => $form.classList.remove('dropping'));
  target.addEventListener('drop', (e) => {
    $form.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  });
}

$stop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

// File links in Muse's replies open in the editor instead of the webview.
$messages.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:')) return; // http(s) etc.: VS Code opens it
  e.preventDefault();
  if (!href || href.startsWith('#')) return;
  let p = decodeURI(href.replace(/^file:\/\//, ''));
  let line;
  const m = p.match(/#L(\d+)/) || p.match(/:(\d+)(?::\d+)?$/);
  if (m) {
    line = Number(m[1]);
    p = p.slice(0, m.index);
  }
  if (p) vscode.postMessage({ type: 'openFile', path: p, line });
});

window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'reset':
      reset(msg.events, msg.busy);
      break;
    case 'event':
      apply(msg.event);
      break;
    case 'busy':
      setBusy(msg.on);
      break;
    case 'controls':
      renderControls(msg);
      break;
    case 'setup':
      renderSetup(msg.status, msg.platform, msg.remote);
      break;
    case 'fileResults':
      if (msg.requestId === mention.requestId && mention.open && mention.mode === 'file') {
        mention.items = msg.paths;
        mention.index = 0;
        renderMentions();
      }
      break;
    case 'editorContext':
      if (!msg.ctx || !editorCtx || msg.ctx.rel !== editorCtx.rel) includeEditor = true;
      editorCtx = msg.ctx;
      renderEditorChip();
      break;
    case 'insert':
      $input.value += ($input.value && !$input.value.endsWith('\n') ? '\n' : '') + msg.text;
      autosize();
      updateSendButton();
      $input.focus();
      break;
  }
});

showEmptyState();
vscode.postMessage({ type: 'ready' });
