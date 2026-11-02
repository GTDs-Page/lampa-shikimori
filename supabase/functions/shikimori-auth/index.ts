// Shikimori OAuth relay for Lampa, running as a Supabase Edge Function.
//
// Endpoints (single function URL + ?action=...):
//   GET  ?action=new                     -> { sid, key, url, qr }
//   GET  ?action=qr&sid=...              -> SVG QR
//   GET  ?action=authorize&sid=...       -> redirect to Shikimori OAuth
//   GET  ?code=...&state=...             -> OAuth callback
//   POST ?action=status  {sid,key}       -> pending / ok(tokens) / error
//   POST ?action=refresh {refresh_token} -> new access token
//   GET  ?action=health                  -> { ok, configured }
//
// Secrets (Supabase -> Project Settings -> Edge Functions -> Secrets):
//   CLIENT_ID, CLIENT_SECRET, SHIKI_BASE (https://shikimori.io)
//   PUBLIC_BASE (optional, for a custom domain)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2';
// @ts-ignore - qrcode-generator has no bundled types
import qrcode from 'npm:qrcode-generator@1.4.4';

const TABLE = 'shikimori_sessions';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const CLIENT_ID = Deno.env.get('CLIENT_ID') || '';
const CLIENT_SECRET = Deno.env.get('CLIENT_SECRET') || '';
const SHIKI_BASE = (Deno.env.get('SHIKI_BASE') || 'https://shikimori.io').replace(/\/+$/, '');

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function publicBase(req: Request): string {
  const custom = Deno.env.get('PUBLIC_BASE');
  if (custom) return custom.replace(/\/+$/, '');
  const url = new URL(req.url);
  // Supabase terminates TLS at its proxy and req.url may arrive as http://.
  // OAuth redirect URIs and QR links must be https.
  return 'https://' + url.host + '/functions/v1/shikimori-auth';
}

