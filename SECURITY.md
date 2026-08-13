# Security Policy

## Supported versions

This extension is at `0.x`, so only the latest release receives fixes. Please reproduce an issue on the newest version before reporting it.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Report it privately instead: open the [Security tab](https://github.com/yosse95ai/permissions-for-kiro/security) of this repository and use **Report a vulnerability**. Only the maintainer sees the report.

Please include the extension version, your Kiro version and operating system, and the steps to reproduce. **Redact your file paths and the contents of your permission settings** — they contain your user name, and the structure alone is usually enough to reproduce a problem.

This is a personal project, so reports are handled on a best-effort basis. Expect an acknowledgement within a couple of weeks. If a fix is needed, it ships as a patch release and the advisory is published afterwards.

## What the extension does and does not do

Useful context when judging whether something is a security issue.

| Behaviour        | Detail                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reads            | `permissions.yaml` and `permissions.json` under `~/.kiro/settings/` and `~/.kiro/workspace-roots/<hash>/`, plus `.trust-migration.json` in the same directories when a hash cannot be resolved |
| Writes           | Only one case: using the pencil icon on a scope with no settings file creates that file containing `rules: []`                                                                                 |
| Network          | **None.** The extension makes no network requests                                                                                                                                              |
| Telemetry        | **None.** Nothing is collected or transmitted                                                                                                                                                  |
| Permission rules | **Read only.** The extension never adds, edits, or removes a rule, and it does not influence what Kiro allows or denies                                                                        |

**The view is a display of Kiro's configuration, not an enforcement point.** If the tree shows something different from what Kiro actually applies, that is a correctness bug worth reporting as a mismatch — but it does not change Kiro's behaviour, since Kiro reads the same files independently.
