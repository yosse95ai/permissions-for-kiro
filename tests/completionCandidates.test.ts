import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  type Candidate,
  capabilityDescriptions,
  completionCandidates,
} from '../src/completionCandidates';
import type { CompletionSite } from '../src/completionContext';
import { KNOWN_RULE_FIELDS } from '../src/parse';
import { KNOWN_CAPABILITIES, VALID_EFFECTS } from '../src/validate';

/** スニペットのプレースホルダを既定値に置き換える（`$1` は空、`${1:src}` は `src`）。 */
function expand(candidate: Candidate): string {
  if (!candidate.snippet) {
    return candidate.insertText;
  }
  return candidate.insertText.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '');
}

function labels(candidates: readonly Candidate[]): string[] {
  return candidates.map((candidate) => candidate.label);
}

function pattern(capability: string | undefined): CompletionSite {
  return { kind: 'pattern', list: 'match', capability };
}

const ruleKey = (present: string[] = [], colonAfter = false): CompletionSite => ({
  kind: 'rule-key',
  present,
  colonAfter,
});

/** 並び順どおりか（`sortText` で並べたときに配列の順になるか）。 */
function isSorted(candidates: readonly Candidate[]): boolean {
  return candidates.every(
    (candidate, i) => i === 0 || candidates[i - 1]!.sortText < candidate.sortText,
  );
}

describe('completionCandidates: キー', () => {
  it('トップレベルは `rules` だけ。書かれていれば出さない', () => {
    const site: CompletionSite = { kind: 'top-level-key', present: [], colonAfter: false };
    expect(labels(completionCandidates(site, 'yaml'))).toEqual(['rules']);
    expect(completionCandidates({ ...site, present: ['rules'] }, 'yaml')).toEqual([]);
  });

  it('ルールのキーは KNOWN_RULE_FIELDS の順で、書かれたキーを除く', () => {
    expect(labels(completionCandidates(ruleKey(), 'yaml'))).toEqual([...KNOWN_RULE_FIELDS]);
    expect(labels(completionCandidates(ruleKey(['capability', 'match']), 'yaml'))).toEqual([
      'effect',
      'exclude',
    ]);
    expect(isSorted(completionCandidates(ruleKey(), 'yaml'))).toBe(true);
  });

  it('YAML は値を書く位置まで入れ、リストのキーは `:` で止める', () => {
    const inserted = Object.fromEntries(
      completionCandidates(ruleKey(), 'yaml').map((c) => [c.label, c.insertText]),
    );
    expect(inserted).toEqual({
      capability: 'capability: ',
      effect: 'effect: ',
      match: 'match:',
      exclude: 'exclude:',
    });
    expect(completionCandidates(ruleKey(), 'yaml').every((c) => !c.snippet)).toBe(true);
  });

  it('JSON は値の側までスニペットで入れる', () => {
    const inserted = Object.fromEntries(
      completionCandidates(ruleKey(), 'json').map((c) => [c.label, c.insertText]),
    );
    expect(inserted).toEqual({
      capability: '"capability": "$1"',
      effect: '"effect": "$1"',
      match: '"match": ["$1"]',
      exclude: '"exclude": ["$1"]',
    });
  });

  it('JSON の挿入文字列は、埋め込んだファイルを JSON.parse できる（末尾のカンマを入れない）', () => {
    for (const candidate of completionCandidates(ruleKey(), 'json')) {
      const text = `{"rules": [{${expand(candidate)}}]}`;
      expect(() => JSON.parse(text)).not.toThrow();
    }
    const [rules] = completionCandidates(
      { kind: 'top-level-key', present: [], colonAfter: false },
      'json',
    );
    expect(JSON.parse(`{${expand(rules!)}}`)).toEqual({ rules: [{ capability: '' }] });
  });

  it('`rules` は最初のルールの capability まで入れ、capability の候補を開く', () => {
    const site: CompletionSite = { kind: 'top-level-key', present: [], colonAfter: false };
    const [yaml] = completionCandidates(site, 'yaml');
    expect(yaml).toMatchObject({
      insertText: 'rules:\n\t- capability: $0',
      snippet: true,
      triggerSuggest: true,
    });
    // エディタは `\t` を字下げの設定（`[yaml]` は空白 2 つ）に置き換えて入れる。
    const inserted = expand(yaml!).replace('\t', '  ');
    expect(inserted).toBe('rules:\n  - capability: ');
    expect(parseYaml(`${inserted}shell`)).toEqual({ rules: [{ capability: 'shell' }] });

    const [json] = completionCandidates(site, 'json');
    expect(json).toMatchObject({ snippet: true, triggerSuggest: true });
  });

  it('`rules` の名前だけを直しているときは、名前だけを入れる', () => {
    const site: CompletionSite = { kind: 'top-level-key', present: [], colonAfter: true };
    expect(completionCandidates(site, 'yaml')).toMatchObject([
      { insertText: 'rules', snippet: false, triggerSuggest: false },
    ]);
    expect(completionCandidates(site, 'json')).toMatchObject([
      { insertText: '"rules"', snippet: false, triggerSuggest: false },
    ]);
  });

  it('キーの名前だけを直しているときは、名前だけを入れて値の候補を開かない', () => {
    const yaml = completionCandidates(ruleKey([], true), 'yaml');
    expect(yaml.map((c) => c.insertText)).toEqual([...KNOWN_RULE_FIELDS]);
    const json = completionCandidates(ruleKey([], true), 'json');
    expect(json.map((c) => c.insertText)).toEqual(KNOWN_RULE_FIELDS.map((key) => `"${key}"`));
    expect([...yaml, ...json].every((c) => !c.snippet && !c.triggerSuggest)).toBe(true);
  });

  it('値の候補があるキー（capability / effect）だけ、確定後に値の候補を開く', () => {
    const opened = completionCandidates(ruleKey(), 'yaml')
      .filter((c) => c.triggerSuggest)
      .map((c) => c.label);
    expect(opened).toEqual(['capability', 'effect']);
  });

  it('キーにはすべて説明文を付ける', () => {
    for (const candidate of completionCandidates(ruleKey(), 'yaml')) {
      expect(candidate.kind).toBe('key');
      expect(candidate.detail).toBeDefined();
      expect(candidate.documentation).toBeDefined();
    }
  });
});

