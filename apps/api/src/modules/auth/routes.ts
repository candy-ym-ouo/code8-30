import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import {
  createSession,
  currentUser,
  deleteCurrentSession,
  generateSessionToken,
  hashPassword,
  requireAuth,
  verifyPassword
} from '../../lib/auth.js';
import { writeEvent } from '../../lib/events.js';
import { assertCredentialChangeAllowed } from '../../lib/credentials.js';

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

      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email, passwordHash: await hashPassword(parsed.data.password) }
        });
        await createSession(tx, created.id, created.credentialsVersion, reply);
        return created;
      });
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
      await createSession(prisma, user.id, user.credentialsVersion, reply);
      return { user: publicUser(user) };
    }
  );

  app.post('/logout', { preHandler: requireAuth }, async (request, reply) => {
    await deleteCurrentSession(request, reply);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: requireAuth }, async (request) => {
    return { user: publicUser(currentUser(request)) };
  });

  app.patch('/password', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = passwordChangeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '密码信息无效', zodFields(parsed.error));
    }
    const authUser = currentUser(request);
    const nextToken = generateSessionToken();

    await prisma.$transaction(
      async (tx) => {
        // 行锁串行化同一用户的并发改密：后到的请求必须等先到者提交后再读版本。
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${authUser.id}::uuid FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: authUser.id } });

        // 冲突口径：版本不一致 = 已在别的设备完成改密，旧设备重试无副作用失败
        //（不吊销会话、不轮换新会话、不写审计）。
        assertCredentialChangeAllowed(authUser.credentialsVersion, user);

        const valid = await verifyPassword(user.passwordHash, parsed.data.currentPassword);
        if (!valid) throw new AppError(422, 'INVALID_PASSWORD', '当前密码不正确');

        const now = new Date();
        const nextVersion = user.credentialsVersion + 1;

        // 密码与版本号一起翻转，失败整事务回滚，不存在“密码变了版本没变”。
        const updated = await tx.user.update({
          where: { id: user.id },
          data: { passwordHash: await hashPassword(parsed.data.newPassword), credentialsVersion: nextVersion }
        });

        // 吊销该用户全部旧会话（包括当前请求这一条），与密码变更同提交。
        await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now }
        });

        // 审计事件在同事务内写入，occurredAt 与凭证状态原子对齐。
        await writeEvent(tx, {
          userId: user.id,
          entityType: 'USER',
          entityId: user.id,
          action: 'PASSWORD_CHANGED',
          payload: { fromVersion: user.credentialsVersion, toVersion: nextVersion }
        });

        // 仅给改密成功的设备签发新版本会话。
        await createSession(tx, updated.id, updated.credentialsVersion, reply, nextToken);
      },
      { timeout: 15_000 }
    );
    return { ok: true };
  });

  app.delete('/account', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = deleteAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '请输入密码', zodFields(parsed.error));
    }
    const authUser = currentUser(request);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${authUser.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: authUser.id } });
      assertCredentialChangeAllowed(authUser.credentialsVersion, user);
      if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
        throw new AppError(422, 'INVALID_PASSWORD', '密码不正确');
      }
      const now = new Date();
      await Promise.all([
        tx.session.updateMany({
          where: { userId: authUser.id, revokedAt: null },
          data: { revokedAt: now }
        }),
        tx.user.update({
          where: { id: authUser.id },
          data: { status: 'DELETED', deletedAt: now }
        })
      ]);
    });
    reply.clearCookie('pbt_session', { path: '/' });
    return reply.status(204).send();
  });
};
