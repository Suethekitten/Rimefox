# Fixed link-order responses

These HTML and JSON files are byte-for-byte copies from the independent QA clone
`edge-bilingual-qa-0122/qa/pages/` and `qa/replies/`, tested at
`813c87f6a2703aa88c42ec8480a79ff0490efc58`. The QA clone remains unchanged.

The original report is `qa/QA-REPORT-LINK-ORDER-0.12.2.md` in that clone. The HTML
contains the English and Arabic Wikipedia AI lead paragraphs; it is a frozen DOM
fixture, not a request to those websites. `order-*` contains Control, Reorder,
Tail, and MissingOne; `ar-*` contains the Arabic Control and Reorder responses.

Run `node tools/e2e-link-order.mjs`. It loads the actual unpacked extension in an
isolated Chrome profile, serves these pages and recorded responses locally, and
checks visible text and href correspondence, failure state, event/node identity,
cache reuse on mode changes, dynamic replacement, and exact restoration. No paid
API or external page is used. Output JSON and screenshots go to a temporary
directory, or the directory supplied with `--out`.
