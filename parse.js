// parse.js — fast drop-in for marked 18.1.3 (default options: gfm on, breaks
// off, pedantic off, async off). Hand-written from the CommonMark 0.31.2 /
// GFM 0.29 specifications and black-box checks of marked's observable
// output. Single-pass block scan + inline emitter; no token tree, no cache
// across parse() calls, no regex in the hot path.

// Document-level "inside an unclosed inline <a> tag" flag. An unclosed
// inline <a> suppresses all GFM extended autolinks (www., scheme://,
// email, scheme:email) for the rest of the document (marked quirk);
// </a> inline clears it; <...> autolinks are unaffected.
let _inLink = false;

export function parse(markdown) {
  _inLink = false;
  return renderDocument(parseBlocks(markdown));
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
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Remove backslash escapes (backslash before ASCII punctuation -> the char).
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
    if (s[i] === '\\' && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

// Normalize a link label: trim, collapse internal whitespace to one space,
// lowercase then uppercase then lowercase (marked's order).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
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
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const doc = newNode('document');
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
        if (c === '\\' && j + 1 < n && isPunct(text.charCodeAt(j + 1))) { label += text[j] + text[j + 1]; j += 2; continue; }
        label += c; j++;
      }
      if (!ok || j >= n || label.length === 0) break;
      j++; // past ']'
      // optional spaces/tabs (not newlines yet), then ':'
      let k = j;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      if (k >= n || text[k] !== ':') break;
      k++;
      // skip spaces/tabs/newlines (dest may be on next line)
      let m = k;
      while (m < n && (text[m] === ' ' || text[m] === '\t' || text[m] === '\n')) m++;
      if (m >= n) break;
      // destination
      let dest = null, end = m;
      if (text[m] === '<') {
        let e = m + 1;
        while (e < n && text[e] !== '>' && text[e] !== '\n') {
          if (text[e] === '\\' && e + 1 < n && isPunct(text.charCodeAt(e + 1))) { e += 2; continue; }
          e++;
        }
        if (e >= n || text[e] !== '>') break;
        dest = text.slice(m + 1, e);
        end = e + 1;
      } else {
        let e = m, depth = 0;
        while (e < n) {
          const c = text[e];
          if (c === ' ' || c === '\t' || c === '\n') break;
          if (c === '\\' && e + 1 < n && isPunct(text.charCodeAt(e + 1))) { e += 2; continue; }
          if (c === '(') { depth++; e++; continue; }
          if (c === ')') {
            if (depth === 0) break;
            depth--; e++; continue;
          }
          e++;
        }
        if (e === m) break; // empty dest
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
        break;
      }
      if (t < n && (text[t] === '"' || text[t] === "'" || text[t] === '(')) {
        const q = text[t];
        const close = q === '(' ? ')' : q;
        let e = t + 1, okT = true;
        while (e < n && text[e] !== close) {
          if (text[e] === '\\' && e + 1 < n && isPunct(text.charCodeAt(e + 1))) { e += 2; continue; }
          if (q === '(' && text[e] === '(') { okT = false; break; }
          e++;
        }
        if (okT && e < n) {
          title = text.slice(t + 1, e);
          endAfterTitle = e + 1;
          // after title: only spaces/tabs then newline or EOF
          let u = endAfterTitle;
          while (u < n && (text[u] === ' ' || text[u] === '\t')) u++;
          if (u < n && text[u] !== '\n') { /* junk after title: whole def fails */ break; }
          endAfterTitle = u;
        } else if (q === '(') {
          break; // '(' title must close on same line-ish; treat as failed def
        } else {
          // quote title may span lines; try again allowing newline
          let e2 = t + 1, ok2 = true;
          while (e2 < n && text[e2] !== close) {
            if (text[e2] === '\\' && e2 + 1 < n && isPunct(text.charCodeAt(e2 + 1))) { e2 += 2; continue; }
            e2++;
          }
          if (ok2 && e2 < n) {
            title = text.slice(t + 1, e2);
            endAfterTitle = e2 + 1;
            let u = endAfterTitle;
            while (u < n && (text[u] === ' ' || text[u] === '\t')) u++;
            if (u < n && text[u] !== '\n') break;
            endAfterTitle = u;
          } else {
            break;
          }
        }
      } else {
        // no title: after dest, only spaces/tabs then newline or EOF
        let u = end;
        while (u < n && (text[u] === ' ' || text[u] === '\t')) u++;
        if (u < n && text[u] !== '\n') break;
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
              if (text[e] === '\\' && e + 1 < n && isPunct(text.charCodeAt(e + 1))) { e += 2; continue; }
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
      if (c === BSLASH && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) { cur += s[i] + s[i + 1]; i += 2; continue; }
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
      if (!/^ -+$/.test(core) && !/^-+$/.test(core)) return null;
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
      if (c === BSLASH && i + 1 < s.length && (s[i + 1] === '|' || isPunct(s.charCodeAt(i + 1)))) {
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
          if (ch() === SP || ch() === TAB) adv1();
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
          const ci = container._contentIndent;
          if (countIndent() < ci) { allMatched = false; break; }
          advCols(ci);
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
      // content line: strip up to fence indent
      const ind2 = countIndent();
      let strip = Math.min(ind2, tip._fenceIndent);
      // Never partially consume a leading tab while stripping the fence
      // indent: if the line starts with a tab whose width exceeds the
      // remaining strip, leave the tab whole (doc-02: tab at col 4, fence
      // indent 2 -> full 4 spaces, not 2).
      if (pos < line.length && line.charCodeAt(pos) === TAB) {
        const w = 4 - (col % 4);
        if (strip < w) strip = 0;
      }
      // The tab-expansion column is the column after container matching
      // but BEFORE the fence indent is stripped: top level -> 0 (a leading
      // tab is preserved, doc-15), list item -> content indent (doc-02).
      const colBeforeStrip = col;
      advCols(strip);
      // Inside a blockquote with a zero-indent fence the reference counts
      // the content as starting at column 2 regardless of blockquote depth
      // (a leading tab always becomes 2 spaces there). With a non-zero
      // fence indent the absolute column applies (doc-26: indent 2, tab at
      // col 4 -> 4 spaces).
      let inBlockquote = false;
      {
        let anc = tip.parent;
        while (anc) {
          if (anc.t === 'blockquote') { inBlockquote = true; break; }
          anc = anc.parent;
        }
      }
      let tabCol;
      if (inBlockquote) {
        tabCol = tip._fenceIndent === 0 ? 2 : col;
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
        addLine(tip, expandTabs(restOfLine(), col));
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
      // finalize paragraph + unmatched containers when a block interrupts it;
      // then close a list whose item this line does not continue.
      const interrupt = () => {
        if (atPara) {
          finalize(tip); tip = tip.parent;
          if (!allMatched) { finalizeUpTo(matchedContainer); tip = matchedContainer; }
        }
        closeListIfNotContinued();
      };
      const closeListIfNotContinued = () => {
        if (tip.t === 'list') {
          // a thematic break is not a list item, even if it looks like one
          if (checkHr()) { finalize(tip); tip = tip.parent; return; }
          const li0 = listInfoAtCursor();
          let cont = false;
          if (li0 && tip._listData.ordered === li0.ordered && tip._listData.bullet === li0.bullet) cont = true;
          if (!cont) { finalize(tip); tip = tip.parent; }
        }
      };

      if (ind5 <= 3) {
        advCols(ind5);
        const c5 = ch();
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
        // --- setext / table (paragraph open, containers matched) ---
        if (atPara && allMatched) {
          const sl = checkSetext();
          if (sl > 0) {
            const p = tip;
            const rest = stripRefDefs(p.strings.join('\n'), refs);
            // a paragraph that is only link reference definitions has no
            // content to turn into a heading: the underline is plain text
            if (rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') !== '') {
              p.t = 'heading';
              p._level = sl;
              p._text = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
              p.strings = null;
              finalize(p);
              tip = p.parent;
              break;
            }
            // else: fall through to paragraph continuation
          }
          const aligns = checkTableDelim();
          if (aligns) {
            const p = tip;
            const rest = stripRefDefs(p.strings.join('\n'), refs);
            const plines = rest.split('\n');
            const headerCells = splitTableRow(plines[plines.length - 1]);
            if (headerCells.length === aligns.length) {
              const parent = p.parent;
              const idx = parent.children.indexOf(p);
              const tbl = newNode('table');
              tbl._header = headerCells;
              tbl._align = aligns;
              tbl._rows = [];
              parent.children[idx] = tbl;
              tbl.parent = parent;
              parent.lastChild = parent.children[parent.children.length - 1];
              const earlier = plines.slice(0, -1).join('\n');
              if (earlier !== '') {
                const ep = newNode('paragraph');
                ep.strings = earlier.split('\n');
                parent.children.splice(idx, 0, ep);
                ep.parent = parent;
                finalize(ep);
              }
              tip = tbl;
              break;
            }
          }
        }
        // --- thematic break ---
        if (checkHr()) {
          interrupt();
          const hr = addChild(tip, newNode('hr'));
          finalize(hr);
          break;
        }
        // --- list ---
        const mk = listInfoAtCursor();
        if (mk) {
          let canInterrupt = true;
          if (atPara) {
            // Is this paragraph inside a list item (possibly nested in a
            // blockquote)? Then any list marker ends the item (new item /
            // new list), so it may interrupt.
            let inItem = false;
            let anc = tip.parent;
            while (anc) {
              if (anc.t === 'item') { inItem = true; break; }
              anc = anc.parent;
            }
            if (!inItem) {
              if (!mk.hasContent) canInterrupt = false;
              if (mk.ordered && mk.start !== 1) canInterrupt = false;
            }
          }
          if (canInterrupt) {
            interrupt();
            let padding;
            if (!mk.hasContent) padding = 1;
            else if (mk.padCols >= 1 && mk.padCols <= 4) padding = mk.padCols;
            else padding = 1;
            const contentIndent = ind5 + mk.width + padding;
            advCols(mk.width + padding);
            let listNode = null;
            if (tip.t === 'list' && tip._listData.ordered === mk.ordered && tip._listData.bullet === mk.bullet) {
              listNode = tip;
            }
            // NOTE: when tip is an ITEM, the marker lies inside that item's
            // content area, so this is always a NESTED list, never a reuse
            // of the parent list.
            if (!listNode) {
              listNode = addChild(tip, newNode('list'));
              listNode._listData = { ordered: mk.ordered, bullet: mk.bullet, start: mk.start };
            }
            const item = addChild(listNode, newNode('item'));
            item._contentIndent = contentIndent;
            tip = item;
            if (mk.hasContent) continue;
            break;
          }
          // cannot interrupt: fall through to paragraph (cursor unchanged)
        }
      }
      // --- indented code ---
      if (ind5 >= 4 && tip.t !== 'paragraph') {
        advCols(4);
        const code = addChild(tip, newNode('code_indented'));
        addLine(code, restOfLine());
        tip = code;
        break;
      }
      // --- paragraph (new or continuation / lazy) ---
      // paragraph lines keep their leading spaces verbatim (up to 3),
      // so restore the cursor to before the indent was consumed.
      pos = savePos; col = saveCol; ptab = savePtab;
      if (tip.t === 'paragraph' && !allMatched) {
        // lazy continuation: an indent of 4+ is stripped by 4 columns
        // (as if it were indented code); smaller indents are kept.
        if (countIndent() >= 4) advCols(4);
      }
      if (tip.t !== 'paragraph') {
        // no (real) content left (e.g. an empty blockquote line): no paragraph
        if (restOfLine().trim() === '') break;
        tip = addChild(tip, newNode('paragraph'));
      }
      let pcontent = restOfLine();
      if (tip.t === 'paragraph' && !allMatched && tip._lastLazy) {
        // a lazy setext-underline line following another lazy line gains
        // 4 spaces (marked quirk, cm-093)
        const trimmed = pcontent.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        if (/^=+$/.test(trimmed)) pcontent = '    ' + pcontent;
      }
      addLine(tip, pcontent);
      tip._lastLazy = !allMatched;
      break;
    }
  }

  // finalize everything still open
  while (tip !== doc) { finalize(tip); tip = tip.parent; }
  return { doc, refs };
}

// ---------------------------------------------------------------- inline parser

// Escape text, preserving named-entity-like sequences (&name;) verbatim.
function escapeText(s, out) {
  let i = 0, j = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === AMP) {
      // named entity-like? & + letter + alnum* + ';'
      let k = i + 1;
      if (k < n && ((s.charCodeAt(k) >= 65 && s.charCodeAt(k) <= 90) || (s.charCodeAt(k) >= 97 && s.charCodeAt(k) <= 122))) {
        k++;
        while (k < n && isAlnum(s.charCodeAt(k))) k++;
        if (k < n && s.charCodeAt(k) === 59) {
          if (j < i) out.push(s.slice(j, i));
          out.push(s.slice(i, k + 1));
          i = k + 1; j = i;
          continue;
        }
      }
      if (j < i) out.push(s.slice(j, i));
      out.push('&amp;'); j = i + 1;
    } else if (c === LT) { if (j < i) out.push(s.slice(j, i)); out.push('&lt;'); j = i + 1; }
    else if (c === GT) { if (j < i) out.push(s.slice(j, i)); out.push('&gt;'); j = i + 1; }
    else if (c === QUOT) { if (j < i) out.push(s.slice(j, i)); out.push('&quot;'); j = i + 1; }
    else if (c === APOS) { if (j < i) out.push(s.slice(j, i)); out.push('&#39;'); j = i + 1; }
    i++;
  }
  if (j < n) out.push(s.slice(j, n));
}
function escapeTextStr(s) { const o = []; escapeText(s, o); return o.join(''); }
// Escape for code spans/blocks: & always escaped.
function escapeCode(s, out) {
  let i = 0, j = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === AMP) { if (j < i) out.push(s.slice(j, i)); out.push('&amp;'); j = i + 1; }
    else if (c === LT) { if (j < i) out.push(s.slice(j, i)); out.push('&lt;'); j = i + 1; }
    else if (c === GT) { if (j < i) out.push(s.slice(j, i)); out.push('&gt;'); j = i + 1; }
    else if (c === QUOT) { if (j < i) out.push(s.slice(j, i)); out.push('&quot;'); j = i + 1; }
    else if (c === APOS) { if (j < i) out.push(s.slice(j, i)); out.push('&#39;'); j = i + 1; }
    i++;
  }
  if (j < n) out.push(s.slice(j, n));
}

