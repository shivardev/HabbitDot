# Security Policy

## Supported version

Security fixes target the latest version on the default branch.

## Reporting a vulnerability

Please do not publish vulnerabilities, private user data, or proof-of-concept exploits in a public issue. Use the repository host's private security-advisory feature to report the issue, including:

- the affected version or commit;
- reproduction steps;
- the expected impact; and
- any suggested mitigation.

Maintainers should acknowledge a complete report promptly and coordinate disclosure after a fix is available.

## Security model

HabbitDot is local-first. Habit records and completion history are stored in the app's local SQLite database. The project does not require an account, analytics service, or remote API. Forks that introduce networking must document the data transmitted and protect it in transit and at rest.
