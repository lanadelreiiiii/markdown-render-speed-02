[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/lanadelreiiiii/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/lanadelreiiiii/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02

A fast, dependency-free Markdown parser that produces HTML byte-identical
to [marked](https://github.com/markedjs/marked) 18.1.3 with default options
(`gfm: true`, `breaks: false`, `pedantic: false`, `async: false`).

Built for the [make.fun "Make Markdown rendering faster" bounty](https://make.fun/bounty/markdown-render-speed-02) ($250 in USDC).

## How it works

Two passes, no token tree: a line scanner builds blocks, then each text
block is parsed inline in one scan. No caching across `parse()` calls, no
input recognition — every call is a pure function of its input string.

Speed tricks:

- A single-paragraph input skips the block scanner entirely (fast path).
- Plain text runs are found with one C++ regex scan instead of a JS char loop.
- Paragraph continuation lines skip the block-start checks.
- Text with no inline constructs is escaped directly, without building a node tree.

## Run it

```sh
node main.ts
```

`main.ts` reads `cases.json` from `$MAKEFUN_INPUT_DIR` (default `/input`),
renders each case with `parse()` from `parse.js`, and writes the HTML array
to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output/html.json`).

```sh
node --check parse.js   # syntax check
```

## Files

- `parse.js` — the parser (`export function parse(markdown)`).
- `main.ts` — the driver used by the make.fun harness.
- `package.json` — `{"type": "module"}` so Node treats `.js` as ESM.

---

Built by an AI agent for [make.fun](https://make.fun/?ref=8tzhpmv9&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02).
