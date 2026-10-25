# Anonymization procedure (v1)

Every record states `"procedureVersion": 1` and names a reviewer who checked it against this list. The leak guard in CI (`findLeaks` in `schema.ts`) is a second check, not a replacement.

## Before you start

- Keep the mapping from real values to aliases (repo names, run ids) **outside this repo**, in your team's secure storage. Anyone with the mapping can de-anonymize the dataset.
- If you find a live secret in a CI log, **do not commit the record**. Report the secret so it is rotated, then continue with another failure.

## Replace

| Real value                                                             | Replace with                                                       | Example                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Repo name                                                              | An alias                                                           | `repo-checkout-web`                    |
| CI run id                                                              | `run-` + the first 12 hex characters of a salted SHA-256 of the id | `run-3f9a0c41be72`                     |
| Failure date                                                           | Year and month                                                     | `2026-09`                              |
| People: names, usernames, emails                                       | Remove; labelers and reviewers are `L1`, `L2`, …                   |                                        |
| Hostnames                                                              | `*.example.test` names that keep the role                          | `sso.example.test`, `api.example.test` |
| IP addresses                                                           | Documentation ranges                                               | `192.0.2.10`                           |
| Customer or patient data in logs (names, ids, addresses, card numbers) | Obvious placeholders                                               | `Jane Doe`, `ACCT-0000`                |
| Unreleased product or feature names                                    | A generic description                                              | `the new checkout flow`                |
| File paths                                                             | Keep the structure; alias identifying segments                     | `tests/checkout/apply-coupon.spec.ts`  |

## Keep

Error messages, stack shapes, retry outcomes and selectors, as far as the replacements above allow. These are what the labels depend on.

## Artifacts

Phase 0 records carry no artifacts. Traces, screenshots and videos may only be added under `artifacts/` after the Phase 3 trace scrubber exists, and only scrubbed copies.

## Review

A second person (`reviewedBy`) reads the whole record against this list before the PR merges. CI runs the leak guard on every record.
