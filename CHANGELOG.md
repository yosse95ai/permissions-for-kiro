# Changelog

All notable changes to this extension are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). **While the version is below `1.0.0`, expect the view to keep moving.** The extension reproduces internals of Kiro itself and has to follow them as they change.

## 0.1.0 - 2026-08-13

Initial release.

### Added

- `PERMISSIONS` view in the Kiro sidebar, listing the permission rules in effect for every workspace root and for the user profile
- Three levels of detail: scope, rule (capability and effect), and individual `match` / `exclude` patterns
- Clicking a row without children opens the settings file at the line that defines it
- Pencil icon on a scope row opens that scope's settings file, creating it if it does not exist yet
- Automatic reload when a settings file changes, including edits made outside the editor
- Rules that Kiro skips because of an unknown capability are marked as such, so a rule with no effect can be told apart from one that applies
- A warning on the scope when the whole configuration fails to load, in which case Kiro applies no rule from it at all
- YAML and JSON parse errors, reported with the line that caused them
- Support for `permissions.json` alongside `permissions.yaml`, and for multi-root workspaces
- Japanese UI, with English used for every other locale