// CommonMark flanking for a delimiter run.
function flanking(text, start, end) {
  // start = index of first delim char, end = index past last delim char
  const prev = start > 0 ? text[start - 1] : '\n';
  const next = end < text.length ? text[end] : '\n';
  const prevC = prev.charCodeAt(0), nextC = next.charCodeAt(0);
  const prevWs = isWhitespace(prevC), nextWs = isWhitespace(nextC);
  const prevPunct = isPunct(prevC), nextPunct = isPunct(nextC);
  const leftFlanking = !nextWs && (!nextPunct || prevWs || prevPunct);
  const rightFlanking = !prevWs && (!prevPunct || nextWs || nextPunct);
  return { left: leftFlanking, right: rightFlanking };
}

function parseInline(text, refs) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  let scopeCounter = 0;
  let textBuf = null;
  const n = text.length;
  let i = 0;

  function addText(s) {
    if (!textBuf) { textBuf = { t: 'text', s: '', _ins: null }; nodes.push(textBuf); }
    textBuf.s += s;
  }
  function addRaw(s) { textBuf = null; nodes.push({ t: 'raw', s }); }
  function addNode(nd) { textBuf = null; nodes.push(nd); return nd; }

  // --- link destination/title parsing (after a ']' or '(') ---
  // Parse an inline link's (dest "title") starting at pos (text[pos] === '(').
  // Returns { dest, title, end } or null.
  function parseInlineLink(pos) {
    let p = pos + 1;
    while (p < n && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n')) p++;
    if (p >= n) return null;
    let dest = null, end = p;
    if (text[p] === '<') {
      let e = p + 1;
      while (e < n && text[e] !== '>' && text[e] !== '\n') {
        if (text[e] === '\\' && e + 1 < n && isPunct(text.charCodeAt(e + 1))) { e += 2; continue; }
        e++;
      }
      if (e >= n || text[e] !== '>') return null;
      dest = text.slice(p + 1, e);
      end = e + 1;
    } else {
      let e = p, depth = 0;
      while (e < n) {
        const c = text[e];
        if (c === ' ' || c === '\t' || c === '\n') break;
        if (c === '\\' && e + 1 < n && isPunct(text.charCodeAt(e + 1))) { e += 2; continue; }
        if (c === '(') { depth++; e++; continue; }
        if (c === ')') {
          if (depth === 0) break;
          depth--; e++; continue;
        }
        e++;
      }
      // empty dest is allowed: () or ( "title")
      dest = text.slice(p, e);
      end = e;
    }
    // optional title
    let title = null, endAfter = end;
    let t = end;
    while (t < n && (text[t] === ' ' || text[t] === '\t' || text[t] === '\n')) t++;
    if (t < n && (text[t] === '"' || text[t] === "'" || text[t] === '(')) {
      const q = text[t];
      const close = q === '(' ? ')' : q;
      let e = t + 1, okT = true;
      while (e < n && text[e] !== close) {
        if (text[e] === '\\' && e + 1 < n && isPunct(text.charCodeAt(e + 1))) { e += 2; continue; }
        if (q === '(' && text[e] === '(') { okT = false; break; }
        e++;
      }
      if (!okT || e >= n) return null;
      // for '(' title, the closing ')' must be on the same line (no newline inside)
      if (q === '(' && text.slice(t + 1, e).indexOf('\n') !== -1) return null;
      title = text.slice(t + 1, e);
      endAfter = e + 1;
      let u = endAfter;
      while (u < n && (text[u] === ' ' || text[u] === '\t' || text[u] === '\n')) u++;
      if (u >= n || text[u] !== ')') return null;
      endAfter = u + 1;
    } else {
      let u = end;
      while (u < n && (text[u] === ' ' || text[u] === '\t' || text[u] === '\n')) u++;
      if (u >= n || text[u] !== ')') return null;
      endAfter = u + 1;
    }
    return { dest: unescapeBackslashes(dest), title: title == null ? null : unescapeBackslashes(title), end: endAfter };
  }

  // Try to resolve a bracket (at brackets[idx]) now that we hit ']'.
  // closePos = index of ']' in text. Returns the end position to resume
  // scanning at (past the link), or -1 when no link forms.
  // Inside a link's text, autolinks are plain text (links cannot nest).
  // Convert any autolink node (marked _auto) back to a text node.
  function deautolink(nodes) {
    for (let k = 0; k < nodes.length; k++) {
      const nd = nodes[k];
      if (nd.t === 'link' && nd._auto) {
        nodes[k] = { t: 'text', s: plainTextOf(nd.c), _ins: null };
      } else if (nd.t === 'link' || nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') {
        deautolink(nd.c);
      }
    }
  }

// True if `label` contains a code span whose content includes a backtick,
// or an unmatched backtick run. Such a label cannot form a link (doc-20).
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
    if (found === -1) return true; // unmatched backtick run
    const content = label.slice(i + run, found);
    if (content.indexOf('`') !== -1) return true; // backtick inside code span
    i = found + run;
  }
  return false;
}

  function tryLink(idx, closePos) {
    const br = brackets[idx];
    if (!br.active) return -1;
    const isImage = br.isImage;
    // find the label text (raw, between '[' and ']')
    const labelStart = br.labelStart; // index just after '['
    const labelText = text.slice(labelStart, closePos);

    // parse what follows ']'
    let p = closePos + 1;
    let dest = null, title = null, endPos = -1;
    if (p < n && text[p] === '(') {
      const r = parseInlineLink(p);
      if (r) { dest = r.dest; title = r.title; endPos = r.end; }
      else {
        // inline link invalid (e.g. bare dest with space): fall back to
        // shortcut reference, leaving "(...)" as literal text.
        const ref = refs.get(normalizeLabel(labelText));
        if (ref) { dest = ref.dest; title = ref.title; endPos = closePos + 1; }
      }
    } else if (p < n && text[p] === '[') {
      // [label] or []
      let e = p + 1;
      while (e < n && text[e] !== ']') {
        if (text[e] === '\\' && e + 1 < n) { e += 2; continue; }
        if (text[e] === '[') { e = -1; break; }
        e++;
      }
      if (e !== -1 && e < n) {
        const lab = e === p + 1 ? labelText : text.slice(p + 1, e);
        const ref = refs.get(normalizeLabel(lab));
        if (ref) { dest = ref.dest; title = ref.title; endPos = e + 1; }
      }
    } else {
      // shortcut reference
      const ref = refs.get(normalizeLabel(labelText));
      if (ref) { dest = ref.dest; title = ref.title; endPos = closePos + 1; }
    }
    if (dest === null) return -1;
    // Build the link/image node from the nodes after the bracket's content start.
    const clean = cleanUrl(dest);
    if (clean === null) return -1;
    // Remove the bracket node (the '[' or '![' text node).
    const bn = br.node;
    const bi = nodes.indexOf(bn);
    if (bi !== -1) nodes.splice(bi, 1);
    // Content nodes start at br.nodeIndex - 1 after removing the bracket node.
    const startIdx = br.nodeIndex - 1;
    const linkChildren = nodes.slice(startIdx);
    nodes.length = startIdx;
    textBuf = null;
    deautolink(linkChildren);
    // Scope delimiters inside this link/image: they may match each other
    // but not delimiters outside the link (links cannot nest emphasis).
    const scopeId = ++scopeCounter;
    const childSet = new Set(linkChildren);
    for (const d of delims) {
      if (childSet.has(d.node)) d.scope = scopeId;
    }
    // deactivate enclosing link brackets (not image brackets) when a LINK forms
    if (!isImage) {
      for (let k = 0; k < brackets.length; k++) {
        if (brackets[k].active && !brackets[k].isImage) brackets[k].active = false;
      }
    }
    if (isImage) {
      addNode({ t: 'image', src: clean, title, c: linkChildren });
    } else {
      addNode({ t: 'link', href: clean, title, c: linkChildren });
    }
    return endPos;
  }

  // --- main scan ---
  while (i < n) {
    const c = text.charCodeAt(i);
    // backslash escape
    if (c === BSLASH && i + 1 < n && text.charCodeAt(i + 1) < 128 && ASCII_PUNCT[text.charCodeAt(i + 1)] === 1) {
      const ec = text[i + 1];
      if (ec === '&') addText('&amp;'); // literal '&': must not start an entity
      else addText(ec); // escapeText at render escapes < > " ' as needed
      i += 2;
      continue;
    }
    // newline: soft/hard break
    if (c === LF) {
      // hard break if previous char is '\' (already handled) or 2+ trailing spaces
      // count trailing spaces in the current text buffer
      let trailing = 0;
      if (textBuf) {
        let k = textBuf.s.length - 1;
        while (k >= 0 && textBuf.s[k] === ' ') { trailing++; k--; }
      }
      if (trailing >= 2) {
        // strip the trailing spaces, emit <br>, skip leading spaces of next line
        textBuf.s = textBuf.s.slice(0, textBuf.s.length - trailing);
        if (textBuf.s === '') { nodes.pop(); textBuf = null; }
        addNode({ t: 'br' });
        i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      } else {
        addNode({ t: 'softbreak' });
        i++;
      }
      continue;
    }
    // backslash + newline = hard break
    if (c === BSLASH && i + 1 < n && text[i + 1] === '\n') {
      addNode({ t: 'br' });
      i += 2;
      while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      continue;
    }
    // code span
    if (c === TICK) {
      let run = 0;
      while (i + run < n && text.charCodeAt(i + run) === TICK) run++;
      // find a matching run of the same length
      let found = -1, j = i + run;
      while (j < n) {
        if (text.charCodeAt(j) === TICK) {
          let r2 = 0;
          while (j + r2 < n && text.charCodeAt(j + r2) === TICK) r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else j++;
      }
      if (found !== -1) {
        let content = text.slice(i + run, found);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        addNode({ t: 'code', s: content });
        i = found + run;
      } else {
        addText(text.slice(i, i + run));
        i += run;
      }
      continue;
    }
    // entity / ampersand
    if (c === AMP) {
      if (i + 1 < n && text[i + 1] === '#') {
        const r = decodeNumericRef(text, i);
        if (r) {
          addText(String.fromCodePoint(r[0]));
          i = r[1];
          continue;
        }
      }
      // named-entity-like: pass through verbatim
      let k = i + 1;
      if (k < n && ((text.charCodeAt(k) >= 65 && text.charCodeAt(k) <= 90) || (text.charCodeAt(k) >= 97 && text.charCodeAt(k) <= 122))) {
        k++;
        while (k < n && isAlnum(text.charCodeAt(k))) k++;
        if (k < n && text.charCodeAt(k) === 59) {
          addText(text.slice(i, k + 1));
          i = k + 1;
          continue;
        }
      }
      addText('&');
      i++;
      continue;
    }
    // '<' : autolink or inline HTML
    if (c === LT) {
      // try autolink: find '>'
      const gt = text.indexOf('>', i + 1);
      if (gt !== -1) {
        const inner = text.slice(i + 1, gt);
        // scheme autolink
        const sm = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):([^\s<>]+)$/.exec(inner);
        if (sm) {
          const href = cleanUrl(inner);
          if (href !== null) {
            addNode({ t: 'link', href, title: null, c: [{ t: 'text', s: inner, _ins: null }], _angle: true });
            i = gt + 1;
            continue;
          }
        }
        // email autolink
        if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(inner)) {
          addNode({ t: 'link', href: 'mailto:' + inner, title: null, c: [{ t: 'text', s: inner, _ins: null }], _angle: true });
          i = gt + 1;
          continue;
        }
      }
      // inline HTML tag
      const tag = matchHtmlTag(text, i);
      if (tag) {
        // unclosed inline <a> suppresses extended autolinks for the rest
        // of the document; inline </a> clears it (doc-03).
        const low = tag.toLowerCase();
        if (low === '</a>' || low.startsWith('</a>') && (low[4] === ' ' || low[4] === '\t' || low[4] === '\n' || low[4] === '>')) {
          _inLink = false;
        } else if ((low.startsWith('<a ') || low.startsWith('<a\t') || low.startsWith('<a\n') || low === '<a>' || low.startsWith('<a>')) && !low.endsWith('/>')) {
          _inLink = true;
        }
        addRaw(tag);
        i += tag.length;
        continue;
      }
      addText('<');
      i++;
      continue;
    }
    // image start '!['
    if (c === BANG && i + 1 < n && text[i + 1] === '[') {
      textBuf = null;
      const bracketNode = { t: 'text', s: '![', _ins: null };
      nodes.push(bracketNode);
      brackets.push({ isImage: true, active: true, node: bracketNode, offset: 0, labelStart: i + 2, nodeIndex: nodes.length });
      textBuf = null;
      i += 2;
      continue;
    }
    // link start '['
    if (c === LBRK) {
      textBuf = null;
      const bracketNode = { t: 'text', s: '[', _ins: null };
      nodes.push(bracketNode);
      brackets.push({ isImage: false, active: true, node: bracketNode, offset: 0, labelStart: i + 1, nodeIndex: nodes.length });
      textBuf = null;
      i++;
      continue;
    }
    // link end ']'
    if (c === RBRK) {
      // ']' pairs with the MOST RECENT bracket (top of stack), active or
      // not. If that bracket is inactive (deactivated by an inner link),
      // the ']' is literal; do NOT skip to an older active bracket.
      if (brackets.length === 0) { addText(']'); i++; continue; }
      const bidx = brackets.length - 1;
      const endPos = tryLink(bidx, i);
      if (endPos === -1) {
        // bracket failed: pop it, ']' stays literal
        brackets.splice(bidx, 1);
        addText(']');
        i++;
      } else {
        brackets.splice(bidx, 1);
        i = endPos;
      }
      continue;
    }
    // emphasis / strikethrough delimiters
    if (c === STAR || c === UNDER || c === TILDE) {
      let run = 0;
      while (i + run < n && text.charCodeAt(i + run) === c) run++;
      if (c === TILDE && run >= 3) {
        addText(text.slice(i, i + run));
        i += run;
        continue;
      }
      const fl = flanking(text, i, i + run);
      let canOpen, canClose;
      if (c === UNDER) {
        // CommonMark _ rule: intraword emphasis is disallowed.
        const prevC = i > 0 ? text.charCodeAt(i - 1) : 32;
        const nextC = i + run < n ? text.charCodeAt(i + run) : 32;
        const prevWs = isWhitespace(prevC), prevPunct = isPunct(prevC);
        const nextWs = isWhitespace(nextC), nextPunct = isPunct(nextC);
        canOpen = fl.left && (!fl.right || prevWs || prevPunct);
        canClose = fl.right && (!fl.left || nextWs || nextPunct);
      } else {
        canOpen = fl.left;
        canClose = fl.right;
      }
      if (!canOpen && !canClose) {
        addText(text.slice(i, i + run));
        i += run;
        continue;
      }
      addText(text.slice(i, i + run));
      const node = textBuf;
      delims.push({ ch: c, len: run, origLen: run, canOpen, canClose, node, offset: node.s.length - run, active: true, scope: 0 });
      i += run;
      continue;
    }
    // extended autolink: scheme:// — only http/https/ftp (case-insensitive), GFM
    if (c === COLON && !_inLink && text[i + 1] === '/' && text[i + 2] === '/' && textBuf) {
      const s = textBuf.s;
      const low = s.toLowerCase();
      let schemeStart = -1, scheme = '';
      for (const cand of ['https', 'http', 'ftp']) {
        if (low.endsWith(cand)) {
          schemeStart = s.length - cand.length; scheme = s.slice(schemeStart); break;
        }
      }
      if (schemeStart >= 0) {
        const rest = matchSchemeRest(text, i + 3);
        if (rest) {
          const url = scheme + '://' + rest;
          textBuf.s = s.slice(0, schemeStart);
          if (textBuf.s === '') { nodes.pop(); textBuf = null; }
          const href = cleanUrl(url);
          if (href !== null) {
            addNode({ t: 'link', href, title: null, c: [{ t: 'text', s: url, _ins: null }], _auto: true });
            i += 3 + rest.length;
            continue;
          }
        }
      }
    }
    // scheme:email autolink (mailto:foo@bar.baz, xmpp:foo@bar.baz/txt)
    if (c === COLON && !_inLink && textBuf) {
      const s = textBuf.s;
      let b = s.length - 1;
      while (b >= 0) {
        const ch = s.charCodeAt(b);
        if ((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 43 || ch === 45 || ch === 46) { b--; continue; }
        break;
      }
      const scheme = s.slice(b + 1);
      const schemeOk = scheme.length >= 2 && scheme.length <= 32
        && scheme.charCodeAt(0) >= 65 && ((scheme.charCodeAt(0) <= 90) || (scheme.charCodeAt(0) >= 97 && scheme.charCodeAt(0) <= 122))
        && (b < 0 || isWhitespace(s.charCodeAt(b)) || isPunct(s.charCodeAt(b)));
      if (schemeOk) {
        const em = matchEmailForward(text, i + 1);
        if (em) {
          let end = em.end;
          // optional single path segment after the email (xmpp:foo@bar.baz/txt)
          if (end < text.length && text.charCodeAt(end) === 47) {
            let q = end + 1;
            while (q < text.length) {
              const ch = text.charCodeAt(q);
              if (ch === 32 || ch === 9 || ch === 10 || ch === 60 || ch === 62 || ch === 47) break;
              q++;
            }
            if (q > end + 1) {
              let pe = q;
              while (pe > end + 1) {
                const ch = text.charCodeAt(pe - 1);
                if (ch === 46 || ch === 44 || ch === 59 || ch === 58 || ch === 33 || ch === 63) { pe--; continue; }
                break;
              }
              if (pe > end + 1) end = pe;
            }
          }
          const url = scheme + ':' + text.slice(i + 1, end);
          textBuf.s = s.slice(0, b + 1);
          if (textBuf.s === '') { nodes.pop(); textBuf = null; }
          const href = cleanUrl(url);
          if (href !== null) {
            addNode({ t: 'link', href, title: null, c: [{ t: 'text', s: url, _ins: null }], _auto: true });
            i = end;
            continue;
          }
        }
      }
    }
    // extended autolink: www.
    if (c === 119 && !_inLink && text.startsWith('www.', i)) { // 'w'
      const prevC = i > 0 ? text.charCodeAt(i - 1) : 32;
      const okPrev = i === 0 || isWhitespace(prevC) || isPunct(prevC);
      if (okPrev) {
        const url = matchExtendedUrl(text, i);
        if (url) {
          const href = cleanUrl('http://' + url);
          if (href !== null) {
            addNode({ t: 'link', href, title: null, c: [{ t: 'text', s: url, _ins: null }], _auto: true });
            i += url.length;
            continue;
          }
        }
      }
    }
    // extended autolink: email (on '@')
    if (c === 64 && !_inLink) { // '@'
      let hasUndOpener = false;
      for (const d of delims) { if (d.ch === UNDER && d.canOpen && d.active) { hasUndOpener = true; break; } }
      const em = matchEmailBefore(text, i, hasUndOpener);
      if (em) {
        // remove the local part from the text buffer
        const local = em.local;
        if (textBuf && textBuf.s.endsWith(local)) {
          textBuf.s = textBuf.s.slice(0, textBuf.s.length - local.length);
          if (textBuf.s === '') { nodes.pop(); textBuf = null; }
        }
        const full = local + '@' + em.domain;
        addNode({ t: 'link', href: 'mailto:' + full, title: null, c: [{ t: 'text', s: full, _ins: null }], _auto: true });
        i = em.end;
        continue;
      }
      addText('@');
      i++;
      continue;
    }
    // ordinary char: fast path — append a run of non-special chars
    let j = i;
    while (j < n) {
      const cc = text.charCodeAt(j);
      if (cc === BSLASH || cc === TICK || cc === AMP || cc === LT || cc === LBRK || cc === RBRK || cc === BANG || cc === STAR || cc === UNDER || cc === TILDE || cc === LF || cc === 64 || cc === 119 || cc === COLON) break;
      j++;
    }
    if (j === i) j = i + 1; // single char (e.g. 'w' not starting www.)
    addText(text.slice(i, j));
    i = j;
  }

  // --- emphasis / strikethrough processing (delimiter stack) ---
  processDelimiters(delims, text);

  return nodes;
}

