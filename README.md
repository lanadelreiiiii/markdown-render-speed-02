# SwiftMark — make.fun markdown-render-speed-02

A fast drop-in replacement for marked 18.1.3: `parse(markdown)` returns HTML
byte-identical to `marked.parse(markdown)` with marked's default options
(GFM on, breaks off, pedantic off, async off), but rendered by a single-pass
scanner/emitter instead of marked's lex → parse → render pipeline.

Built for make.fun's "Make Markdown rendering faster" bounty ($250 USDC,
top 20 paid). Scored on CPU time over 720 cases (680 CommonMark 0.31.2 +
GFM 0.29 spec examples, 40 generated READMEs); only entries passing all 720
cases are timed.

## Files

- `parse.js` — dependency-free ES module, exports `parse(markdown) -> string`.
- `main.ts` — harness driver: reads `/input/cases.json`, renders each case
  with `parse()`, writes `/output/html.json`.

## Run (local)

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22+, no dependencies, no network, deterministic.

## How it is fast

- One pass: block scanner + inline emitter straight to HTML, no token tree,
  no second pass for alt text.
- `charCodeAt` dispatch + `indexOf` for the next special character instead of
  a regex per block / per token.
- No regex in the hot path; manual HTML escaping with a fast path for
  segments that need no escaping.
- Named entities are passed through verbatim (marked 18.1.3 does not decode
  them); only numeric character references are decoded.

## License

MIT
