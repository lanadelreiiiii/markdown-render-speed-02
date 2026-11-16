// parse.js — fast drop-in replacement for marked 18.1.3 (default options:
// gfm on, breaks off, pedantic off, async off). Built from the CommonMark
// 0.31.2 and GFM 0.29 specifications plus black-box probing of marked's
// observable output. Two passes and no token tree: a line scanner builds
// blocks, then each text block is parsed inline in a single scan. No
// caching across parse() calls and no input recognition: every call is a
// pure function of its input string.
//
// Speed: a single-paragraph input skips the block scanner entirely
// (parse fast path); plain text runs are found with one C++ regex scan
// instead of a JS character loop; paragraph continuation lines skip the
// block-start checks; text with no inline constructs is escaped directly.

// Document-level "inside an unclosed inline <a> tag" flag. An unclosed
// inline <a> suppresses all GFM extended autolinks (www., scheme://,
// email, scheme:email) for the rest of the document (marked quirk);
// </a> inline clears it; <...> autolinks are unaffected.
let _inLink = false;
let _aSelfClose = false;

export function parse(markdown) {
  _inLink = false;
  _aSelfClose = false;
  const fp = tryFastParagraph(markdown);
  if (fp !== null) return fp;
  return renderDocument(parseBlocks(markdown));
}

// Fast path: the whole input is one plain paragraph (no blank line, no
// line that can start any other block, no tab-indented line, no link
// reference definition at the start). Returns the HTML, or null to fall
// through to the full block parser. This covers a large share of the
// small spec cases, where the block scanner's fixed cost dominates.
function tryFastParagraph(src) {
  if (src.indexOf('\r') !== -1) return null;
  if (src === '') return '';
  // Cheap rejects before splitting the whole input: an empty line
  // ('\n\n') is a blank line, so this is not a single paragraph.
  if (src.indexOf('\n\n') !== -1) return null;
  // First line: at most 3 leading spaces, no leading tab, first
  // character plain (and not '[' — a link reference definition).
  let p = 0, ind = 0;
  while (p < src.length && src.charCodeAt(p) === SP) { ind++; p++; }
  if (ind > 3) return null;
  if (p >= src.length) return null; // blank first line
  if (src.charCodeAt(p) === TAB) return null;
  const c0 = src.charCodeAt(p);
  if (!isPlainStart(c0) || c0 === 91) return null;
  // A newline inside the first line's leading run means the first line
  // itself is blank (only spaces before the newline).
  if (src.charCodeAt(p) === LF) return null;
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return '';
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length === 0) return null; // blank line
    // leading whitespace: at most 3 columns, no tabs (a leading tab has
    // subtle strip/expand behaviour in the full parser)
    let ind2 = 0, q = 0;
    while (q < line.length) {
      const c = line.charCodeAt(q);
      if (c === 32) { ind2++; q++; }
      else if (c === 9) return null;
      else break;
    }
    if (ind2 > 3) return null;
    if (q >= line.length) return null; // whitespace-only line = blank
    const c1 = line.charCodeAt(q);
    if (!isPlainStart(c1)) return null;
    // a '[' as the first character of the first line can start a link
    // reference definition, which the paragraph fast path cannot strip
    if (li === 0 && c1 === 91) return null;
  }
  const text = lines.join('\n');
  const refs = new Map();
  let out = '<p>';
  if (isPlainInline(text)) {
    const frags = [];
    escapeText(text, frags);
    out += frags.join('');
  } else {
    const frags = [];
    renderInline(parseInline(text, refs), frags);
    out += frags.join('');
  }
  out += '</p>\n';
  return out;
}

