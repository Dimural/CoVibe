/**
 * Session state machine — pure discriminated union + typed transition functions.
 *
 * All transition functions are pure: they take the current state (or relevant
 * fields) and return the next state. No side effects here.
 */

// ---------------------------------------------------------------------------
// ParticipantView
// ---------------------------------------------------------------------------

export interface ParticipantView {
  id: string;
  displayName: string;
  color: string;
  /** Relative path of the file the participant currently has open, if any. */
  currentFile?: string;
}

// ---------------------------------------------------------------------------
// SessionState discriminated union
// ---------------------------------------------------------------------------

export type SessionState =
  | { kind: 'Idle' }
  | { kind: 'Connecting'; sessionId: string; inviteLink: string }
  | {
      kind: 'Active';
      sessionId: string;
      inviteLink: string;
      participants: ParticipantView[];
    }
  | {
      kind: 'Reconnecting';
      sessionId: string;
      inviteLink: string;
      participants: ParticipantView[];
      attempt: number;
    }
  | { kind: 'Failed'; reason: string };

// ---------------------------------------------------------------------------
// Constant initial state
// ---------------------------------------------------------------------------

export const IDLE_STATE: SessionState = { kind: 'Idle' };

// ---------------------------------------------------------------------------
// Typed transition functions (pure)
// ---------------------------------------------------------------------------

/** Transition to Connecting (from Idle). */
export function toConnecting(
  _state: SessionState & { kind: 'Idle' },
  sessionId: string,
  inviteLink: string,
): SessionState {
  return { kind: 'Connecting', sessionId, inviteLink };
}

/** Transition to Active (from Connecting or Reconnecting). */
export function toActive(
  state: SessionState & { kind: 'Connecting' | 'Reconnecting' },
  participants: ParticipantView[],
): SessionState {
  return {
    kind: 'Active',
    sessionId: state.sessionId,
    inviteLink: state.inviteLink,
    participants,
  };
}

/** Transition to Reconnecting (from Active). */
export function toReconnecting(
  state: SessionState & { kind: 'Active' },
  attempt: number,
): SessionState {
  return {
    kind: 'Reconnecting',
    sessionId: state.sessionId,
    inviteLink: state.inviteLink,
    participants: state.participants,
    attempt,
  };
}

/** Update Reconnecting state with a new attempt counter (from Active or Reconnecting). */
export function toReconnectingUpdate(
  state: SessionState & { kind: 'Active' | 'Reconnecting' },
  attempt: number,
): SessionState {
  return {
    kind: 'Reconnecting',
    sessionId: state.sessionId,
    inviteLink: state.inviteLink,
    participants: state.participants,
    attempt,
  };
}

/** Transition to Failed with a descriptive reason string. */
export function toFailed(reason: string): SessionState {
  return { kind: 'Failed', reason };
}

/** Transition back to Idle. */
export function toIdle(): SessionState {
  return { kind: 'Idle' };
}
