import { beforeEach, describe, expect, it } from 'vitest';
import { MarkdownString, ThemeColor, ThemeIcon, TreeItemCollapsibleState, Uri } from 'vscode';

import type { ScopeData } from '../src/model';
import type { ParseResult, PermissionRule } from '../src/parse';
import { PermissionsTreeDataProvider, SCOPE_CONTEXT_VALUE, type TreeNode } from '../src/tree';
import { makeParseResult, makeRule, okValidation, validationOf } from './fixtures';

let provider: PermissionsTreeDataProvider;

beforeEach(() => {
  provider = new PermissionsTreeDataProvider();
});

function rule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return makeRule({ line: 1, ...overrides });
}

/**
 * User スコープを作る。
 *
 * **検証結果は実際の `validatePermissions` を通す。** 手で組むと判定と表示が食い違い、
 * テストが通っても実機で崩れる。
 */
function userScope(overrides: Partial<ParseResult> = {}): ScopeData {
  const result = makeParseResult(overrides);
  return {
    kind: 'user',
    key: 'user',
    label: 'User',
    file: {
      dir: '/home/test/.kiro/settings',
      filePath: '/home/test/.kiro/settings/permissions.yaml',
      exists: true,
      format: 'yaml',
    },
    content: { state: 'parsed', result },
    validation: validationOf(result),
  };
}

function missingWorkspaceScope(overrides: Partial<ScopeData> = {}): ScopeData {
  return {
    kind: 'workspace',
    key: 'workspace:/Users/test/project',
    label: 'project',
    file: {
      dir: '/home/test/.kiro/workspace-roots/0654434d556baf69',
      filePath: '/home/test/.kiro/workspace-roots/0654434d556baf69/permissions.yaml',
      exists: false,
      format: 'yaml',
    },
    hash: '0654434d556baf69',
    resolvedVia: 'hash',
    folder: { uri: Uri.file('/Users/test/project'), name: 'project', index: 0 },
    content: { state: 'missing' },
    validation: okValidation(),
    ...overrides,
  };
}

/**
 * tooltip の本文を取り出す。
 *
 * 型アサーションを避けるために `instanceof` で絞る（`no-unsafe-type-assertion`）。
 * 実行時は alias によりモックの `MarkdownString` になる。
 */
function tooltipOf(item: { tooltip?: unknown }): string {
  const { tooltip } = item;
  if (tooltip instanceof MarkdownString) {
    return tooltip.value;
  }
  if (typeof tooltip === 'string') {
    return tooltip;
  }
  throw new Error('tooltip is not set');
}

describe('スコープ行', () => {
  it('展開済みで、ペンシル用の contextValue を持つ', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: userScope() });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(item.contextValue).toBe(SCOPE_CONTEXT_VALUE);
  });

  it('id はワークスペースのパス由来で安定している（ハッシュを使わない）', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: missingWorkspaceScope() });

    // ハッシュは resolvedVia の経路によって変わりうるため id には使わない。
    expect(item.id).toBe('workspace:/Users/test/project');
    expect(item.id).not.toContain('0654434d556baf69');
  });

  it('クリックしても何も起きない（展開のトグルのみ）', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: userScope() });

    expect(item.command).toBeUndefined();
  });

  it('User と Workspace でアイコンの色が違う', () => {
    const user = provider.getTreeItem({ kind: 'scope', scope: userScope() });
    const workspace = provider.getTreeItem({ kind: 'scope', scope: missingWorkspaceScope() });

    expect(user.iconPath).toMatchObject({ id: 'milestone', color: { id: 'charts.purple' } });
    expect(workspace.iconPath).toMatchObject({ id: 'milestone', color: { id: 'icon.foreground' } });
  });

  it('読み上げラベルに件数を含む', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: userScope({ rules: [rule()] }) });

    expect(item.accessibilityInformation?.label).toBe('User, 1 rule');
  });
});