// True when a text has no inline construct at all: no backslash, code
// span, entity, tag, emphasis, link/image bracket, strikethrough, and no
// GFM autolink trigger (@, ://, www.), and no hard break (2+ spaces
// before a newline). Such text renders as its own escaping, with
// newlines kept (a soft break renders as '\n').
const RE_INLINE_SPECIAL = /[\\`&<*_!\[\]~]/;
function isPlainInline(text) {
  if (RE_INLINE_SPECIAL.test(text)) return false;
  if (text.indexOf('@') !== -1) return false;
  if (text.indexOf('://') !== -1) return false;
  if (text.indexOf('www.') !== -1) return false;
  if (text.indexOf('  \n') !== -1) return false;
  return true;
}

// ---------------------------------------------------------------- helpers

const SP = 32, TAB = 9, LF = 10, CR = 13;
const LT = 60, GT = 62, AMP = 38, QUOT = 34, APOS = 39;
const BSLASH = 92, STAR = 42, UNDER = 95, TILDE = 126, TICK = 96;
const LBRK = 91, RBRK = 93, LPAR = 40, RPAR = 41, HASH = 35;
const BANG = 33, DASH = 45, PLUS = 43, DOT = 46, COLON = 58;
const SLASH = 47, EQ = 61, PIPE = 124, CARET = 94, PCT = 37;

// ASCII punctuation table (code < 128): 1 = punctuation per CommonMark.
const ASCII_PUNCT = new Uint8Array(128);
for (const c of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASCII_PUNCT[c.charCodeAt(0)] = 1;

const RE_PUNCT_U = /[\p{P}\p{S}]/u;
const RE_WS_U = /\s/u;

function isSpaceCode(c) {
  return c === SP || c === TAB || c === LF || c === CR || c === 11 || c === 12;
}
function isWhitespace(c) {
  if (c < 128) return isSpaceCode(c);
  return RE_WS_U.test(String.fromCharCode(c));
}
function isPunct(c) {
  // Unicode punctuation for flanking / emphasis rules: ASCII punctuation
  // plus any non-ASCII character in Unicode general categories P
  // (punctuation) or S (symbol) — the spec's "Unicode punctuation".
  // So '£' (Sc) and '€' (Sc) count, and a '*' next to them is not
  // flanking the way it would be next to a letter (cm-354).
  if (c < 128) return ASCII_PUNCT[c] === 1;
  return RE_PUNCT_U.test(String.fromCharCode(c));
}
function isPunctAscii(c) {
  // ASCII punctuation only: backslash escapes and label scans use this
  // (a backslash before a non-ASCII punctuation mark is literal, cm-013).
  return c < 128 && ASCII_PUNCT[c] === 1;
}
function isPunctU(c) {
  // Unicode punctuation (for flanking / emphasis rules).
  if (c < 128) return ASCII_PUNCT[c] === 1;
  return RE_PUNCT_U.test(String.fromCharCode(c));
}
// Is the code unit an ASCII letter/digit (for flanking / autolink checks)?
function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// Unicode letter/number (fallback for non-ASCII flanking).
const RE_ALNUM_U = /[\p{L}\p{N}]/u;
function isWordChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAlnum(c);
  return RE_ALNUM_U.test(ch);
}

// Escape text for HTML output: & < > " '  (marked's escape()).
function escapeHtml(s, out, start, end) {
  let i = start, j = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === AMP) { if (j < i) out.push(s.slice(j, i)); out.push('&amp;'); j = i + 1; }
    else if (c === LT) { if (j < i) out.push(s.slice(j, i)); out.push('&lt;'); j = i + 1; }
    else if (c === GT) { if (j < i) out.push(s.slice(j, i)); out.push('&gt;'); j = i + 1; }
    else if (c === QUOT) { if (j < i) out.push(s.slice(j, i)); out.push('&quot;'); j = i + 1; }
    else if (c === APOS) { if (j < i) out.push(s.slice(j, i)); out.push('&#39;'); j = i + 1; }
    i++;
  }
  if (j < end) out.push(s.slice(j, end));
}
function escapeStr(s) {
  const out = [];
  escapeHtml(s, out, 0, s.length);
  return out.join('');
}

// Decode a numeric character reference starting at i (s[i] === '&', s[i+1] === '#').
// Returns [codePoint, endIndex] or null when not a valid numeric reference.
function decodeNumericRef(s, i) {
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const d0 = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
            : (c >= 48 && c <= 57)) j++;
    else break;
  }
  if (j === d0 || j >= s.length || s[j] !== ';') return null;
  if (hex ? (j - d0) > 6 : (j - d0) > 7) return null;
  let cp = parseInt(s.slice(d0, j), hex ? 16 : 10);
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
  return [cp, j + 1];
}

// cleanUrl: encodeURI + %25 -> % ; null when encodeURI throws.
// The %25 -> % replacement only matters when the href itself holds a
// '%', so skip the regex scan otherwise.
function cleanUrl(href) {
  try {
    const e = encodeURI(href);
    return href.indexOf('%') === -1 ? e : e.replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Expand tabs in the LEADING whitespace of s to spaces, starting at
// column startCol (code blocks only). Mid-line tabs are preserved verbatim.
// A leading tab at column 0 (top-level) is preserved; inside a container
// (col > 0) a leading tab expands to the next multiple of 4.
function expandTabs(s, startCol) {
  if (startCol === 0) return s;
  let k = 0, col = startCol;
  let out = '';
  while (k < s.length) {
    const ch = s[k];
    if (ch === '\t') {
      const sp = 4 - (col % 4);
      out += ' '.repeat(sp);
      col += sp;
      k++;
    } else if (ch === ' ') {
      out += ' ';
      col++;
      k++;
    } else break;
  }
  if (k === 0) return s;
  return out + s.slice(k);
}

function unescapeBackslashes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && isPunctAscii(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

// Normalize a link label: trim, collapse internal whitespace to one space,
// lowercase then uppercase then lowercase (marked's order).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// A character that cannot start any block (setext underline, table
// delimiter row, thematic break, list marker, ATX/fence/HTML/blockquote).
// Used to skip the expensive block-start checks for plain paragraph
// continuation lines (the common case in long documents).
function isPlainStart(c) {
  if (c === -1) return false;
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 128) return true;
  // safe punctuation: " ' ( ) , . ; ? ! / \ @ $ % ^ & { } [ ]
  // (NOT ':' — it can start a table delimiter cell ':-:'.)
  return c === 34 || c === 39 || c === 40 || c === 41 || c === 44 || c === 46 ||
    c === 59 || c === 63 || c === 33 || c === 47 || c === 92 ||
    c === 64 || c === 36 || c === 37 || c === 94 || c === 38 || c === 123 ||
    c === 125 || c === 91 || c === 93;
}

// ---------------------------------------------------------------- block nodes

function newNode(type) {
  return { t: type, open: true, children: [], parent: null, lastChild: null, strings: null, _blank: false, _lastLineBlank: false, _listData: null };
}
function addChild(parent, node) {
  node.parent = parent;
  if (parent.lastChild) parent.lastChild.next = node;
  parent.children.push(node);
  parent.lastChild = node;
  return node;
}

// ---------------------------------------------------------------- block parser

const BLOCK_TAG_NAMES = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));

function parseBlocks(src) {
  // Skip the CR normalization (and the full-string copy it entails)
  // when the input has no carriage return at all (the common case).
  if (src.indexOf('\r') !== -1) src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const doc = newNode('document');
  doc._refs = refs;
  doc._endsNL = src.endsWith('\n');
  let tip = doc;

  // --- per-line cursor ---
  let line = '';
  let pos = 0, col = 0, ptab = 0;

  function ch() {
    if (ptab > 0) return SP;
    return pos < line.length ? line.charCodeAt(pos) : -1;
  }
  function advCols(n) {
    while (n > 0 && (ptab > 0 || pos < line.length)) {
      if (ptab > 0) {
        ptab--; col++; n--;
        if (ptab === 0) pos++; // tab fully consumed: move past it
      }
      else if (line.charCodeAt(pos) === TAB) {
        const w = 4 - (col % 4);
        if (w <= n) { col += w; pos++; n -= w; }
        else { ptab = w - n; col += n; n = 0; }
      } else { col++; pos++; n--; }
    }
  }
  function adv1() { advCols(1); }
  // skip spaces/tabs fully; returns columns skipped
  function skipSpaces() {
    let n = 0;
    for (;;) {
      if (ptab > 0) {
        ptab--; col++; n++;
        if (ptab === 0) pos++;
      }
      else if (pos < line.length) {
        const c = line.charCodeAt(pos);
        if (c === SP) { pos++; col++; n++; }
        else if (c === TAB) { const w = 4 - (col % 4); col += w; pos++; n += w; }
        else break;
      } else break;
    }
    return n;
  }
  // indent (space columns) from current position to first non-space char
  function countIndent() {
    let c = col, p = pos, pt = ptab, n = 0;
    for (;;) {
      if (pt > 0) {
        pt--; c++; n++;
        if (pt === 0) p++;
      }
      else if (p < line.length) {
        const cc = line.charCodeAt(p);
        if (cc === SP) { p++; c++; n++; }
        else if (cc === TAB) { const w = 4 - (c % 4); c += w; p++; n += w; }
        else break;
      } else break;
    }
    return n;
  }
  function isBlankLine() {
    let p = pos, pt = ptab;
    for (;;) {
      if (pt > 0) { pt--; if (pt === 0) p++; continue; }
      if (p >= line.length) return true;
      const c = line.charCodeAt(p);
      if (c === SP || c === TAB) { p++; continue; }
      return false;
    }
  }
  // rest of line from current cursor (respects partial tab:
  // when ptab>0, pos points at the tab char, represented by ptab spaces)
  function restOfLine() {
    if (ptab > 0) return ' '.repeat(ptab) + line.slice(pos + 1);
    return line.slice(pos);
  }

  // --- node helpers ---
  function finalize(node) {
    node.open = false;
    // A blank line nested inside a blockquote/list must not mark the parent
    // as ending with a blank line (it is not a separator at parent level).
    if (node.t === 'blockquote' && node.parent) {
      node.parent._lastLineBlank = false;
    }
    if (node.t === 'code_indented') {
      // strip trailing blank lines
      const s = node.strings;
      while (s.length && s[s.length - 1] === '') s.pop();
    } else if (node.t === 'list') {
      node._tight = true;
      // loose if any item has a blank line with a following sibling block/item
      for (const item of node.children) {
        if (item._lastLineBlank && item.next) { node._tight = false; break; }
        for (const b of item.children) {
          if (b._lastLineBlank && b.next) { node._tight = false; break; }
        }
        if (!node._tight) break;
      }
      // NOTE: a loose child list does NOT make the parent loose; only
      // blank lines between this list's own items / blocks do.
    } else if (node.t === 'paragraph') {
      // strip leading link reference definitions
      const text = node.strings.join('\n');
      const rest = stripRefDefs(text, refs);
      node._text = rest;
      if (rest === '') node._empty = true;
    }
  }
  function finalizeUpTo(container) {
    // finalize from tip up to (not including) container
    while (tip !== container) {
      const parent = tip.parent;
      finalize(tip);
      tip = parent;
    }
  }
  function addLine(node, s) {
    if (!node.strings) node.strings = [];
    node.strings.push(s);
    // New content after a blank line: this block (and its ancestors) no
    // longer "end with a blank line". Without this, a blank line nested
    // inside a child list would wrongly mark the parent list loose.
    let n = node;
    while (n) { n._lastLineBlank = false; n = n.parent; }
  }

  // --- link reference definitions (parsed from paragraph text) ---
  // Parse consecutive defs from the start of text; store into refs; return rest.
  function stripRefDefs(text, refs) {
    let i = 0;
    const n = text.length;
    while (i < n) {
      const save = i;
      // leading indent (up to 3 spaces/tabs) before the label
      let ind = 0;
      while (i < n && (text[i] === ' ' || text[i] === '\t')) { ind++; i++; }
      if (ind > 3) { i = save; break; }
      // label: '[' ... ']' with no unescaped '[' or ']' inside, non-empty
      if (i >= n || text[i] !== '[') { i = save; break; }
      let j = i + 1, label = '';
      let ok = true;
      while (j < n && text[j] !== ']') {
        const c = text[j];
        if (c === '[') { ok = false; break; }
        if (c === '\\' && j + 1 < n && isPunctAscii(text.charCodeAt(j + 1))) { label += text[j] + text[j + 1]; j += 2; continue; }
        label += c; j++;
      }
      if (!ok || j >= n || label.length === 0) { i = save; break; }
      j++; // past ']'
      // optional spaces/tabs (not newlines yet), then ':'
      let k = j;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      if (k >= n || text[k] !== ':') { i = save; break; }
      k++;
      // skip spaces/tabs/newlines (dest may be on next line)
      let m = k;
      while (m < n && (text[m] === ' ' || text[m] === '\t' || text[m] === '\n')) m++;
      if (m >= n) { i = save; break; }
      // destination
      let dest = null, end = m;
      if (text[m] === '<') {
        let e = m + 1;
        while (e < n && text[e] !== '>' && text[e] !== '\n') {
          if (text[e] === '\\' && e + 1 < n && isPunctAscii(text.charCodeAt(e + 1))) { e += 2; continue; }
          e++;
        }
        if (e >= n || text[e] !== '>') { i = save; break; }
        dest = text.slice(m + 1, e);
        end = e + 1;
      } else {
        let e = m, depth = 0;
        while (e < n) {
          const c = text[e];
          if (c === ' ' || c === '\t' || c === '\n') break;
          if (c === '\\' && e + 1 < n && isPunctAscii(text.charCodeAt(e + 1))) { e += 2; continue; }
          if (c === '(') { depth++; e++; continue; }
          if (c === ')') {
            if (depth === 0) break;
            depth--; e++; continue;
          }
          e++;
        }
        if (e === m) { i = save; break; } // empty dest
        dest = text.slice(m, e);
        end = e;
      }
      // optional title on same or next line (must be separated from the
      // dest by whitespace; a quote/paren glued to the dest is junk)
      let title = null, endAfterTitle = end;
      let t = end;
      while (t < n && (text[t] === ' ' || text[t] === '\t')) t++;
      const hasWsBeforeTitle = t > end;
      if (t < n && (text[t] === '"' || text[t] === "'" || text[t] === '(') && !hasWsBeforeTitle) {
        // title glued to dest: not a title, so this is junk after the dest
        { i = save; break; }
      }
      if (t < n && (text[t] === '"' || text[t] === "'" || text[t] === '(')) {
        const q = text[t];
        const close = q === '(' ? ')' : q;
        let e = t + 1, okT = true;
        while (e < n && text[e] !== close) {
          if (text[e] === '\\' && e + 1 < n && isPunctAscii(text.charCodeAt(e + 1))) { e += 2; continue; }
          if (q === '(' && text[e] === '(') { okT = false; break; }
          e++;
        }
        if (okT && e < n) {
          title = text.slice(t + 1, e);
          endAfterTitle = e + 1;
          // after title: only spaces/tabs then newline or EOF
          let u = endAfterTitle;
          while (u < n && (text[u] === ' ' || text[u] === '\t')) u++;
          if (u < n && text[u] !== '\n') { /* junk after title: whole def fails */ i = save; break; }
          endAfterTitle = u;
        } else if (q === '(') {
          i = save; break; // '(' title must close on same line-ish; treat as failed def
        } else {
          // quote title may span lines; try again allowing newline
          let e2 = t + 1, ok2 = true;
          while (e2 < n && text[e2] !== close) {
            if (text[e2] === '\\' && e2 + 1 < n && isPunctAscii(text.charCodeAt(e2 + 1))) { e2 += 2; continue; }
            e2++;
          }
          if (ok2 && e2 < n) {
            title = text.slice(t + 1, e2);
            endAfterTitle = e2 + 1;
            let u = endAfterTitle;
            while (u < n && (text[u] === ' ' || text[u] === '\t')) u++;
            if (u < n && text[u] !== '\n') { i = save; break; }
            endAfterTitle = u;
          } else {
            i = save; break;
          }
        }
      } else {
        // no title: after dest, only spaces/tabs then newline or EOF
        let u = end;
        while (u < n && (text[u] === ' ' || text[u] === '\t')) u++;
        if (u < n && text[u] !== '\n') { i = save; break; }
        endAfterTitle = u;
      }
      // title on the NEXT line (when not found on same line)
      if (title === null) {
        let t2 = end;
        while (t2 < n && (text[t2] === ' ' || text[t2] === '\t')) t2++;
        if (t2 < n && text[t2] === '\n') {
          let t3 = t2 + 1;
          while (t3 < n && (text[t3] === ' ' || text[t3] === '\t')) t3++;
          if (t3 < n && (text[t3] === '"' || text[t3] === "'" || text[t3] === '(')) {
            const q = text[t3];
            const close = q === '(' ? ')' : q;
            let e = t3 + 1, okT = true;
            while (e < n && text[e] !== close) {
              if (text[e] === '\\' && e + 1 < n && isPunctAscii(text.charCodeAt(e + 1))) { e += 2; continue; }
              if (q === '(' && text[e] === '(') { okT = false; break; }
              if (text[e] === '\n' && q !== '"') { /* '(' title ends at first ')' on same line */ }
              e++;
            }
            if (okT && e < n && (q !== '(' || text.slice(t3 + 1, e).indexOf('\n') === -1)) {
              title = text.slice(t3 + 1, e);
              endAfterTitle = e + 1;
              let u = endAfterTitle;
              while (u < n && (text[u] === ' ' || text[u] === '\t')) u++;
              if (u < n && text[u] !== '\n') { /* junk: def has no title */ title = null; endAfterTitle = end; }
              else endAfterTitle = u;
            }
          }
        }
      }
      // store (first def wins); dest/title have backslash escapes removed
      const norm = normalizeLabel(label);
      if (norm === '') { i = save; break; } // empty label: not a def
      if (!refs.has(norm)) refs.set(norm, { dest: unescapeBackslashes(dest), title: title == null ? null : unescapeBackslashes(title) });
      // advance past this def (and one following newline)
      i = endAfterTitle;
      if (i < n && text[i] === '\n') i++;
      if (i === save) break;
    }
    return text.slice(i);
  }

  // --- block-start checks (cursor at line content start, indent <= 3) ---
  function checkATX() {
    // returns level 1-6 or 0; cursor at first '#'
    if (ch() !== HASH) return 0;
    let lvl = 0;
    let p = pos;
    while (p < line.length && line.charCodeAt(p) === HASH && lvl < 7) { lvl++; p++; }
    if (lvl > 6 || lvl === 0) return 0;
    if (p < line.length) {
      const c = line.charCodeAt(p);
      if (c !== SP && c !== TAB && c !== -1) return 0;
    }
    return lvl;
  }
  function checkFence() {
    // returns {fchar, flen} or null; cursor at first fence char
    const c = ch();
    if (c !== TICK && c !== TILDE) return null;
    let p = pos, len = 0;
    while (p < line.length && line.charCodeAt(p) === c) { len++; p++; }
    if (len < 3) return null;
    return { fchar: c, flen: len };
  }
  function checkHr() {
    // thematic break: 3+ same char (*, -, _) with only spaces between
    const c = ch();
    if (c !== STAR && c !== DASH && c !== UNDER) return false;
    let p = pos, n = 0;
    while (p < line.length) {
      const cc = line.charCodeAt(p);
      if (cc === c) { n++; p++; }
      else if (cc === SP || cc === TAB) p++;
      else return false;
    }
    return n >= 3;
  }
  function checkSetext() {
    // returns 1 (=) or 2 (-) or 0; cursor at first char
    // run of = or -, then only trailing spaces/tabs (no spaces inside)
    const c = ch();
    if (c !== EQ && c !== DASH) return 0;
    let p = pos;
    while (p < line.length && line.charCodeAt(p) === c) p++;
    while (p < line.length && (line.charCodeAt(p) === SP || line.charCodeAt(p) === TAB)) p++;
    if (p !== line.length) return 0;
    return c === EQ ? 1 : 2;
  }
  // List marker info at cursor (cursor at marker start, ptab==0).
  // Pure lookahead: does not move the cursor. Returns null when not a marker.
  function listInfoAtCursor() {
    // skip leading spaces/tabs (the marker may be indented)
    let sp = pos, sc = col;
    while (sp < line.length) {
      const cc = line.charCodeAt(sp);
      if (cc === SP) { sp++; sc++; }
      else if (cc === TAB) { const w = 4 - (sc % 4); sc += w; sp++; }
      else break;
    }
    // a list marker may be indented at most 3 columns from here
    if (sc - col > 3) return null;
    const c = sp < line.length ? line.charCodeAt(sp) : -1;
    // use the skipped position for marker parsing
    const pos0 = pos, col0 = col;
    pos = sp; col = sc;
    const res = listInfoAtCursorInner();
    pos = pos0; col = col0;
    return res;
  }
  function listInfoAtCursorInner() {
    const c = line.charCodeAt(pos);
    let ordered = false, bullet = 0, start = null, width = 0;
    if (c === DASH || c === PLUS || c === STAR) {
      const nc = pos + 1 < line.length ? line.charCodeAt(pos + 1) : -1;
      if (nc !== SP && nc !== TAB && nc !== -1) return null;
      ordered = false; bullet = c; width = 1;
    } else if (c >= 48 && c <= 57) {
      let p = pos, num = 0, digits = 0;
      while (p < line.length && line.charCodeAt(p) >= 48 && line.charCodeAt(p) <= 57 && digits < 10) {
        num = num * 10 + (line.charCodeAt(p) - 48); digits++; p++;
      }
      if (digits === 0 || digits > 9) return null;
      if (p >= line.length) return null;
      const d = line.charCodeAt(p);
      if (d !== DOT && d !== RPAR) return null;
      const nc = p + 1 < line.length ? line.charCodeAt(p + 1) : -1;
      if (nc !== SP && nc !== TAB && nc !== -1) return null;
      ordered = true; bullet = d; start = num; width = digits + 1;
    } else return null;
    // spaces after the marker, in columns (tabs expand)
    let cc = col + width, p = pos + width, padCols = 0;
    while (p < line.length) {
      const ch2 = line.charCodeAt(p);
      if (ch2 === SP) { padCols++; cc++; p++; }
      else if (ch2 === TAB) { const w = 4 - (cc % 4); padCols += w; cc += w; p++; }
      else break;
    }
    return { ordered, bullet, start, width, padCols, hasContent: p < line.length };
  }
  function htmlBlockType() {
    // returns 1-7 or 0; cursor at '<'
    if (ch() !== LT) return 0;
    const s = line.slice(pos);
    // type 1: script/pre/style/textarea — OPEN tags only. A closing tag
    // (</pre> etc.) does not interrupt a paragraph (cm-148), so it must not
    // be type 1 here; it falls through to type 7 below.
    let m = /^<(script|pre|style|textarea)(?=[\s>\/]|$)/i.exec(s);
    if (m) return 1;
    // type 2: comment
    if (s.startsWith('<!--')) return 2;
    // type 3: ?
    if (s.startsWith('<?')) return 3;
    // type 4: <! + letter
    if (s.startsWith('<!') && s.length > 2 && /[A-Za-z]/.test(s[2])) return 4;
    // type 5: CDATA
    if (s.startsWith('<![CDATA[')) return 5;
    // type 6: block tag. A closing tag of a type-1 name (</pre> etc.) is
    // NOT type 6: it cannot interrupt a paragraph (cm-148).
    m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s>\/]|$)/.exec(s);
    if (m && BLOCK_TAG_NAMES.has(m[1].toLowerCase())) {
      const isClose = s.startsWith('</');
      const low = m[1].toLowerCase();
      if (!(isClose && (low === 'script' || low === 'pre' || low === 'style' || low === 'textarea'))) return 6;
    }
    // type 7: complete open/closing tag alone on line.
    // Closing tags take no attributes (and no '/'); open tags may.
    if (s.startsWith('</')) {
      m = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(s);
    } else {
      m = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/.exec(s);
    }
    if (m) {
      const rest = s.slice(m[0].length);
      if (/^[ \t]*$/.test(rest)) return 7;
    }
    return 0;
  }
  function htmlBlockEnds(type, text) {
    // does this line end the html block of given type?
    if (type === 1) return /<\/\s*(script|pre|style|textarea)/i.test(text);
    if (type === 2) return text.indexOf('-->') !== -1;
    if (type === 3) return text.indexOf('?>') !== -1;
    if (type === 4) return text.indexOf('>') !== -1;
    if (type === 5) return text.indexOf(']]>') !== -1;
    return false; // types 6,7 end at blank line
  }
  function checkTableDelim() {
    // current line (from cursor) is a table delimiter row? returns aligns[] or null
    const s = restOfLine();
    // split on unescaped pipes
    const cells = [];
    let cur = '', i = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === BSLASH && i + 1 < s.length && isPunctAscii(s.charCodeAt(i + 1))) { cur += s[i] + s[i + 1]; i += 2; continue; }
      if (c === PIPE) { cells.push(cur); cur = ''; i++; continue; }
      cur += s[i]; i++;
    }
    cells.push(cur);
    // drop empty leading/trailing cells from leading/trailing pipe
    if (cells.length && cells[0].trim() === '') cells.shift();
    if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
    if (!cells.length) return null;
    const aligns = [];
    for (const cell of cells) {
      const t = cell.trim();
      const left = t.startsWith(':');
      const right = t.endsWith(':');
      const core = t.replace(/^:/, '').replace(/:$/, '');
      if (!/^-+$/.test(core)) return null;
      aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
    }
    return aligns;
  }
  function splitTableRow(s) {
    const cells = [];
    let cur = '', i = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === BSLASH && i + 1 < s.length && (s[i + 1] === '|' || isPunctAscii(s.charCodeAt(i + 1)))) {
        if (s[i + 1] === '|') { cur += '|'; i += 2; continue; }
        cur += s[i] + s[i + 1]; i += 2; continue;
      }
      if (c === PIPE) { cells.push(cur); cur = ''; i++; continue; }
      cur += s[i]; i++;
    }
    cells.push(cur);
    if (cells.length && cells[0].trim() === '') cells.shift();
    if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
    return cells.map(x => x.trim());
  }

  // is the raw line at idx blank (spaces/tabs only)?
  function isLineBlank(idx) {
    if (idx < 0 || idx >= lines.length) return false;
    const nl = lines[idx];
    for (let i = 0; i < nl.length; i++) {
      const c = nl.charCodeAt(i);
      if (c !== SP && c !== TAB) return false;
    }
    return true;
  }

  // ================= main loop =================
  const nlines = lines.length;
  for (let li = 0; li < nlines; li++) {
    line = lines[li];
    pos = 0; col = 0; ptab = 0;
    const blank = isBlankLine();

    // ---- ultra-fast path: top-level paragraph continuation ----
    // A paragraph that is a direct child of the document has no
    // containers to match (phase 1 is a no-op, allMatched is always
    // true). A non-blank line with at most 3 leading spaces whose
    // first character cannot start any block is plain paragraph text:
    // append it directly, skipping phases 1-5. This is the most
    // common line in long documents.
    if (!blank && tip.t === 'paragraph' && tip.parent === doc) {
      let p0 = 0;
      while (p0 < line.length && line.charCodeAt(p0) === SP) p0++;
      if (p0 <= 3 && p0 < line.length && isPlainStart(line.charCodeAt(p0))) {
        // paragraph continuation: the line is kept verbatim (marked
        // keeps a paragraph's leading spaces: ' foo' -> '<p> foo</p>')
        addLine(tip, line);
        tip._lastLazy = false;
        continue;
      }
    }

    // ---- phase 1: match open containers ----
    let container = doc;
    let allMatched = true;
    while (true) {
      const last = container.lastChild;
      if (!last || !last.open) break;
      container = last;
      const t = container.t;
      if (t === 'blockquote') {
        const ind = countIndent();
        if (ind > 3) { allMatched = false; break; }
        const sp = pos, sc = col, st = ptab;
        advCols(ind);
        if (ch() === GT) {
          adv1();
          if (ch() === SP) adv1();
          else if (ch() === TAB) {
            // The single space/tab after '>' is consumed relative to the
            // enclosing list-item indents (doc-30: '>' at abs col 7 in a
            // list item of indent 7 -> tab at rel col 1, width 3, 2 left).
            let lis = 0;
            {
              let anc = container.parent;
              while (anc) {
                if (anc.t === 'item' && anc._contentIndent) {
                  let p = anc.parent, itemInBQ = false;
                  while (p) { if (p.t === 'blockquote') { itemInBQ = true; break; } p = p.parent; }
                  if (!itemInBQ) lis += anc._contentIndent;
                }
                anc = anc.parent;
              }
            }
            const relCol = col - lis;
            const w = 4 - (relCol % 4);
            if (w <= 1) { col += w; pos++; }
            else { ptab = w - 1; col += 1; }
          }
        } else {
          // no '>': restore cursor so a lazy continuation keeps its indent
          pos = sp; col = sc; ptab = st;
          allMatched = false; break;
        }
      } else if (t === 'item') {
        // blank line (raw, or blank after outer container prefixes
        // like '>' were consumed) inside item: matches, no advance
        let restBlank = blank;
        if (!restBlank) {
          restBlank = true;
          for (let q = pos; q < line.length; q++) {
            const cc = line.charCodeAt(q);
            if (cc !== SP && cc !== TAB) { restBlank = false; break; }
          }
        }
        if (restBlank) {
          // blank line inside item: matches, no advance
        } else {
          // The item's content column is measured from the enclosing
          // container's content origin on THIS line: need =
          // (content column on the first line) - (origin column on the
          // first line). An indented top-level list ('  - foo', content
          // at col 4) needs 4 columns from a tab; a list inside two
          // blockquotes needs only its relative indent (cm-004, cm-259).
          const oc = container._originCol !== undefined ? container._originCol : 0;
          const need = (container._contentCol !== undefined ? container._contentCol : col + container._contentIndent) - oc;
          if (need > 0 && countIndent() < need) { allMatched = false; break; }
          if (need > 0) advCols(need);
        }
      } else if (t === 'list') {
        // lists consume no input
      } else {
        break; // leaf block
      }
    }
    const matchedContainer = allMatched ? container : container.parent;

    // ---- phase 2: blank line handling ----
    // A line with NOTHING left after the container prefixes were consumed
    // (e.g. '>' or '> ' inside a blockquote) is a blank line too.
    // (A line that still has spaces left, e.g. '>  ', has content.)
    const blankAfter = (pos >= line.length && ptab === 0);
    // A TAB-only line inside a table is a table row with empty cells,
    // NOT a blank line ending the table (doc-02/26/33). A spaces-only or
    // completely empty line DOES end the table. Intercept before any blank
    // marking so the row is content, not a separator.
    if ((blank || blankAfter) && tip.t === 'table' && restOfLine().indexOf('\t') !== -1) {
      const cells = splitTableRow('');
      const hlen = tip._header.length;
      while (cells.length < hlen) cells.push('');
      if (cells.length > hlen) cells.length = hlen;
      tip._rows.push(cells);
      continue;
    }
    if (blank || blankAfter) {
      // Mark the blank on ALL currently-open blocks FIRST, before any
      // finalize: an item/list that ends at this blank line must record
      // it, otherwise a loose list is wrongly rendered tight.
      let n0 = tip;
      while (n0) { n0._lastLineBlank = true; n0 = n0.parent; }
    }
    if (blankAfter && !blank) {
      // close containers that did not match this line
      if (!allMatched) { finalizeUpTo(matchedContainer); tip = matchedContainer; }
    }
    if (blank || blankAfter) {
      // A blank line closes containers it does not match (e.g. a blockquote
      // with no '>' on this line).
      if (!allMatched && tip.t !== 'code_fenced' && tip.t !== 'code_indented') {
        finalizeUpTo(matchedContainer); tip = matchedContainer;
      }
      // A blank line outside the code block's containers closes the block.
      if ((tip.t === 'code_fenced' || tip.t === 'code_indented') && !allMatched) {
        finalizeUpTo(matchedContainer);
        tip = matchedContainer;
      }
      if (tip.t === 'code_fenced') {
        // fenced code keeps the line's spaces (after container prefixes).
        // A blank line here is code content, not a block separator, so it
        // must not mark the enclosing item/list as ending with a blank line
        // (that would wrongly make a tight list loose, cm-318).
        // A lazy blank line (no container prefix) in a fence inside a
        // blockquote still loses the enclosing list-item indent (doc-13:
        // '   ' in an item of indent 2 is 1 space of code, not 3).
        let blankStrip = 0;
        if (!allMatched && !tip._inBQ) {
          let anc = tip.parent, lis = 0, inBQ = false;
          while (anc) {
            if (anc.t === 'blockquote') inBQ = true;
            if (anc.t === 'item' && anc._contentIndent) {
              let p = anc.parent, itemInBQ = false;
              while (p) { if (p.t === 'blockquote') { itemInBQ = true; break; } p = p.parent; }
              if (!itemInBQ) lis += anc._contentIndent;
            }
            anc = anc.parent;
          }
          if (inBQ) blankStrip = tip._fenceIndent + lis;
        } else if (!tip._inBQ) {
          blankStrip = tip._fenceIndent;
        }
        if (blankStrip > 0) {
          // A whitespace-only line strips by CHARACTER count (a tab is
          // one character): '   ' with budget 2 -> ' '; a lone '\t'
          // with budget 2 -> '' (doc-13).
          let chars = 0, p = pos;
          while (p < line.length && chars < blankStrip) {
            const c = line.charCodeAt(p);
            if (c !== SP && c !== TAB) break;
            chars++; p++;
          }
          while (pos < p) {
            if (line.charCodeAt(pos) === TAB) { col += 4 - (col % 4); pos++; }
            else { col++; pos++; }
          }
        }
        addLine(tip, expandTabs(restOfLine(), col));
        continue;
      }
      if (tip.t === 'code_indented') {
        // indented code strips up to 4 columns of indent from the blank line
        const ind = countIndent();
        advCols(ind < 4 ? ind : 4);
        addLine(tip, expandTabs(restOfLine(), col));
        continue;
      }
      if (tip.t === 'html' && tip._htmlType !== 6 && tip._htmlType !== 7) {
        // types 1-5 end at their end marker, not at a blank line:
        // a blank line inside is part of the block.
        if (!allMatched) { finalizeUpTo(matchedContainer); tip = matchedContainer; }
        else {
          addLine(tip, restOfLine());
          continue;
        }
      }
      // mark blank on all open blocks
      let n = tip;
      // Also record the blank on the last direct child of the innermost
      // open item: a blank line after a (possibly already closed) child
      // block, before the next sibling block, makes the list loose.
      {
        let it = tip;
        while (it && it.t !== 'item') it = it.parent;
        if (it && it.children && it.children.length > 0) {
          it.children[it.children.length - 1]._lastLineBlank = true;
        }
      }
      while (n) { n._lastLineBlank = true; n = n.parent; }
      // An empty list item (no content yet) followed by a blank line is
      // closed: later indented lines do not continue it (cm-280).
      if (tip.t === 'item' && (!tip.children || tip.children.length === 0)) {
        finalize(tip); tip = tip.parent;
      }
      if (tip.t === 'paragraph') { finalize(tip); tip = tip.parent; }
      if (tip.t === 'table') { finalize(tip); tip = tip.parent; }
      if (tip.t === 'html' && (tip._htmlType === 6 || tip._htmlType === 7)) {
        tip._followedByBlank = true;
        finalize(tip); tip = tip.parent;
      }
      continue;
    }

    // ---- phase 3: finalize unmatched (paragraph deferred to phase 5) ----
    if (!allMatched) {
      // A fenced code block opened inline with a list-item marker does NOT
      // swallow lines that fail to match its containers: the line ends the
      // code block (doc-17). A standalone fenced code block DOES swallow
      // such lines as code content (doc-02) — but only once it already has
      // content: if the FIRST line after the fence fails to match, the block
      // closes empty (doc-17 toml fence).
      const swallow = tip.t === 'code_fenced' && tip._swallow && tip.strings && tip.strings.length > 0;
      if (tip.t !== 'paragraph' && !swallow) {
        finalizeUpTo(matchedContainer);
        tip = matchedContainer;
      }
      // if tip is a paragraph, phase 5 decides (interrupt vs lazy continuation)
    }

    // ---- phase 4: open containers / leaf blocks already open ----
    // If tip is a fenced code block, add line (unless it closes the fence)
    if (tip.t === 'code_fenced') {
      const ind = countIndent();
      if (ind <= 3) {
        const savePos = pos, saveCol = col, savePtab = ptab;
        advCols(ind);
        const f = checkFence();
        if (f && f.fchar === tip._fenceChar && f.flen >= tip._fenceLen) {
          // closing fence (rest of line must be spaces only)
          let p = pos + f.flen;
          let ok = true;
          while (p < line.length) {
            const c = line.charCodeAt(p);
            if (c !== SP && c !== TAB) { ok = false; break; }
            p++;
          }
          if (ok) {
            // The blank line immediately before the closing fence is not
            // content: drop one trailing empty string (cm-318).
            const s = tip.strings;
            if (s && s.length && s[s.length - 1] === '') s.pop();
            finalize(tip); tip = tip.parent; continue;
          }
        }
        pos = savePos; col = saveCol; ptab = savePtab;
      }
      // content line: strip up to fence indent (never inside a blockquote)
      const ind2 = countIndent();
      let strip = tip._inBQ ? 0 : Math.min(ind2, tip._fenceIndent);
      // Never partially consume a leading tab while stripping the fence
      // indent: if the line starts with a tab whose width exceeds the
      // remaining strip, leave the tab whole (doc-02: tab at col 4, fence
      // indent 2 -> full 4 spaces, not 2).
      if (pos < line.length && line.charCodeAt(pos) === TAB) {
        const w = 4 - (col % 4);
        if (strip < w) strip = 0;
      }
      // Top-level fence (col 0): the indent strip counts whitespace
      // CHARACTERS, not columns — a leading tab is one character and is
      // removed whole when within the fence-indent budget (doc-17: fence
      // indent 3, content '\t' -> 0 spaces; '   \t' -> tab preserved).
      // (colBeforeStrip must be the column before ANY stripping.)
      const colBeforeStrip0 = col;
      if (col === 0 && !tip._inBQ && tip._fenceIndent > 0) {
        let chars = 0, p = pos;
        while (p < line.length && chars < tip._fenceIndent) {
          const c = line.charCodeAt(p);
          if (c !== SP && c !== TAB) break;
          chars++; p++;
        }
        // advance past exactly those characters (a tab counts as one)
        while (pos < p) {
          if (line.charCodeAt(pos) === TAB) { col += 4 - (col % 4); pos++; }
          else { col++; pos++; }
        }
        strip = 0; // already stripped by character count
      }
      // The tab-expansion column is the column after container matching
      // but BEFORE the fence indent is stripped: top level -> 0 (a leading
      // tab is preserved, doc-15), list item -> content indent (doc-02).
      const colBeforeStrip = colBeforeStrip0;
      advCols(strip);
      // Inside a blockquote with a zero-indent fence the reference counts
      // the content as starting at column 2 regardless of blockquote depth
      // (a leading tab always becomes 2 spaces there). With a non-zero
      // fence indent the absolute column applies (doc-26: indent 2, tab at
      // col 4 -> 4 spaces).
      // Tab-expansion column: top level keeps the pre-strip column
      // (0 -> a leading tab is preserved, doc-15). Inside a blockquote the
      // absolute column applies, minus enclosing list-item indents
      // (doc-02: list+blockquote, col 6 - 2 = 4); a zero-indent fence in
      // a blockquote always counts a leading tab as 2 spaces (doc-26).
      // Tab-expansion column: top level keeps the pre-strip column
      // (0 -> a leading tab is preserved, doc-15). Inside a blockquote the
      // absolute column applies; a zero-indent fence there counts a leading
      // tab as 2 spaces only when no list item intervenes (doc-26), and
      // the indent of a top-level list item is subtracted (doc-02
      // isolated: col 6 - 2 = 4). A list item inside a blockquote does
      // not shift the tab stop.
      // Tab-expansion column: top level keeps the pre-strip column
      // (0 -> a leading tab is preserved, doc-15). Inside a blockquote
      // the absolute column applies, minus top-level list-item indents
      // (doc-02 isolated: col 6 - 2 = 4). Exception: a zero-indent fence
      // in a blockquote with NO list item counts a leading tab as 2
      // spaces regardless of depth (doc-05 `> >`, doc-26); when a list
      // item intervenes the absolute column applies (doc-02).
      let inBlockquote = false, listIndentSum = 0, hasItem = false;
      {
        let anc = tip.parent;
        while (anc) {
          if (anc.t === 'blockquote') inBlockquote = true;
          if (anc.t === 'item') {
            hasItem = true;
            if (anc._contentIndent) {
              let p = anc.parent, itemInBQ = false;
              while (p) { if (p.t === 'blockquote') { itemInBQ = true; break; } p = p.parent; }
              if (!itemInBQ) listIndentSum += anc._contentIndent;
            }
          }
          anc = anc.parent;
        }
      }
      let tabCol;
      if (inBlockquote) {
        tabCol = (tip._fenceIndent === 0 && !hasItem) ? 2 : col - listIndentSum;
      } else {
        tabCol = colBeforeStrip;
      }
      addLine(tip, expandTabs(restOfLine(), tabCol));
      continue;
    }
    if (tip.t === 'code_indented') {
      // indented code continues while indent >= 4 (or blank, handled above)
      const ind = countIndent();
      if (ind >= 4) {
        advCols(4);
        // Top level: a leading tab is preserved (col 0). Inside a
        // blockquote/list the absolute column expands it (doc-06).
        let inCont = false;
        { let anc = tip.parent; while (anc) { if (anc.t === 'blockquote' || anc.t === 'item') { inCont = true; break; } anc = anc.parent; } }
        addLine(tip, expandTabs(restOfLine(), inCont ? col : 0));
        continue;
      }
      finalize(tip); tip = tip.parent;
      // fall through to block-start checks
    }
    if (tip.t === 'html') {
      const ht = tip._htmlType;
      if (ht === 6 || ht === 7) {
        // ends at blank line only (handled above); keep adding lines
        addLine(tip, restOfLine());
        continue;
      }
      addLine(tip, restOfLine());
      if (htmlBlockEnds(ht, restOfLine())) {
        // types 1-5: strip the trailing newline only when the next line is
        // completely empty; a whitespace-only line does not strip it (doc-15).
        if (lines[li + 1] === '') tip._followedByBlank = true;
        finalize(tip); tip = tip.parent;
      }
      continue;
    }

    // ---- phase 5: block-start checks (loop: opening a container re-runs) ----
    // (interrupt/closeList are defined once per line, not per iteration.)
    const interrupt = () => {
      if (tip.t === 'paragraph') {
        finalize(tip); tip = tip.parent;
        if (!allMatched) { finalizeUpTo(matchedContainer); tip = matchedContainer; }
      }
      closeListIfNotContinued();
    };
    const closeListIfNotContinued = () => {
      if (tip.t === 'list') {
        if (checkHr()) { finalize(tip); tip = tip.parent; return; }
        const li0 = listInfoAtCursor();
        let cont = false;
        if (li0 && tip._listData.ordered === li0.ordered && tip._listData.bullet === li0.bullet) cont = true;
        if (!cont) { finalize(tip); tip = tip.parent; }
      }
    };
    for (;;) {
      const savePos = pos, saveCol = col, savePtab = ptab;
      const ind5 = countIndent();
      const atPara = tip.t === 'paragraph';
      // --- table rows ---
      if (tip.t === 'table') {
        if (ind5 <= 3) {
          advCols(ind5);
          const c5 = ch();
          let startsBlock = false;
          if (c5 === GT) startsBlock = true;
          else if (c5 === HASH && checkATX() > 0) startsBlock = true;
          else if ((c5 === TICK || c5 === TILDE) && checkFence()) startsBlock = true;
          else if (c5 === LT && htmlBlockType() > 0) startsBlock = true;
          else if (checkHr()) startsBlock = true;
          else if (listInfoAtCursor()) startsBlock = true;
          if (!startsBlock) {
            const cells = splitTableRow(restOfLine());
            const hlen = tip._header.length;
            while (cells.length < hlen) cells.push('');
            if (cells.length > hlen) cells.length = hlen;
            tip._rows.push(cells);
            break;
          }
          finalize(tip); tip = tip.parent;
          continue; // re-run block-start checks for the new block
        }
        finalize(tip); tip = tip.parent; // indented code ends the table
      }
      // A list whose item failed to match is closed unless this line
      // starts a new item for the same list (same bullet / ordered delim).
      if (tip.t === 'list') {
        const li0 = listInfoAtCursor();
        let cont = false;
        if (li0 && tip._listData.ordered === li0.ordered && tip._listData.bullet === li0.bullet) cont = true;
        if (!cont) { finalize(tip); tip = tip.parent; }
      }
      if (ind5 <= 3) {
        advCols(ind5);
        const c5 = ch();
        // --- FAST PATH: plain paragraph continuation ---
        // A matched line whose first character cannot start any block is
        // plain paragraph text: skip every block-start check and append
        // it directly. This is the common line in long documents.
        // (allMatched: no lazy-continuation quirks apply; isPlainStart
        // excludes setext/table/hr/list/ATX/fence/HTML/blockquote starts;
        // ind<=3 excludes indented code.)
        if (atPara && allMatched && isPlainStart(c5)) {
          // plain paragraph text: keep the line verbatim (leading spaces
          // included); only the container prefixes were consumed
          pos = savePos; col = saveCol; ptab = savePtab;
          addLine(tip, expandTabs(restOfLine(), col));
          tip._lastLazy = false;
          break;
        }
        // --- blockquote ---
        if (c5 === GT) {
          interrupt();
          tip = addChild(tip, newNode('blockquote'));
          adv1();
          if (ch() === SP || ch() === TAB) adv1();
          continue;
        }
        // --- ATX heading ---
        if (c5 === HASH) {
          const lvl = checkATX();
          if (lvl > 0) {
            interrupt();
            const h = addChild(tip, newNode('heading'));
            h._level = lvl;
            advCols(lvl);
            skipSpaces();
            let content = restOfLine();
            content = content.replace(/[ \t]+$/, '');
            if (/^#+$/.test(content)) content = '';
            else content = content.replace(/([ \t])#+$/, '$1');
            content = content.replace(/[ \t]+$/, '');
            h._text = content;
            finalize(h);
            break;
          }
        }
        // --- fenced code ---
        if (c5 === TICK || c5 === TILDE) {
          const f = checkFence();
          if (f) {
            let okInfo = true;
            if (f.fchar === TICK) {
              let p = pos + f.flen;
              while (p < line.length) { if (line.charCodeAt(p) === TICK) { okInfo = false; break; } p++; }
            }
            if (okInfo) {
              interrupt();
              // A fence that is the first block of a list item is opened
              // inline with the marker: it does NOT swallow lines that fail
              // to match its containers (doc-17). A fence opened as a
              // standalone block (after a paragraph, at top level, or in a
              // blockquote) DOES swallow such lines as code content (doc-02).
              const parent = tip;
              // Only a fence that is a standalone block inside a list item
              // swallows lines failing container match (doc-02). A fence
              // that is the first block of an item (doc-17), or inside a
              // blockquote / at top level, closes on mismatch.
              const isFirstInItem = parent.t === 'item' && (!parent.children || parent.children.length === 0);
              const code = addChild(tip, newNode('code_fenced'));
              code._swallow = parent.t === 'item' && !isFirstInItem;
              code._fenceChar = f.fchar;
              code._fenceLen = f.flen;
              code._fenceIndent = ind5;
              // A tilde fence never strips its indent from content lines
              // (doc-22: '~~~ts' keeps 3 spaces; top-level '  ~~~ts' also
              // keeps them). A backtick fence strips normally (doc-15).
              code._inBQ = f.fchar === TILDE;
              let infoRaw = line.slice(pos + f.flen);
              let q = 0;
              while (q < infoRaw.length && (infoRaw.charCodeAt(q) === SP || infoRaw.charCodeAt(q) === TAB)) q++;
              infoRaw = infoRaw.slice(q);
              let e = 0;
              while (e < infoRaw.length && infoRaw.charCodeAt(e) !== SP && infoRaw.charCodeAt(e) !== TAB) e++;
              code._info = unescapeBackslashes(infoRaw.slice(0, e));
              tip = code;
              break;
            }
          }
        }
        // --- HTML block ---
        if (c5 === LT) {
          const ht = htmlBlockType();
          if (ht > 0 && !(atPara && ht === 7)) {
            interrupt();
            const hb = addChild(tip, newNode('html'));
            hb._htmlType = ht;
            // first line keeps its leading spaces (up to 3)
            pos = savePos; col = saveCol; ptab = savePtab;
            addLine(hb, restOfLine());
            tip = hb;
            if (ht !== 6 && ht !== 7 && htmlBlockEnds(ht, restOfLine())) {
              if (lines[li + 1] === '') hb._followedByBlank = true;
              finalize(hb); tip = hb.parent;
            }
            break;
          }
        }

        // --- setext heading / table header ---
        // Only when the line matched every container of the paragraph:
        // a setext underline (or table delimiter) outside the paragraph's
        // containers is not one ('> Foo\n---' -> <hr>, cm-092/cm-234).
        if (atPara && allMatched) {
          const st = checkSetext();
          if (st > 0) {
            const text = tip.strings.join('\n');
            const rest = stripRefDefs(text, refs);
            if (rest.trim() === '') {
              // the paragraph holds only link reference definitions: there
              // is no heading content, so the underline line is ordinary
              // paragraph text (cm-216: '[foo]: /url\n===\n[foo]' stays a
              // paragraph)
              pos = savePos; col = saveCol; ptab = savePtab;
              advCols(tip._pli || 0);
              addLine(tip, expandTabs(restOfLine(), col));
              tip._lastLazy = false;
              break;
            }
            // convert the paragraph node itself into the heading
            tip.open = false;
            tip._isSetext = true;
            tip._headingLevel = st;
            // heading text: ref defs stripped, leading/trailing
            // whitespace trimmed (the paragraph itself keeps its spaces)
            tip._headingText = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            tip._text = tip._headingText;
            finalize(tip); tip = tip.parent;
            break;
          }
          // table header: this paragraph's text is a single line, and this
          // line is a delimiter row
          if (tip.strings.length === 1 && tip._lastLazy === false) {
            const aligns = checkTableDelim();
            if (aligns) {
              const header = splitTableRow(tip.strings[0]);
              // the delimiter row must have the same number of cells as
              // the header row (gfm-203: '| --- |' under a 2-cell header
              // is not a table); otherwise fall through to paragraph.
              if (header.length === aligns.length) {
                const hlen = aligns.length;
                while (header.length < hlen) header.push('');
                if (header.length > hlen) header.length = hlen;
                // replace the paragraph node with the table node
                const parent = tip.parent;
                parent.children.pop();
                parent.lastChild = parent.children.length ? parent.children[parent.children.length - 1] : null;
                const tbl = addChild(parent, newNode('table'));
                tbl._header = header;
                tbl._aligns = aligns;
                tbl._rows = [];
                tip.open = false;
                tip = tbl;
                break;
              }
            }
          }
        }
        // --- thematic break ---
        // Checked before list items: a line like ' - - -' is an <hr>,
        // not a nested list (cm-051). A '-' line after a paragraph was
        // already handled as setext above.
        if (checkHr()) {
          interrupt();
          const hr = addChild(tip, newNode('hr'));
          finalize(hr);
          break;
        }
        // --- list ---
        // (A list marker cannot interrupt a paragraph unless the item is
        // empty — cm-300.) A list DOES interrupt a paragraph when it is
        // a bullet list, or an ordered list starting with 1 (cm-303,
        // cm-305); an ordered list starting with 14 does not (cm-304).
        {
          const li = listInfoAtCursor();
          if (li) {
            // Can this marker interrupt a paragraph? If the paragraph is
            // inside a list item, any marker ends the item (new item /
            // new list), so it may interrupt. At top level, a bare marker
            // never interrupts a paragraph, and an ordered list interrupts
            // only when it starts with 1 (cm-303/304/305/315).
            let canInterrupt = true;
            if (atPara) {
              let inItem = false;
              let anc = tip.parent;
              while (anc) {
                if (anc.t === 'item') { inItem = true; break; }
                anc = anc.parent;
              }
              if (!inItem) {
                if (!li.hasContent) canInterrupt = false;
                if (li.ordered && li.start !== 1) canInterrupt = false;
              }
            }
            if (canInterrupt) {
              interrupt();
              let list = tip.t === 'list' && tip._listData && tip._listData.ordered === li.ordered && tip._listData.bullet === li.bullet ? tip : null;
              if (!list) {
                list = addChild(tip, newNode('list'));
                list._listData = { ordered: li.ordered, bullet: li.bullet, start: li.start };
                list._tight = true;
                tip = list;
              }
              // For a list item after a blank line, check whether the
              // marker should end the previous item's paragraph (it does
              // when the marker is at the SAME indent as the previous
              // item's marker, i.e. this is a sibling item).
              const item = addChild(tip, newNode('item'));
              item._contentIndent = li.width + li.padCols;
              if (li.padCols >= 5 || !li.hasContent) item._contentIndent = li.width + 1;
              // advance past the marker, then only up to the content
              // indent: the remaining whitespace belongs to the content
              // (cm-007: '-\t\tfoo' is an indented code block '  foo')
              const markerPos = pos;
              pos = markerPos + li.width;
              col += li.width;
              advCols(item._contentIndent - li.width);
              item._markerCol = col - item._contentIndent;
              // absolute column where this item's content starts, and
              // the enclosing container's content origin on this line
              // (used by phase 1 to compute the needed indent). Use the
              // INTENDED content column (marker col + content indent):
              // for a bare marker at the end of the line, advCols above
              // is clamped by the line end, so `col` is too small
              // (cm-278: '-\\n  foo' needs 2, not 1).
              item._contentCol = li.hasContent ? col : saveCol + item._contentIndent;
              item._originCol = saveCol;
              if (li.hasContent) {
                tip = item;
                // continue the phase-5 loop: the item's content is
                // parsed as a new block on this same line
                continue;
              }
              // empty item: item is a leaf; set tip to it so the loop
              // breaks (the item stays open for following lines)
              tip = item;
              break;
            }
            // cannot interrupt: fall through to paragraph (cursor unchanged)
          }
        }
        // --- indented code ---
        if (ind5 >= 4 && !atPara) {
          // (only when not a paragraph: indented code cannot interrupt a paragraph)
          interrupt();
          const code = addChild(tip, newNode('code_indented'));
          advCols(4);
          // Top level: a leading tab is preserved (col 0). Inside a
          // blockquote/list the absolute column expands it (doc-06).
          let inCont = false;
          { let anc = code.parent; while (anc) { if (anc.t === 'blockquote' || anc.t === 'item') { inCont = true; break; } anc = anc.parent; } }
          addLine(code, expandTabs(restOfLine(), inCont ? col : 0));
          tip = code;
          break;
        }
        // --- paragraph ---
        if (atPara) {
          // paragraph continuation. A lazy line (failed to match the
          // containers) has an indent of 4+ stripped by 4 columns, as if
          // it were indented code; smaller indents are kept verbatim.
          pos = savePos; col = saveCol; ptab = savePtab;
          if (!allMatched && countIndent() >= 4) advCols(4);
          let pcontent = expandTabs(restOfLine(), col);
          if (!allMatched && tip._lastLazy) {
            // a lazy setext-underline line following another lazy line
            // gains 4 spaces (marked quirk, cm-093)
            const trimmed = pcontent.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            if (/^=+$/.test(trimmed)) pcontent = '    ' + pcontent;
          }
          addLine(tip, pcontent);
          tip._lastLazy = !allMatched;
          break;
        }
        // new paragraph: content starts after the container prefixes,
        // keeping its leading spaces (marked keeps them:
        // ' foo' -> '<p> foo</p>', '  foo' -> '<p>  foo</p>')
        pos = savePos; col = saveCol; ptab = savePtab;
        // A line with nothing but whitespace left after the container
        // prefixes (e.g. '>  ' inside a blockquote) does NOT start a
        // paragraph (cm-240); it only continues one that is already open.
        if (restOfLine().trim() === '') break;
        const p = addChild(tip, newNode('paragraph'));
        p._pli = 0;
        p._lastLazy = false;
        addLine(p, expandTabs(restOfLine(), col));
        tip = p;
        break;
      }
      // ind > 3: indented code (when not a paragraph) or paragraph continuation
      if (atPara) {
        // paragraph continuation (lazy or matched). A lazy line with an
        // indent of 4+ is stripped by 4 columns; a lazy setext-underline
        // line following another lazy line gains 4 spaces (cm-093).
        pos = savePos; col = saveCol; ptab = savePtab;
        if (!allMatched && countIndent() >= 4) advCols(4);
        let pcontent = expandTabs(restOfLine(), col);
        if (!allMatched && tip._lastLazy) {
          const trimmed = pcontent.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          if (/^=+$/.test(trimmed)) pcontent = '    ' + pcontent;
        }
        addLine(tip, pcontent);
        tip._lastLazy = !allMatched;
        break;
      }
      // indented code block
      const code = addChild(tip, newNode('code_indented'));
      advCols(4);
      let inCont = false;
      { let anc = code.parent; while (anc) { if (anc.t === 'blockquote' || anc.t === 'item') { inCont = true; break; } anc = anc.parent; } }
      addLine(code, expandTabs(restOfLine(), inCont ? col : 0));
      tip = code;
      break;
    }
  }
  // finalize all open blocks
  while (tip) { finalize(tip); tip = tip.parent; }
  // A paragraph that became a setext heading must not render as a paragraph;
  // and a paragraph whose text was only link reference definitions must be
  // dropped (its _empty flag). finalize() already set _empty for those.
  return doc;
}

// ---------------------------------------------------------------- inline

// Escape text (marked's escapeText). Rules, verified against marked 18.1.3:
// - a numeric character reference (&#123; / &#x1F;) decodes to the character
//   (0, >0x10FFFF or a surrogate becomes U+FFFD); the decoded character is
//   then HTML-escaped when it is one of & < > " '.
// - a named reference &name; with name = [A-Za-z0-9]+ passes through
//   UNCHANGED (marked does not validate the name against any table:
//   &foo; stays &foo;, &Dcaron; stays &Dcaron;).
// - any other '&' becomes &amp;.
// - < > " ' are escaped; everything else passes through.
function escapeText(s, out, start, end, lineStart) {
  if (start === undefined) { start = 0; end = s.length; }
  let i = start, j = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === AMP) {
      if (i + 1 < end && s.charCodeAt(i + 1) === HASH) {
        const dec = decodeNumericRef(s, i);
        if (dec) {
          if (j < i) out.push(s.slice(j, i));
          const cp = dec[0];
          if (cp === AMP) out.push('&amp;');
          else if (cp === LT) out.push('&lt;');
          else if (cp === GT) out.push('&gt;');
          else if (cp === QUOT) out.push('&quot;');
          else if (cp === APOS) out.push('&#39;');
          else out.push(String.fromCodePoint(cp));
          i = dec[1]; j = i; continue;
        }
      } else {
        // named reference: &[A-Za-z0-9]+; passes through unchanged
        let k = i + 1;
        while (k < end) {
          const cc = s.charCodeAt(k);
          if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57)) k++;
          else break;
        }
        if (k > i + 1 && k < end && s[k] === ';') {
          // valid named reference: emit as-is (skip it, do not escape)
          i = k + 1; continue;
        }
      }
      if (j < i) out.push(s.slice(j, i));
      out.push('&amp;');
      i++; j = i;
    } else if (c === LT) {
      if (j < i) out.push(s.slice(j, i));
      out.push('&lt;'); i++; j = i;
    } else if (c === GT) {
      if (j < i) out.push(s.slice(j, i));
      out.push('&gt;'); i++; j = i;
    } else if (c === QUOT) {
      if (j < i) out.push(s.slice(j, i));
      out.push('&quot;'); i++; j = i;
    } else if (c === APOS) {
      if (j < i) out.push(s.slice(j, i));
      out.push('&#39;'); i++; j = i;
    } else i++;
  }
  if (j < end) out.push(s.slice(j, end));
}

// Escape code span content: & < > " ' only (no entity decoding).
function escapeCode(s, out, start, end) {
  let i = start, j = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === AMP) { if (j < i) out.push(s.slice(j, i)); out.push('&amp;'); j = i + 1; }
    else if (c === LT) { if (j < i) out.push(s.slice(j, i)); out.push('&lt;'); j = i + 1; }
    else if (c === GT) { if (j < i) out.push(s.slice(j, i)); out.push('&gt;'); j = i + 1; }
    else if (c === QUOT) { if (j < i) out.push(s.slice(j, i)); out.push('&quot;'); j = i + 1; }
    else if (c === APOS) { if (j < i) out.push(s.slice(j, i)); out.push('&#39;'); j = i + 1; }
    i++;
  }
  if (j < end) out.push(s.slice(j, end));
}

// Flanking: is the run of delimiter chars at [start,end) in s
// Flanking: is the run of delimiter chars at [start,end) in s
// left-flanking / right-flanking (CommonMark rules)? Punctuation here is
// ASCII only: marked treats a Unicode punctuation mark next to a delimiter
// run as an ordinary character for flanking (a closing '*' before '«'
// is still left-flanking). At the text boundaries the missing neighbour
// counts as whitespace ('\n').
function flanking(s, start, end) {
  const prev = start > 0 ? s[start - 1] : '\n';
  const next = end < s.length ? s[end] : '\n';
  const prevC = prev.charCodeAt(0), nextC = next.charCodeAt(0);
  const prevWs = isWhitespace(prevC), nextWs = isWhitespace(nextC);
  const prevPunct = isPunct(prevC), nextPunct = isPunct(nextC);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return { left, right };
}

// Next inline special: backslash, backtick, &, <, *, _, !, [, ], ~.
// One C++ regex scan; used to find plain-text runs quickly.
const RE_NEXT_SPECIAL = /[\\`&<*_!\[\]~]/g;

