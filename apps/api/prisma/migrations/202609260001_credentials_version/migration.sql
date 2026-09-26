-- 凭证版本号：作为多端并发改密的唯一仲裁依据，并记录在会话上用于失效校验。
ALTER TABLE "users" ADD COLUMN "credentials_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "sessions" ADD COLUMN "credentials_version" INTEGER NOT NULL DEFAULT 1;

-- 改密审计事件类型与动作。
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'USER' BEFORE 'BOOK';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'PASSWORD_CHANGED';
