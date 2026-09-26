import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import {
  createSession,
  currentUser,
  deleteCurrentSession,
  persistSession,
  revokeActiveSessions,
  setSessionCookie,
  hashPassword,
  requireAuth,
  verifyPassword
} from '../../lib/auth.js';
import { resolveCredentialConflict } from '../../lib/credentials.js';
import { writeEvent } from '../../lib/events.js';

const credentialsSchema = z.object({
  email: z.string().trim().email('请输入有效邮箱').max(320),
  password: z.string().min(8, '密码至少 8 位').max(128)
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, '新密码至少 8 位').max(128)
});

const deleteAccountSchema = z.object({
  password: z.string().min(1, '请输入密码')
});

/** 凭证事务等待用户行锁的最长时间，超出即按冲突失败处理。 */
const CREDENTIAL_TX_TIMEOUT_MS = 15_000;

interface LockedUserRow {
  id: Buffer;
  password_hash: string;
  status: string;
  deleted_at: Date | null;
}

/**
 * 在事务内锁住用户行并读回最新凭证状态。
 * 并发的凭证操作在此排队串行，拿不到一致状态就失败，绝不各写各的。
 */
async function lockActiveUser(tx: Prisma.TransactionClient, userId: string): Promise<LockedUserRow> {
  const rows = await tx.$queryRaw<LockedUserRow[]>`
    SELECT id, password_hash, status, deleted_at
    FROM users
    WHERE id = ${userId}::uuid
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row || row.status !== 'ACTIVE' || row.deleted_at) {
    throw new AppError(401, 'UNAUTHENTICATED', '登录状态已失效');
  }
  return row;
}

function normalizeEmail(email: string): string {
  return email.normalize('NFC').trim().toLowerCase();
}

function publicUser(user: { id: string; email: string; createdAt: Date }) {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/register',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour'
        }
      }
    },
    async (request, reply) => {
      const parsed = credentialsSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(422, 'VALIDATION_ERROR', '注册信息无效', zodFields(parsed.error));
      }
      const email = normalizeEmail(parsed.data.email);
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) throw new AppError(409, 'EMAIL_EXISTS', '该邮箱已注册');

      const user = await prisma.user.create({
        data: { email, passwordHash: await hashPassword(parsed.data.password) }
      });
      await createSession(user.id, reply);
      return reply.status(201).send({ user: publicUser(user) });
    }
  );

  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (request) => {
            const body = request.body as { email?: string } | undefined;
            return `${request.ip}:${String(body?.email ?? '').toLowerCase()}`;
          }
        }
      }
    },
    async (request, reply) => {
      const parsed = credentialsSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
      }
      const email = normalizeEmail(parsed.data.email);
      const user = await prisma.user.findUnique({ where: { email } });
      const valid = user ? await verifyPassword(user.passwordHash, parsed.data.password) : false;
      if (!user || !valid || user.status !== 'ACTIVE' || user.deletedAt) {
        throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
      }
      await createSession(user.id, reply);
      return { user: publicUser(user) };
    }
  );

  app.post('/logout', { preHandler: requireAuth }, async (request, reply) => {
    await deleteCurrentSession(request, reply);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: requireAuth }, async (request) => {
    return { user: currentUser(request) };
  });

  app.patch('/password', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = passwordChangeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '密码信息无效', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;

    // 事务外先按“本请求所依据的凭证版本”校验密码并预哈希新密码，
    // 避免在行锁内执行昂贵的 Argon2 计算。
    const observed = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (observed.status !== 'ACTIVE' || observed.deletedAt) {
      throw new AppError(401, 'UNAUTHENTICATED', '登录状态已失效');
    }
    const currentPasswordValid = await verifyPassword(observed.passwordHash, parsed.data.currentPassword);
    if (!currentPasswordValid) throw new AppError(422, 'INVALID_PASSWORD', '当前密码不正确');
    const nextPasswordHash = await hashPassword(parsed.data.newPassword);

    // 凭证状态全有或全无：密码哈希、旧会话吊销、新会话、审计同一事务提交。
    const issued = await prisma.$transaction(
      async (tx) => {
        const locked = await lockActiveUser(tx, userId);
        const decision = resolveCredentialConflict(
          locked.password_hash,
          observed.passwordHash,
          currentPasswordValid
        );
        if (decision.outcome === 'conflict') {
          // 先提交的改密已经生效：不写密码、不轮换会话、不写本端审计。
          throw new AppError(409, 'CREDENTIALS_CHANGED', '密码已在其他设备修改，请使用新密码重新操作');
        }
        if (decision.outcome === 'invalid') {
          throw new AppError(422, 'INVALID_PASSWORD', '当前密码不正确');
        }

        const rotatedAt = new Date();
        // 固定顺序：先吊销全部旧会话，再换密码哈希，再签发本端新会话，最后落审计。
        await revokeActiveSessions(tx, userId, rotatedAt);
        await tx.user.update({ where: { id: userId }, data: { passwordHash: nextPasswordHash } });
        const session = await persistSession(tx, userId);
        await writeEvent(tx, {
          userId,
          entityType: 'USER',
          entityId: userId,
          action: 'PASSWORD_CHANGED',
          payload: { otherSessionsRevoked: true, rotatedAt: rotatedAt.toISOString() }
        });
        return session;
      },
      { timeout: CREDENTIAL_TX_TIMEOUT_MS }
    );

    // 只有事务提交成功后才下发新会话 Cookie，失败时浏览器仍持旧凭据，不产生中间态。
    setSessionCookie(reply, issued.token, issued.expiresAt);
    return { ok: true };
  });

  app.delete('/account', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = deleteAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '请输入密码', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const observed = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const passwordValid = await verifyPassword(observed.passwordHash, parsed.data.password);
    if (!passwordValid) throw new AppError(422, 'INVALID_PASSWORD', '密码不正确');

    await prisma.$transaction(
      async (tx) => {
        const locked = await lockActiveUser(tx, userId);
        const decision = resolveCredentialConflict(locked.password_hash, observed.passwordHash, passwordValid);
        if (decision.outcome === 'conflict') {
          throw new AppError(409, 'CREDENTIALS_CHANGED', '密码已在其他设备修改，请使用新密码重新操作');
        }
        if (decision.outcome === 'invalid') {
          throw new AppError(422, 'INVALID_PASSWORD', '密码不正确');
        }
        const now = new Date();
        await revokeActiveSessions(tx, userId, now);
        await tx.user.update({
          where: { id: userId },
          data: { status: 'DELETED', deletedAt: now }
        });
      },
      { timeout: CREDENTIAL_TX_TIMEOUT_MS }
    );
    reply.clearCookie('pbt_session', { path: '/' });
    return reply.status(204).send();
  });
};