// True if `label` contains a code span whose content includes a
// backtick. Such a label cannot form a link: it blocks when text
// follows the code span ([a ``x`y`` b](u) does not form, [a ``x`y``](u)
// does), or when the span sits inside an underscore emphasis
// (_..._): doc-16 ([at _node `` a ` b ``_](u)) and doc-18
// ([empty test `` a ` b `` output][all-40]).
function labelHasBadBacktick(label) {
  let i = 0;
  const n = label.length;
  while (i < n) {
    const c = label.charCodeAt(i);
    if (c === 92 && i + 1 < n) { i += 2; continue; } // backslash escape
    if (c !== 96) { i++; continue; } // not a backtick
    let run = 0;
    while (i + run < n && label.charCodeAt(i + run) === 96) run++;
    // find a matching run of the same length
    let j = i + run, found = -1;
    while (j < n) {
      if (label.charCodeAt(j) === 96) {
        let r2 = 0;
        while (j + r2 < n && label.charCodeAt(j + r2) === 96) r2++;
        if (r2 === run) { found = j; break; }
        j += r2;
      } else j++;
    }
    if (found === -1) { i += run; continue; } // unmatched run: does not block
    const content = label.slice(i + run, found);
    if (content.indexOf('`') !== -1) {
      // blocks when text follows the code span
      if (found + run < n) return true;
      // inside an underscore emphasis? an unescaped '_' before the span
      // and an unescaped '_' after it.
      let hasOpen = false;
      for (let k = i - 1; k >= 0; k--) {
        const ch = label.charCodeAt(k);
        if (ch === 92) { k--; continue; }
        if (ch === 95) { hasOpen = true; break; }
        if (ch === 91 || ch === 93) break;
      }
      let hasClose = false;
      for (let k = found + run; k < n; k++) {
        const ch = label.charCodeAt(k);
        if (ch === 92) { k++; continue; }
        if (ch === 95) { hasClose = true; break; }
        if (ch === 91 || ch === 93) break;
      }
      if (hasOpen && hasClose) return true;
    }
    i = found + run;
  }
  return false;
}

