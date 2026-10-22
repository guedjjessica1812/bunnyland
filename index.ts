import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-bunnyland-webhook-secret' };
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const expectedSecret = Deno.env.get('BUNNYLAND_WEBHOOK_SECRET') || '';
  const suppliedSecret = req.headers.get('x-bunnyland-webhook-secret') || '';
  if (!expectedSecret || suppliedSecret !== expectedSecret) return new Response('Unauthorized', { status: 401 });

  try {
    const payload = await req.json();
    const row = payload.record || payload;
    const recipientId = row.recipient_id;
    if (!recipientId) return new Response(JSON.stringify({ ok: true, skipped: 'missing recipient_id' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const publicKey = Deno.env.get('VAPID_PUBLIC_KEY')!;
    const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')!;
    const siteUrl = Deno.env.get('BUNNYLAND_SITE_URL') || 'https://example.com';
    webpush.setVapidDetails('mailto:bunnyland-admin@example.com', publicKey, privateKey);
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: subscriptions, error } = await admin.from('bunnyland_push_subscriptions').select('id, endpoint, subscription').eq('user_id', recipientId);
    if (error) throw error;

    const title = 'Bunnyland';
    const body = row.message || ({
      comment: 'Quelqu’un a commenté une publication.', reply: 'Quelqu’un a répondu à un commentaire.',
      like: 'Quelqu’un a aimé une publication.', message: 'Tu as reçu un message.', rp_reply: 'Quelqu’un a répondu à ton sujet RP.'
    })[row.kind] || 'Tu as une nouvelle notification.';
    const notification = JSON.stringify({ title, body, url: siteUrl, tag: `bunnyland-${row.id || Date.now()}` });
    const results = await Promise.all((subscriptions || []).map(async (sub) => {
      try {
        await webpush.sendNotification(sub.subscription, notification);
        return { ok: true };
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await admin.from('bunnyland_push_subscriptions').delete().eq('id', sub.id);
        }
        return { ok: false, statusCode };
      }
    }));
    return new Response(JSON.stringify({ ok: true, sent: results.filter(x => x.ok).length, attempted: results.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('bunnyland-send-push error', error);
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
