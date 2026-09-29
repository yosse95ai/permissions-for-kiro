import * as vscode from 'vscode';

import type { CompletionSite } from './completionContext';
import { KNOWN_RULE_FIELDS } from './parse';
import type { PermissionsFormat } from './permissionsFile';
import { KNOWN_CAPABILITIES, VALID_EFFECTS } from './validate';

/**
 * 補完の候補を作る層。
 *
 * **語彙は既存の定数から読む**（`KNOWN_RULE_FIELDS` / `KNOWN_CAPABILITIES` / `VALID_EFFECTS`）。
 * Kiro が capability を増やしたときに直すのは `validate.ts` だけで済む。説明文がない語彙は、
 * 説明文なしで候補に出す。
 *
 * **説明文は Kiro のドキュメント（https://kiro.dev/docs/permissions/）に書かれている内容だけを
 * 書く。** 本体の実装を読んで知った振る舞いは、Kiro の更新で黙って変わりうるので書かない。
 * 例外は `validate.ts` が再現している判定（skip / fail closed / 文字列の配列）で、これは
 * この拡張がツリーで見せている内容と同じ。
 *
 * vscode への依存は `vscode.l10n` だけ（`display.ts` と同じ）。`CompletionItem` への変換は
 * `completion.ts` が行う。
 */

/** 候補の種類。`completion.ts` が `CompletionItemKind` に変換する。 */
export type CandidateKind = 'key' | 'value';

export interface Candidate {
  label: string;
  kind: CandidateKind;
  /** 1 行の補足 */
  detail?: string;
  /** Markdown の説明文 */
  documentation?: string;
  /** 挿入する文字列。`snippet` が `true` なら `$1` などを含むスニペット */
  insertText: string;
  snippet: boolean;
  /** 一覧の並び順 */
  sortText: string;
  /** 確定したあとに、続けて値の候補を開く */
  triggerSuggest: boolean;
}

interface Description {
  detail?: string;
  documentation?: string;
}

/** 並び順を保つための `sortText`。候補は多くても 20 件ほどなので 2 桁で足りる。 */
function sortKey(index: number): string {
  return String(index).padStart(2, '0');
}

/**
 * キーの説明文。
 *
 * @param capability 同じルールの capability。`match` / `exclude` の説明に、その capability の
 *   パターンの書き方と例を足す
 */
function keyDescriptions(capability?: string): Record<string, Description> {
  const patterns = patternHelp(capability);
  const withPatterns = (text: string): string =>
    patterns === undefined ? text : `${text}\n\n${patterns}`;
  return {
    rules: {
      detail: vscode.l10n.t('list of rules'),
      documentation: vscode.l10n.t(
        'Each rule needs `capability` and `effect`. `match` and `exclude` are optional.',
      ),
    },
    capability: {
      detail: vscode.l10n.t('required'),
      documentation: vscode.l10n.t(
        'What the rule applies to. An unknown value makes Kiro skip the rule.',
      ),
    },
    effect: {
      detail: vscode.l10n.t('required'),
      documentation: vscode.l10n.t(
        '`deny`, `ask`, or `allow`. Any other value makes the whole file fail closed.',
      ),
    },
    match: {
      detail: vscode.l10n.t('optional'),
      documentation: withPatterns(
        vscode.l10n.t(
          'Patterns the rule applies to. Must be a list of strings. Without it, the rule applies to everything in the capability.',
        ),
      ),
    },
    exclude: {
      detail: vscode.l10n.t('optional'),
      documentation: withPatterns(
        vscode.l10n.t('Patterns the rule must not apply to. Same format as `match`.'),
      ),
    },
  };
}

/** capability の説明文。ドキュメントにない振る舞いは書かない（`context` / `diagnostics` は説明なし）。 */
export function capabilityDescriptions(): Record<string, Description> {
  return {
    all: {
      detail: vscode.l10n.t('meta capability'),
      documentation: vscode.l10n.t('Every capability except `sandbox_network`.'),
    },
    builtin: {
      detail: vscode.l10n.t('meta capability'),
      documentation: vscode.l10n.t('All built-in tools.'),
    },
    filesystem: {
      detail: vscode.l10n.t('meta capability: {0}', 'fs_read + fs_write'),
      documentation: vscode.l10n.t('Reading and writing files.'),
    },
    fs_read: { detail: vscode.l10n.t('read files') },
    fs_write: { detail: vscode.l10n.t('write files') },
    shell: {
      detail: vscode.l10n.t('run commands'),
      documentation: vscode.l10n.t(
        'Compound commands ({0}) are split and each part is checked on its own.',
        '`;`, `&&`, `||`, `|`',
      ),
    },
    web_fetch: { detail: vscode.l10n.t('fetch web pages') },
    web_search: { detail: vscode.l10n.t('web search') },
    mcp: {
      detail: vscode.l10n.t('MCP tools'),
      documentation: vscode.l10n.t('Tools from MCP servers. Patterns look like `server/tool`.'),
    },
    subagent: { detail: vscode.l10n.t('subagents') },
    skill: { detail: vscode.l10n.t('skills') },
    power: { detail: 'Kiro Powers' },
    sandbox_network: {
      detail: vscode.l10n.t('sandbox network'),
      documentation: vscode.l10n.t('Not included in `all`.'),
    },
  };
}