function parseInline(text, refs, inBracket) {
  // inBracket: true when parsing a link/image label (inside '[...]'):
  // an autolink inside a label stops at ']' (it closes the label);
  // outside a label a ']' after ')' is swallowed into the URL (doc-08).
  const _hasActiveBracket = !!inBracket;
  const nodes = [];
  const delims = []; // emphasis/strikethrough delimiter runs, resolved after the scan
  // label ranges whose link was blocked by a bad backtick: '_' delimiters
  // inside them must stay literal (doc-16: _node ... _ does not form <em>)
  const blockedRanges = [];
  const n = text.length;
  let i = 0;
  let lastNode = null;
  const pushText = (t) => {
    if (t === '') return;
    // Never merge into a text node that ends with a bare '&': the next
    // text could complete a false entity (e.g. decoded '&' + 'amp;'
    // must stay two nodes, else escapeText would pass '&amp;' through).
    if (lastNode && lastNode.t === 'text' && !lastNode.text.endsWith('&')) { lastNode.text += t; return; }
    const nd = { t: 'text', text: t };
    nodes.push(nd); lastNode = nd;
  };
  const pushNode = (nd) => { nodes.push(nd); lastNode = nd; };
  // Inside a link's text, EXTENDED autolinks (www., scheme://, email)
  // are plain text (links cannot nest), but ANGLE-BRACKET autolinks
  // (<...>) stay links: convert only autolink nodes WITHOUT the angle
  // flag back to a text node with its display text, recursing into
  // link/em/strong/del children (doc-06 vs doc-03/08/09/10/11).
  const stripAutolinks = (nds) => {
    for (let k = 0; k < nds.length; k++) {
      const nd = nds[k];
      if (nd.t === 'link' && nd.autolink && !nd.angle) {
        nds[k] = { t: 'text', text: nd.label };
      } else if (nd.children) {
        stripAutolinks(nd.children);
      }
    }
  };
  // Push a plain-text segment, processing hard breaks inside it (2+
  // spaces before a newline -> <br>, stripping the next line's leading
  // spaces/tabs). Used for the text before an autolink AND for the tail
  // of a plain run: the text before an autolink must get the same
  // treatment, else a hard break before a URL on the next line is lost
  // (doc-04/05/06).
  const pushSegment = (seg) => {
    let k = 0;
    while (k < seg.length) {
      const nl = seg.indexOf('\n', k);
      if (nl === -1) { pushText(seg.slice(k)); break; }
      let sp = 0, q = nl - 1;
      while (q >= k && seg[q] === ' ') { sp++; q--; }
      if (sp >= 2) {
        if (q + 1 > k) pushText(seg.slice(k, q + 1));
        pushNode({ t: 'br' });
        k = nl + 1;
        while (k < seg.length && (seg[k] === ' ' || seg[k] === '\t')) k++;
      } else {
        pushText(seg.slice(k, nl + 1));
        k = nl + 1;
      }
    }
  };

  // --- helpers (closed over text/refs/nodes) ---
  function parseInlineLink(i0) {
    // i0 at '[' (or '![' handled by caller). Returns node or null.
    let j = i0 + 1;
    let label = '';
    let depth = 0;
    let hasNested = false;
    while (j < n) {
      const c = text[j];
      if (c === '\\' && j + 1 < n && isPunctAscii(text.charCodeAt(j + 1))) { label += text[j] + text[j + 1]; j += 2; continue; }
      if (c === '<') {
        // an autolink or HTML tag inside the label swallows a ']' inside
        // it (cm-524: <bar attr="](baz)">; cm-526: <https://...?search=]
        // (uri)>): skip past its closing '>' so the ']' does not close
        // the label. If it is neither, '<' is an ordinary label char.
        const tagRes = deautolink(j);
        if (tagRes) {
          label += text.slice(j, tagRes.end);
          j = tagRes.end;
          continue;
        }
        label += c; j++; continue;
      }
      // nested brackets are KEPT in the label so the label can be
      // re-parsed inline (an image inside a link label: doc-01)
      if (c === '[') { depth++; hasNested = true; label += c; j++; continue; }
      if (c === ']') {
        if (depth === 0) break;
        depth--; label += c; j++; continue;
      }
      if (c === '`') {
        // a backtick inside a link label: the label may contain a code
        // span; find its close to skip it (unclosed backtick is literal)
        let k = j, cnt = 0;
        while (k < n && text[k] === '`') { cnt++; k++; }
        let e = k;
        let closed = false;
        while (e < n) {
          if (text[e] === '`') {
            let k2 = e, cnt2 = 0;
            while (k2 < n && text[k2] === '`') { cnt2++; k2++; }
            if (cnt2 === cnt) { closed = true; e = k2; break; }
            e = k2; continue;
          }
          e++;
        }
        if (closed) { label += text.slice(j, e); j = e; continue; }
        label += c; j++; continue;
      }
      label += c; j++;
    }
    if (j >= n) return null;
    const labelEnd = j; // position of ']'
    // inline link: '(' ... ')'. If it fails to parse (e.g. a bare dest
    // with a space: '[foo](not a link)'), fall through to the shortcut
    // reference below instead of returning null (cm-568: '[foo]' then
    // resolves against '[foo]: /url1', leaving '(not a link)' literal).
    if (j + 1 < n && text[j + 1] === '(') {
      let k = j + 2;
      while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
      let dest = null, end = k, title = null, inlineOk = k < n;
      if (inlineOk && text[k] === '<') {
        let e = k + 1;
        while (e < n && text[e] !== '>' && text[e] !== '\n') {
          if (text[e] === '\\' && e + 1 < n && isPunctAscii(text.charCodeAt(e + 1))) { e += 2; continue; }
          e++;
        }
        if (e >= n || text[e] !== '>') inlineOk = false;
        else { dest = text.slice(k + 1, e); end = e + 1; }
      } else if (inlineOk) {
        let e = k, depth2 = 0;
        while (e < n) {
          const c = text[e];
          if (c === ' ' || c === '\t' || c === '\n') break;
          if (c === '\\' && e + 1 < n && isPunctAscii(text.charCodeAt(e + 1))) { e += 2; continue; }
          if (c === '(') { depth2++; e++; continue; }
          if (c === ')') {
            if (depth2 === 0) break;
            depth2--; e++; continue;
          }
          e++;
        }
        if (e === k) { /* empty destination is valid: [link]() -> href="" */ }
        dest = text.slice(k, e);
        end = e;
      }
      if (inlineOk) {
        // optional title
        let t = end;
        while (t < n && (text[t] === ' ' || text[t] === '\t' || text[t] === '\n')) t++;
        if (t < n && (text[t] === '"' || text[t] === "'" || text[t] === '(')) {
          const q = text[t];
          const close = q === '(' ? ')' : q;
          let e = t + 1, okT = true;
          while (e < n && text[e] !== close) {
            if (text[e] === '\\' && e + 1 < n && isPunctAscii(text.charCodeAt(e + 1))) { e += 2; continue; }
            if (q === '(' && text[e] === '(') { okT = false; break; }
            e++;
          }
          if (okT && e < n) {
            title = text.slice(t + 1, e);
            end = e + 1;
            // after title: only spaces/tabs/newlines then ')'
            let u = end;
            while (u < n && (text[u] === ' ' || text[u] === '\t' || text[u] === '\n')) u++;
            if (u >= n || text[u] !== ')') inlineOk = false;
            else end = u + 1;
          } else inlineOk = false;
        } else {
          // after dest: only spaces/tabs/newlines then ')'
          let u = end;
          while (u < n && (text[u] === ' ' || text[u] === '\t' || text[u] === '\n')) u++;
          if (u >= n || text[u] !== ')') inlineOk = false;
          else end = u + 1;
        }
      }
      if (inlineOk) {
        return { node: { t: 'link', dest: unescapeBackslashes(dest), title: title == null ? null : unescapeBackslashes(title), label, labelEnd, hasNested }, end };
      }
    }
    // reference link: [label][ref] or [label][] or [label]
    if (j + 1 < n && text[j + 1] === '[') {
      let k = j + 2, ref = '';
      let depth3 = 0;
      while (k < n && text[k] !== ']') {
        if (text[k] === '[') { depth3++; }
        if (text[k] === ']' && depth3 > 0) { depth3--; }
        ref += text[k]; k++;
      }
      if (k >= n) return null;
      const key = ref === '' ? normalizeLabel(label) : normalizeLabel(ref);
      const def = refs.get(key);
      if (!def) return null;
      return { node: { t: 'link', dest: def.dest, title: def.title, label, labelEnd, hasNested }, end: k + 1 };
    }
    // shortcut reference: [label]
    {
      const key = normalizeLabel(label);
      const def = refs.get(key);
      if (!def) return null;
      return { node: { t: 'link', dest: def.dest, title: def.title, label, labelEnd, hasNested }, end: j + 1 };
    }
  }
  // Is there an unmatched '[' or ']' (or unclosed backtick) in the label
  // text? Used to decide whether a shortcut ref link may resolve.
  function labelHasUnmatchedRun2(s2) {
    // returns true when the label contains an unmatched '[' (depth>0 at end)
    // or an unmatched ']' (a ']' with no matching '[' before it)
    let depth = 0;
    for (let k = 0; k < s2.length; k++) {
      const c = s2[k];
      if (c === '\\' && k + 1 < s2.length && isPunctAscii(s2.charCodeAt(k + 1))) { k++; continue; }
      if (c === '[') depth++;
      else if (c === ']') {
        if (depth === 0) return true;
        depth--;
      }
    }
    return depth > 0;
  }
  function labelHasUnmatchedRun1(s2) {
    // same as Run2 but also treats an unclosed backtick as unmatched
    let depth = 0;
    for (let k = 0; k < s2.length; k++) {
      const c = s2[k];
      if (c === '\\' && k + 1 < s2.length && isPunctAscii(s2.charCodeAt(k + 1))) { k++; continue; }
      if (c === '`') {
        let cnt = 0, q = k;
        while (q < s2.length && s2[q] === '`') { cnt++; q++; }
        let e = q, closed = false;
        while (e < s2.length) {
          if (s2[e] === '`') {
            let k2 = e, cnt2 = 0;
            while (k2 < s2.length && s2[k2] === '`') { cnt2++; k2++; }
            if (cnt2 === cnt) { closed = true; break; }
            e = k2; continue;
          }
          e++;
        }
        if (!closed) return true;
        k = q - 1; continue;
      }
      if (c === '[') depth++;
      else if (c === ']') {
        if (depth === 0) return true;
        depth--;
      }
    }
    return depth > 0;
  }
  // <...> autolink / raw HTML tag at i (text[i] === '<'). Returns node or null.
  function deautolink(i0) {
    // raw HTML tag first (a '<' followed by a letter, '/', '!', '?')
    const tag = matchHtmlTag(text, i0);
    if (tag) {
      const t = tag.text;
      const low = t.toLowerCase();
      if (low === '</a>' || low.startsWith('</a ') || low.startsWith('</a>')) { _inLink = false; _aSelfClose = false; }
      else if (/^<a(\s|\/?>)/.test(low)) {
        if (low.endsWith('/>')) { _aSelfClose = true; }
        else { _inLink = true; _aSelfClose = false; }
      }
      return { node: { t: 'html', text: t }, end: tag.end };
    }
    // autolink <scheme:...> or <email>
    let j = i0 + 1;
    // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
    if (j < n && /[A-Za-z]/.test(text[j])) {
      let k = j;
      while (k < n && /[A-Za-z0-9+.-]/.test(text[k])) k++;
      if (k - j >= 2 && k - j <= 32 && k < n && text[k] === ':') {
        // scan to '>' with no space / '<'
        let e = k + 1;
        while (e < n && text[e] !== '>' && text[e] !== ' ' && text[e] !== '\t' && text[e] !== '\n' && text[e] !== '<') e++;
        if (e < n && text[e] === '>') {
          const dest = text.slice(i0 + 1, e);
          return { node: { t: 'link', dest, title: null, label: dest, labelEnd: -1, hasNested: false, autolink: true, angle: true }, end: e + 1 };
        }
      }
    }
    // email: <local@domain.tld> — find '>' then test the whole inner
    // against the email regex (domain needs a dot, labels start/end
    // alnum). The manual scan used to stop at the first dot and reject
    // multi-label domains (cm-604).
    {
      const gt = text.indexOf('>', i0 + 1);
      if (gt !== -1) {
        const inner = text.slice(i0 + 1, gt);
        if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(inner)) {
          const dest = 'mailto:' + inner;
          return { node: { t: 'link', dest, title: null, label: inner, labelEnd: -1, hasNested: false, autolink: true, email: true, angle: true }, end: gt + 1 };
        }
      }
    }
    return null;
  }
  // Try to parse a link/image starting at i (text[i] === '[' or '![').
  // Returns {node, end} or null. Handles precedence: a link whose label
  // contains a nested link resolves the INNER one first (marked quirk).
  function tryLink(i0) {
    const isImage = text[i0] === '!';
    const open = isImage ? i0 + 1 : i0;
    if (text[open] !== '[') return null;
    const res = parseInlineLink(open);
    if (!res) return null;
    const node = res.node;
    node.t = isImage ? 'image' : 'link';
    // A label holding a code span whose content contains a backtick
    // cannot form a link (doc-16/18). The link does not form, and the
    // '_' delimiters inside the label stay literal (no <em>).
    if (node.label.indexOf('`') !== -1 && labelHasBadBacktick(node.label)) {
      blockedRanges.push([open + 1, node.labelEnd]);
      return null;
    }
    // precedence: if the label contains a nested '[' that itself forms a
    // LINK, the inner link wins and the outer '[' is literal text.
    // A nested IMAGE does not block the outer link: [![img](/u)](/u2)
    // is a link containing an image (doc-01).
    if (node.hasNested && !isImage) {
      // find the first nested '[' that parses as a link
      let k = open + 1;
      while (k < node.labelEnd) {
        // a nested IMAGE (inline or reference) is skipped whole,
        // including its optional [ref] / (dest): the [ref] after
        // ![valid] belongs to the image, it is not an inner link
        // (doc-02: ![valid][an fixes] inside a link label).
        if (text[k] === '!' && text[k + 1] === '[') {
          const img = parseInlineLink(k + 1);
          if (img) { k = img.end; continue; }
        }
        if (text[k] === '[' && text[k - 1] !== '!') {
          const inner = parseInlineLink(k);
          if (inner) {
            // the outer link does not form; return null so the caller
            // treats this '[' as literal and the inner one as a link
            return { nestedAt: k, inner };
          }
        }
        k++;
      }
    }
    return { node, end: res.end };
  }

  // --- main scan loop ---
  while (i < n) {
    const c = text[i];
    // plain-text run: scan to next special char with one regex search
    if (c !== '\\' && c !== '`' && c !== '&' && c !== '<' && c !== '*' && c !== '_' && c !== '!' && c !== '[' && c !== ']' && c !== '~') {
      RE_NEXT_SPECIAL.lastIndex = i;
      const m = RE_NEXT_SPECIAL.exec(text);
      let end = m ? m.index : n;
      // GFM extended autolinks inside plain runs: www., scheme://, email
      // (only when not inside an unclosed inline <a>)
      if (!_inLink) {
        let scan = i;
        while (scan < end) {
          // www. at word start
          if (text.startsWith('www.', scan) && (scan === 0 || !isWordChar(text[scan - 1]))) {
            const m2 = matchExtendedUrl(text, scan, 'www', _hasActiveBracket);
            if (m2) {
              if (scan > i) pushSegment(text.slice(i, scan));
              pushNode({ t: 'link', dest: 'http://' + m2.text, title: null, label: m2.text, labelEnd: -1, hasNested: false, autolink: true });
              i = m2.end;
              scan = i;
              // continue scanning the rest of this plain run
              RE_NEXT_SPECIAL.lastIndex = i;
              const m3 = RE_NEXT_SPECIAL.exec(text);
              end = m3 ? m3.index : n;
              continue;
            }
          }
          // scheme:// — trigger on the ':' of '://', then scan the scheme
          // name backwards (a scheme is 2-32 chars, [A-Za-z][A-Za-z0-9+.-]*)
          if (text[scan] === ':' && text[scan + 1] === '/' && text[scan + 2] === '/') {
            let s0 = scan - 1;
            while (s0 >= 0 && /[A-Za-z0-9+.-]/.test(text[s0])) s0--;
            s0++;
            if (s0 < scan && /[A-Za-z]/.test(text[s0]) && scan - s0 >= 2 && scan - s0 <= 32) {
              const m2 = matchSchemeRest(text, s0, _hasActiveBracket);
              if (m2) {
                if (s0 > i) pushSegment(text.slice(i, s0));
                pushNode({ t: 'link', dest: m2.text, title: null, label: m2.text, labelEnd: -1, hasNested: false, autolink: true });
                i = m2.end;
                scan = i;
                RE_NEXT_SPECIAL.lastIndex = i;
                const m3 = RE_NEXT_SPECIAL.exec(text);
                end = m3 ? m3.index : n;
                continue;
              }
            }
          }
          // scheme:email autolink (mailto:foo@bar.baz, xmpp:foo@bar.baz/txt):
          // a ':' preceded by a scheme name (2-32 chars, starts with a
          // letter, preceded by whitespace/punctuation/start) and followed
          // by an email forms one link; the scheme is removed from the
          // text buffer (gfm-633/634/635).
          if (text[scan] === ':' && !_inLink) {
            let s0 = scan - 1;
            while (s0 >= 0) {
              const cc = text.charCodeAt(s0);
              if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 43 || cc === 45 || cc === 46) { s0--; continue; }
              break;
            }
            s0++;
            const scheme = text.slice(s0, scan);
            const schemeOk = scheme.length >= 2 && scheme.length <= 32
              && scheme.charCodeAt(0) >= 65 && ((scheme.charCodeAt(0) <= 90) || (scheme.charCodeAt(0) >= 97 && scheme.charCodeAt(0) <= 122))
              && (s0 === 0 || isWhitespace(text.charCodeAt(s0 - 1)) || isPunct(text.charCodeAt(s0 - 1)));
            if (schemeOk) {
              let hasUndOpener2 = false;
              for (const d of delims) { if (d.ch === 95 && d.canOpen && d.active) { hasUndOpener2 = true; break; } }
              const em = matchEmailForward(text, scan + 1, hasUndOpener2);
              if (em) {
                let eend = em.end;
                // optional single path segment after the email (xmpp:foo@bar.baz/txt)
                if (eend < n && text.charCodeAt(eend) === 47) {
                  let q = eend + 1;
                  while (q < n) {
                    const cc = text.charCodeAt(q);
                    if (cc === 32 || cc === 9 || cc === 10 || cc === 60 || cc === 62 || cc === 47) break;
                    q++;
                  }
                  if (q > eend + 1) {
                    let pe = q;
                    while (pe > eend + 1) {
                      const cc = text.charCodeAt(pe - 1);
                      if (cc === 46 || cc === 44 || cc === 59 || cc === 58 || cc === 33 || cc === 63) { pe--; continue; }
                      break;
                    }
                    if (pe > eend + 1) eend = pe;
                  }
                }
                const url = scheme + ':' + text.slice(scan + 1, eend);
                // remove the scheme from the text buffer / current run
                if (s0 < i) {
                  const pushedScheme = text.slice(s0, i);
                  if (lastNode && lastNode.t === 'text' && pushedScheme !== '' && lastNode.text.endsWith(pushedScheme)) {
                    lastNode.text = lastNode.text.slice(0, lastNode.text.length - pushedScheme.length);
                    if (lastNode.text === '') { nodes.pop(); lastNode = nodes.length ? nodes[nodes.length - 1] : null; }
                  }
                } else if (s0 > i) {
                  pushSegment(text.slice(i, s0));
                }
                pushNode({ t: 'link', dest: url, title: null, label: url, labelEnd: -1, hasNested: false, autolink: true });
                i = eend;
                scan = i;
                RE_NEXT_SPECIAL.lastIndex = i;
                const m3 = RE_NEXT_SPECIAL.exec(text);
                end = m3 ? m3.index : n;
                continue;
              }
            }
          }
          // email: look for '@' then validate backwards/forwards
          if (text[scan] === '@') {
            // an active '_' opener before '@' means a trailing '_' run
            // in the domain is the emphasis closer, not a domain char
            let hasUndOpener = false;
            for (const d of delims) { if (d.ch === 95 && d.canOpen && d.active) { hasUndOpener = true; break; } }
            const m2 = matchEmailBefore(text, scan, hasUndOpener);
            if (m2) {
              // the local part (before '@') may already be partly in the
              // text buffer (pushed by earlier runs, e.g. across a '_'
              // delimiter in 'a.b-c_d@a.b'): remove the pushed portion
              // (up to the current run start) so the email text is not
              // duplicated (gfm-632). The rest of the local part is in
              // this run and simply is not pushed.
              if (m2.start < i) {
                const pushedLocal = text.slice(m2.start, i);
                if (lastNode && lastNode.t === 'text' && pushedLocal !== '' && lastNode.text.endsWith(pushedLocal)) {
                  lastNode.text = lastNode.text.slice(0, lastNode.text.length - pushedLocal.length);
                  if (lastNode.text === '') { nodes.pop(); lastNode = nodes.length ? nodes[nodes.length - 1] : null; }
                }
              }
              if (m2.start > i) pushSegment(text.slice(i, m2.start));
              pushNode({ t: 'link', dest: 'mailto:' + m2.text, title: null, label: m2.text, labelEnd: -1, hasNested: false, autolink: true, email: true });
              i = m2.end;
              scan = i;
              RE_NEXT_SPECIAL.lastIndex = i;
              const m3 = RE_NEXT_SPECIAL.exec(text);
              end = m3 ? m3.index : n;
              continue;
            }
          }
          scan++;
        }
      }
      if (i < end) {
        // the tail of the run, with hard breaks processed (pushSegment)
        pushSegment(text.slice(i, end));
        i = end;
      }
      continue;
    }
    if (c === '\\') {
      // backslash + punctuation -> literal punct; backslash + newline -> hard break
      if (i + 1 < n) {
        const nc = text.charCodeAt(i + 1);
        if (isPunctAscii(nc)) { pushText(text[i + 1]); i += 2; continue; }
        if (text[i + 1] === '\n') {
          pushNode({ t: 'br' });
          i += 2;
          // a hard break strips the next line's leading spaces/tabs
          while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
          continue;
        }
      }
      pushText('\\'); i++; continue;
    }
    if (c === '`') {
      // code span: run of backticks, matching close run of same length
      let j = i, cnt = 0;
      while (j < n && text[j] === '`') { cnt++; j++; }
      let e = j, found = -1;
      while (e < n) {
        if (text[e] === '`') {
          let k = e, cnt2 = 0;
          while (k < n && text[k] === '`') { cnt2++; k++; }
          if (cnt2 === cnt) { found = e; break; }
          e = k; continue;
        }
        e++;
      }
      if (found === -1) { pushText(text.slice(i, j)); i = j; continue; }
      let code = text.slice(j, found);
      // strip one leading/trailing space when both present and code has
      // non-space content; newlines become spaces
      if (code.indexOf('\n') !== -1) code = code.replace(/\n/g, ' ');
      if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1);
      pushNode({ t: 'code', text: code });
      i = found + cnt;
      continue;
    }
    if (c === '&') {
      // entity / numeric reference, else literal '&'
      if (i + 1 < n && text.charCodeAt(i + 1) === HASH) {
        const dec = decodeNumericRef(text, i);
        if (dec) { pushText(String.fromCodePoint(dec[0])); i = dec[1]; continue; }
      } else {
        let k = i + 1;
        while (k < n) {
          const cc = text.charCodeAt(k);
          if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57)) k++;
          else break;
        }
        if (k > i + 1 && k < n && text[k] === ';') {
          // valid named reference: pass through unchanged (marked does
          // not validate the name; &foo; stays &foo;)
          pushText(text.slice(i, k + 1)); i = k + 1; continue;
        }
      }
      pushText('&'); i++; continue;
    }
    if (c === '<') {
      const res = deautolink(i);
      if (res) {
        if (res.node.t === 'link') {
          pushNode(res.node);
        } else {
          pushNode(res.node);
        }
        i = res.end;
        continue;
      }
      pushText('<'); i++; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      // emphasis / strikethrough delimiter run. Two-phase: the run's
      // characters are pushed as literal text now and the run is recorded
      // as a delimiter; processDelimiters (after the scan) decides which
      // runs actually form <em>/<strong>/<del> and records insertions on
      // the text nodes. A run of 3+ tildes is literal text, never a
      // delimiter; a single '~' IS a delimiter (forms <del>).
      let j = i, cnt = 0;
      while (j < n && text[j] === c) { cnt++; j++; }
      if (c === '~' && cnt >= 3) { pushText(text.slice(i, j)); i = j; continue; }
      const fl = flanking(text, i, j);
      let canOpen, canClose;
      if (c === '_') {
        // CommonMark '_' rule: can open iff left-flanking and (not
        // right-flanking or preceded by whitespace/punctuation); can close
        // iff right-flanking and (not left-flanking or followed by
        // whitespace/punctuation). Punctuation is ASCII here.
        const prevC = i > 0 ? text.charCodeAt(i - 1) : 32;
        const nextC = j < n ? text.charCodeAt(j) : 32;
        const prevWs = isWhitespace(prevC), prevPunct = isPunct(prevC);
        const nextWs = isWhitespace(nextC), nextPunct = isPunct(nextC);
        canOpen = fl.left && (!fl.right || prevWs || prevPunct);
        canClose = fl.right && (!fl.left || nextWs || nextPunct);
      } else {
        canOpen = fl.left; canClose = fl.right;
      }
      if (!canOpen && !canClose) { pushText(text.slice(i, j)); i = j; continue; }
      pushText(text.slice(i, j));
      const node = lastNode;
      delims.push({ ch: c.charCodeAt(0), len: cnt, canOpen, canClose, node, offset: node.text.length - cnt, active: true, scope: 0, pos: i });
      i = j;
      continue;
    }
    if (c === '!' || c === '[') {
      const res = tryLink(i);
      if (res && res.nestedAt !== undefined) {
        // inner link wins: the outer '[' is literal text; parse from nestedAt
        pushText(text[i]);
        i++;
        continue;
      }
      if (res) {
        const node = res.node;
        if (node.t === 'link') {
          // label children are parsed inline (recursively); autolinks
          // inside the label become plain text (links cannot nest)
          node.children = parseInline(node.label, refs, true);
          stripAutolinks(node.children);
          // a link inside a link is not allowed: if any child is a link,
          // the outer link does not form (handled by nestedAt above for
          // direct nesting; deeper nesting via refs is rare)
          pushNode(node);
        } else {
          // image: alt text is the label parsed inline (without links)
          node.children = parseInline(node.label, refs, true);
          stripAutolinks(node.children);
          node.alt = plainTextOf(node.children);
          pushNode(node);
        }
        i = res.end;
        continue;
      }
      pushText(c); i++; continue;
    }
    if (c === ']') {
      // unmatched ']' is literal text
      pushText(']'); i++; continue;
    }
    // unreachable (all specials handled above), but keep the loop safe
    pushText(c); i++;
  }

  // --- emphasis / strikethrough processing (delimiter stack) ---
  // '_' delimiters inside a label whose link was blocked by a bad
  // backtick stay literal (doc-16).
  if (blockedRanges.length) {
    for (const d of delims) {
      if (d.ch === 95) {
        for (const [a, b] of blockedRanges) {
          if (d.pos >= a && d.pos < b) { d.canOpen = false; d.canClose = false; break; }
        }
      }
    }
  }
  processDelimiters(delims, text);

  return nodes;
}

