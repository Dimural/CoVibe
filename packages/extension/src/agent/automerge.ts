import { diff_match_patch, DIFF_EQUAL, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch';
import type { Diff } from 'diff-match-patch';

export type MergeDecision =
  | { kind: 'noop' }
  | { kind: 'merge'; mergedText: string }
  | { kind: 'conflict' };

export function computeMergeDecision(
  snapshot: string,
  leftText: string,
  rightText: string,
): MergeDecision {
  if (leftText === rightText) {
    return { kind: 'noop' };
  }

  const dmp = new diff_match_patch();
  const leftDiffs = dmp.diff_main(snapshot, leftText);
  const rightDiffs = dmp.diff_main(snapshot, rightText);
  dmp.diff_cleanupSemantic(leftDiffs);
  dmp.diff_cleanupSemantic(rightDiffs);

  const leftLines = changedLines(snapshot, leftDiffs);
  const rightLines = changedLines(snapshot, rightDiffs);

  for (const line of leftLines) {
    if (rightLines.has(line)) return { kind: 'conflict' };
  }

  const leftPatches = dmp.patch_make(snapshot, leftDiffs);
  const [afterLeft] = dmp.patch_apply(leftPatches, snapshot);
  const rightPatches = dmp.patch_make(snapshot, rightDiffs);
  const [mergedText] = dmp.patch_apply(rightPatches, afterLeft);

  return { kind: 'merge', mergedText };
}

function changedLines(original: string, diffs: Diff[]): Set<number> {
  const lines = new Set<number>();
  const lineStarts = buildLineStartIndex(original);
  let pos = 0;

  for (const [op, text] of diffs) {
    if (op === DIFF_EQUAL) {
      pos += text.length;
    } else if (op === DIFF_DELETE) {
      const startLine = lineAt(lineStarts, pos);
      const endLine = lineAt(lineStarts, pos + text.length - 1);
      for (let l = startLine; l <= endLine; l++) lines.add(l);
      pos += text.length;
    } else if (op === DIFF_INSERT) {
      const startLine = lineAt(lineStarts, pos);
      const insertedLineCount = (text.match(/\n/g) ?? []).length;
      for (let l = startLine; l <= startLine + insertedLineCount; l++) lines.add(l);
    }
  }
  return lines;
}

function buildLineStartIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
