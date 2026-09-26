/**
 * 凭证类操作（修改密码、注销账号）的并发冲突口径。
 *
 * 多端同时改密时以用户行为互斥单位：先提交的事务锁住用户行，
 * 后到的事务在同一把行锁上排队；拿到锁后重新核对进入事务前读取到的
 * 密码哈希，一旦不同就说明凭证已被另一处修改，本次请求判为冲突，
 * 由调用方整体回滚（不写密码、不轮换会话、不写审计）。
 */

export type CredentialConflictOutcome =
  | { outcome: 'proceed' }
  | { outcome: 'conflict' }
  | { outcome: 'invalid' };

/**
 * 已拿到用户行锁后，根据锁内状态判断本次凭证操作应继续还是失败。
 *
 * @param lockedHash 事务内锁定用户行后读到的密码哈希
 * @param observedHash 进入事务前读到的密码哈希（本请求所依据的凭证版本）
 * @param currentPasswordValid 调用方对“当前密码”的 Argon2 校验结果
 */
export function resolveCredentialConflict(
  lockedHash: string,
  observedHash: string,
  currentPasswordValid: boolean
): CredentialConflictOutcome {
  if (lockedHash !== observedHash) return { outcome: 'conflict' };
  if (!currentPasswordValid) return { outcome: 'invalid' };
  return { outcome: 'proceed' };
}
