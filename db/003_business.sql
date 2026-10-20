-- Seruen для бизнеса: заведения, их предложения и статистика. Выполнить один раз после 002_auth.sql:
-- Supabase -> SQL Editor -> вставить файл целиком -> Run. Повторный запуск безопасен.

-- Заведение из каталога 2ГИС, которым управляет пользователь. Одно место — один владелец.
-- Заявка становится активной только после проверки командой Seruen (status = approved).
create table if not exists seruen_businesses (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references seruen_profiles(id) on delete cascade,
  place_id      text not null unique,
  place_name    text not null,
  contact       text not null check (char_length(contact) between 5 and 120),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  api_key_hash  text,                    -- sha256 ключа интеграции; сам ключ показывается один раз
  created_at    timestamptz not null default now()
);

-- Предложение: скидка, событие или новинка с днями и часами действия.
create table if not exists seruen_offers (
  id           bigint generated always as identity primary key,
  business_id  uuid not null references seruen_businesses(id) on delete cascade,
  place_id     text not null,
  kind         text not null check (kind in ('discount', 'event', 'news')),
  title        text not null check (char_length(title) between 3 and 80),
  details      text check (char_length(details) <= 300),
  days         smallint[] not null default '{0,1,2,3,4,5,6}',   -- 0 = понедельник
  start_min    smallint not null default 0 check (start_min between 0 and 1440),
  end_min      smallint not null default 1440 check (end_min between 0 and 1440),
  valid_until  date,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists seruen_offers_place_idx on seruen_offers (place_id);

-- Показы и переходы по дням.
create table if not exists seruen_offer_stats (
  offer_id  bigint not null references seruen_offers(id) on delete cascade,
  day       date not null default current_date,
  views     integer not null default 0,
  clicks    integer not null default 0,
  primary key (offer_id, day)
);

-- Атомарный счётчик: показ (view) или переход (click).
create or replace function seruen_offer_hit(p_offer bigint, p_kind text) returns void language sql as $$
  insert into seruen_offer_stats (offer_id, day, views, clicks)
  values (p_offer, current_date, (p_kind = 'view')::int, (p_kind = 'click')::int)
  on conflict (offer_id, day) do update
    set views = seruen_offer_stats.views + excluded.views,
        clicks = seruen_offer_stats.clicks + excluded.clicks;
$$;

alter table seruen_businesses  enable row level security;
alter table seruen_offers      enable row level security;
alter table seruen_offer_stats enable row level security;
