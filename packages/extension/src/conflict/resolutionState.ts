export interface ResolutionState {
  readonly conflictId: string;
  readonly peers: readonly string[];
  readonly leftText: string;
  readonly rightText: string;
  readonly baseText: string;
  readonly resolutionText: string;
  readonly confirmed: ReadonlySet<string>;
  readonly cancelled: boolean;
}

const CONFLICT_MARKER = '<<<<<<<';

export function createResolutionState(
  conflictId: string,
  peers: string[],
  leftText: string,
  rightText: string,
  baseText: string,
): ResolutionState {
  const resolutionText = buildInitialResolutionText(leftText, rightText);
  return {
    conflictId,
    peers,
    leftText,
    rightText,
    baseText,
    resolutionText,
    confirmed: new Set(),
    cancelled: false,
  };
}

export function updateResolutionText(state: ResolutionState, text: string): ResolutionState {
  return { ...state, resolutionText: text };
}

export function confirmParticipant(state: ResolutionState, participantId: string): ResolutionState {
  const confirmed = new Set(state.confirmed);
  confirmed.add(participantId);
  return { ...state, confirmed };
}

export function cancelResolution(state: ResolutionState): ResolutionState {
  return { ...state, cancelled: true };
}

export function isResolved(state: ResolutionState): boolean {
  return !state.resolutionText.includes(CONFLICT_MARKER);
}

export function isBothConfirmed(state: ResolutionState): boolean {
  return state.peers.every((p) => state.confirmed.has(p));
}

function buildInitialResolutionText(left: string, right: string): string {
  if (left === right) return left;
  return `<<<<<<< YOURS\n${left}\n=======\n${right}\n>>>>>>> THEIRS\n`;
}
