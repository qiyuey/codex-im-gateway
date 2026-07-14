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

Safe deployments must use private, allowlisted chats; restricted workspaces; a
local app-server transport; an unprivileged service account where practical;
and the narrowest useful Codex sandbox. Full-access execution must never be
enabled through an IM command.