function effectDescriptions(): Record<string, Description> {
  return {
    deny: {
      detail: vscode.l10n.t('block'),
      documentation: vscode.l10n.t(
        'Always blocks. `deny > ask > allow`: a `deny` in any scope wins over every `allow`.',
      ),
    },
    ask: {
      detail: vscode.l10n.t('prompt you'),
      documentation: vscode.l10n.t('Asks you before running. Wins over `allow`.'),
    },
    allow: {
      detail: vscode.l10n.t('proceed silently'),
      documentation: vscode.l10n.t(
        'Runs without asking, unless a `deny` or `ask` rule also matches.',
      ),
    },
  };
}

/** effect を並べる順。優先順位（`deny > ask > allow`）の順にする。 */
const EFFECT_ORDER: readonly string[] = ['deny', 'ask', 'allow'];

interface PatternExamples {
  /** パターンの書き方 */
  syntax: string;
  /** Kiro のドキュメントの例から取ったパターン */
  examples: readonly string[];
}

/**
 * capability ごとのパターンの書き方と例。
 *
 * パターンは値の候補としては出さない（具体的な値が一覧に並ぶと、推奨の設定のように見える
 * ため）。`match` / `exclude` のキーの説明文とホバーに、例として載せる。
 *
 * ドキュメントにパターンの形が示されている capability（ファイル系・`shell`・`mcp`）だけ。
 * `all` / `builtin` は含まれる capability ごとに意味が違うので、1 つに決められない。
 */
function patternExamples(capability: string | undefined): PatternExamples | undefined {
  switch (capability) {
    case 'fs_read':
    case 'fs_write':
    case 'filesystem':
      return {
        syntax: vscode.l10n.t(
          '`*` matches within one path segment, `**` across segments. {0} and {1} are supported. A pattern without wildcards also matches everything under it.',
          '`{a,b}`',
          '`[abc]`',
        ),
        examples: ['src/**', '**/.env', '**/*.pem'],
      };
    case 'shell':
      return {
        syntax: vscode.l10n.t(
          '`*` matches any characters. `**`, `?`, and character classes are not supported.',
        ),
        examples: ['git *', 'npm *', 'rm -rf *'],
      };
    case 'mcp':
      return {
        syntax: vscode.l10n.t(
          '`server/tool`. `*` matches any characters. `**`, `?`, and character classes are not supported.',
        ),
        examples: ['my-server/*', 'my-server/dangerous-tool'],
      };
    default:
      return undefined;
  }
}

