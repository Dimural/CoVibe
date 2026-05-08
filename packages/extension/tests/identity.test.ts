import { describe, it, expect } from 'vitest';
import { deriveColor } from '../src/identity.js';

describe('deriveColor', () => {
  it('is deterministic — same input always returns the same hex string', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const color1 = deriveColor(id);
    const color2 = deriveColor(id);
    expect(color1).toBe(color2);
  });

  it('returns a valid hex color string matching /^#[0-9a-f]{6}$/i', () => {
    const id = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const color = deriveColor(id);
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('different UUIDs produce different colors (20 pairs should not all be the same)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `test-uuid-${i}-abcdef1234567890`);
    const colors = ids.map(deriveColor);
    const uniqueColors = new Set(colors);
    // All 20 pairs should not be identical — at least 2 distinct colors expected
    expect(uniqueColors.size).toBeGreaterThan(1);
  });

  it('does not depend on vscode being present (module loads and runs without vscode)', () => {
    // If this test runs at all, the module loaded successfully without vscode.
    // Confirm deriveColor works with a few sample inputs.
    const samples = [
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ];
    for (const id of samples) {
      const color = deriveColor(id);
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
