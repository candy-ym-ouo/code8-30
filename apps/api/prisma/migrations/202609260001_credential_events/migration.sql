-- 凭证操作需要进入用户可见的时间线：新增“用户”实体与“改密”动作。
-- PostgreSQL 12+ 允许在事务中追加枚举值（本迁移不立即使用新值）。
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'USER';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'PASSWORD_CHANGED';
