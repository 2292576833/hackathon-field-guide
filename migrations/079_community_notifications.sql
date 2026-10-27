-- 079 · 社区通知复用既有 outbox（P6 的根增量迁移）
--
-- 依据：规划 34 §4 与宪法 v1.23.0 原则 XIII「赛事社区……复用既有通知与保留边界」。
-- 社区（连接请求 / 私信）的通知走**同一个** organizer_notification_outbox 与同一套发信状态机，
-- 只是把 kind 的取值扩到 'community'——**不新建第二套通知系统**，也不改任何既有行。

ALTER TABLE organizer_notification_batches DROP CONSTRAINT IF EXISTS organizer_notification_batches_kind_check;
ALTER TABLE organizer_notification_batches ADD CONSTRAINT organizer_notification_batches_kind_check CHECK(kind IN ('announcement','selection','community'));
ALTER TABLE organizer_notification_outbox DROP CONSTRAINT IF EXISTS organizer_notification_outbox_kind_check;
ALTER TABLE organizer_notification_outbox ADD CONSTRAINT organizer_notification_outbox_kind_check CHECK(kind IN ('announcement','selection','community'));
-- 表级约束还要求 announcement 的 registration_id 为空；社区与公告同样没有报名关联，必须一起放宽。
ALTER TABLE organizer_notification_outbox DROP CONSTRAINT IF EXISTS organizer_notification_outbox_check;
ALTER TABLE organizer_notification_outbox ADD CONSTRAINT organizer_notification_outbox_check CHECK(
  (kind IN ('announcement','community') AND registration_id IS NULL AND registration_revision IS NULL) OR
  (kind='selection' AND registration_id IS NOT NULL AND registration_revision>0));
