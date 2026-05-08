import { createHash, randomUUID } from 'node:crypto';

export interface ParticipantIdentity {
  id: string; // UUID v4
  displayName: string;
  color: string; // hex color, e.g. "#e74c3c"
}

/**
 * Derives a deterministic hex color from a UUID string.
 * Uses SHA-256 hash of the id, then maps bytes to HSL and converts to hex.
 * Pure function — no vscode dependency.
 */
export function deriveColor(id: string): string {
  const hash = createHash('sha256').update(id).digest();

  const b0 = hash[0] ?? 0;
  const b1 = hash[1] ?? 0;
  const b2 = hash[2] ?? 0;

  // byte 0 → hue 0–359
  const h = Math.round((b0 / 255) * 359);
  // byte 1 → saturation 50%–80%
  const s = 50 + Math.round((b1 / 255) * 30);
  // byte 2 → lightness 40%–65%
  const l = 40 + Math.round((b2 / 255) * 25);

  return hslToHex(h, s, l);
}

/** Converts HSL (h: 0–360, s: 0–100, l: 0–100) to a "#rrggbb" hex string. */
function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;

  let r = 0,
    g = 0,
    b = 0;

  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }

  const toHex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Returns true if the value looks like a valid ParticipantIdentity.
 * Pure function — no vscode dependency.
 */
export function isValidIdentity(value: unknown): value is ParticipantIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    v['id'].length > 0 &&
    typeof v['displayName'] === 'string' &&
    v['displayName'].length > 0 &&
    typeof v['color'] === 'string' &&
    v['color'].length > 0
  );
}

// --------------------------------------------------------------------------
// vscode-dependent entry point — only call from the extension host
// --------------------------------------------------------------------------

// Structural types for the vscode APIs we need, so this module can be
// imported without loading vscode (tests never call getOrCreateIdentity).

interface ExtensionContext {
  globalState: {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
  };
}

interface InputBoxOptions {
  prompt: string;
  placeHolder: string;
  validateInput: (v: string) => string | null;
}

interface VsCodeWindow {
  showInputBox(options: InputBoxOptions): Thenable<string | undefined>;
}

/**
 * Retrieves the persisted identity from globalState, or prompts the user to
 * create one and persists it.
 *
 * @param context  VS Code ExtensionContext (provides globalState)
 * @param vsWindow vscode.window — injected so callers can pass the real one;
 *                 if omitted the real vscode.window is required lazily.
 */
export async function getOrCreateIdentity(
  context: ExtensionContext,
  vsWindow?: VsCodeWindow,
): Promise<ParticipantIdentity> {
  const stored = context.globalState.get<ParticipantIdentity>('covibes.identity');
  if (isValidIdentity(stored)) {
    return stored;
  }

  // Import vscode lazily so that importing this module in test files
  // (where vscode is absent) does NOT throw at module load time.
  let win: VsCodeWindow;
  if (vsWindow !== undefined) {
    win = vsWindow;
  } else {
    const vscode = await import('vscode');
    win = vscode.window;
  }

  const id = randomUUID();

  const input = await win.showInputBox({
    prompt: 'Enter your display name for CoVibes',
    placeHolder: 'Your name',
    validateInput: (v: string) => (v.trim().length > 0 ? null : 'Name cannot be empty'),
  });

  const displayName =
    input !== undefined && input.trim().length > 0
      ? input.trim()
      : `User-${randomUUID().slice(0, 6)}`;

  const color = deriveColor(id);

  const identity: ParticipantIdentity = { id, displayName, color };
  await context.globalState.update('covibes.identity', identity);
  return identity;
}
