# Security Policy

## Supported versions

The project has not published a stable release. Security fixes will target the
latest development branch until a version support policy is announced.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities that could expose credentials,
workspace files, Codex conversations, or remote command execution.

Until private GitHub security reporting is configured, contact the maintainer
privately at `1123274330@qq.com`. Include a concise description, affected
revision, reproduction steps, and impact. Do not include real secrets or private
user data.

You should receive an acknowledgement within seven days. Publication timing
will be coordinated after a fix or mitigation is available.

## Security posture

This software is remote-control software. Anyone authorized to send accepted IM
messages may be able to cause Codex to read or modify files and run commands
within configured permissions.

Gateway-originated turns run with `danger-full-access`. Safe deployments must
therefore use a dedicated bot restricted to one private Telegram user, protect
that Telegram account and bot token as remote host credentials, retain the local
app-server transport and kill switch, and use an unprivileged service account or
dedicated host where practical. No IM command can change the permission mode.