// Match the part of a scheme:// URL after "://" (domain, optional :port, path).
// Domain may be a single label (localhost) or an IP; no dot required.
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

// Match an email starting at `start`: local@domain (domain needs a dot,
// must not end in '-' or '_'). Returns { local, domain, end } or null.
function matchEmailForward(text, start) {
  const n = text.length;
  let e = start;
  while (e < n) {
    const c = text.charCodeAt(e);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 45 || c === 43) { e++; continue; }
    break;
  }
  const local = text.slice(start, e);
  if (local === '' || local.startsWith('.') || local.endsWith('.') || local.indexOf('..') !== -1) return null;
  if (e >= n || text.charCodeAt(e) !== 64) return null; // '@'
  let d = e + 1, hasDot = false;
  while (d < n) {
    const c = text.charCodeAt(d);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) { d++; continue; }
    if (c === 46) {
      if (d + 1 < n) {
        const nc = text.charCodeAt(d + 1);
        if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122)) { hasDot = true; d++; continue; }
      }
      break;
    }
    break;
  }
  if (!hasDot) return null;
  let de = d;
  while (de > e + 1) {
    const c = text.charCodeAt(de - 1);
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63) { de--; continue; }
    break;
  }
  if (de <= e + 1) return null;
  const domain = text.slice(e + 1, de);
  if (domain.endsWith('-') || domain.endsWith('_')) return null;
  return { local, domain, end: de };
}

