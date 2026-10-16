-- ScalpClock: Paper Trading — schema
-- Same convention as the other scripts in this folder: a reference copy of
-- what was applied to the live project (this repo has no migration runner).
--
-- ADDITIVE ONLY. Three brand-new tables and four new functions. Nothing
-- existing is altered, so no member XP/streaks/badges/journal/referral/
-- subscription data can be touched by this script.
--
-- Security model: members can READ their own rows (RLS), but cannot write
-- anything directly. Every write goes through /api/paper/*, which verifies
-- the caller's JWT, prices the fill server-side from live quotes, and calls
-- the functions below with the service role. That keeps fill prices honest —
-- a client can never submit its own price.

-- 1. Tables -----------------------------------------------------------------
create table if not exists paper_accounts (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  cash           numeric not null,
  starting_cash  numeric not null default 25000,
  reset_count    integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One row per open holding. `symbol` is the ticker for stocks and the OCC
-- contract symbol (e.g. SPY261016C00580000) for options. avg_cost is per
-- share for stocks and per share of premium for options (x100 per contract).
create table if not exists paper_positions (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references paper_accounts(user_id) on delete cascade,
  asset_class  text not null check (asset_class in ('stock','option')),
  symbol       text not null,
  underlying   text not null,
  option_type  text check (option_type in ('call','put')),
  strike       numeric,
  expiry       date,
  qty          numeric not null check (qty > 0),
  avg_cost     numeric not null,
  opened_at    timestamptz not null default now(),
  unique (user_id, symbol)
);

-- Append-only fill history. realized_pnl is set on sells.
create table if not exists paper_fills (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references paper_accounts(user_id) on delete cascade,
  asset_class   text not null check (asset_class in ('stock','option')),
  symbol        text not null,
  underlying    text not null,
  option_type   text,
  strike        numeric,
  expiry        date,
  side          text not null check (side in ('buy','sell')),
  qty           numeric not null check (qty > 0),
  price         numeric not null check (price >= 0),
  notional      numeric not null,
  realized_pnl  numeric,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists paper_fills_user_created on paper_fills (user_id, created_at desc);

-- 2. RLS: read own rows only, no direct writes --------------------------------
alter table paper_accounts  enable row level security;
alter table paper_positions enable row level security;
alter table paper_fills     enable row level security;

drop policy if exists "paper_accounts read own"  on paper_accounts;
drop policy if exists "paper_positions read own" on paper_positions;
drop policy if exists "paper_fills read own"     on paper_fills;
create policy "paper_accounts read own"  on paper_accounts  for select to authenticated using ((select auth.uid()) = user_id);
create policy "paper_positions read own" on paper_positions for select to authenticated using ((select auth.uid()) = user_id);
create policy "paper_fills read own"     on paper_fills     for select to authenticated using ((select auth.uid()) = user_id);

revoke insert, update, delete on paper_accounts, paper_positions, paper_fills from anon, authenticated;

-- 3. Functions (service role only) -------------------------------------------
create or replace function paper_ensure_account(p_user uuid)
returns paper_accounts
language plpgsql security definer set search_path = public as $$
declare acct paper_accounts;
begin
  insert into paper_accounts (user_id, cash) values (p_user, 25000)
  on conflict (user_id) do nothing;
  select * into acct from paper_accounts where user_id = p_user;
  return acct;
end $$;

-- Executes one fill atomically: locks the account row, checks buying power
-- (buys) or held quantity (sells), updates cash + position, logs the fill.
-- Long-only: no shorting stock, no writing options.
create or replace function paper_execute(
  p_user uuid, p_asset_class text, p_symbol text, p_underlying text,
  p_option_type text, p_strike numeric, p_expiry date,
  p_side text, p_qty numeric, p_price numeric, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  acct     paper_accounts;
  pos      paper_positions;
  mult     numeric := case when p_asset_class = 'option' then 100 else 1 end;
  notional numeric := round(p_qty * p_price * mult, 2);
  pnl      numeric := null;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be positive'; end if;
  if p_asset_class = 'option' and p_qty <> trunc(p_qty) then raise exception 'Options trade in whole contracts'; end if;
  if p_price is null or p_price < 0 then raise exception 'Invalid price'; end if;

  perform paper_ensure_account(p_user);
  select * into acct from paper_accounts where user_id = p_user for update;
  select * into pos from paper_positions where user_id = p_user and symbol = p_symbol;

  if p_side = 'buy' then
    if notional > acct.cash then
      raise exception 'Not enough buying power: need $%, have $%', notional, round(acct.cash, 2);
    end if;
    update paper_accounts set cash = cash - notional, updated_at = now() where user_id = p_user;
    if pos.id is null then
      insert into paper_positions (user_id, asset_class, symbol, underlying, option_type, strike, expiry, qty, avg_cost)
      values (p_user, p_asset_class, p_symbol, p_underlying, p_option_type, p_strike, p_expiry, p_qty, p_price);
    else
      update paper_positions
         set avg_cost = (avg_cost * qty + p_price * p_qty) / (qty + p_qty),
             qty = qty + p_qty
       where id = pos.id;
    end if;
  elsif p_side = 'sell' then
    if pos.id is null or pos.qty < p_qty then
      raise exception 'You can only sell what you hold (have %)', coalesce(pos.qty, 0);
    end if;
    pnl := round((p_price - pos.avg_cost) * p_qty * mult, 2);
    update paper_accounts set cash = cash + notional, updated_at = now() where user_id = p_user;
    if pos.qty = p_qty then
      delete from paper_positions where id = pos.id;
    else
      update paper_positions set qty = qty - p_qty where id = pos.id;
    end if;
  else
    raise exception 'Side must be buy or sell';
  end if;

  insert into paper_fills (user_id, asset_class, symbol, underlying, option_type, strike, expiry, side, qty, price, notional, realized_pnl, note)
  values (p_user, p_asset_class, p_symbol, p_underlying, p_option_type, p_strike, p_expiry, p_side, p_qty, p_price, notional, pnl, p_note);

  select * into acct from paper_accounts where user_id = p_user;
  return jsonb_build_object('cash', acct.cash, 'notional', notional, 'realized_pnl', pnl);
end $$;

-- Wipes positions + history and restores starting cash.
create or replace function paper_reset(p_user uuid)
returns paper_accounts
language plpgsql security definer set search_path = public as $$
declare acct paper_accounts;
begin
  perform paper_ensure_account(p_user);
  delete from paper_positions where user_id = p_user;
  delete from paper_fills where user_id = p_user;
  update paper_accounts
     set cash = starting_cash, reset_count = reset_count + 1, updated_at = now()
   where user_id = p_user
  returning * into acct;
  return acct;
end $$;

revoke execute on function paper_ensure_account(uuid) from public, anon, authenticated;
revoke execute on function paper_execute(uuid, text, text, text, text, numeric, date, text, numeric, numeric, text) from public, anon, authenticated;
revoke execute on function paper_reset(uuid) from public, anon, authenticated;
grant execute on function paper_ensure_account(uuid) to service_role;
grant execute on function paper_execute(uuid, text, text, text, text, numeric, date, text, numeric, numeric, text) to service_role;
grant execute on function paper_reset(uuid) to service_role;
