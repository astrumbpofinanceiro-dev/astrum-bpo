-- Cria o primeiro BPO_MASTER. Executar uma vez com a credencial de migration.
-- uid = id do usuário já criado no Supabase Auth.
--   psql "$DATABASE_MIGRATION_URL" -v uid='...' -v email='...' -v nome='...' -f scripts/bootstrap-master.sql
BEGIN;
SELECT set_config('app.current_user_id', :'uid', true), set_config('app.actor_role', 'BPO_MASTER', true),
       set_config('app.change_reason', 'bootstrap inicial', true);
INSERT INTO users (id, email, full_name, is_bpo_master) VALUES (:'uid', :'email', :'nome', true);
COMMIT;