function matchSchemeRest(text, pos) {
  const n = text.length;
  let e = pos;
  // domain: labels of [A-Za-z0-9_-] separated by '.' (dot only if followed by label char)
  let labelLen = 0;
  while (e < n) {
    const c = text.charCodeAt(e);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) { e++; labelLen++; continue; }
    if (c === 46) { // '.'
      if (e + 1 < n) {
        const nc = text.charCodeAt(e + 1);
        if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122)) { e++; labelLen = 0; continue; }
      }
      break;
    }
    break;
  }
  if (e === pos || labelLen === 0) return null;
  // optional :port
  if (e < n && text.charCodeAt(e) === COLON) {
    let q = e + 1;
    while (q < n) {
      const c = text.charCodeAt(q);
      if (c >= 48 && c <= 57) q++;
      else break;
    }
    if (q > e + 1) e = q;
  }
  // path: / ... with balanced parens
  let p = e;
  const openStack = [];
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c === 91 || c === 93) break;
    // '&' starting an entity-like reference ends the URL (gfm-627).
    if (c === 38 && isEntityStart(text, p, n)) break;
    if (c === 40) { openStack.push(p); p++; continue; }
    if (c === 41 && openStack.length > 0) { openStack.pop(); p++; continue; }
    p++;
  }
  let end = p;
  if (openStack.length > 0) end = openStack[0];
  while (end > pos) {
    const c = text.charCodeAt(end - 1);
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 42 || c === 95 || c === 126) { end--; continue; }
    if (c === 41) {
      let opens = 0, closes = 0;
      for (let q = pos; q < end; q++) {
        if (text.charCodeAt(q) === 40) opens++;
        else if (text.charCodeAt(q) === 41) closes++;
      }
      if (closes > opens) { end--; continue; }
    }
    break;
  }
  if (end <= pos) return null;
  return text.slice(pos, end);
}

