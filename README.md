# markdown-render-speed-02

A fast, dependency-free Markdown parser that produces HTML byte-identical
to [marked](https://github.com/markedjs/marked) 18.1.3 with default options
(`gfm: true`, `breaks: false`, `pedantic: false`, `async: false`).

Built for the make.fun `markdown-render-speed-02` competition: parse 720
cases (680 CommonMark 0.31.2 + GFM 0.29 spec examples and 40 generated
README documents) and be faster than the marked baseline.

## Files

- `parse.js` — the parser. A single exported function `parse(markdown)`
  that returns an HTML string. ES module, no dependencies, no caching
  across calls, no input recognition: every call is a pure function of
  its input string.
- `main.ts` — the competition driver. Reads `MAKEFUN_INPUT_DIR` /
  `MAKEFUN_OUTPUT_DIR` (defaulting to `/input` and `/output`), parses
  every case in `cases.json` in order, and writes `html.json`.
- `package.json` — `{"type": "module"}` so Node loads the ES modules
  without the typeless-package reparse warning.
- `LICENSE` — MIT.

## How it works

Two passes, no token tree:

1. **Block scan.** A single line scanner walks the document once,
   matching open containers (blockquote, list item) per line, then
   deciding the block type (ATX/setext heading, fenced/indented code,
   HTML block, thematic break, list, table, paragraph). Blocks store
   their raw lines; link reference definitions are stripped from
   paragraphs at finalisation time.
2. **Inline parse.** Each paragraph/heading/table cell is parsed inline
   in one left-to-right scan: backslash escapes, code spans, autolinks
   (angle, `www.`, scheme, email), HTML tags, links/images with
   reference lookup, and emphasis/strikethrough via a delimiter list
   processed in closer order (CommonMark rules, including the rule of
   3 and link/image scoping). Output is emitted as string fragments
   joined once.

Hot-path choices: a single-paragraph fast path that skips the block
scanner; plain-text runs found with one C++ regex scan instead of a
JS char loop; plain paragraph continuations skip the block-start
checks (plus an ultra-fast path for top-level paragraphs); text with
no inline construct is escaped directly without building a node tree;
dispatch on `charCodeAt`, `indexOf` instead of regex, manual HTML
escaping with a fast path for plain text, and a single `join` per
document. CR normalisation is skipped when the input holds no `\r`,
and link-label backtick scans are skipped when the label holds no
backtick.

## Correctness notes (verified by black-box probing against marked)

- Only numeric character references are decoded (`&#65;` → `A`,
  `&#x41;` → `A`, invalid/surrogate → U+FFFD). Named entities such as
  `&copy;` pass through verbatim.
- GFM tables, task-list checkboxes, and strikethrough are supported.
  Headings have no `id`. Raw HTML blocks (including `<script>`,
  `<style>`, `<title>`) are rendered as-is.
- Tabs: a leading tab on a paragraph continuation line expands
  relative to the enclosing list-item indents; tabs inside fenced and
  indented code expand per container rules; a backtick fence strips up
  to its indent from content lines (counted in characters at column
  0), while a tilde fence never strips its indent.
- An unclosed `<a href>` suppresses GFM extended autolinks for the
  rest of the document (until `</a>`); a bare `<a>` or self-closing
  `<a />` does not, unless another tag follows it in the paragraph.

## Testing

Practice set (from the competition kit):

```bash
K=/path/to/markdown-render-speed-02-kit
mkdir -p /tmp/mdtest/in /tmp/mdtest/out /tmp/mdtest/scores
cp "$K/practice/input/cases.json" /tmp/mdtest/in/cases.json
MAKEFUN_INPUT_DIR=/tmp/mdtest/in MAKEFUN_OUTPUT_DIR=/tmp/mdtest/out node main.ts
MAKEFUN_OUTPUT_DIR=/tmp/mdtest/out \
  MAKEFUN_REFERENCE_DIR="$K/practice/reference" \
  MAKEFUN_SCORES_DIR=/tmp/mdtest/scores \
  node "$K/program/scorer/main.ts"
cat /tmp/mdtest/scores/scores.json
```

Local result: **720/720 cases pass** on the practice set, deterministic
(two driver runs produce byte-identical `html.json`).

## Timing

Measure with `process.cpuUsage()` around the parse loop (1 warmup run
+ 5 timed runs, median), separately for the 680 spec cases and the 40
documents, and always compare against the marked baseline on the same
machine and command. Report speedup (baseline CPU / entry CPU), not
absolute milliseconds.

Local result (shared VM, noisy — median of 3 runs): **~2.5x overall**
(entry ~317 ms vs baseline ~810 ms CPU for all 720 cases), **~2.0x on
the 40 documents**, **~0.6x on the 680 spec cases** (slower than marked
on tiny inputs: per-call overhead dominates there). The 3x target was
not reached: the documents dominate total time (~290 ms of ~317 ms)
and sit at ~2.0x, while the spec cases drag the overall down. Further
gains would need a structural change to the inline parser (direct
emission without a node tree), which was not attempted in this round.

## License

MIT. See `LICENSE`.
