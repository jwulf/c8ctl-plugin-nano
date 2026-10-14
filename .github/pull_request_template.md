<!-- Describe the change and link the issue it closes (e.g. `Closes #123`). -->

## Parity with the Rust supervisor (`nanobpm/nano-supervisor`)

The Rust re-implementation mirrors this worker. If this PR **changes
engine-observable worker behaviour**, it must land a disposition in the
nano-supervisor parity ledger (`contract-tests/PARITY.md`, nanobpm/nano-supervisor#57)
so the port is never silently missed. Tick exactly one:

- [ ] **contract test added** — the behaviour is pinned in `nano-supervisor/contract-tests` (link it).
- [ ] **nano-supervisor issue linked** — a Rust-side gap issue tracks the port (link it).
- [ ] **n/a** — not an engine-observable worker-contract change (say why).

If this is a behaviour change, also apply the **`behaviour-change`** label so the
nano-supervisor `parity-ledger` CI gate sees it.
