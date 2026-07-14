# Contributing

Codex IM Gateway is currently in pre-alpha implementation. Contributions that
validate the assumptions in `PLAN.md`, improve the threat model, or add
reproducible protocol and adapter fixtures are especially useful.

## Before opening a change

1. Search existing issues and discussions.
2. Keep changes focused on one behavior or decision.
3. Open an issue first for protocol, persistence, security-boundary, or adapter
   API changes.
4. Never include real bot tokens, Codex credentials, prompts, transcripts, or
   private workspace paths in tests or documentation.

## Development expectations

Once implementation begins, every change should include appropriate tests and
must pass formatting, linting, type checking, unit tests, and relevant
integration tests.

Use Conventional Commits for commit messages, for example:

```text
feat(router): bind replies to originating Codex threads
fix(delivery): recover expired event leases
docs(security): document Telegram token rotation
```

## Pull requests

- Explain the user-visible behavior and failure behavior.
- Identify any trust-boundary or data-migration impact.
- Include verification steps.
- Update `PLAN.md` or an ADR when a design decision changes.
- Keep credential-dependent end-to-end tests opt-in.

By contributing, you agree that your contribution is licensed under the MIT
License.
