# shared

**Phase 0 (built).** Cross-cutting code that isn't in the brief's layout (see decision D-013).

- `logger.ts`: pino JSON logs with service, level label and ISO time, plus key-based redaction of credentials.
- `correlation.ts`: `withCorrelationId(id, fn)` puts an id on every log line inside `fn`, across awaits. Inbound ids that could inject log content are replaced with a UUID.
