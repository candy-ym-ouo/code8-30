import { createHash, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { AppError } from './errors.js';

export const SESSION_COOKIE = 'pbt_session';

/** 可在事务内执行的 Prisma 客户端：顶层客户端或事务回调里的 tx。 */
type Db = PrismaClient | Prisma.TransactionClient;

export interface AuthUser {
  id: string;
  email: string;
  createdAt: Date;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(passwordHash, password);
  } catch {
    return false;
  }
}

export interface SessionToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function buildSessionToken(): SessionToken {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash: tokenHash(token), expiresAt };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  });
}

/** 吊销用户名下所有仍有效的会话。必须在凭证事务内调用。 */
export async function revokeActiveSessions(db: Db, userId: string, now = new Date()): Promise<void> {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now }
  });
}

/** 在指定客户端（可传事务 tx）内落库一条新会话，但不下发 Cookie。 */
export async function persistSession(db: Db, userId: string): Promise<SessionToken> {
  const issued = buildSessionToken();
  await db.session.create({
    data: { userId, tokenHash: issued.tokenHash, expiresAt: issued.expiresAt }
  });
  return issued;
}

/** 注册、登录使用：落库会话并立即下发 Cookie。 */
export async function createSession(userId: string, reply: FastifyReply): Promise<void> {
  const issued = await persistSession(prisma, userId);
  setSessionCookie(reply, issued.token, issued.expiresAt);
}

export async function deleteCurrentSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: tokenHash(token), revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function requireAuth(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  const session = await prisma.session.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true }
  });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() <= Date.now() ||
    session.user.status !== 'ACTIVE' ||
    session.user.deletedAt
  ) {
    throw new AppError(401, 'UNAUTHENTICATED', '登录状态已失效');
  }

  request.authUser = {
    id: session.user.id,
    email: session.user.email,
    createdAt: session.user.createdAt
  };

  const now = Date.now();
  const rollingInterval = 24 * 60 * 60 * 1000;
  if (session.expiresAt.getTime() - now < env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000 - rollingInterval) {
    const expiresAt = new Date(now + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt } });
  }
}

export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  return request.authUser;
}