describe('ルール行', () => {
  const scope = userScope();

  it('match が複数のルールは折りたたみで、クリックしても開かない', () => {
    const target = rule({
      matchShape: 'list',
      matches: [
        { pattern: 'a', line: 3 },
        { pattern: 'b', line: 4 },
      ],
    });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 0, rule: target });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    // 子を持つ行に command を付けると展開のトグルと同時にエディタが開いてしまう。
    expect(item.command).toBeUndefined();
  });

  it('match が 1 件のルールも折りたたみになる（ツリー形式に統一。Q36）', () => {
    const target = rule({
      effect: 'deny',
      line: 26,
      matchShape: 'list',
      matches: [{ pattern: 'sudo*', line: 28 }],
    });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 3, rule: target });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(item.command).toBeUndefined();
  });

  it('all のルールは葉になり、クリックで該当行にジャンプする', () => {
    const item = provider.getTreeItem({
      kind: 'rule',
      scope,
      ruleIndex: 1,
      rule: rule({ capability: 'web_fetch', line: 22 }),
    });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    // パターン行を持たないため、この行にジャンプを割り当てないと飛ぶ手段が無くなる（Q36）。
    expect(item.command?.arguments).toEqual([
      { filePath: '/home/test/.kiro/settings/permissions.yaml', line: 22 },
    ]);
  });

  it('exclude だけを持つルールは子を持つのでジャンプを割り当てない', () => {
    const target = rule({
      capability: 'fs_read',
      line: 30,
      exclude: {
        patterns: [{ pattern: '.env', line: 32 }],
        shape: 'list',
        hasNonStringEntry: false,
      },
    });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 5, rule: target });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(item.command).toBeUndefined();
  });

  it('id にスコープと索引を含む', () => {
    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 4, rule: rule() });

    expect(item.id).toBe('user/4');
  });

  it('ラベルは capability、description は match の要約', () => {
    const item = provider.getTreeItem({
      kind: 'rule',
      scope,
      ruleIndex: 0,
      rule: rule({ effect: 'deny', matchShape: 'list', matches: [{ pattern: 'sudo*', line: 5 }] }),
    });

    expect(item.label).toBe('shell');
    expect(item.description).toBe('deny · 1 pattern');
  });
});

describe('パターン行', () => {
  it('クリックでその行にジャンプする', () => {
    const scope = userScope();
    const item = provider.getTreeItem({
      kind: 'pattern',
      list: 'match',
      scope,
      ruleIndex: 0,
      patternIndex: 5,
      pattern: { pattern: 'npm run build', line: 8 },
    });

    expect(item.label).toBe('npm run build');
    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(item.command?.arguments).toEqual([
      { filePath: '/home/test/.kiro/settings/permissions.yaml', line: 8 },
    ]);
  });

  it('id にスコープ・ルール・パターンの索引を含む', () => {
    const item = provider.getTreeItem({
      kind: 'pattern',
      list: 'match',
      scope: userScope(),
      ruleIndex: 0,
      patternIndex: 5,
      pattern: { pattern: 'npm run build', line: 8 },
    });

    // `match` と `exclude` で名前空間を分ける（Q35）。
    expect(item.id).toBe('user/0/match/5');
  });
});

