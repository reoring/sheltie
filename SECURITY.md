# Security Policy

## Supported line

Sheltie is an experimental local PoC. The supported line is the current `main` branch and its current experimental 0.1.x development line. Older revisions are not supported.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/reoring/sheltie/security/advisories/new).

Do **not** open a public issue, pull request, discussion, or public proof-of-concept for a security vulnerability before coordinated disclosure. A private report should include:

- a concise impact statement;
- affected revision or commit, if known;
- clear reproduction steps or a minimal proof of concept;
- any relevant configuration assumptions; and
- a safe contact method for follow-up.

Do not include credentials, private state databases, socket paths, message bodies, Agent identities, or other sensitive local data unless the maintainer explicitly requests a safe sharing path.

## What to expect

Maintainers will review private reports when they can, may ask for clarification or a minimal reproduction, and will validate the impact before coordinating a fix, mitigation, and disclosure. The project makes no response-time, remediation-time, availability, or support SLA.

## Scope and boundaries

Security-relevant areas include state-directory ownership and permissions, Agent caller authentication, manifest authorization, durable message lifecycle, cleanup target validation, and safe public output.

Sheltie is not a hard security boundary against another process running as the same Unix user with access to the state database, filesystem, or Herdr socket. The current implementation is intentionally constrained to the exact compatible Herdr runtime: public `reoring/herdr` revision `dda3fb5a99752948c87214d79e8b218e3a5b4078`, version 0.8.0, protocol 20.

For development expectations, see [CONTRIBUTING.md](CONTRIBUTING.md).
