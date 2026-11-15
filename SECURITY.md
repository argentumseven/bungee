# Reporting a security concern

The [security design](docs/SECURITY.md) documents Bungee's trust boundaries and [validation record](docs/VALIDATION.md) separates automated checks from physical-device evidence. No independent security audit is documented.

Please avoid putting exploit details, household data, locations, photos, credentials, keys or pairing invitations in a public issue. Use this repository's **Security → Advisories → Report a vulnerability** private-reporting option if it is available. If it is unavailable, open an issue asking the maintainer for a private reporting channel without including the vulnerability details or sensitive data.

Include affected versions/source commits, the component, a minimal reproduction with synthetic data, expected/actual behavior and the security impact. There is no published response-time guarantee or paid bounty. Use the normal issue tracker for non-security bugs.

Follow current main/release updates; historical APKs and old disposable signing identities are not maintained as separate security branches. Update the server and matching phone app together using [the installation guide](docs/INSTALL.md#update-from-github).
