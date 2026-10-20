-- Seruen: вход и регистрация (Supabase Auth). Выполнить один раз после schema.sql:
-- Supabase -> SQL Editor -> вставить файл целиком -> Run. Повторный запуск безопасен.

-- Паспорт (очки, отметки, значки) хранится в профиле — переезжает между устройствами.
alter table seruen_profiles
  add column if not exists passport jsonb not null default '{}'::jsonb;

-- Профиль = пользователь Supabase Auth: удалили аккаунт — удалились профиль, посты и лайки.
-- not valid: старые строки не проверяем, новые — обязательно.
do $$ begin
  alter table seruen_profiles
    add constraint seruen_profiles_user_fk foreign key (id) references auth.users(id) on delete cascade not valid;
exception when duplicate_object then null;
end $$;