// Forward email match from the '@' position: returns {start, end, text} or null.
// The local part is scanned backwards from '@'.
function matchEmailBefore(s, atPos, hasUnderscoreOpener) {
  // local part backwards
  let st = atPos - 1;
  const localChars = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
  while (st >= 0 && localChars.test(s[st])) st--;
  st++;
  if (st >= atPos) return null;
  // A backslash escape in/before the local part invalidates the email
  // (cm-606: foo\+@bar is not an email — the '+' is escaped).
  if (st > 0 && s[st - 1] === '\\') return null;
  // domain forwards (labels of alnum/'-'/'_', separated by '.'; a '.'
  // only counts when followed by a label char)
  let e = atPos + 1;
  let hasDot = false;
  while (e < s.length) {
    const cc = s.charCodeAt(e);
    // A '_' that is the last domain char (next char is not a domain
    // char) is an emphasis closer, not part of the domain, when an '_'
    // opener exists before '@' (doc-20/25/31/37/38: __better an@x__).
    // Otherwise it is a domain char and the endsWith('_') check below
    // rejects the email (gfm-632).
    if (cc === 95 && hasUnderscoreOpener) {
      let q = e;
      while (q < s.length && s.charCodeAt(q) === 95) q++;
      const nc = q < s.length ? s.charCodeAt(q) : 32;
      const ncIsDomain = (nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122) || nc === 45 || nc === 46;
      if (!ncIsDomain) break;
    }
    if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 45 || cc === 95) { e++; continue; }
    if (cc === 46) {
      if (e + 1 < s.length) {
        const nc = s.charCodeAt(e + 1);
        if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122)) { hasDot = true; e++; continue; }
      }
      break;
    }
    break;
  }
  if (!hasDot) return null;
  const domain = s.slice(atPos + 1, e);
  // A domain ending in '-' or '_' is not a valid email (gfm-632):
  // reject outright, do not trim it away.
  if (domain.endsWith('-') || domain.endsWith('_')) return null;
  // strip trailing punctuation from domain
  let end = e;
  while (end > atPos + 1) {
    const cc = s.charCodeAt(end - 1);
    if (cc === 46 || cc === 44 || cc === 59 || cc === 58 || cc === 33 || cc === 63) { end--; continue; }
    break;
  }
  if (end <= atPos + 1) return null;
  const dom = s.slice(atPos + 1, end);
  if (dom.indexOf('.') === -1) return null;
  // the char before the local part must not be a word char (would extend it)
  if (st > 0 && isWordChar(s[st - 1])) return null;
  return { start: st, end, text: s.slice(st, end) };
}
// scheme://... forward match from the scheme start.
// True if an HTML entity-like reference (&name; / &#123; / &#x1F;) starts at p.
function isEntityStart(text, p, n) {
  if (p >= n || text.charCodeAt(p) !== 38) return false; // '&'
  let q = p + 1;
  if (q < n && text.charCodeAt(q) === 35) { // '#'
    q++;
    if (q < n && (text.charCodeAt(q) === 120 || text.charCodeAt(q) === 88)) q++; // 'x'
    const d0 = q;
    while (q < n) {
      const c = text.charCodeAt(q);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) q++;
      else break;
    }
    return q > d0 && q < n && text.charCodeAt(q) === 59;
  }
  const d0 = q;
  while (q < n) {
    const c = text.charCodeAt(q);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) q++;
    else break;
  }
  return q > d0 && q < n && text.charCodeAt(q) === 59;
}

