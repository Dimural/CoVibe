import { describe, it, expect } from 'vitest';
import {
  RelayUnreachableError,
  ProtocolMismatchError,
  AuthFailedError,
  SessionFullError,
  BranchMismatchError as TypedBranchMismatchError,
  GitNoRemoteError,
  InvalidInviteLinkError,
  userMessage,
} from '../src/errors.js';

describe('Typed error classes', () => {
  it('RelayUnreachableError has correct name and message', () => {
    const e = new RelayUnreachableError('wss://relay.example.com');
    expect(e.name).toBe('RelayUnreachableError');
    expect(e.message).toContain('wss://relay.example.com');
    expect(e instanceof RelayUnreachableError).toBe(true);
    expect(e instanceof Error).toBe(true);
  });

  it('ProtocolMismatchError has correct name', () => {
    const e = new ProtocolMismatchError(1, 2);
    expect(e.name).toBe('ProtocolMismatchError');
    expect(e.localVersion).toBe(1);
    expect(e.remoteVersion).toBe(2);
  });

  it('AuthFailedError has correct name', () => {
    const e = new AuthFailedError();
    expect(e.name).toBe('AuthFailedError');
    expect(e instanceof AuthFailedError).toBe(true);
  });

  it('SessionFullError has correct name', () => {
    const e = new SessionFullError();
    expect(e.name).toBe('SessionFullError');
  });

  it('TypedBranchMismatchError has requiredBranch', () => {
    const e = new TypedBranchMismatchError('feature/x');
    expect(e.requiredBranch).toBe('feature/x');
    expect(e.name).toBe('BranchMismatchError');
  });

  it('GitNoRemoteError has correct name', () => {
    const e = new GitNoRemoteError();
    expect(e.name).toBe('GitNoRemoteError');
  });

  it('InvalidInviteLinkError has correct name', () => {
    const e = new InvalidInviteLinkError('bad input');
    expect(e.name).toBe('InvalidInviteLinkError');
  });
});

describe('userMessage', () => {
  it('returns actionable message for RelayUnreachableError', () => {
    const msg = userMessage(new RelayUnreachableError('wss://relay.example.com'));
    expect(msg).toContain('relay');
    expect(msg.length).toBeGreaterThan(20);
  });

  it('returns actionable message for SessionFullError', () => {
    const msg = userMessage(new SessionFullError());
    expect(msg).toContain('4'); // max 4 participants
  });

  it('returns actionable message for BranchMismatchError', () => {
    const msg = userMessage(new TypedBranchMismatchError('main'));
    expect(msg).toContain('main');
  });

  it('returns a fallback message for unknown errors', () => {
    const msg = userMessage(new Error('something weird'));
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('returns actionable message for ProtocolMismatchError', () => {
    const msg = userMessage(new ProtocolMismatchError(1, 2));
    expect(msg).toContain('update');
  });

  it('returns actionable message for GitNoRemoteError', () => {
    const msg = userMessage(new GitNoRemoteError());
    expect(msg).toContain('remote');
  });

  it('returns actionable message for AuthFailedError', () => {
    const msg = userMessage(new AuthFailedError());
    expect(msg).toContain('expired');
  });

  it('returns actionable message for InvalidInviteLinkError', () => {
    const msg = userMessage(new InvalidInviteLinkError('covibes://bad'));
    expect(msg).toContain('covibes://join');
  });
});
