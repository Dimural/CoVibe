import { describe, it, expect } from 'vitest';
import { buildParticipantListHtml } from '../../src/ui/sessionPanel.js';
import type { ParticipantView } from '../../src/session/state.js';

describe('buildParticipantListHtml', () => {
  it('renders an empty string for an empty participants list', () => {
    const result = buildParticipantListHtml([]);
    expect(result).toBe('');
  });

  it('renders a single participant with correct name and color', () => {
    const participants: ParticipantView[] = [{ id: 'p1', displayName: 'Alice', color: '#ff0000' }];
    const result = buildParticipantListHtml(participants);
    expect(result).toContain('Alice');
    expect(result).toContain('#ff0000');
    expect(result).toContain('<li class="participant" data-participant-id="p1">');
    expect(result).toContain('class="color-dot"');
    expect(result).toContain('class="participant-name"');
  });

  it('renders a participant with currentFile showing the file', () => {
    const participants: ParticipantView[] = [
      { id: 'p2', displayName: 'Bob', color: '#00ff00', currentFile: 'src/index.ts' },
    ];
    const result = buildParticipantListHtml(participants);
    expect(result).toContain('src/index.ts');
    expect(result).toContain('class="participant-file"');
  });

  it('escapes XSS in displayName', () => {
    const participants: ParticipantView[] = [
      { id: 'p3', displayName: '<script>alert(1)</script>', color: '#0000ff' },
    ];
    const result = buildParticipantListHtml(participants);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });
});