function redirectUri(req: Request): string {
  return (Deno.env.get('REDIRECT_URI') || publicBase(req)).replace(/\/+$/, '');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function html(status: number, text: string): Response {
  const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Shikimori</title>
<style>body{background:#15171c;color:#e8eaed;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
.box{max-width:560px;text-align:center}.ok{color:#2ecc71}.err{color:#ff6b6b}h1{font-size:24px;margin:0 0 12px}p{color:#aab0b8}</style>
</head><body><div class="box"><h1>Shikimori</h1><p>${text}</p></div></body></html>`;
  return new Response(page, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function svg(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function token(bytes = 24): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for') || '';
  return forwarded.split(',')[0].trim() || 'unknown';
}

function configured(): boolean {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

async function oauth(payload: Record<string, string>): Promise<any> {
  const body = new URLSearchParams(payload).toString();
  const response = await fetch(SHIKI_BASE + '/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'Lampa-Shikimori-QR/2.0',
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OAuth ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function newSession(req: Request): Promise<Response> {
  if (!configured()) return json(503, { error: 'QR-авторизация не настроена: нет CLIENT_ID/CLIENT_SECRET' });

  const base = publicBase(req);
  const ip = clientIp(req);
  const now = Date.now();

  // Drop old sessions (10 minutes).
  await db.from(TABLE).delete().lt('created_at', new Date(now - 10 * 60 * 1000).toISOString());

  // At most 10 new sessions per minute per IP.
  const { count } = await db
    .from(TABLE)
    .select('sid', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('created_at', new Date(now - 60 * 1000).toISOString());

  if ((count || 0) >= 10) return json(429, { error: 'Слишком много запросов, попробуйте позже' });

  const sid = token(24);
  const key = token(24);
  const { error } = await db.from(TABLE).insert({
    sid,
    skey: key,
    status: 'pending',
    ip,
    created_at: new Date(now).toISOString(),
  });
  if (error) throw error;

  return json(200, {
    sid,
    key,
    url: `${base}?action=authorize&sid=${encodeURIComponent(sid)}`,
    qr: `${base}?action=qr&sid=${encodeURIComponent(sid)}`,
  });
}

async function qr(sid: string, req: Request): Promise<Response> {
  if (!sid) return html(400, 'Нет sid.');
  const { data: row, error } = await db.from(TABLE).select('sid, qr_svg').eq('sid', sid).maybeSingle();
  if (error) throw error;
  if (!row) return html(404, 'QR-код устарел, откройте вход заново.');
  if (row.qr_svg) return svg(row.qr_svg);

  const url = `${publicBase(req)}?action=authorize&sid=${encodeURIComponent(sid)}`;
  // @ts-ignore
  const qrCode = qrcode(0, 'M');
  qrCode.addData(url);
  qrCode.make();
  // @ts-ignore
  const image = qrCode.createSvgTag(8, 4);

  await db.from(TABLE).update({ qr_svg: image }).eq('sid', sid);
  return svg(image);
}

async function authorize(sid: string, req: Request): Promise<Response> {
  if (!sid) return html(400, 'Нет sid.');
  const { data: row, error } = await db.from(TABLE).select('sid').eq('sid', sid).maybeSingle();
  if (error) throw error;
  if (!row) return html(404, 'QR-код устарел. Откройте вход на телевизоре ещё раз.');
  if (!configured()) return html(503, 'OAuth-приложение Shikimori не настроено на сервере.');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: '',
    state: sid,
  });
  return new Response(null, {
    status: 302,
    headers: { Location: `${SHIKI_BASE}/oauth/authorize?${params.toString()}`, 'Cache-Control': 'no-store' },
  });
}

async function callback(code: string, state: string, errorParam: string, req: Request): Promise<Response> {
  const { data: row, error } = await db.from(TABLE).select('sid').eq('sid', state).maybeSingle();
  if (error) throw error;
  if (!row) return html(404, 'Сессия не найдена или истекла. Откройте вход на телевизоре заново.');

  if (errorParam) {
    await db.from(TABLE).update({ status: 'error', error: errorParam }).eq('sid', state);
    return html(400, '<span class="err">Доступ не разрешён.</span>');
  }
  if (!code) return html(400, '<span class="err">Shikimori не вернул код.</span>');

  try {
    const data = await oauth({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(req),
    });
    if (!data.access_token) throw new Error('no access_token');
    await db.from(TABLE).update({
      status: 'ok',
      access_token: data.access_token,
      refresh_token: data.refresh_token || '',
      expires_in: data.expires_in || 0,
      error: null,
    }).eq('sid', state);
    return html(200, '<span class="ok">Готово!</span><br>Вернитесь к телевизору — вход выполнится автоматически.');
  } catch (e) {
    console.error('token exchange failed', e);
    await db.from(TABLE).update({ status: 'error', error: 'token_exchange_failed' }).eq('sid', state);
    return html(502, '<span class="err">Не удалось получить токен.</span> Проверьте client_id/secret и redirect_uri приложения.');
  }
}

async function status(sid: string, key: string): Promise<Response> {
  const { data: consumed, error: rpcError } = await db.rpc('consume_shikimori_session', {
    p_sid: sid,
    p_key: key,
  });
  if (!rpcError && consumed && consumed.length) {
    const row = consumed[0];
    return json(200, {
      status: 'ok',
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expires_in: row.expires_in,
    });
  }

  const { data: row, error } = await db
    .from(TABLE)
    .select('skey, status, error, access_token, refresh_token, expires_in')
    .eq('sid', sid)
    .maybeSingle();
  if (error) throw error;
  if (!row) return json(200, { status: 'expired' });
  if (row.skey !== key) return json(200, { status: 'forbidden' });
  if (row.status === 'ok') {
    await db.from(TABLE).delete().eq('sid', sid);
    return json(200, {
      status: 'ok',
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expires_in: row.expires_in,
    });
  }
  if (row.status === 'error') {
    await db.from(TABLE).delete().eq('sid', sid);
    return json(200, { status: 'error', error: row.error || 'error' });
  }
  return json(200, { status: 'pending' });
}

async function refresh(refreshToken: string): Promise<Response> {
  if (!configured()) return json(503, { status: 'error', error: 'not_configured' });
  if (!refreshToken) return json(400, { status: 'error', error: 'no_refresh_token' });

  try {
    const data = await oauth({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    if (!data.access_token) throw new Error('no access_token');
    return json(200, {
      status: 'ok',
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_in: data.expires_in || 0,
    });
  } catch (e) {
    console.error('refresh failed', e);
    return json(502, { status: 'error', error: 'refresh_failed' });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || '';
    const sid = url.searchParams.get('sid') || '';
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const oauthError = url.searchParams.get('error') || '';

    if (action === 'health') return json(200, { ok: true, configured: configured() });

    if (req.method === 'POST' && action === 'status') {
      const body = await req.json().catch(() => ({}));
      return await status(String(body.sid || ''), String(body.key || ''));
    }
    if (req.method === 'POST' && action === 'refresh') {
      const body = await req.json().catch(() => ({}));
      return await refresh(String(body.refresh_token || ''));
    }

    if (action === 'new') return await newSession(req);
    if (action === 'qr') return await qr(sid, req);
    if (action === 'authorize') return await authorize(sid, req);
    if (state && (code || oauthError)) return await callback(code, state, oauthError, req);

    return json(200, { ok: true, service: 'shikimori-auth' });
  } catch (e) {
    console.error('relay error', e);
    return json(500, { error: String((e as Error)?.message || e) });
  }
});
