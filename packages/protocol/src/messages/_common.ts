/**
 * Shared primitive schemas used across all message payload definitions.
 * All string-based ids are opaque unless specified otherwise.
 */
import { z } from 'zod';

/** Opaque server-assigned participant identifier, stable across reconnects within grace period. */
export const ParticipantId = z.string().min(1).max(64);
export type ParticipantId = z.infer<typeof ParticipantId>;

/** User-chosen display name shown in the UI. */
export const DisplayName = z.string().min(1).max(64);
export type DisplayName = z.infer<typeof DisplayName>;

/** CSS hex color in 6-digit form, e.g. `#a3f0cc`. */
export const ColorHex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export type ColorHex = z.infer<typeof ColorHex>;

/** Opaque session identifier. */
export const SessionId = z.string().min(1).max(128);
export type SessionId = z.infer<typeof SessionId>;

/**
 * POSIX-style relative path within the workspace.
 * Rejects: absolute paths, backslashes, empty strings, null bytes, and `..` traversal segments.
 */
export const RelPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes('\0') &&
      !p.split('/').some((seg) => seg === '..'),
    {
      message:
        'RelPath must be a relative POSIX path with no `..` segments, backslashes, or null bytes',
    },
  );
export type RelPath = z.infer<typeof RelPath>;

/** Unicode codepoint offset (NOT UTF-16 code-unit index). */
export const CodepointOffset = z.number().int().nonnegative();
export type CodepointOffset = z.infer<typeof CodepointOffset>;

/** Monotonically-increasing document version, assigned by the server OT engine. */
export const DocVersion = z.number().int().nonnegative();
export type DocVersion = z.infer<typeof DocVersion>;

/** Unix epoch milliseconds, non-negative integer. */
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;
