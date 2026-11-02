-- Sessions for the Shikimori OAuth relay.
-- Only the Edge Function (service_role) touches this table; RLS is enabled with
-- no policies, so anon/authenticated keys cannot read tokens.

create table if not exists public.shikimori_sessions (
  sid           text primary key,
  skey          text not null,
  status        text not null default 'pending',
  access_token  text,
  refresh_token text,
  expires_in    integer default 0,
  error         text,
  ip            text,
  qr_svg        text,
  created_at    timestamptz not null default now()
);

create index if not exists shikimori_sessions_created_idx
  on public.shikimori_sessions (created_at);

create index if not exists shikimori_sessions_ip_idx
  on public.shikimori_sessions (ip, created_at);

alter table public.shikimori_sessions enable row level security;

revoke all on table public.shikimori_sessions from anon, authenticated;
grant select, insert, update, delete on table public.shikimori_sessions to service_role;

-- Atomically take the token once: the first /status after the callback deletes
-- the row, so the token cannot be fetched twice.
create or replace function public.consume_shikimori_session(p_sid text, p_key text)
returns table (access_token text, refresh_token text, expires_in integer)
language sql
security definer
set search_path = public
as $$
  delete from public.shikimori_sessions
   where sid = p_sid
     and skey = p_key
     and status = 'ok'
  returning public.shikimori_sessions.access_token,
            public.shikimori_sessions.refresh_token,
            public.shikimori_sessions.expires_in;
$$;

revoke all on function public.consume_shikimori_session(text, text) from public, anon, authenticated;
grant execute on function public.consume_shikimori_session(text, text) to service_role;
