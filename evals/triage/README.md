# Triage eval set

Historical Playwright failures, anonymized and labeled by two people, used to score the Phase 4 triage pilot.

| File                                 | What it is                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| [rubric.md](rubric.md)               | The five classes, the decision order and tie-breaks                                 |
| [anonymization.md](anonymization.md) | What to replace before a record is committed                                        |
| [schema.ts](schema.ts)               | The record schema and the leak guard                                                |
| `records/`                           | Real labeled failures (**0 so far**; 10 is the Phase 0 target, 50 the Phase 4 gate) |
| `fixtures/`                          | Two synthetic records that exercise the schema; they never count                    |

## Adding a failure

1. **Pick.** Spread picks across repos, months and all five classes. Include hard cases, not just obvious ones.
2. **Anonymize** following [anonymization.md](anonymization.md).
3. **Label independently.** Two labelers each read the evidence and pick a class from [rubric.md](rubric.md), with a confidence and a one-line rationale. Neither sees the other's label first.
4. **Adjudicate disagreements.** A third person picks the final class and writes why. Disagreements stay in the record; they show where the rubric is unclear.
5. **Commit** as `records/tri-NNNN.json` in a PR. CI validates the schema and runs the leak guard; the anonymization reviewer approves the PR.

Phase 4's eval harness reports agreement between labelers as well as the model's precision and recall per class.
