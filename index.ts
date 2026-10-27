import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-bunnyland-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('BUNNYLAND_WEBHOOK_SECRET') || '';
  const suppliedSecret = req.headers.get('x-bunnyland-webhook-secret') || '';
  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    console.error('Bunnyland push: webhook secret absent ou incorrect.');
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const payload = await req.json();
    const row = payload.record || payload;
    const recipientId = row.recipient_id;

    if (!recipientId) {
      return json({ ok: true, skipped: 'missing recipient_id' });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const publicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    const privateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const siteUrl = Deno.env.get('BUNNYLAND_SITE_URL') || 'https://guedjjessica1812.github.io/bunnyland';

    if (!supabaseUrl || !serviceRoleKey || !publicKey || !privateKey) {
      console.error('Bunnyland push: configuration serveur incomplète.');
      return json({ error: 'Configuration serveur incomplète (vérifier les secrets Supabase).' }, 500);
    }

    webpush.setVapidDetails('mailto:bunnyland-admin@example.com', publicKey, privateKey);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: subscriptions, error } = await admin
      .from('bunnyland_push_subscriptions')
      .select('id, user_id, endpoint, subscription')
      .eq('user_id', recipientId);

    if (error) {
      console.error('Bunnyland push: lecture abonnements impossible', error.message);
      throw error;
    }

    if (!subscriptions?.length) {
      console.log('Bunnyland push: aucun abonnement pour le destinataire.');
      return json({ ok: true, sent: 0, attempted: 0, message: 'Aucun abonnement pour ce destinataire.' });
    }

    const title = 'Bunnyland';
    const body = row.message || ({
      comment: 'Quelqu’un a commenté une publication.',
      reply: 'Quelqu’un a répondu à un commentaire.',
      like: 'Quelqu’un a aimé une publication.',
      message: 'Tu as reçu un message.',
      rp_reply: 'Quelqu’un a répondu à ton sujet RP.',
    })[row.kind] || 'Tu as une nouvelle notification.';

    const notification = JSON.stringify({
      title,
      body,
      url: siteUrl,
      tag: `bunnyland-${row.id || Date.now()}`,
    });

    const results = await Promise.all(subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub.subscription, notification);
        return { subscriptionId: sub.id, ok: true };
      } catch (err) {
        const pushError = err as {
          statusCode?: number;
          body?: string;
          message?: string;
        };
        const statusCode = Number(pushError?.statusCode || 0);
        const responseBody = String(pushError?.body || '');
        const message = String(pushError?.message || err || 'Erreur inconnue');

        // Supprime seulement les abonnements explicitement expirés/révoqués.
        if (statusCode === 404 || statusCode === 410) {
          const { error: deleteError } = await admin
            .from('bunnyland_push_subscriptions')
            .delete()
            .eq('id', sub.id);
          if (deleteError) console.error('Nettoyage abonnement expiré impossible:', deleteError.message);
        }

        // Le détail du fournisseur permet de diagnostiquer 400/403 sans exposer les clés.
        console.error('Bunnyland push failed', {
          subscriptionId: sub.id,
          statusCode,
          message,
          body: responseBody.slice(0, 500),
        });

        return {
          subscriptionId: sub.id,
          ok: false,
          statusCode,
          message,
          body: responseBody.slice(0, 500),
        };
      }
    }));

    const sent = results.filter((result) => result.ok).length;
    const failures = results.filter((result) => !result.ok);

    return json({
      ok: true,
      sent,
      attempted: results.length,
      failures,
    });
  } catch (error) {
    console.error('bunnyland-send-push error', error);
    return json({ error: String(error) }, 500);
  }
});
