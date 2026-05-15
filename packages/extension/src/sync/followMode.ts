// ---------------------------------------------------------------------------
// FollowMode — automatically navigate to a followed participant's position
// ---------------------------------------------------------------------------

export interface FollowModeOptions {
  /** Open a file and optionally scroll to a position. */
  showDocument(path: string, position?: { line: number; character: number }): Promise<void>;
  /** Called when follow mode is activated or deactivated. */
  onFollowStateChange(participantId: string | null): void;
}

export class FollowMode {
  private readonly options: FollowModeOptions;
  private _following: string | null = null;

  constructor(options: FollowModeOptions) {
    this.options = options;
  }

  /** Start following a participant. If already following someone else, switches. */
  follow(participantId: string): void {
    this._following = participantId;
    this.options.onFollowStateChange(participantId);
  }

  /** Stop following. */
  unfollow(): void {
    this._following = null;
    this.options.onFollowStateChange(null);
  }

  /** Toggle: if following `participantId`, unfollow; otherwise follow them. */
  toggle(participantId: string): void {
    if (this._following === participantId) {
      this.unfollow();
    } else {
      this.follow(participantId);
    }
  }

  /** Returns the participantId being followed, or null if not in follow mode. */
  get following(): string | null {
    return this._following;
  }

  /**
   * Call when a remote nav.file arrives for any participant.
   * If that participant is being followed, opens the file.
   */
  onRemoteNavFile(participantId: string, path: string): void {
    if (this._following !== participantId) return;
    void this.options.showDocument(path);
  }

  /**
   * Call when a remote cursor.update arrives for any participant.
   * If that participant is being followed, scrolls to their cursor position.
   */
  onRemoteCursor(
    participantId: string,
    path: string,
    anchorLine: number,
    anchorChar: number,
  ): void {
    if (this._following !== participantId) return;
    void this.options.showDocument(path, { line: anchorLine, character: anchorChar });
  }

  /** Call when a participant leaves. If they were being followed, stops follow mode. */
  onParticipantLeft(participantId: string): void {
    if (this._following === participantId) {
      this.unfollow();
    }
  }
}
