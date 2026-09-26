import { describe, expect, it } from 'vitest';
import { resolveCredentialConflict } from './credentials.js';

describe('resolveCredentialConflict', () => {
  it('proceeds when the locked hash still matches the observed hash and password is valid', () => {
    expect(resolveCredentialConflict('hash-v1', 'hash-v1', true)).toEqual({ outcome: 'proceed' });
  });

  it('flags a conflict when another device already rotated the password', () => {
    // 旧设备在排队期间，先提交的改密已把哈希换成 v2；即使它拿着正确的旧密码也必须失败。
    expect(resolveCredentialConflict('hash-v2', 'hash-v1', true)).toEqual({ outcome: 'conflict' });
  });

  it('treats a wrong current password as invalid only when credentials did not move', () => {
    expect(resolveCredentialConflict('hash-v1', 'hash-v1', false)).toEqual({ outcome: 'invalid' });
  });

  it('prioritises conflict over invalid so stale retries cannot rotate sessions', () => {
    // 哈希已变说明先提交者胜出，绝不能再落到“密码错误”之外的可重试写路径。
    expect(resolveCredentialConflict('hash-v2', 'hash-v1', false)).toEqual({ outcome: 'conflict' });
  });
});