function matchSchemeRest(s, start, hasActiveBracket) {
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31} followed by ://
  let k = start;
  if (k >= s.length || !/[A-Za-z]/.test(s[k])) return null;
  k++;
  while (k < s.length && /[A-Za-z0-9+.-]/.test(s[k])) k++;
  if (k - start < 2 || k - start > 32) return null;
  if (k + 2 >= s.length || s[k] !== ':' || s[k + 1] !== '/' || s[k + 2] !== '/') return null;
  const pos = k + 3; // start of the domain (after '://')
  const n = s.length;
  // domain: labels of [A-Za-z0-9_-] separated by '.' (a '.' only counts
  // when followed by a label char)
  let e = pos;
  let labelLen = 0;
  while (e < n) {
    const cc = s.charCodeAt(e);
    if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 45 || cc === 95) { e++; labelLen++; continue; }
    if (cc === 46) {
      if (e + 1 < n) {
        const nc = s.charCodeAt(e + 1);
        if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122)) { e++; labelLen = 0; continue; }
      }
      break;
    }
    break;
  }
  if (e === pos || labelLen === 0) return null;
  // optional :port
  if (e < n && s.charCodeAt(e) === 58) {
    let q = e + 1;
    while (q < n) {
      const cc = s.charCodeAt(q);
      if (cc >= 48 && cc <= 57) q++;
      else break;
    }
    if (q > e + 1) e = q;
  }
  // path: / ... with balanced parens
  let p = e;
  const openStack = [];
  while (p < n) {
    const cc = s.charCodeAt(p);
    if (cc === 32 || cc === 9 || cc === 10 || cc === 60 || cc === 62 || cc === 91) break;
    // A ']' immediately after a ')' is swallowed by the autolink ONLY
    // when it does not close an ACTIVE bracket (doc-08/37: the bracket
    // was deactivated by an inner link, so ')]' is swallowed; doc-05/
    // 09/20: the bracket is active and the link forms, so the autolink
    // stops at ']').
    if (cc === 93) {
      if (p > pos && s.charCodeAt(p - 1) === 41 && !hasActiveBracket) { p++; continue; }
      break;
    }
    // '&' starting an entity-like reference ends the URL (gfm-627)
    if (cc === 38 && isEntityStart(s, p, n)) break;
    if (cc === 40) { openStack.push(p); p++; continue; }
    if (cc === 41 && openStack.length > 0) { openStack.pop(); p++; continue; }
    p++;
  }
  let end = p;
  // an unmatched '(' truncates the URL to the first unmatched '('
  if (openStack.length > 0) end = openStack[0];
  // strip trailing punctuation: . , ; : ! ? * _ ~ and unbalanced ')'
  // (a ')' immediately followed by ']' does not count toward imbalance:
  // it closes a paren outside the URL, the swallowed ')]').
  while (end > pos) {
    const cc = s.charCodeAt(end - 1);
    if (cc === 46 || cc === 44 || cc === 59 || cc === 58 || cc === 33 || cc === 63 || cc === 42 || cc === 95 || cc === 126) { end--; continue; }
    if (cc === 41) {
      let opens = 0, closes = 0;
      for (let q = pos; q < end; q++) {
        if (s.charCodeAt(q) === 40) opens++;
        else if (s.charCodeAt(q) === 41 && !(q + 1 < end && s.charCodeAt(q + 1) === 93)) closes++;
      }
      if (closes > opens) { end--; continue; }
    }
    break;
  }
  if (end <= pos) return null;
  return { text: s.slice(start, end), end };
}
// Raw HTML tag match at i (s[i] === '<'). Returns {text, end} or null.
function matchHtmlTag(s, i) {
  if (s[i] !== '<') return null;
  const rest = s.slice(i);
  // comment
  if (rest.startsWith('<!--')) {
    const e = rest.indexOf('-->');
    if (e !== -1) return { text: rest.slice(0, e + 3), end: i + e + 3 };
    return null;
  }
  // processing instruction
  if (rest.startsWith('<?')) {
    const e = rest.indexOf('?>');
    if (e !== -1) return { text: rest.slice(0, e + 2), end: i + e + 2 };
    return null;
  }
  // declaration <!A ...>
  if (rest.startsWith('<!') && rest.length > 2 && /[A-Za-z]/.test(rest[2])) {
    const e = rest.indexOf('>');
    if (e !== -1) return { text: rest.slice(0, e + 1), end: i + e + 1 };
    return null;
  }
  // CDATA
  if (rest.startsWith('<![CDATA[')) {
    const e = rest.indexOf(']]>');
    if (e !== -1) return { text: rest.slice(0, e + 3), end: i + e + 3 };
    return null;
  }
  // open/close tag: a closing tag takes no attributes and no '/'
  if (rest.startsWith('</')) {
    const m = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(rest);
    if (m) return { text: m[0], end: i + m[0].length };
    return null;
  }
  const m = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/.exec(rest);
  if (m) return { text: m[0], end: i + m[0].length };
  return null;
}
// www. extended autolink from start (s starts with 'www.' there).
function matchExtendedUrl(s, start, kind, hasActiveBracket) {
  // kind 'www': body after 'www.'; same path/paren/']' rules as scheme
  const pos = start;
  const n = s.length;
  // domain: labels of [A-Za-z0-9_-] separated by '.', must contain a dot
  let e = pos;
  let hasDot = false;
  while (e < n) {
    const cc = s.charCodeAt(e);
    if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 45 || cc === 95) { e++; continue; }
    if (cc === 46) {
      if (e + 1 < n) {
        const nc = s.charCodeAt(e + 1);
        if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122)) { hasDot = true; e++; continue; }
      }
      break;
    }
    break;
  }
  if (!hasDot) return null;
  // path: / ... with balanced parens
  let p = e;
  const openStack = [];
  while (p < n) {
    const cc = s.charCodeAt(p);
    if (cc === 32 || cc === 9 || cc === 10 || cc === 60 || cc === 62 || cc === 91) break;
    // A ']' immediately after a ')' is swallowed ONLY when it does not
    // close an ACTIVE bracket (doc-08/37); otherwise the URL stops.
    if (cc === 93) {
      if (p > pos && s.charCodeAt(p - 1) === 41 && !hasActiveBracket) { p++; continue; }
      break;
    }
    // '&' starting an entity-like reference ends the URL (gfm-627)
    if (cc === 38 && isEntityStart(s, p, n)) break;
    if (cc === 40) { openStack.push(p); p++; continue; }
    if (cc === 41 && openStack.length > 0) { openStack.pop(); p++; continue; }
    p++;
  }
  let end = p;
  // an unmatched '(' truncates the URL to the first unmatched '('
  if (openStack.length > 0) end = openStack[0];
  // strip trailing punctuation: . , ; : ! ? ' " * _ ~ and unbalanced ')'
  while (end > pos) {
    const cc = s.charCodeAt(end - 1);
    if (cc === 46 || cc === 44 || cc === 59 || cc === 58 || cc === 33 || cc === 63 || cc === 39 || cc === 34 || cc === 42 || cc === 95 || cc === 126) { end--; continue; }
    if (cc === 41) {
      let opens = 0, closes = 0;
      for (let q = pos; q < end; q++) {
        if (s.charCodeAt(q) === 40) opens++;
        else if (s.charCodeAt(q) === 41 && !(q + 1 < end && s.charCodeAt(q + 1) === 93)) closes++;
      }
      if (closes > opens) { end--; continue; }
    }
    break;
  }
  if (end <= pos) return null;
  return { text: s.slice(pos, end), end };
}
// Forward email match (used by deautolink's <email> path).
function matchEmailForward(s, start, hasUnderscoreOpener) {
  const at = s.indexOf('@', start);
  if (at === -1) return null;
  const m = matchEmailBefore(s, at, hasUnderscoreOpener);
  if (!m || m.start !== start) return null;
  return m;
}