describe('子ノードの構成', () => {
  async function childrenOf(scope: ScopeData): Promise<TreeNode[]> {
    return provider.getChildren({ kind: 'scope', scope });
  }

  it('ルールをそのまま並べる', async () => {
    const children = await childrenOf(userScope({ rules: [rule(), rule()] }));

    expect(children).toHaveLength(2);
    expect(children.every((child) => child.kind === 'rule')).toBe(true);
  });

  it('ファイルが無い場合は作成を促すメッセージを出す', async () => {
    const children = await childrenOf(missingWorkspaceScope());

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ kind: 'message', label: 'Click the pencil to create' });
  });

  it('パースエラーは行番号付きで並べ、クリックでその行に飛べる', async () => {
    const scope = userScope({
      errors: [
        { message: 'Sequence item without - indicator', line: 3, column: 0, code: 'MISSING_CHAR' },
      ],
    });

    const children = await childrenOf(scope);
    expect(children).toHaveLength(1);

    const item = provider.getTreeItem(children[0]!);
    expect(item.label).toBe('Line 4: Sequence item without - indicator');
    expect(item.command?.arguments).toEqual([
      { filePath: '/home/test/.kiro/settings/permissions.yaml', line: 3 },
    ]);
  });

  it('パースエラーのラベルは 1 行目だけにし、tooltip に全文を出す', async () => {
    // `yaml` パッケージが実際に返す複数行のメッセージ（Q37 = D）。
    const message = [
      'Sequence item without - indicator at line 3, column 1:',
      '',
      '  - capability: shell',
      '   effect: allow',
      '^',
      '',
    ].join('\n');
    const scope = userScope({
      errors: [{ message, line: 2, column: 0, code: 'MISSING_CHAR' }],
    });

    const children = await childrenOf(scope);
    const item = provider.getTreeItem(children[0]!);

    expect(item.label).toBe('Line 3: Sequence item without - indicator');
    expect(tooltipOf(item)).toBe(message);
  });

  it('label を短縮していないメッセージは tooltip も同じ文字列', async () => {
    const scope = userScope({ rulesKey: 'missing' });

    const children = await childrenOf(scope);
    const item = provider.getTreeItem(children[0]!);

    expect(tooltipOf(item)).toBe('Policy must contain a "rules" array');
  });

  it('パースエラーがあるときはルールを出さない', async () => {
    const scope = userScope({
      rules: [rule()],
      errors: [{ message: 'broken', line: 0, column: 0 }],
    });

    const children = await childrenOf(scope);

    expect(children.every((child) => child.kind === 'message')).toBe(true);
  });

  it('rules キーが無い場合は原因を行として出す', async () => {
    const scope = userScope({ rulesKey: 'missing' });

    const children = await childrenOf(scope);

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      kind: 'message',
      label: 'Policy must contain a "rules" array',
    });
  });

  it('fatal のときは原因を先頭に置き、ルール行も残す', async () => {
    // `match` が単一文字列。Kiro では fatal になるが、書かれている内容は見せたい。
    const scope = userScope({
      rules: [rule({ matchShape: 'scalar', matches: [{ pattern: 'npm test', line: 2 }] })],
    });

    const children = await childrenOf(scope);

    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({
      kind: 'message',
      label: '"match" must be a string array in rule 0',
    });
    expect(children[1]?.kind).toBe('rule');
  });

  it('原因の行にはジャンプできる', async () => {
    const scope = userScope({
      rules: [rule({ line: 7, matchShape: 'scalar', matches: [{ pattern: 'x', line: 7 }] })],
    });

    const [problem] = await childrenOf(scope);
    const item = provider.getTreeItem(problem!);

    expect(item.command?.arguments?.[0]).toMatchObject({ line: 7 });
  });

  it('パターン行は葉', async () => {
    const children = await provider.getChildren({
      kind: 'pattern',
      list: 'match',
      scope: userScope(),
      ruleIndex: 0,
      patternIndex: 0,
      pattern: { pattern: 'a', line: 1 },
    });

    expect(children).toEqual([]);
  });

  it('exclude のパターンも子として並ぶ（match の後）', async () => {
    const target = rule({
      capability: 'fs_write',
      matchShape: 'list',
      matches: [{ pattern: '**', line: 3 }],
      exclude: {
        patterns: [{ pattern: '.env', line: 5 }],
        shape: 'list',
        hasNonStringEntry: false,
      },
    });

    const children = await provider.getChildren({
      kind: 'rule',
      scope: userScope(),
      ruleIndex: 0,
      rule: target,
    });

    expect(
      children.map((child) =>
        child.kind === 'pattern' ? [child.list, child.pattern.pattern] : [],
      ),
    ).toEqual([
      ['match', '**'],
      ['exclude', '.env'],
    ]);
  });

  it('exclude 行はアイコンと description で区別し、id の名前空間も分ける', async () => {
    const item = provider.getTreeItem({
      kind: 'pattern',
      list: 'exclude',
      scope: userScope(),
      ruleIndex: 2,
      patternIndex: 0,
      pattern: { pattern: '.env', line: 5 },
    });

    expect(item.id).toBe('user/2/exclude/0');
    // 灰色の exclude アイコン。
    expect(item.iconPath).toEqual(
      new ThemeIcon('exclude', new ThemeColor('descriptionForeground')),
    );
    expect(item.description).toBe('exclude');
    // アイコンだけではスクリーンリーダーに伝わらない。
    expect(item.accessibilityInformation?.label).toBe('.env, exclude');
    // match 行と同じくクリックでジャンプできる。
    expect(item.command?.arguments?.[0]).toMatchObject({ line: 5 });
  });

  it('match 行は緑の歯車アイコンと match の description を持つ', async () => {
    const item = provider.getTreeItem({
      kind: 'pattern',
      list: 'match',
      scope: userScope(),
      ruleIndex: 0,
      patternIndex: 0,
      pattern: { pattern: '**', line: 3 },
    });

    // allow の緑（testing.iconPassed）とは別の色 ID を使う。
    expect(item.iconPath).toEqual(new ThemeIcon('gear', new ThemeColor('charts.green')));
    expect(item.description).toBe('match');
    expect(item.accessibilityInformation?.label).toBe('**, match');
  });

  it('ルール行の子は match パターン', async () => {
    const target = rule({
      matchShape: 'list',
      matches: [
        { pattern: 'a', line: 3 },
        { pattern: 'b', line: 4 },
      ],
    });

    const children = await provider.getChildren({
      kind: 'rule',
      scope: userScope(),
      ruleIndex: 0,
      rule: target,
    });

    expect(
      children.map((child) => (child.kind === 'pattern' ? child.pattern.pattern : '')),
    ).toEqual(['a', 'b']);
  });
});

