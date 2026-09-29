import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 翻訳リソースの整合性を検証する。
 *
 * バンドルは手書きで管理しているため（`@vscode/l10n-dev` の抽出結果と一致することは
 * 実測済み）、**文言を追加したときの翻訳漏れと、使われなくなった余剰キーを
 * ここで検出する。**
 */

/**
 * プロジェクトルート。
 *
 * `import.meta.dirname` は使えない（tsconfig が CommonJS 出力のため `tsc` が TS1470 で
 * 拒否する。`vitest.config.mts` で使えるのは拡張子が `.mts` だから）。vitest は
 * プロジェクトルートで起動するため `process.cwd()` で代用する。
 */
const root = process.cwd();

/** 型アサーションを避けるための型述語。`no-unsafe-type-assertion` に引っかからない。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(relativePath: string): Record<string, unknown> {
  const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${relativePath} is not a JSON object`);
  }
  return parsed;
}

/**
 * メッセージに含まれる `{0}` 形式のプレースホルダを出現順に並べる。
 *
 * 並べ替えはしない。現状の文言はプレースホルダが最大 1 個で、語順の違いで順番が入れ替わる
 * ケースがないため、出現順のまま比べれば足りる。
 */
function placeholdersOf(text: string): string[] {
  return [...(text.match(/\{\d+\}/g) ?? [])];
}

/** ソース中の `vscode.l10n.t('...')` の第一引数を集める。 */
function collectSourceMessages(): Set<string> {
  const srcDir = path.join(root, 'src');
  const messages = new Set<string>();

  for (const entry of fs.readdirSync(srcDir)) {
    if (!entry.endsWith('.ts')) {
      continue;
    }
    const text = fs.readFileSync(path.join(srcDir, entry), 'utf8');
    // 第一引数はリテラルでなければ抽出ツールが拾えないため、常にシングルクォートで書く。
    const pattern = /vscode\.l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g;
    for (const match of text.matchAll(pattern)) {
      messages.add(match[1]!);
    }
  }

  return messages;
}

/** `package.json` 中の `%key%` を集める。 */
function collectNlsKeys(): Set<string> {
  const text = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const keys = new Set<string>();
  for (const match of text.matchAll(/"%([^%"]+)%"/g)) {
    keys.add(match[1]!);
  }
  return keys;
}

describe('l10n bundle (source strings)', () => {
  const sourceMessages = collectSourceMessages();
  const japanese = readJson('l10n/bundle.l10n.ja.json');

  it('finds the localized strings in the source', () => {
    // 正規表現による収集が壊れていないことの番人。この下限を書いた時点で 23 件。
    expect(sourceMessages.size).toBeGreaterThanOrEqual(23);
  });

  it('translates every string used in the source', () => {
    const missing = [...sourceMessages].filter((message) => !(message in japanese));
    expect(missing).toEqual([]);
  });

  it('has no leftover keys', () => {
    const unused = Object.keys(japanese).filter((key) => !sourceMessages.has(key));
    expect(unused).toEqual([]);
  });

  it('keeps the placeholders of the original message', () => {
    for (const [message, translation] of Object.entries(japanese)) {
      expect(placeholdersOf(String(translation)), `translation of "${message}"`).toEqual(
        placeholdersOf(message),
      );
    }
  });
});

describe('package.nls (static contributions)', () => {
  const usedKeys = collectNlsKeys();
  const english = readJson('package.nls.json');
  const japanese = readJson('package.nls.ja.json');

  it('defines every key referenced from package.json', () => {
    const missing = [...usedKeys].filter((key) => !(key in english));
    expect(missing).toEqual([]);
  });

  it('has no leftover keys in the English bundle', () => {
    const unused = Object.keys(english).filter((key) => !usedKeys.has(key));
    expect(unused).toEqual([]);
  });

  it('translates every English key into Japanese', () => {
    // ロケールのバンドルに欠けたキーは `package.nls.json` にフォールバックするため実害は
    // ないが、意図しない英語混在を防ぐために一致を要求する。
    const missing = Object.keys(english).filter((key) => !(key in japanese));
    const extra = Object.keys(japanese).filter((key) => !(key in english));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });
});
