import { describe, expect, it } from 'vitest';
import { ThemeColor, ThemeIcon, TreeItemCollapsibleState } from 'vscode';

describe('ツールチェーンの基盤', () => {
  it('`vscode` の import がモックへ差し替わる', () => {
    expect(TreeItemCollapsibleState.Collapsed).toBe(1);

    const color = new ThemeColor('charts.purple');
    const icon = new ThemeIcon('milestone', color);
    expect(icon.id).toBe('milestone');
    expect(icon.color).toBe(color);
  });
});
