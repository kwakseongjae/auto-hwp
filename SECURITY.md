# Security Policy

auto-hwp parses complex document files, renders document-derived SVG, and optionally forwards a bounded document context
to a host-owned AI proxy. Reports that cross any of those trust boundaries are especially valuable.

## Supported versions

| Version | Security fixes |
|---|---|
| Latest public npm stable (`0.0.4`) | Supported |
| `main` | Best effort; not a stable release |
| Older npm releases | Not supported; reproduce on the latest stable first |

## Report a vulnerability privately

Do not open a public issue containing an exploit, a confidential document, credentials, or personal information. Use
[GitHub Private Vulnerability Reporting](https://github.com/kwakseongjae/auto-hwp/security/advisories/new) instead.

Include only the smallest safe reproduction:

- affected package, crate, route, and version or commit;
- impact and required preconditions;
- a minimal synthetic file or test case, never a real confidential HWP/HWPX;
- steps to reproduce and any proposed mitigation.

The maintainers aim to acknowledge a report within 3 business days and provide an initial triage within 7 business days.
These are best-effort targets for a volunteer project, not a service-level agreement. We coordinate disclosure after a fix
or mitigation is available and credit reporters who want to be named.

## In scope

- parser crashes or memory/resource exhaustion caused by an untrusted HWP/HWPX;
- script execution or sanitizer bypass in document-derived SVG/HTML;
- document or AI-context transmission without the documented consent boundary;
- Intent validation bypass, path traversal, command injection, or container escape;
- leaked keys, release artifacts that do not match source, and dependency/supply-chain compromise.

Ordinary fidelity bugs, unsupported document features, and public API questions belong in the normal issue tracker. Please
follow [SUPPORT.md](./SUPPORT.md) to choose the right channel.

## Safe research

Good-faith research that avoids privacy violations, service disruption, persistence, and unnecessary data access is
welcome. Stop after demonstrating impact, keep all obtained data private, and give the project reasonable time to respond.