// Match an inline HTML tag starting at pos (text[pos] === '<').
// Returns the tag string or null.
function matchHtmlTag(text, pos) {
  const n = text.length;
  const s = text.slice(pos);
  // comment
  if (s.startsWith('<!--')) {
    if (s.startsWith('<!-->') || s.startsWith('<!--->')) {
      return s.startsWith('<!--->') ? '<!--->' : '<!-->';
    }
    const e = s.indexOf('-->', 4);
    if (e !== -1) return s.slice(0, e + 3);
    return null;
  }
  // processing instruction
  if (s.startsWith('<?')) {
    const e = s.indexOf('?>', 2);
    if (e !== -1) return s.slice(0, e + 2);
    return null;
  }
  // CDATA
  if (s.startsWith('<![CDATA[')) {
    const e = s.indexOf(']]>', 9);
    if (e !== -1) return s.slice(0, e + 3);
    return null;
  }
  // declaration: <! + letter + [alnum-]* + whitespace + [^>]* + '>'
  if (s.startsWith('<!') && s.length > 2 && /[A-Za-z]/.test(s[2])) {
    let p = 3;
    while (p < s.length && /[A-Za-z0-9-]/.test(s[p])) p++;
    if (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n' || s[p] === '\r')) {
      const e = s.indexOf('>', p);
      if (e !== -1) return s.slice(0, e + 1);
    }
    return null;
  }
  // open/close tag
  let p = 0;
  if (s[0] !== '<') return null;
  p = 1;
  const isClose = s[p] === '/';
  if (isClose) p++;
  if (p >= s.length || !/[A-Za-z]/.test(s[p])) return null;
  while (p < s.length && /[A-Za-z0-9-]/.test(s[p])) p++;
  if (isClose) {
    // closing tag: only optional whitespace then '>' (no attributes, no '/')
    let q = p;
    while (q < s.length && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n' || s[q] === '\r')) q++;
    if (q < s.length && s[q] === '>') return s.slice(0, q + 1);
    return null;
  }
  // attributes
  for (;;) {
    // skip whitespace
    let q = p;
    while (q < s.length && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n' || s[q] === '\r')) q++;
    if (q >= s.length) return null;
    if (s[q] === '>') return s.slice(0, q + 1);
    if (s[q] === '/' && s[q + 1] === '>') return s.slice(0, q + 2);
    if (q === p) return null; // attribute must be preceded by whitespace
    if (s[q] === '`') return null; // backtick not allowed in a tag
    // attribute name
    if (!/[A-Za-z_:]/.test(s[q])) return null;
    p = q;
    while (p < s.length && /[A-Za-z0-9_.:-]/.test(s[p])) p++;
    const nameEnd = p;
    // optional whitespace, '=', value
    q = p;
    while (q < s.length && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n' || s[q] === '\r')) q++;
    if (q < s.length && s[q] === '=') {
      q++;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n' || s[q] === '\r')) q++;
      if (q >= s.length) return null;
      if (s[q] === '"' || s[q] === "'") {
        const qq = s[q];
        const e = s.indexOf(qq, q + 1);
        if (e === -1) return null;
        p = e + 1;
      } else {
        p = q;
        while (p < s.length && !/[ \t\n\r"'=<>`]/.test(s[p])) p++;
        if (p === q) return null;
      }
    } else {
      // valueless attribute: resume right after the name so the next loop
      // iteration still sees the whitespace that precedes the next attribute
      // (otherwise q === p wrongly rejects it, cm-616).
      p = nameEnd;
    }
  }
}

// Extended autolink: www. URL starting at pos. Returns the URL text or null.
function matchExtendedUrl(text, pos) {
  const n = text.length;
  let e = pos;
  // domain: labels of [A-Za-z0-9-]+ separated by '.', must contain a dot + TLD
  let lastDot = -1, hasDot = false;
  while (e < n) {
    const c = text.charCodeAt(e);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) { e++; continue; }
    if (c === 46) { // '.'
      // dot must be followed by a label char
      if (e + 1 < n) {
        const nc = text.charCodeAt(e + 1);
        if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122)) { hasDot = true; lastDot = e; e++; continue; }
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
    const c = text.charCodeAt(p);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c === 91 || c === 93) break;
    // '&' starting an entity-like reference ends the URL (gfm-627).
    if (c === 38 && isEntityStart(text, p, n)) break;
    if (c === 40) { openStack.push(p); p++; continue; }
    if (c === 41 && openStack.length > 0) { openStack.pop(); p++; continue; }
    p++;
  }
  let end = p;
  if (openStack.length > 0) end = openStack[0];
  // strip trailing punctuation: . , ; : ! ? and unbalanced ')'
  while (end > pos) {
    const c = text.charCodeAt(end - 1);
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 42 || c === 95 || c === 126) { end--; continue; }
    if (c === 41) {
      let opens = 0, closes = 0;
      for (let q = pos; q < end; q++) {
        if (text.charCodeAt(q) === 40) opens++;
        else if (text.charCodeAt(q) === 41) closes++;
      }
      if (closes > opens) { end--; continue; }
    }
    break;
  }
  if (end <= pos) return null;
  return text.slice(pos, end);
}

// Email autolink: text[i] === '@'. Returns { local, domain, end } or null.
// The local part must end exactly at i (it is the tail of the current text).
// hasUnderscoreOpener: an '_' emphasis opener exists before '@', so a
// trailing '_' in the domain is an emphasis closer, not a domain char.
function matchEmailBefore(text, i, hasUnderscoreOpener) {
  // scan the domain after '@'
  let e = i + 1;
  const n = text.length;
  let hasDot = false;
  while (e < n) {
    const c = text.charCodeAt(e);
    // A '_' that is the last domain char (next char is not a domain char)
    // is an emphasis closer, not part of the domain, when an '_' opener
    // exists before '@' (doc-31/37/38). Otherwise it is a domain char and
    // the endsWith('_') check below rejects the email (gfm-632).
    if (c === 95 && hasUnderscoreOpener) {
      // Skip a run of '_'s; if the char after the run is not a domain
      // char (alnum, '-', '.'), this run is the closing emphasis delimiter,
      // not part of the domain (doc-25: __...__).
      let q = e;
      while (q < n && text.charCodeAt(q) === 95) q++;
      const nc = q < n ? text.charCodeAt(q) : 32;
      const ncIsDomain = (nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122) || nc === 45 || nc === 46;
      if (!ncIsDomain) break;
    }
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) { e++; continue; }
    if (c === 46) {
      if (e + 1 < n) {
        const nc = text.charCodeAt(e + 1);
        if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122)) { hasDot = true; e++; continue; }
      }
      break;
    }
    break;
  }
  if (!hasDot) return null;
  const domain = text.slice(i + 1, e);
  // A domain ending in '-' or '_' is not a valid email (gfm-632).
  if (domain.endsWith('-') || domain.endsWith('_')) return null;
  // local part: scan backwards from i-1. A backslash escape in/before the
  // local part invalidates the email (e.g. foo\+@bar is not an email).
  let s = i - 1;
  while (s >= 0) {
    const c = text.charCodeAt(s);
    if (c === 92) return null; // backslash: escaped char, not an email
    // An '_' at a word boundary (preceded by whitespace or start of text)
    // is an emphasis delimiter, not part of the email local part
    // (doc-31/37/38: _warning when@..._); a '_' inside a word
    // (foo_bar@baz.com) IS part of the local part.
    if (c === 95) {
      const prev = s - 1 < 0 ? 32 : text.charCodeAt(s - 1);
      if (prev === 32 || prev === 9 || prev === 10) break;
    }
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 45 || c === 43) { s--; continue; }
    break;
  }
  const local = text.slice(s + 1, i);
  if (local === '' || local.startsWith('.') || local.endsWith('.') || local.indexOf('..') !== -1) return null;
  // strip trailing punctuation from domain
  let de = e;
  while (de > i + 1) {
    const c = text.charCodeAt(de - 1);
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63) { de--; continue; }
    break;
  }
  if (de <= i + 1) return null;
  return { local, domain: text.slice(i + 1, de), end: de };
}

