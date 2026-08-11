-- asp-7-migrate-legacy-visibility.sql
-- ASP-7：存量记忆条目可见性迁移（2026-08-11）
--
-- 背景：ASP v2 之前写入的记忆条目无 spaceScope 盖章。读取侧 scopeOf() 对无声明
-- 条目默认 {space:"meta", visibility:"public"}（向后兼容过渡态）。
-- 本迁移把该默认显式落库——语义完全等价（幂等、可复跑）：
--   UPDATE 后存量条目与 scopeOf 默认行为一致；此后新写入走 memory.save 显式声明。
--
-- 可回滚：jsonb_set 是追加键，回滚即删除键：
--   UPDATE memory_entries SET meta = meta - 'spaceScope' WHERE meta ? 'spaceScope' AND meta->>'spaceScope' = '{"space":"meta","visibility":"public"}'::text;

UPDATE memory_entries
SET meta = jsonb_set(meta, '{spaceScope}', '{"space":"meta","visibility":"public"}'::jsonb, true)
WHERE meta->'spaceScope' IS NULL;
