-- Seruen: лента «люди делятся местами и ставят лайки».
-- Выполнить один раз: Supabase -> SQL Editor -> вставить файл целиком -> Run.
-- Повторный запуск безопасен.
--
-- Доступ к таблицам только с сервера Seruen по секретному ключу (service_role):
-- RLS включён и политик для anon нет, поэтому публичный ключ ничего не прочитает и не запишет.

create table if not exists seruen_profiles (
  id          uuid primary key,
  name        text not null check (char_length(name) between 2 and 24),
  created_at  timestamptz not null default now()
);

create table if not exists seruen_posts (
  id              bigint generated always as identity primary key,
  author_id       uuid not null references seruen_profiles(id) on delete cascade,
  place_id        text not null,              -- id организации/объекта в 2ГИС
  place_name      text not null,
  place_category  text,
  lat             double precision not null,  -- координаты места (публичные), не пользователя
  lon             double precision not null,
  text            text not null check (char_length(text) between 3 and 280),
  likes_count     integer not null default 0,
  reports_count   integer not null default 0,
  hidden          boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists seruen_posts_created_idx on seruen_posts (created_at desc);
create index if not exists seruen_posts_place_idx on seruen_posts (place_id);

create table if not exists seruen_likes (
  post_id     bigint not null references seruen_posts(id) on delete cascade,
  profile_id  uuid not null references seruen_profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, profile_id)
);

create table if not exists seruen_reports (
  post_id     bigint not null references seruen_posts(id) on delete cascade,
  profile_id  uuid not null references seruen_profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, profile_id)
);

-- Счётчик лайков держит база, а не клиент.
create or replace function seruen_on_like() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update seruen_posts set likes_count = likes_count + 1 where id = new.post_id;
  else
    update seruen_posts set likes_count = greatest(likes_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end $$;
drop trigger if exists seruen_likes_count on seruen_likes;
create trigger seruen_likes_count after insert or delete on seruen_likes
  for each row execute function seruen_on_like();

-- Три жалобы от разных людей — пост скрывается до ручной проверки.
create or replace function seruen_on_report() returns trigger language plpgsql as $$
begin
  update seruen_posts
     set reports_count = reports_count + 1,
         hidden = hidden or reports_count + 1 >= 3
   where id = new.post_id;
  return null;
end $$;
drop trigger if exists seruen_reports_count on seruen_reports;
create trigger seruen_reports_count after insert on seruen_reports
  for each row execute function seruen_on_report();

alter table seruen_profiles enable row level security;
alter table seruen_posts    enable row level security;
alter table seruen_likes    enable row level security;
alter table seruen_reports  enable row level security;
