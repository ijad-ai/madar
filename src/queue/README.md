# queue

**Phase 1.** BullMQ producers and workers with strict per-thread ordering (one run per thread at a time) and a global concurrency limit. Run semantics follow decision D-004.

**Phase 5.** A run waiting for approval frees its worker but keeps its thread lock. New messages in that thread queue behind it, and `stop` cancels the pending approval.
