// LemonSqueezy billing integration.
//
// Lemon Squeezy is our "merchant of record" — they handle global tax,
// chargebacks, affiliate payouts. We just:
//   1. Hand a user a checkout URL when they click "Upgrade to Pro"
//   2. Listen to webhooks for subscription_created / updated / cancelled
//   3. Mirror the user's tier into our profiles table
//
// Required env (set per LS dashboard once the product is created):
//   LEMONSQUEEZY_API_KEY        — Bearer token for the LS REST API
//   LEMONSQUEEZY_STORE_ID       — store id (e.g. 421593)
//   LEMONSQUEEZY_PRO_VARIANT_ID — variant id for the Pro subscription
//   LEMONSQUEEZY_WEBHOOK_SECRET — for verifying webhook signatures
//
// Checkout flow:
//   POST /billing/checkout {} → returns { url } pointing at the LS-hosted
//   checkout page. After paying, LS redirects to redirect_url and fires
//   webhooks at /billing/webhook on our backend.

import { createHmac, timingSafeEqual } from 'node:crypto';

const LS_API = 'https://api.lemonsqueezy.com/v1';

function lsHeaders() {
  if (!process.env.LEMONSQUEEZY_API_KEY) throw new Error('LEMONSQUEEZY_API_KEY not set');
  return {
    Authorization: `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
  };
}

// Build a checkout URL tied to one of our authenticated users. The
// `custom` payload travels through LS and back to us in webhooks so we
// can match the payment to req.userId without trusting customer email.
export async function createCheckout({ userId, email, variantId, storeId }) {
  const body = {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: {
          email: email || undefined,
          custom: { user_id: userId },
        },
        product_options: {
          enabled_variants: [Number(variantId)],
          redirect_url: 'https://app.earshot.cc/?upgrade=success',
          receipt_link_url: 'https://app.earshot.cc/',
          receipt_thank_you_note: 'Welcome to Earshot Pro!',
        },
        // Test-mode store → test-mode checkout. LS infers from the store.
      },
      relationships: {
        store:   { data: { type: 'stores',   id: String(storeId) } },
        variant: { data: { type: 'variants', id: String(variantId) } },
      },
    },
  };
  const r = await fetch(`${LS_API}/checkouts`, {
    method: 'POST',
    headers: lsHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`ls checkout ${r.status}: ${text.slice(0, 300)}`);
  }
  const json = await r.json();
  return json?.data?.attributes?.url;
}

// HMAC-SHA256 verification of webhook payloads. LS sends the secret as
// `X-Signature` header; the body is hashed with the shared secret.
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) return false; // fail closed
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(digest), Buffer.from(signatureHeader || ''));
  } catch { return false; }
}

// Map LS event to a tier change. Active subscription → Pro. Cancelled /
// expired → Free. We ignore one-off payments (not used yet).
export function tierFromWebhook(event, payload) {
  const status = payload?.data?.attributes?.status;
  const cancelled = payload?.data?.attributes?.cancelled;
  if (event === 'subscription_created' || event === 'subscription_resumed'
      || event === 'subscription_updated') {
    if (['active', 'on_trial', 'past_due'].includes(status) && !cancelled) return 'pro';
    if (['cancelled', 'expired', 'unpaid'].includes(status)) return 'free';
  }
  if (event === 'subscription_cancelled' || event === 'subscription_expired') return 'free';
  return null;
}