// Plain-text content of inline nodes (for image alt text).
function plainTextOf(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') {
      // skip emphasis delimiter chars recorded in _ins (set by
      // processDelimiters); before that pass _ins is absent. So the alt
      // text of '![foo *bar*]' is 'foo bar', not 'foo *bar*' (cm-573).
      const ins = nd._ins;
      if (!ins || ins.length === 0) { out += nd.text; continue; }
      const sorted = ins.slice().sort((a, b) => a.pos - b.pos);
      let last = 0;
      for (const it of sorted) {
        out += nd.text.slice(last, it.pos);
        last = it.pos + it.skip;
      }
      out += nd.text.slice(last);
    }
    else if (nd.t === 'code') out += nd.text;
    else if (nd.t === 'br') out += '\n';
    else if (nd.t === 'delim') out += nd.char.repeat(nd.len);
    else if (nd.children) out += plainTextOf(nd.children);
  }
  return out;
}

// Delimiter-stack emphasis resolution (CommonMark appendix A, as in
// marked): walk the recorded delimiter runs; each closer looks backwards
// for the nearest usable opener of the same character and scope. A match
// consumes 1 or 2 delimiters and records <em>/<strong>/<del> insertions
// on the text nodes that hold the runs (the run characters stay in the
// text; the renderer skips the consumed ones). Delimiters strictly inside
// a formed span are re-scoped to it, so they cannot match outside the
// span (no crossing emphasis). Rule of 3, the single-delimiter-before-a-
// word block, and the strong-span block are applied per the spec cases.
function processDelimiters(delims, text) {
  const list = [];
  for (const d of delims) {
    if (d.canOpen || d.canClose) list.push(d);
  }
  // Emphasis scopes (negative ids, distinct from link scopes): when an
  // emphasis forms, delimiters inside its span are scoped to it, so they
  // cannot match a closer outside the span (no crossing emphasis).
  let emScopeCounter = 0;
  // Strong spans already formed. An outer em of the SAME delimiter char
  // does NOT form around a strong whose closing delimiter can also open
  // (immediately followed by a word char): *a **b**c*. A different char
  // (_large **data**not_) is unaffected.
  const strongSpans = [];
  for (let ci = 0; ci < list.length; ci++) {
    const closer = list[ci];
    if (!closer.active || closer.len === 0 || !closer.canClose) continue;
    let oi = ci - 1;
    while (oi >= 0 && closer.len > 0) {
      const opener = list[oi];
      if (!opener.active || opener.len === 0 || !opener.canOpen || opener.ch !== closer.ch || opener.scope !== closer.scope) { oi--; continue; }
      // Rule of 3 (spec rule 9): either is "both" and sum%3==0 and not both
      // multiples of 3 -> skip. Not re-checked for a pair that already matched.
      const eitherBoth = (opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose);
      if (eitherBoth && closer._lastOpener !== opener) {
        const sum = opener.len + closer.len;
        if (sum % 3 === 0 && !(opener.len % 3 === 0 && closer.len % 3 === 0)) { oi--; continue; }
      }
      // match
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      // A single-delimiter closer does not match a double opener when
      // the word before it is immediately preceded by a single delimiter
      // that closed an emphasis (*so*other* -> the * after 'other' stays
      // literal and the outer ** forms a strong). A double delimiter
      // before the word (**parse**parse*) does NOT block.
      if (use === 1 && opener.len >= 2 && closer.len === 1 && closer.pos !== undefined) {
        let w = closer.pos - 1;
        while (w >= 0 && isAlnum(text.charCodeAt(w))) w--;
        const before = w;
        if (before >= 0 && text.charCodeAt(before) === closer.ch
          && (before === 0 || text.charCodeAt(before - 1) !== closer.ch)) {
          oi--; continue;
        }
      }
      // An em (use 1) of the same char does not form around a strong whose
      // closing delimiter can also open and is the nearest delimiter span
      // just before this closer: *a **b**c*. If another delimiter follows
      // the strong (*a **b**c** d*), or the chars differ, it forms.
      if (use === 1) {
        let blocked = false;
        for (const sp of strongSpans) {
          // Block only when the strong's opener is open-only (preceded by
          // a space, e.g. 'so **change**') — when it can also close
          // ('first**stream**', attached to a word) the outer em forms.
          // The strong's closer need not be the immediately preceding
          // delimiter: single delimiters in between (doc-11: a lone '*'
          // after the strong, before the em closer) do not break the
          // block; a run of 2+ in between does (*a **b**c** d* forms).
          if (sp.oi > oi && sp.ci < ci && sp.closer.canOpen && sp.closer.ch === closer.ch && !sp.opener.canClose) {
            let interveningStrong = false;
            for (let k = sp.ci + 1; k < ci; k++) {
              const mid = list[k];
              if (mid.active && mid.len >= 2 && (mid.canOpen || mid.canClose)) { interveningStrong = true; break; }
            }
            if (!interveningStrong) { blocked = true; break; }
          }
        }
        if (blocked) { oi--; continue; }
      }
      const tag = closer.ch === TILDE ? 'del' : (use === 2 ? 'strong' : 'em');
      if (use === 2 && closer.ch !== TILDE) strongSpans.push({ oi, ci, closer, opener });
      addInsertion(opener.node, opener.offset + opener.len - use, use, tag, true);
      // The closer run is consumed from the END (like the opener) when
      // its leftover delimiters cannot match any opener: the leftover
      // then stays literal INSIDE the emphasis (doc-30: **by command
      // *tool*one*** -> <strong>...one*</strong>). When the leftover CAN
      // match (***a***: the opener still has 1 left), consume from the
      // start so the later match's closing tag sorts after this one.
      const leftover = closer.len - use;
      let leftoverCanMatch = false;
      if (leftover > 0) {
        if (opener.len - use > 0) leftoverCanMatch = true;
        else {
          for (let k = ci - 1; k >= 0; k--) {
            if (k === oi) continue; // current opener: already counted above
            const od = list[k];
            if (od.active && od.len > 0 && od.canOpen && od.ch === closer.ch && od.scope === closer.scope) { leftoverCanMatch = true; break; }
          }
        }
      }
      // End-consumption (leftover inside) only when the word right
      // before this closer run is immediately preceded by a SINGLE
      // delimiter of the same char that closed an emphasis
      // (**a *b*c*** -> inside, **a *b* c*** / **foo*** -> outside).
      let insideLeftover = false;
      if (use === 2 && leftover > 0 && !leftoverCanMatch && closer.pos !== undefined) {
        let w = closer.pos - 1;
        while (w >= 0 && isAlnum(text.charCodeAt(w))) w--;
        if (w >= 0 && text.charCodeAt(w) === closer.ch
          && (w === 0 || text.charCodeAt(w - 1) !== closer.ch)) insideLeftover = true;
      }
      if (insideLeftover) {
        // place the closing tag after the leftover chars
        addInsertion(closer.node, closer.offset + leftover, use, tag, false);
        closer.offset += closer.len;
        closer.len = 0;
      } else {
        addInsertion(closer.node, closer.offset, use, tag, false);
        closer.offset += use;
        closer.len -= use;
      }
      opener.len -= use;
      closer._lastOpener = opener;
      // Scope delimiters strictly inside this emphasis span (same level as
      // the opener/closer) so they cannot match outside the span.
      const emScope = --emScopeCounter;
      for (let k = oi + 1; k < ci; k++) {
        if (list[k].scope === opener.scope) list[k].scope = emScope;
      }
      if (opener.len > 0) {
        // opener still has delimiters: re-check it next (same oi)
      } else {
        // opener exhausted: keep looking at earlier openers
        oi--;
      }
    }
  }
}
function addInsertion(node, pos, skip, tag, isOpen) {
  if (!node._ins) node._ins = [];
  node._ins.push({ pos, skip, tag, isOpen });
}

