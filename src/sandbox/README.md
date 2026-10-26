# sandbox

**Phase 2.** The `SandboxProvider` interface (`create`, `exec`, `readFile`, `writeFile`, `destroy`, `status`) and its Docker implementation with the global hardening: non-root, no capabilities, read-only root, tmpfs mounts, resource limits, gVisor where available (decision D-006).

Lifecycle: lazy create, reuse within a thread, idle TTL, hard maximum lifetime, a reaper for crashes, and a workspace volume whose TTL is separate from the container's.
