import { describe, expect, it } from 'vitest';
import {
  assertCredentialChangeAllowed,
  decideCredentialChange,
  type CredentialState
} from './credentials.js';
import { AppError } from './errors.js';

const activeUser = (credentialsVersion = 1): CredentialState => ({
  status: 'ACTIVE',
  deletedAt: null,
  credentialsVersion
});

describe('credential change arbitration', () => {
  it('allows a change when the session matches the current credentials version', () => {
    expect(decideCredentialChange(3, activeUser(3))).toBe('ok');
    expect(() => assertCredentialChangeAllowed(3, activeUser(3))).not.toThrow();
  });

  it('marks the request stale when another device already advanced the credentials version', () => {
    // 设备 A 先提交改密：版本 1 -> 2。旧设备 B 带着版本 1 重试。
    expect(decideCredentialChange(1, activeUser(2))).toBe('stale');
    expect(() => assertCredentialChangeAllowed(1, activeUser(2))).toThrow(AppError);
    try {
      assertCredentialChangeAllowed(1, activeUser(2));
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(409);
      expect((error as AppError).code).toBe('CREDENTIALS_CHANGED');
    }
  });

  it('never treats a newer-than-row session version as a win', () => {
    // 任何方向的不一致都说明请求基于过期/异常状态，统一按冲突拒绝。
    expect(decideCredentialChange(5, activeUser(4))).toBe('stale');
  });

  it('rejects inactive or soft-deleted accounts after the version check', () => {
    expect(
      decideCredentialChange(1, { status: 'DELETED', deletedAt: new Date(), credentialsVersion: 1 })
    ).toBe('inactive');
    expect(() =>
      assertCredentialChangeAllowed(1, { status: 'DELETED', deletedAt: new Date(), credentialsVersion: 1 })
    ).toThrow(AppError);
  });

  it('checks version drift before account status so old-device retries cannot reach password rotation', () => {
    // 版本落后且账号异常时，冲突优先，错误口径稳定为 409。
    const decision = decideCredentialChange(1, {
      status: 'DELETED',
      deletedAt: new Date(),
      credentialsVersion: 2
    });
    expect(decision).toBe('stale');
  });
});