// ---------------------------------------------------------------- render

// Render one inline text node, applying the emphasis insertions recorded
// on it (sorted by position; equal positions keep insertion order, which
// is what nests <em> outside <strong> for '***a***'). Text between
// insertions is escaped; 'skip' characters at each insertion (the
// consumed delimiters) are dropped; unconsumed delimiters stay literal.
function renderInlineTextNode(nd, out) {
  const s = nd.text;
  const ins = nd._ins;
  if (!ins || !ins.length) { escapeText(s, out, 0, s.length); return; }
  ins.sort((a, b) => a.pos - b.pos);
  let i = 0;
  for (const insn of ins) {
    if (insn.pos > i) escapeText(s, out, i, insn.pos);
    out.push(insn.isOpen ? '<' + insn.tag + '>' : '</' + insn.tag + '>');
    i = insn.pos + insn.skip;
  }
  if (i < s.length) escapeText(s, out, i, s.length);
}

function renderInline(nodes, out) {
  for (const nd of nodes) {
    if (nd.t === 'text') {
      renderInlineTextNode(nd, out);
    } else if (nd.t === 'code') {
      out.push('<code>');
      escapeCode(nd.text, out, 0, nd.text.length);
      out.push('</code>');
    } else if (nd.t === 'br') {
      out.push('<br>');
    } else if (nd.t === 'html') {
      out.push(nd.text);
    } else if (nd.t === 'delim') {
      // unclosed delimiter: literal characters (no longer produced by
      // the scanner, kept for safety)
      escapeText(nd.char.repeat(nd.len), out, 0, nd.len);
    } else if (nd.t === 'em') {
      out.push('<em>'); renderInline(nd.children, out); out.push('</em>');
    } else if (nd.t === 'strong') {
      out.push('<strong>'); renderInline(nd.children, out); out.push('</strong>');
    } else if (nd.t === 'del') {
      out.push('<del>'); renderInline(nd.children, out); out.push('</del>');
    } else if (nd.t === 'link') {
      const href = cleanUrl(nd.dest);
      if (href === null) {
        // unencodable href: render as plain text (marked behaviour)
        if (nd.children) renderInline(nd.children, out);
        else escapeText(nd.label || nd.dest, out, 0, (nd.label || nd.dest).length);
      } else {
        out.push('<a href="');
        escapeText(href, out, 0, href.length);
        out.push('"');
        if (nd.title != null) {
          out.push(' title="');
          escapeText(nd.title, out, 0, nd.title.length);
          out.push('"');
        }
        out.push('>');
        if (nd.children) renderInline(nd.children, out);
        else escapeText(nd.label || nd.dest, out, 0, (nd.label || nd.dest).length);
        out.push('</a>');
      }
    } else if (nd.t === 'image') {
      const src = cleanUrl(nd.dest);
      if (src === null) {
        renderInline(nd.children, out);
      } else {
        out.push('<img src="');
        escapeText(src, out, 0, src.length);
        out.push('" alt="');
        escapeText(nd.alt || '', out, 0, (nd.alt || '').length);
        out.push('"');
        if (nd.title != null) {
          out.push(' title="');
          escapeText(nd.title, out, 0, nd.title.length);
          out.push('"');
        }
        out.push('>');
      }
    }
  }
}

function renderTextNode(text, refs, out) {
  if (isPlainInline(text)) {
    escapeText(text, out, 0, text.length);
  } else {
    renderInline(parseInline(text, refs), out);
  }
}

// Render a text block (paragraph / heading / table cell): the block's
// strings joined with '\n', inline-parsed once.
function renderTextBlock(node, refs, out) {
  const text = node._text !== undefined ? node._text : (node.strings ? node.strings.join('\n') : '');
  renderTextNode(text, refs, out);
}

function renderBlock(node, refs, out) {
  switch (node.t) {
    case 'document': {
      for (const ch of node.children) renderBlock(ch, refs, out);
      break;
    }
    case 'paragraph': {
      if (node._empty) break;
      if (node._isSetext) {
        out.push('<h' + node._headingLevel + '>');
        renderTextNode(node._headingText, refs, out);
        out.push('</h' + node._headingLevel + '>\n');
        break;
      }
      out.push('<p>');
      renderTextBlock(node, refs, out);
      out.push('</p>\n');
      break;
    }
    case 'heading': {
      out.push('<h' + node._level + '>');
      if (node._text) renderTextNode(node._text, refs, out);
      out.push('</h' + node._level + '>\n');
      break;
    }
    case 'hr': {
      out.push('<hr>\n');
      break;
    }
    case 'code_fenced': {
      out.push('<pre><code');
      if (node._info) {
        const cls = node._info.split(/\s+/)[0];
        if (cls) { out.push(' class="language-'); escapeText(cls, out, 0, cls.length); out.push('"'); }
      }
      out.push('>');
      const s = node.strings || [];
      for (const ln of s) { escapeHtml(ln, out, 0, ln.length); out.push('\n'); }
      out.push('</code></pre>\n');
      break;
    }
    case 'code_indented': {
      out.push('<pre><code>');
      const s = node.strings || [];
      for (const ln of s) { escapeHtml(ln, out, 0, ln.length); out.push('\n'); }
      out.push('</code></pre>\n');
      break;
    }
    case 'html': {
      const s = node.strings || [];
      let html = s.join('\n');
      // no trailing newline when followed by a blank line, or when this
      // block is the last child of a non-document parent (the parent
      // closes right after it, e.g. an HTML block ending a list item).
      const lastInParent = !node.next && node.parent && node.parent.t !== 'document';
      // Top-level HTML block that is the last block: no trailing newline
      // when the input itself does not end with one (gfm-657).
      const lastInDoc = !node.next && node.parent && node.parent.t === 'document';
      const noTrail = lastInDoc && node.parent._endsNL === false;
      if (!node._followedByBlank && !lastInParent && !noTrail) html += '\n';
      out.push(html);
      break;
    }
    case 'blockquote': {
      out.push('<blockquote>\n');
      for (const ch of node.children) renderBlock(ch, refs, out);
      out.push('</blockquote>\n');
      break;
    }
    case 'list': {
      const d = node._listData;
      out.push(d.ordered ? '<ol' : '<ul');
      if (d.ordered && d.start !== 1 && d.start != null) out.push(' start="' + d.start + '"');
      out.push('>\n');
      for (const ch of node.children) renderBlock(ch, refs, out);
      out.push(d.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'item': {
      out.push('<li>');
      const tight = node.parent && node.parent._tight;
      const kids = node.children;
      // Task list (GFM): the item's first paragraph may start with
      // '[ ] ' (unchecked) or '[x] ' / '[X] ' (checked), followed by a
      // space. '[x]bar' (no space) and a bare '[ ]' are not tasks.
      let taskPara = null, task = null;
      for (const ch of kids) {
        if (ch.t === 'paragraph') {
          if (ch._empty || ch._isSetext) continue;
          const text = ch._text !== undefined ? ch._text : (ch.strings ? ch.strings.join('\n') : '');
          if (text.length >= 4 && text[0] === '[' && text[2] === ']' && text[3] === ' ' &&
              (text[1] === ' ' || text[1] === 'x' || text[1] === 'X')) {
            taskPara = ch;
            task = { checked: text[1] !== ' ', rest: text.slice(3) };
          }
          break;
        }
        break; // first block is not a paragraph: no task marker
      }
      const checkbox = task ? (task.checked
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">') : '';
      for (const ch of kids) {
        if (ch.t === 'paragraph') {
          if (ch._empty) continue;
          if (ch === taskPara) {
            if (tight) {
              out.push(checkbox);
              renderTextNode(task.rest, refs, out);
            } else {
              out.push('<p>');
              out.push(checkbox);
              renderTextNode(task.rest, refs, out);
              out.push('</p>\n');
            }
            continue;
          }
          if (tight) {
            if (ch._isSetext) {
              out.push('<h' + ch._headingLevel + '>');
              renderTextNode(ch._headingText, refs, out);
              out.push('</h' + ch._headingLevel + '>\n');
            } else {
              renderTextBlock(ch, refs, out);
            }
          } else {
            renderBlock(ch, refs, out);
          }
        } else {
          renderBlock(ch, refs, out);
        }
      }
      out.push('</li>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < node._header.length; k++) {
        const al = node._aligns[k];
        out.push(al ? '<th align="' + al + '">' : '<th>');
        renderTextNode(node._header[k], refs, out);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node._rows.length) {
        out.push('<tbody>');
        for (const row of node._rows) {
          out.push('<tr>\n');
          for (let k = 0; k < node._header.length; k++) {
            const al = node._aligns[k];
            out.push(al ? '<td align="' + al + '">' : '<td>');
            renderTextNode(row[k] || '', refs, out);
            out.push('</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

function renderDocument(doc) {
  const out = [];
  // refs live in the document's parse state: they were stored in the
  // closure `refs` of parseBlocks — re-derive by re-parsing is wrong;
  // instead the refs map is attached to the document node.
  const refs = doc._refs || new Map();
  renderBlock(doc, refs, out);
  return out.join('');
}
