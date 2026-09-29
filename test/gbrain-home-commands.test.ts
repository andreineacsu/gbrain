/**
 * #5549: command-level state paths resolve under GBRAIN_HOME, not HOME.
 * HOME and GBRAIN_HOME point at two different dirs, so a resolver still
 * building `$HOME/.gbrain/...` lands in the wrong one and fails here.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { withSplitHomes } from './helpers/with-env.ts';
import { upgradeStatePath } from '../src/commands/upgrade.ts';
import { defaultMiningOutPath, defaultReviewOutPath } from '../src/commands/notability-eval.ts';

describe('command state paths follow GBRAIN_HOME (#5549)', () => {
  const cases: Array<[string, () => string, string[]]> = [
    ['upgrade-state.json', upgradeStatePath, ['upgrade-state.json']],
    ['notability mining output', defaultMiningOutPath, ['eval', 'notability-mining-candidates.jsonl']],
    ['notability review output', defaultReviewOutPath, ['eval', 'notability-real.jsonl']],
  ];

  test.each(cases)('%s resolves under GBRAIN_HOME/.gbrain', async (_name, resolve, segments) => {
    await withSplitHomes(({ gbrainHome }) => {
      expect(resolve()).toBe(join(gbrainHome, '.gbrain', ...segments));
    });
  });
});
