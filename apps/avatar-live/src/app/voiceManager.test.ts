import { describe, it, expect } from 'vitest';
import { retryEligible, statusBadge } from './voiceManager.js';

// Pure presentation/eligibility logic for the cloned-voice manager. The fetch +
// DOM glue is browser-only (not unit-tested); these two helpers are not.

describe('retryEligible', () => {
  it('offers retry for every non-ready clone (failed / cloning / pending)', () => {
    expect(retryEligible('failed')).toBe(true);
    expect(retryEligible('cloning')).toBe(true);
    expect(retryEligible('pending')).toBe(true);
  });
  it('hides retry once the clone is ready', () => {
    expect(retryEligible('ready')).toBe(false);
  });
});

describe('statusBadge', () => {
  it('maps each status to a .badge variant + label', () => {
    expect(statusBadge('ready')).toEqual({ label: 'ready', cls: 'success' });
    expect(statusBadge('failed')).toEqual({ label: 'failed', cls: 'error' });
    expect(statusBadge('cloning')).toEqual({ label: 'cloning', cls: 'loading' });
    expect(statusBadge('pending')).toEqual({ label: 'pending', cls: 'loading' });
  });
  it('falls back to a warning badge for an unknown status', () => {
    expect(statusBadge('weird')).toEqual({ label: 'weird', cls: 'warning' });
  });
});
