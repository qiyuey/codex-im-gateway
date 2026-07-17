---
name: release
description: "Publish the Codex IM plugin through a guarded end-to-end release workflow: refresh the plugin cachebuster, reproduce CI locally, commit and push with Conventional Commits, reinstall and verify the exact local plugin cache, restart and verify the gateway daemon and migrations, and monitor the matching GitHub Actions run to completion. Use only when the user explicitly asks to release, publish, ship, or deploy the current repository changes; this skill performs git pushes, changes the locally installed plugin, and restarts the gateway daemon."
---

# Release Codex IM

Run the stages below in order. Treat the commit SHA and manifest version as the release identity.
Do not claim success unless exact-cache application, post-restart runtime activation, end-to-end
delivery, and remote CI all succeed.

## 1. Guard the release scope

1. Work from the repository root containing `package.json` and `.codex-plugin/plugin.json`.
2. Inspect `git status --short`, the current branch, remotes, upstream, and any in-progress
   merge or rebase. Stop for unresolved conflicts, a detached HEAD, missing `origin`, or missing
   GitHub authentication.
3. Review the tracked diff and the contents of every untracked file, not only their names. Never
   include `.env`, credentials, tokens, transcripts, private workspace paths, or generated secrets.
   If unrelated user changes make the release scope ambiguous, ask before staging them; never
   discard them.
4. Fetch `origin`. If the current branch has an upstream, synchronize with
   `git pull --rebase --autostash` before changing the manifest. Resolve failures without rewriting
   published history.

## 2. Prepare and reproduce CI locally

1. Run `node .agents/skills/release/scripts/update-cachebuster.mjs .`. This replaces the manifest build
   suffix with `+codex.<UTC timestamp>` while preserving the base version. Do this before checks
   and commit so the locally installed version is also the committed, CI-tested version.
2. Inspect `.github/workflows/ci.yml` and `package.json`, then compare the local Node and pnpm
   versions with the versions declared by CI. Run CI with its declared tool versions without
   changing repository configuration merely to hide an existing version mismatch. If the exact
   CI toolchain cannot be used, stop and report the drift; do not describe a different toolchain
   as a local reproduction. With the matching toolchain, run the workflow's verification commands:

   ```bash
   pnpm install --frozen-lockfile
   pnpm check
   ```

3. Stop immediately on failure. Fix only issues within the requested release scope, rerun the
   complete check, and do not push a failing tree.
4. Inspect `git diff --check`, `git status --short`, and `git diff --stat` after checks. Compare the
   resulting file inventory with the scope already reviewed in stage 1. Confirm the cachebuster is
   the only mechanical release mutation and no check produced unintended files; re-read content
   here only for new or unexpectedly changed paths, because the authoritative full patch review
   happens after staging.

## 3. Commit and push

1. Stage the agreed release scope. Use `git add -A` only after confirming every current change
   belongs in this release.
2. Review `git diff --cached --check`, `git diff --cached --stat`, and the complete staged diff.
   Treat this as the authoritative release patch: it includes newly added files and must exactly
   match the agreed scope.
3. Create a concise Conventional Commit message that describes the substantive change. Use
   `chore(release): refresh plugin build` only when the cachebuster is the sole change. Do not amend
   or bypass hooks.
4. Capture `release_sha=$(git rev-parse HEAD)` and
   `release_version` from `.codex-plugin/plugin.json`, then push the current branch to `origin`.
   Set its upstream on the first push when necessary.
5. Confirm the pushed remote ref resolves to `release_sha`. Stop the publishing stage if it does
   not.

## 4. Apply the exact build and restart the daemon locally

Local application must use the marketplace entry that already points at this checkout.

1. Read `codex plugin list --available --json`, but filter the JSON before displaying it so only
   `codex-im` entries consume context. Also read `codex plugin marketplace list --json`.
   Find exactly one entry whose `source.source` is `local`, whose source path resolves through
   `realpath` to the current repository root, and whose marketplace has a local filesystem root
   that contains that source path. Do not infer identity from the plugin name alone, and do not
   edit marketplace JSON or Codex config by hand.
2. If no exact local source match exists, record local application as failed and continue to CI
   monitoring; do not install a similarly named or remote plugin.
3. Reinstall from the matched marketplace:

   ```bash
   codex plugin add codex-im@<marketplace-name> --json
   ```

4. Re-read `codex plugin list --json`. Verify the plugin is installed and enabled, its resolved
   source is this checkout, and its installed version equals `release_version`. Capture the exact
   installed cache root for that version. Read its `.codex-plugin/plugin.json` and require the same
   version. Compare SHA-256 hashes between the checkout and installed cache for the manifest and
   these runtime entry points:

   - `dist/daemon.js`
   - `dist/cli.js`
   - `dist/mcp/server.js`
   - `dist/hooks/stop.js`

   Treat a missing file, version mismatch, or hash mismatch as a failed local application. The
   marketplace source path alone does not prove that Codex copied the current build into its cache.
