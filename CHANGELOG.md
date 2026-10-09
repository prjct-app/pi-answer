# Changelog

## 0.1.6 (2026-10-09)

- The answer policy lives in the tool description. The tool no longer adds a snippet or guidelines to the system prompt of every request.

## 0.1.4 (2026-10-06)

- Require the lossless shared reply implementation. Invalid evidence remains visible for model correction; fallback preserves every value.

## 0.1.3 — 2026-10-06

- Normal prose completes a turn by default. Structured answer enforcement is explicit, and only valid reply JSON is repaired into a tool call.