describe('completionCandidates: capability の値', () => {
  const site: CompletionSite = { kind: 'capability-value' };

  it('KNOWN_CAPABILITIES をすべて、同じ順で出す', () => {
    const candidates = completionCandidates(site, 'yaml');
    expect(labels(candidates)).toEqual([...KNOWN_CAPABILITIES]);
    expect(isSorted(candidates)).toBe(true);
    expect(candidates.every((c) => c.kind === 'value' && !c.snippet)).toBe(true);
  });

  it('YAML はそのまま、JSON は引用符を付けて入れる', () => {
    expect(completionCandidates(site, 'yaml')[0]!.insertText).toBe('all');
    expect(completionCandidates(site, 'json')[0]!.insertText).toBe('"all"');
  });

  it('説明文のキーはすべて KNOWN_CAPABILITIES にある（ない語彙を出さない）', () => {
    for (const key of Object.keys(capabilityDescriptions())) {
      expect(KNOWN_CAPABILITIES).toContain(key);
    }
  });

  it('説明文のない capability も候補には出す', () => {
    const context = completionCandidates(site, 'yaml').find((c) => c.label === 'context');
    expect(context).toMatchObject({ label: 'context', insertText: 'context' });
    expect(context?.detail).toBeUndefined();
    expect(context?.documentation).toBeUndefined();
  });
});

describe('completionCandidates: effect の値', () => {
  it('優先順位（deny > ask > allow）の順に並べる', () => {
    const candidates = completionCandidates({ kind: 'effect-value' }, 'json');
    expect(labels(candidates)).toEqual(['deny', 'ask', 'allow']);
    expect(isSorted(candidates)).toBe(true);
    expect(candidates.map((c) => c.insertText)).toEqual(['"deny"', '"ask"', '"allow"']);
  });

  it('VALID_EFFECTS と同じ語彙を出す', () => {
    const effects = labels(completionCandidates({ kind: 'effect-value' }, 'yaml'));
    expect(effects).toHaveLength(VALID_EFFECTS.length);
    expect(new Set(effects)).toEqual(new Set(VALID_EFFECTS));
  });

  it('すべてに説明文を付ける', () => {
    for (const candidate of completionCandidates({ kind: 'effect-value' }, 'yaml')) {
      expect(candidate.documentation).toBeDefined();
    }
  });
});

describe('completionCandidates: パターンのひな型', () => {
  it('ドキュメントにパターンの形がある capability だけに出す', () => {
    const withTemplates = KNOWN_CAPABILITIES.filter(
      (capability) => completionCandidates(pattern(capability), 'yaml').length > 0,
    );
    expect(withTemplates).toEqual(['filesystem', 'fs_read', 'fs_write', 'shell', 'mcp']);
  });

  it('capability が未記入か未知なら出さない', () => {
    expect(completionCandidates(pattern(undefined), 'yaml')).toEqual([]);
    expect(completionCandidates(pattern('network'), 'yaml')).toEqual([]);
  });

  it('一覧には既定値を埋めた、引用符のない形を見せる', () => {
    expect(labels(completionCandidates(pattern('fs_read'), 'yaml'))).toEqual([
      'src/**',
      '**/.env',
      '**/*.pem',
    ]);
    expect(labels(completionCandidates(pattern('shell'), 'yaml'))).toEqual(['git *', 'npm test']);
    expect(labels(completionCandidates(pattern('mcp'), 'yaml'))).toEqual([
      'server/*',
      'server/tool',
    ]);
  });

  it('YAML に入れても、Kiro と同じ yaml.parse で文字列として読める（`*` で始まってもエイリアスにならない）', () => {
    for (const capability of ['fs_read', 'shell', 'mcp']) {
      for (const candidate of completionCandidates(pattern(capability), 'yaml')) {
        const text = [
          'rules:',
          `  - capability: ${capability}`,
          '    effect: deny',
          '    match:',
          `      - ${expand(candidate)}`,
        ].join('\n');
        let parsed: unknown;
        expect(() => {
          parsed = parseYaml(text);
        }).not.toThrow();
        expect(parsed).toEqual({
          rules: [{ capability, effect: 'deny', match: [candidate.label] }],
        });
      }
    }
  });

  it('JSON の配列に入れても JSON.parse できる', () => {
    for (const candidate of completionCandidates(pattern('fs_write'), 'json')) {
      const text = `{"rules": [{"capability": "fs_write", "effect": "deny", "match": [${expand(candidate)}]}]}`;
      expect(JSON.parse(text)).toMatchObject({ rules: [{ match: [candidate.label] }] });
    }
  });

  it('スニペットとして入れ、書き方の説明文を付ける', () => {
    for (const candidate of completionCandidates(pattern('shell'), 'yaml')) {
      expect(candidate).toMatchObject({ kind: 'pattern', snippet: true, triggerSuggest: false });
      expect(candidate.documentation).toBeDefined();
    }
  });
});