describe('スコープ行の tooltip', () => {
  it('スコープの種別とファイルのパスを載せる', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: userScope() });

    const tooltip = tooltipOf(item);
    expect(tooltip).toContain('User scope');
    expect(tooltip).toContain('/home/test/.kiro/settings/permissions.yaml');
  });

  it('ワークスペースはハッシュを載せる', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: missingWorkspaceScope() });

    const tooltip = tooltipOf(item);
    expect(tooltip).toContain('Workspace scope');
    expect(tooltip).toContain('0654434d556baf69');
  });

  it('ファイルが無いことを明記する', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: missingWorkspaceScope() });

    expect(tooltipOf(item)).toContain('The file does not exist yet.');
  });

  it('ハッシュ以外の経路で解決した場合は resolvedVia を載せる', () => {
    // ハッシュ規則が想定と変わったときの診断材料になる。
    const item = provider.getTreeItem({
      kind: 'scope',
      scope: missingWorkspaceScope({ resolvedVia: 'reverse-scan' }),
    });

    expect(tooltipOf(item)).toContain('reverse-scan');
  });

  it('ハッシュで解決した場合は resolvedVia を載せない（既定の経路なので）', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: missingWorkspaceScope() });

    expect(tooltipOf(item)).not.toContain('Resolved via');
  });

  it('User スコープにはハッシュを載せない', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: userScope() });

    expect(tooltipOf(item)).not.toContain('Hash:');
  });

  it('fatal があれば原因を一覧にする', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: userScope({ rulesKey: 'missing' }) });

    const tooltip = tooltipOf(item);
    expect(tooltip).toContain('Not loaded');
    expect(tooltip).toContain('Policy must contain a "rules" array');
  });

  it('skip されたルールを一覧にする', () => {
    const scope = userScope({
      rules: [rule({ capability: 'dev', capabilityRaw: 'dev' })],
    });

    const item = provider.getTreeItem({ kind: 'scope', scope });

    const tooltip = tooltipOf(item);
    expect(tooltip).toContain('Skipped rules');
    expect(tooltip).toContain('unknown capability "dev"');
  });

  it('問題がなければ Not loaded も Skipped rules も載せない', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: userScope({ rules: [rule()] }) });

    const tooltip = tooltipOf(item);
    expect(tooltip).not.toContain('Not loaded');
    expect(tooltip).not.toContain('Skipped rules');
  });
});