// Plain-text rendering of inline nodes (for image alt text).
function plainTextOf(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') {
      // skip emphasis delimiter chars recorded in _ins (set by
      // processDelimiters); before that pass _ins is absent.
      const ins = nd._ins;
      if (!ins || ins.length === 0) { out += nd.s; continue; }
      const sorted = ins.slice().sort((a, b) => a.pos - b.pos);
      let last = 0;
      for (const it of sorted) {
        out += nd.s.slice(last, it.pos);
        last = it.pos + it.skip;
      }
      out += nd.s.slice(last);
    }
    else if (nd.t === 'raw') out += nd.s;
    else if (nd.t === 'code') out += nd.s;
    else if (nd.t === 'link' || nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') out += plainTextOf(nd.c);
    else if (nd.t === 'image') out += plainTextOf(nd.c || []);
    else if (nd.t === 'br' || nd.t === 'softbreak') out += '\n';
  }
  return out;
}

// Emphasis / strikethrough processing over the delimiter list.
// Records tag insertions on the delimiter text nodes (_ins).
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
          if (sp.oi > oi && sp.ci === ci - 1 && sp.closer.canOpen && sp.closer.ch === closer.ch && !sp.opener.canClose) { blocked = true; break; }
        }
        if (blocked) { oi--; continue; }
      }
      const tag = closer.ch === TILDE ? 'del' : (use === 2 ? 'strong' : 'em');
      if (use === 2 && closer.ch !== TILDE) strongSpans.push({ oi, ci, closer, opener });
      addInsertion(opener.node, opener.offset + opener.len - use, use, tag, true);
      addInsertion(closer.node, closer.offset, use, tag, false);
      opener.len -= use;
      closer.len -= use;
      closer.offset += use;
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

