// Small line icons (16×16, stroke = currentColor) so they follow the VS Code theme.
const svg = (body, extra = '') =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const icons = {
  send: svg('<path d="M8 13V3"/><path d="M3.5 7.5 8 3l4.5 4.5"/>'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/>'),
  attach: svg('<path d="M13 7.5 8.2 12.3a3 3 0 0 1-4.3-4.2l5-5a2 2 0 0 1 2.9 2.8L6.9 10.8a1 1 0 0 1-1.5-1.4L10 4.9"/>'),
  at: svg('<circle cx="8" cy="8" r="2.4"/><path d="M10.4 8v.9a1.6 1.6 0 0 0 3.2 0V8A5.6 5.6 0 1 0 11 12.6"/>'),
  terminal: svg('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><path d="m4.5 6.3 2 1.7-2 1.7"/><path d="M8.2 10h3.2"/>'),
  file: svg('<path d="M9 1.8H4.6a1.3 1.3 0 0 0-1.3 1.3v9.8a1.3 1.3 0 0 0 1.3 1.3h6.8a1.3 1.3 0 0 0 1.3-1.3V5.5Z"/><path d="M9 1.8v3.7h3.7"/>'),
  edit: svg('<path d="M10.8 2.6a1.5 1.5 0 0 1 2.1 2.1L5.6 12 2.8 12.8l.8-2.8Z"/><path d="m9.8 3.6 2.1 2.1"/>'),
  search: svg('<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.4 3.4"/>'),
  globe: svg('<circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2a9.5 9.5 0 0 1 0 12A9.5 9.5 0 0 1 8 2Z"/>'),
  checklist: svg('<path d="m2.5 4.2 1.2 1.2 2-2.2"/><path d="m2.5 10.2 1.2 1.2 2-2.2"/><path d="M8 4.5h5.5"/><path d="M8 10.5h5.5"/>'),
  book: svg('<path d="M2.5 3.2c1.8-.6 3.7-.4 5.5.8 1.8-1.2 3.7-1.4 5.5-.8v9.6c-1.8-.6-3.7-.4-5.5.8-1.8-1.2-3.7-1.4-5.5-.8Z"/><path d="M8 4v9.6"/>'),
  agent: svg('<circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5a5 5 0 0 1 10 0"/>'),
  tool: svg('<path d="M10.5 2.2a3.2 3.2 0 0 0-3.4 4.3L2.6 11a1.3 1.3 0 0 0 1.9 1.9L9 8.4a3.2 3.2 0 0 0 4.3-3.4l-1.9 1.9-1.8-.5-.5-1.8Z"/>'),
  check: svg('<path d="m3.5 8.5 3 3 6-6.5"/>'),
  x: svg('<path d="m4.5 4.5 7 7"/><path d="m11.5 4.5-7 7"/>'),
  minus: svg('<path d="M4.5 8h7"/>'),
  copy: svg('<rect x="5.2" y="5.2" width="8.3" height="8.3" rx="1.4"/><path d="M10.8 5.2V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v5.5a1.4 1.4 0 0 0 1.4 1.4h1.3"/>'),
  shield: svg('<path d="M8 1.8 3 3.7v4c0 3 2.2 5.4 5 6.5 2.8-1.1 5-3.5 5-6.5v-4Z"/>'),
  chevron: svg('<path d="m4.5 6.2 3.5 3.5 3.5-3.5"/>'),
  sparkle: svg('<path d="M8 1.8 9.4 6.6l4.8 1.4-4.8 1.4L8 14.2 6.6 9.4 1.8 8l4.8-1.4Z"/>'),
};

/** Picks an icon for a Muse tool name. */
export function toolIcon(tool = '') {
  const t = tool.toLowerCase();
  if (/bash|shell|exec|command|terminal|run_/.test(t)) return icons.terminal;
  if (/write|edit|patch|replace|insert|create_file|multi_edit/.test(t)) return icons.edit;
  if (/read|view|open|cat|list_dir|ls/.test(t)) return icons.file;
  if (/search|grep|glob|find/.test(t)) return icons.search;
  if (/web|fetch|http|url|browse/.test(t)) return icons.globe;
  if (/todo/.test(t)) return icons.checklist;
  if (/skill|doc/.test(t)) return icons.book;
  if (/agent/.test(t)) return icons.agent;
  return icons.tool;
}

/** The app mark, used on the welcome screen. */
export const logo = `<svg viewBox="0 0 256 256" width="44" height="44" aria-hidden="true"><defs><linearGradient id="ms-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C3AED"/><stop offset="1" stop-color="#EC4899"/></linearGradient></defs><rect x="8" y="8" width="240" height="240" rx="56" fill="url(#ms-bg)"/><path d="M60 184V80l68 66 68-66v104" fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/><path d="M196 34l7 17 17 7-17 7-7 17-7-17-17-7 17-7z" fill="#fff"/></svg>`;
