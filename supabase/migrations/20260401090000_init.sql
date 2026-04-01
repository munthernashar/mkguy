-- Baseline migration scaffold
-- Intentionally minimal: this project currently relies on Supabase defaults only.

begin;

-- Keep baseline explicit for future migrations.
select 'baseline_initialized' as status;

commit;
