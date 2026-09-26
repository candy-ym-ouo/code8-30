import { AppError } from './errors.js';

export interface CredentialState {
  status: string;
  deletedAt: Date | null;
  credentialsVersion: number;
}

export type CredentialChangeDecision = 'ok' | 'stale' | 'inactive';

/**
 * 改密/注销等敏感操作在拿到 users 行锁之后执行的统一冲突裁决。
 *
 * 口径：
 * - 会话携带的凭证版本与行上当前版本不一致 -> stale：凭证已被另一设备的
 *   改密事务推进，本次重试必须无副作用地失败（不轮换会话、不写审计）。
 * - 账号已非 ACTIVE 或被软删 -> inactive。
 * - 其余 -> ok，旧密码是否正确由调用方继续验证。
 */
export function decideCredentialChange(
  sessionCredentialsVersion: number,
  user: CredentialState
): CredentialChangeDecision {
  if (sessionCredentialsVersion !== user.credentialsVersion) return 'stale';
  if (user.status !== 'ACTIVE' || user.deletedAt) return 'inactive';
  return 'ok';
}

export function assertCredentialChangeAllowed(
  sessionCredentialsVersion: number,
  user: CredentialState
): void {
  const decision = decideCredentialChange(sessionCredentialsVersion, user);
  if (decision === 'stale') {
    throw new AppError(409, 'CREDENTIALS_CHANGED', '凭证已在其他设备更新，请重新登录');
  }
  if (decision === 'inactive') {
    throw new AppError(401, 'UNAUTHENTICATED', '登录状态已失效');
  }
}