// Render inline nodes to HTML fragments (appended to out).
function renderInline(nodes, out) {
  for (const nd of nodes) {
    if (nd.t === 'text') {
      renderTextNode(nd, out);
    } else if (nd.t === 'raw') {
      out.push(nd.s);
    } else if (nd.t === 'code') {
      out.push('<code>');
      escapeCode(nd.s, out);
      out.push('</code>');
    } else if (nd.t === 'br') {
      out.push('<br>');
    } else if (nd.t === 'softbreak') {
      out.push('\n');
    } else if (nd.t === 'em') {
      out.push('<em>'); renderInline(nd.c, out); out.push('</em>');
    } else if (nd.t === 'strong') {
      out.push('<strong>'); renderInline(nd.c, out); out.push('</strong>');
    } else if (nd.t === 'del') {
      out.push('<del>'); renderInline(nd.c, out); out.push('</del>');
    } else if (nd.t === 'link') {
      out.push('<a href="');
      escapeText(nd.href, out);
      out.push('"');
      if (nd.title !== null && nd.title !== undefined) {
        out.push(' title="');
        escapeText(nd.title, out);
        out.push('"');
      }
      out.push('>');
      renderInline(nd.c, out);
      out.push('</a>');
    } else if (nd.t === 'image') {
      out.push('<img src="');
      escapeText(nd.src, out);
      out.push('" alt="');
      escapeText(plainTextOf(nd.c || []), out);
      out.push('"');
      if (nd.title !== null && nd.title !== undefined) {
        out.push(' title="');
        escapeText(nd.title, out);
        out.push('"');
      }
      out.push('>');
    }
  }
}
function renderTextNode(nd, out) {
  const s = nd.s;
  const ins = nd._ins;
  if (!ins || !ins.length) { escapeText(s, out); return; }
  // sort insertions by position
  ins.sort((a, b) => a.pos - b.pos);
  let i = 0;
  for (const insn of ins) {
    if (insn.pos > i) escapeText(s.slice(i, insn.pos), out);
    out.push(insn.isOpen ? '<' + insn.tag + '>' : '</' + insn.tag + '>');
    i = insn.pos + insn.skip;
  }
  if (i < s.length) escapeText(s.slice(i), out);
}

