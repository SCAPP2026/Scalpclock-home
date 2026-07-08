export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const id  = url.searchParams.get('id');
  if (!id) return new Response(JSON.stringify({ error: 'id required' }));

  const res  = await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}?expand[]=total_details.breakdown.discounts`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const data = await res.json();
  return new Response(JSON.stringify({
    status: res.status,
    amount_total: data.amount_total,
    amount_subtotal: data.amount_subtotal,
    currency: data.currency,
    total_details: data.total_details,
    discounts: data.discounts,
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
