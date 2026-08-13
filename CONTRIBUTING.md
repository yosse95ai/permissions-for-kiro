# Contributing

Thanks for taking an interest in this extension. Issues and pull requests are both welcome.

This is a small project maintained by one person in their spare time, so responses may take a while. Please read [the Code of Conduct](./CODE_OF_CONDUCT.md) before taking part.

## Reporting an issue

Pick the template that matches what you found.

| Template            | Use it for                                                           |
| ------------------- | -------------------------------------------------------------------- |
| **Bug report**      | The extension misbehaves: wrong output, an error, nothing shows up   |
| **Mismatch report** | The view disagrees with what Kiro actually does — see the note below |
| **Feature request** | Something you would like the extension to do                         |

**Mismatch reports matter more than they look.** The extension reproduces part of Kiro's own behaviour (see [How it works](#how-it-works-in-one-paragraph)), so a change in Kiro can make the view drift away from reality even though the extension itself did not change. If the tree says one thing and Kiro does another, that is worth reporting even if nothing looks broken.

**Redact your paths.** Permission settings live under your home directory and the file paths contain your user name. Replace anything you would rather not publish before pasting logs, screenshots, or file contents. Keep the structure intact — the shape of the file is what matters for reproducing an issue.

## Getting set up

| Requirement | Notes                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| **Bun**     | `1.3.14`. The version is pinned; `bun.lock` is committed and CI installs with a frozen lockfile        |
| **Node.js** | Needed only for packaging (`vsce` spawns npm internally). Any recent LTS works                         |
| **Kiro**    | Required to run the extension. It relies on Kiro's permission model and does not work in plain VS Code |

```bash
bun install
bun run build
```

