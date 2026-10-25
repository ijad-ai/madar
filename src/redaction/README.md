# redaction

**Phase 3.** Content redaction applied before tool output reaches the model, before audit writes and before Slack posts: token patterns, high-entropy strings, exact matches against values held in the vault, and the PII rules in `docs/data-handling.md`.

The logger's key-based redaction in `src/shared/logger.ts` is a backstop, not a substitute.