5. Inspect lifecycle hooks with Codex `/hooks`. If the `codex-im` Stop hook is new or changed,
   review its exact source and command before trusting it. Require the reviewed command to invoke
   `$PLUGIN_ROOT/dist/hooks/stop.js` and use the expected Codex IM data directory. Do not trust
   unrelated pending hooks. Treat an untrusted or unverifiable Codex IM hook as a failed local
   application; a healthy daemon alone does not prove completion capture works.
6. Only after the exact plugin, cache, and hook verification succeeds, inspect the macOS launchd
   service `gui/$(id -u)/com.qiyuey.codex-im`. Require its program arguments to invoke the current
   repository's `dist/daemon.js`; a similarly named service or a daemon path from another checkout
   does not apply this release. Then restart that exact service:

   ```bash
   service_target="gui/$(id -u)/com.qiyuey.codex-im"
   before_state=$(launchctl print "$service_target")
   before_pid=$(printf '%s\n' "$before_state" | awk '/^[[:space:]]*pid = / {print $3; exit}')
   test -n "$before_pid"
   launchctl kickstart -k "$service_target"

   after_pid=
   restart_verified=false
   for attempt in 1 2 3 4 5 6 7 8 9 10; do
     after_state=$(launchctl print "$service_target" 2>/dev/null || true)
     after_pid=$(printf '%s\n' "$after_state" | awk '/^[[:space:]]*pid = / {print $3; exit}')
     if test -n "$after_pid" && test "$after_pid" != "$before_pid" && \
       printf '%s\n' "$after_state" | grep -q 'state = running' && \
       printf '%s\n' "$after_state" | grep -q 'last exit code = 0' && \
       node dist/cli.js health | jq -e '.status == "ok"' >/dev/null; then
       restart_verified=true
       break
     fi
     sleep 1
   done
   test "$restart_verified" = true
   ```

   - require `launchctl print` for that exact service target to succeed before restarting;
   - capture its current PID, run `launchctl kickstart -k` for the exact target, then poll briefly;
   - require a new non-empty PID, `state = running`, and `last exit code = 0`;
   - run `node dist/cli.js health` from the repository root and require `status = ok`;
   - do not fall back to killing a process discovered by name or to restarting a similarly named
     service.

7. After the new PID is healthy, verify runtime activation rather than stopping at process health:

   - re-read `schema_migrations` from the database path returned by `node dist/cli.js health`;
   - if this release adds migrations, require every new migration version and name to be present;
   - verify the concrete columns, indexes, or triggers introduced by those migrations with SQLite
     schema inspection, and require `PRAGMA integrity_check` to return `ok`;
   - inspect the installed daemon bundle for a distinctive symbol from the released behavior when
     the release changes runtime routing or storage, so an old cached bundle cannot masquerade as
     a successful restart;
   - run `node dist/cli.js health` again and require `status = ok`, `runtime.running = true`,
     `runtime.appServerConnected = true`, and `runtime.pid = after_pid`.

   Poll briefly for migrations and heartbeat updates after restart instead of treating the first
   pre-initialization snapshot as final. Do not report local activation from the base runtime
   version alone because the cachebuster is intentionally outside that value.
8. Run one minimal real Codex task only after the restart and migration checks pass. Verify its
   top-level completion produces a new delivered event in the gateway database with the same
   thread ID. This intentionally sends one Telegram test card and validates the installed Stop
   hook -> queue -> newly restarted daemon -> Telegram path; do not use `gateway_enqueue` as a
   substitute.
9. If the exact cache, service, migration, health, or end-to-end verification fails, record local
   application as failed and continue to CI monitoring so the remote result is still reported. Do
   not claim the release succeeded.
10. Tell the user to start a new Codex task to load the refreshed skill and MCP bundle.

## 5. Monitor the matching CI run

1. Search by the exact pushed SHA, not merely by branch or latest run:

   ```bash
   gh run list --workflow ci.yml --commit "$release_sha" \
     --json databaseId,status,conclusion,url,headSha,event --limit 10
   ```

2. GitHub may take time to create the run. Poll briefly until a run with
   `headSha == release_sha` appears. Determine triggers from the current workflow rather than
   assuming every branch push creates a run. If no matching run is expected, report the release
   as incomplete because remote CI did not succeed; never watch an unrelated run or imply that the
   pushed commit was rolled back.
3. Watch the selected run to a terminal state:

   ```bash
   gh run watch <run-id> --compact --exit-status
   ```

4. On failure, run `gh run view <run-id> --log-failed`, report the failed job and relevant error,
   and leave the release incomplete. Do not make a follow-up commit unless the user asks for a fix.

## Result contract

Report all of the following in the final response:

- branch, commit SHA, Conventional Commit subject, and pushed remote;
- manifest version and local plugin application status;
- installed cache root and exact-artifact hash verification status;
- lifecycle Hook trust and end-to-end completion delivery status;
- daemon restart status, including the old and new PID when successful;
- migration and post-restart runtime activation status;
- CI run URL and terminal conclusion, or the precise reason no matching run exists;
- the required new-task pickup step;
- any partial failure after the push, without implying that the remote commit was rolled back.

Call the release successful only when exact local plugin application, the verified daemon restart,
and the matching remote CI run all succeed. A missing or non-triggered CI run is an incomplete
release, not a successful one.