Press <kbd>F5</kbd> in Kiro to launch an extension development host. The full list of scripts is in the [Development section of the README](./README.md#development).

Run `bun run package` before opening a pull request. It chains typecheck, lint, tests, a production build, and the VSIX packaging step, so it catches almost everything CI would.

## How it works, in one paragraph

The extension does not simply display the contents of `permissions.yaml`. It reproduces two behaviours from Kiro itself:

1. **How a workspace path becomes a directory name.** The path is normalized (separators, trailing slash, lower-cased on Windows) and hashed with SHA-256, and the first 16 hex characters name the directory under `~/.kiro/workspace-roots/`.
2. **How rules are validated.** Kiro rejects a broken file in two different weights. Some problems make it skip a single rule and apply the rest. Others make it discard the whole configuration and fail closed, in which case no rule applies at all.

**The guiding principle is to show the rules that are actually in effect, not the rules as written.** Anything that makes the view diverge from what Kiro really does is a bug, even if the view matches the file.

Both behaviours were established by reading Kiro's own bundled extension:

```
macOS   /Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent/dist/extension.js
Windows %LOCALAPPDATA%\Programs\Kiro\resources\app\extensions\kiro.kiro-agent\dist\extension.js
```

If you change the hashing or the validation rules, please say in the pull request which Kiro version you checked against and how.

## Things worth knowing before you change code

These are the constraints that are easy to break without noticing.

### Keep the layers separate

```
workspaceHash.ts   path normalization and hashing        no vscode dependency
permissionsFile.ts scope path resolution, reverse scan   no vscode dependency
parse.ts           YAML / JSON parsing                   no vscode dependency
validate.ts        Kiro's validation rules               no vscode dependency
display.ts         pure display logic                    depends on vscode.l10n only
model.ts           loading and validating a scope
tree.ts            TreeDataProvider and TreeItem
commands.ts        refresh / open / reveal
watch.ts           file watching and debouncing
extension.ts       activate / deactivate
```

**`parse.ts` records facts about the shape of the file and never judges them.** That `match` held a single string rather than an array is a fact; whether that is acceptable is Kiro's rule, and every such rule lives in `validate.ts`. Keeping the split means that when Kiro changes, there is exactly one file to fix.

**Prefer growing the vscode-free layers.** They can be tested without mocking the editor, which is why coverage stays high.

### Compare paths through `normalizeRoot()`

Never compare path strings directly. On Windows, `Uri.fsPath` lower-cases the drive letter while `os.homedir()` returns it upper-cased, so a plain comparison always fails. `normalizeRoot()` absorbs both the casing and the separators.

Functions that take a `platform` argument (defaulting to `process.platform`) do so on purpose: it lets the tests exercise both operating systems from either one. Pass it through rather than reaching for `process.platform` inside.

### Tree view details that bite

- **Do not set `TreeItem.command` on a row that has children.** Clicking such a row runs the command _and_ toggles the expansion at the same time ([vscode#34130](https://github.com/microsoft/vscode/issues/34130)).
- **Give every item a stable `TreeItem.id`,** otherwise expansion state resets on every refresh. Do not build the id out of the path hash — it can change depending on how the directory was resolved.
- **`TreeItem.label` is cut at the first newline.** Multi-line text such as a parser error belongs in the tooltip.
- **A `MarkdownString` tooltip needs blank lines between paragraphs,** or the lines are joined into one.
- **Verify a codicon exists before using it.** An unknown id does not throw; the icon area is simply blank. The authoritative list is `node_modules/@vscode/codicons/dist/codicon.css` inside the Kiro app bundle.

### Localization

The UI is English by default, with a Japanese resource bundle and an English fallback for every other locale.

- Call `vscode.l10n.t()` directly from the file that needs it. Do not wrap it — the extraction tooling parses the call sites statically, so the first argument has to be a literal with `{0}`-style placeholders.
- Bundle keys are the English source strings themselves, not identifiers.
- After adding or changing a string, update `l10n/bundle.l10n.ja.json` and, for anything referenced from `package.json`, both `package.nls.json` and `package.nls.ja.json`. `tests/l10n.test.ts` fails if a translation is missing or a placeholder is dropped.
- **Error message bodies and identifiers stay in English** in every locale. Capability names, effect names, paths, and parser messages are not translated. `Permissions` is kept untranslated as the name of the feature.

## Tests

```bash
bun run test           # vitest, single run
bun run test:coverage  # with istanbul coverage
```

- **Run vitest through Node, not `bun test`.** The alias configuration that provides the `vscode` mock lives in `vitest.config.mts`, and `bun test` does not read it. Coverage uses istanbul because v8 coverage does not work on the Bun runtime.
- Add the API you need to `tests/mocks/vscode.ts` as you go. The `vscode.l10n` mock returns its first argument, which is why expectations can stay in English.
- **Derive validation results from the real functions** (`tests/fixtures.ts` provides helpers) instead of hand-building them. Hand-built results drift from the implementation and let tests pass while the real view is wrong.
- **Avoid hard-coded POSIX paths** in arguments and expectations; they fail on Windows. Use a temporary directory, or pass `platform` explicitly.
- The coverage text reporter omits files that are at 100% on every metric. A file missing from the table is fully covered, not unmeasured; `coverage/lcov.info` has the complete list.

## Style

Formatting and linting are enforced, so let the tools decide.

```bash
bun run format   # prettier
bun run lint     # oxlint, type-aware
```

- To suppress a lint rule, the directive is `/* oxlint-disable <plugin>/<rule> */`. The ESLint-style `-- reason` suffix silently disables the whole directive, so put the reason on a neighbouring comment line.
- Line endings are LF, enforced by `.gitattributes`. Do not fight your Git configuration; the attribute wins.

## Changelog and versioning

[CHANGELOG.md](./CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Add your change to the `Unreleased` section at the top, creating that section if it is not there, under one of the six headings (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`). Write it for someone deciding whether to update, not for someone reading the diff.

- **Leave out anything users cannot see.** Refactors, test changes, and dependency bumps do not belong in the changelog. If a dependency bump does change behaviour, describe the effect under the heading that fits.
- **`Fixed` means the behaviour was wrong. `Changed` means it worked as intended and now works differently.** When in doubt, ask whether the old behaviour was a bug.
- **Mark a breaking change with a `**Breaking:**` prefix** on the entry itself, keeping it under `Changed` or `Removed`.

The extension has no public API, so version numbers describe what users see:

| Change                                          | Bump                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A new capability of the view                    | minor                                                                                        |
| A change to how something is displayed          | minor — the labels and colours are the interface here                                        |
| A fix                                           | patch                                                                                        |
| Following a change in Kiro itself               | patch, since it corrects a view that had drifted; minor if the display changes substantially |
| Raising the minimum supported Kiro version      | minor                                                                                        |
| A dependency update with no user-visible effect | no release                                                                                   |

While the version is below `1.0.0`, a breaking change ships as a minor bump with the `**Breaking:**` marker rather than a major one.

## Commits and pull requests

- Write commit messages in English with a short prefix: `feat:`, `fix:`, `docs:`, `chore:`, `test:`.
- Keep a pull request to one concern. Small and reviewable beats complete.
- Fill in the pull request template, in particular whether you ran `bun run package` and whether you checked the change in Kiro itself.
- **Mention which platform you verified on.** macOS and Windows differ in path handling, in file watching latency, and in how the filesystem normalizes Unicode, and all three have caused real bugs here.
- Do not commit scripts or fixtures that contain your own absolute paths.

## License

By contributing you agree that your contribution is licensed under the [MIT License](./LICENSE).