// ---------------------------------------------------------------- renderer

function renderDocument(parsed) {
  const { doc, refs } = parsed;
  const out = [];
  for (const child of doc.children) renderBlock(child, refs, out);
  return out.join('');
}

function renderBlock(node, refs, out) {
  switch (node.t) {
    case 'paragraph': {
      if (node._empty) break;
      const text = node._text !== undefined ? node._text : (node.strings ? node.strings.join('\n') : '');
      if (text === '') break;
      out.push('<p>');
      renderInline(parseInline(text, refs), out);
      out.push('</p>\n');
      break;
    }
    case 'heading': {
      const text = node._text || '';
      out.push('<h' + node._level + '>');
      renderInline(parseInline(text, refs), out);
      out.push('</h' + node._level + '>\n');
      break;
    }
    case 'code_fenced': {
      const lines = node.strings || [];
      out.push('<pre><code');
      if (node._info) {
        out.push(' class="language-');
        escapeText(node._info, out);
        out.push('"');
      }
      out.push('>');
      if (lines.length) {
        escapeCode(lines.join('\n') + '\n', out);
      }
      out.push('</code></pre>\n');
      break;
    }
    case 'code_indented': {
      const lines = node.strings || [];
      out.push('<pre><code>');
      if (lines.length) {
        escapeCode(lines.join('\n') + '\n', out);
      }
      out.push('</code></pre>\n');
      break;
    }
    case 'html': {
      const lines = node.strings || [];
      let html = lines.join('\n');
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
    case 'hr': {
      out.push('<hr>\n');
      break;
    }
    case 'blockquote': {
      out.push('<blockquote>\n');
      for (const child of node.children) renderBlock(child, refs, out);
      out.push('</blockquote>\n');
      break;
    }
    case 'list': {
      const ld = node._listData;
      out.push(ld.ordered ? '<ol' : '<ul');
      if (ld.ordered && ld.start !== 1) out.push(' start="' + ld.start + '"');
      out.push('>\n');
      for (const child of node.children) renderBlock(child, refs, out);
      out.push(ld.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'item': {
      out.push('<li>');
      const tight = node.parent._tight;
      // task list item? first child paragraph starting with [ ]/[x]/[X] + space
      let taskHtml = null;
      let firstPara = null;
      if (node.children.length && node.children[0].t === 'paragraph') {
        firstPara = node.children[0];
        const text = firstPara._text !== undefined ? firstPara._text : (firstPara.strings ? firstPara.strings.join('\n') : '');
        const m = /^\[( |x|X)\][ \t]+/.exec(text);
        if (m && text.slice(m[0].length) !== '') {
          taskHtml = (m[1] === 'x' || m[1] === 'X')
            ? '<input checked="" disabled="" type="checkbox">'
            : '<input disabled="" type="checkbox">';
          firstPara._text = text.slice(m[0].length);
        }
      }
      for (let k = 0; k < node.children.length; k++) {
        const child = node.children[k];
        if (child.t === 'paragraph' && tight) {
          if (k === 0 && taskHtml) { out.push(taskHtml); out.push(' '); }
          const text = child._text !== undefined ? child._text : (child.strings ? child.strings.join('\n') : '');
          if (text !== '') renderInline(parseInline(text, refs), out);
        } else if (child.t === 'paragraph' && k === 0 && taskHtml) {
          out.push('<p>');
          out.push(taskHtml); out.push(' ');
          const text = child._text !== undefined ? child._text : (child.strings ? child.strings.join('\n') : '');
          renderInline(parseInline(text, refs), out);
          out.push('</p>\n');
        } else {
          renderBlock(child, refs, out);
        }
      }
      out.push('</li>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < node._header.length; k++) {
        const align = node._align[k];
        out.push('<th');
        if (align) out.push(' align="' + align + '"');
        out.push('>');
        renderInline(parseInline(node._header[k], refs), out);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node._rows.length) {
        out.push('<tbody>');
        for (const row of node._rows) {
          out.push('<tr>\n');
          for (let k = 0; k < row.length; k++) {
            const align = node._align[k];
            out.push('<td');
            if (align) out.push(' align="' + align + '"');
            out.push('>');
            renderInline(parseInline(row[k], refs), out);
            out.push('</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
    default:
      break;
  }
}