describe('ルール行の tooltip', () => {
  it('capability と effect、パターンの一覧を載せる', () => {
    const scope = userScope({ rules: [rule()] });
    const target = rule({
      matchShape: 'list',
      matches: [
        { pattern: 'npm test', line: 3 },
        { pattern: 'ls *', line: 4 },
      ],
    });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 0, rule: target });

    const tooltip = tooltipOf(item);
    expect(tooltip).toContain('shell');
    expect(tooltip).toContain('allow');
    expect(tooltip).toContain('npm test');
    expect(tooltip).toContain('ls *');
  });

  it('match 省略のときは全対象であることを説明する', () => {
    const scope = userScope({ rules: [rule()] });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 0, rule: rule() });

    expect(tooltipOf(item)).toContain('applies to everything');
  });

  it('exclude のパターンも載せる', () => {
    const target = rule({
      exclude: {
        patterns: [{ pattern: '.env', line: 6 }],
        shape: 'list',
        hasNonStringEntry: false,
      },
    });
    const scope = userScope({ rules: [target] });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 0, rule: target });

    const tooltip = tooltipOf(item);
    expect(tooltip).toContain('exclude');
    expect(tooltip).toContain('.env');
  });

  it('skip されたルールは理由を先頭に載せる', () => {
    const target = rule({ capability: 'dev', capabilityRaw: 'dev' });
    const scope = userScope({ rules: [target] });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 0, rule: target });

    const tooltip = tooltipOf(item);
    expect(tooltip).toContain('Skipped by Kiro');
    expect(tooltip).toContain('has no effect until the file is fixed');
    expect(tooltip).toContain('unknown capability "dev"');
    // 理由がパターンの説明より前に来る。
    expect(tooltip.indexOf('Skipped by Kiro')).toBeLessThan(
      tooltip.indexOf('applies to everything'),
    );
  });

  it('読み込まれていないスコープのルールはその旨を載せる', () => {
    const target = rule();
    const scope = userScope({ rules: [target], rulesKey: 'not-a-list' });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 0, rule: target });

    const tooltip = tooltipOf(item);
    expect(tooltip).toContain('Not loaded');
    expect(tooltip).toContain('none of these rules apply');
  });
});

describe('パターン行の tooltip', () => {
  it('match 行はパターン文字列そのもの', () => {
    const item = provider.getTreeItem({
      kind: 'pattern',
      list: 'match',
      scope: userScope(),
      ruleIndex: 0,
      patternIndex: 0,
      pattern: { pattern: 'npm run build', line: 3 },
    });

    expect(tooltipOf(item)).toBe('npm run build');
  });

  it('exclude 行は除外であることを説明する', () => {
    const item = provider.getTreeItem({
      kind: 'pattern',
      list: 'exclude',
      scope: userScope(),
      ruleIndex: 0,
      patternIndex: 0,
      pattern: { pattern: '.env', line: 6 },
    });

    const tooltip = tooltipOf(item);
    expect(tooltip).toContain('.env');
    expect(tooltip).toContain('Excluded from this rule.');
  });
});

describe('ルート要素', () => {
  it('スコープの一覧を返す', async () => {
    // 実 HOME を読むため内容は環境依存。**必ず User スコープが含まれる**ことだけを見る。
    const children = await provider.getChildren();

    expect(children.length).toBeGreaterThanOrEqual(1);
    expect(children.every((child) => child.kind === 'scope')).toBe(true);
    expect(children.some((child) => child.kind === 'scope' && child.scope.kind === 'user')).toBe(
      true,
    );
  });

  /** ルート要素から `ScopeData` を取り出す。TreeNode は毎回作り直されるため中身を見る。 */
  async function loadedScopes(): Promise<ScopeData[]> {
    const children = await provider.getChildren();
    return children.map((child) => {
      if (child.kind !== 'scope') {
        throw new Error('root children must be scopes');
      }
      return child.scope;
    });
  }

  it('2 回目は読み込み結果を再利用する', async () => {
    const first = await loadedScopes();
    const second = await loadedScopes();

    // ルートの読み込みはファイル I/O を伴うため、refresh まで結果を保持する。
    // TreeNode 自体は毎回作られるが、中の ScopeData は同じインスタンスになる。
    expect(second[0]).toBe(first[0]);
  });

  it('refresh すると読み直す', async () => {
    const first = await loadedScopes();

    provider.refresh();
    const second = await loadedScopes();

    expect(second[0]).not.toBe(first[0]);
  });
});

describe('読み込みエラー', () => {
  it('read-error のスコープはメッセージを子として出す', async () => {
    const scope: ScopeData = {
      ...userScope(),
      content: { state: 'read-error', message: 'EACCES: permission denied' },
    };

    const children = await provider.getChildren({ kind: 'scope', scope });

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      kind: 'message',
      slug: 'read-error',
      label: 'EACCES: permission denied',
    });
  });

  it('read-error のスコープ行は read error と表示する', () => {
    const scope: ScopeData = {
      ...userScope(),
      content: { state: 'read-error', message: 'EACCES' },
    };

    const item = provider.getTreeItem({ kind: 'scope', scope });

    expect(item.description).toBe('read error');
  });
});