/** `match` / `exclude` の説明に足す、書き方と例の段落。例のない capability では `undefined`。 */
function patternHelp(capability: string | undefined): string | undefined {
  const patterns = patternExamples(capability);
  if (patterns === undefined) {
    return undefined;
  }
  const examples = patterns.examples.map((example) => `\`${example}\``).join(', ');
  return `${patterns.syntax}\n\n${vscode.l10n.t('Examples for {0}: {1}', `\`${capability}\``, examples)}`;
}

/**
 * キーの候補を挿入する文字列。
 *
 * YAML は `capability: ` のように値を書く位置まで入れる。`rules` は最初のルールの
 * `capability` まで入れる。JSON は値の側まで入れる
 * （`"capability": ` だけでは JSON として不完全なまま残るため）。末尾の `,` は足さない。
 * 最後の要素に付くと、Kiro の `JSON.parse()` が失敗する。
 */
function keyInsertText(
  key: string,
  format: PermissionsFormat,
  colonAfter: boolean,
): { insertText: string; snippet: boolean } {
  if (colonAfter) {
    return { insertText: format === 'json' ? `"${key}"` : key, snippet: false };
  }
  if (key === 'rules') {
    // `rules` の下には必ずルールが来て、ルールには必ず `capability` があるので、最初のルールの
    // `capability` まで入れる。YAML の `\t` は、スニペットの挿入時にエディタの字下げの設定
    // （空白の数）に置き換わる。
    return format === 'yaml'
      ? { insertText: 'rules:\n\t- capability: $0', snippet: true }
      : { insertText: '"rules": [{"capability": "$1"}]', snippet: true };
  }
  if (format === 'yaml') {
    // リストのキーの下には `- ` で要素を書くので、次の行の `- ` まで入れる。深さは Kiro の
    // ドキュメントの例と同じく 1 段深くする。
    return key === 'match' || key === 'exclude'
      ? { insertText: `${key}:\n\t- $0`, snippet: true }
      : { insertText: `${key}: `, snippet: false };
  }
  switch (key) {
    case 'match':
    case 'exclude':
      return { insertText: `"${key}": ["$1"]`, snippet: true };
    default:
      return { insertText: `"${key}": "$1"`, snippet: true };
  }
}

/**
 * キーを確定したあとに、続けて値の候補を開くか。
 *
 * 値の候補があるキーだけ開く。`rules` は最初のルールの capability の値まで入れるので開く。
 * `match` / `exclude` の値（パターン）は候補を出さないので開かない。キーの名前だけを直して
 * いるときは、値はもう書かれているので開かない。
 */
function opensValues(key: string, colonAfter: boolean): boolean {
  return !colonAfter && (key === 'rules' || key === 'capability' || key === 'effect');
}

function keyCandidates(
  keys: readonly string[],
  present: readonly string[],
  format: PermissionsFormat,
  colonAfter: boolean,
  capability?: string,
): Candidate[] {
  const descriptions = keyDescriptions(capability);
  return keys
    .filter((key) => !present.includes(key))
    .map((key) => {
      const { insertText, snippet } = keyInsertText(key, format, colonAfter);
      const candidate: Candidate = {
        label: key,
        kind: 'key',
        insertText,
        snippet,
        sortText: sortKey(keys.indexOf(key)),
        triggerSuggest: opensValues(key, colonAfter),
      };
      return Object.assign(candidate, descriptions[key]);
    });
}

function valueCandidates(
  values: readonly string[],
  descriptions: Record<string, Description>,
  format: PermissionsFormat,
): Candidate[] {
  return values.map((value, index) => {
    const candidate: Candidate = {
      label: value,
      kind: 'value',
      insertText: format === 'json' ? `"${value}"` : value,
      snippet: false,
      sortText: sortKey(index),
      triggerSuggest: false,
    };
    return Object.assign(candidate, descriptions[value]);
  });
}

/**
 * 文脈に合った候補を返す。出す候補がなければ空の配列。
 */
export function completionCandidates(site: CompletionSite, format: PermissionsFormat): Candidate[] {
  switch (site.kind) {
    case 'top-level-key':
      return keyCandidates(['rules'], site.present, format, site.colonAfter);

    case 'rule-key':
      return keyCandidates(
        KNOWN_RULE_FIELDS,
        site.present,
        format,
        site.colonAfter,
        site.capability,
      );

    case 'capability-value':
      return valueCandidates(KNOWN_CAPABILITIES, capabilityDescriptions(), format);

    case 'effect-value': {
      // 優先順位の順に並べ、定数にあって順序にない値は後ろに足す。
      const ordered = [
        ...EFFECT_ORDER.filter((effect) => VALID_EFFECTS.includes(effect)),
        ...VALID_EFFECTS.filter((effect) => !EFFECT_ORDER.includes(effect)),
      ];
      return valueCandidates(ordered, effectDescriptions(), format);
    }

    default:
      // `pattern`。パターンは候補として出さず、`match` / `exclude` の説明に例を載せる。
      return [];
  }
}

/** 説明文の出典。ホバーの末尾にリンクを付ける。 */
export const PERMISSIONS_DOCS_URL = 'https://kiro.dev/docs/permissions/';

/**
 * 書かれたキーや値にマウスを乗せたときの説明（Markdown）。
 *
 * 補完の一覧と同じ説明文を使い、末尾に Kiro のドキュメントへのリンクを付ける。説明文の
 * 範囲は補完と同じく、ドキュメントに書かれている内容だけ（含まれる capability の一覧などは、
 * リンク先で確かめてもらう）。
 *
 * @param word 引用符を外した、書かれているキーか値
 * @returns 説明する語でなければ `undefined`（未知の capability、パターンなど）
 */
export function hoverMarkdown(site: CompletionSite, word: string): string | undefined {
  let descriptions: Record<string, Description>;
  let known: readonly string[];
  switch (site.kind) {
    case 'top-level-key':
      descriptions = keyDescriptions();
      known = ['rules'];
      break;
    case 'rule-key':
      descriptions = keyDescriptions(site.capability);
      known = KNOWN_RULE_FIELDS;
      break;
    case 'capability-value':
      descriptions = capabilityDescriptions();
      known = KNOWN_CAPABILITIES;
      break;
    case 'effect-value':
      descriptions = effectDescriptions();
      known = VALID_EFFECTS;
      break;
    default:
      return undefined;
  }
  if (!known.includes(word)) {
    return undefined;
  }

  const { detail, documentation } = descriptions[word] ?? {};
  const heading = detail === undefined ? `**${word}**` : `**${word}** — ${detail}`;
  const link = `[${vscode.l10n.t('Kiro documentation: {0}', 'Permissions')}](${PERMISSIONS_DOCS_URL})`;
  return [heading, documentation, link].filter((part) => part !== undefined).join('\n\n');
}
