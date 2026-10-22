// The sales page: shows the price from the server (which reads it from Stripe), and starts Checkout.
(function () {
  const $ = (id) => document.getElementById(id);
  const isHttps = (value) => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
  let ready = false;

  function update() { $('buy').disabled = !(ready && $('agree').checked); }

  async function load() {
    try {
      const res = await fetch('/api/offer');
      if (!res.ok) throw new Error(String(res.status));
      const offer = await res.json();
      document.title = `${offer.name}: CDOT Inspection Stations`;
      $('name').textContent = offer.name;
      $('headline').textContent = offer.headline;
      $('term').textContent = offer.term;
      $('extra').textContent = offer.extra;
      $('price').textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: offer.currency.toUpperCase() }).format(offer.amount / 100);
      for (const [id, url] of [['terms', offer.termsUrl], ['refund', offer.refundUrl], ['privacy', offer.privacyUrl]]) {
        if (isHttps(url)) $(id).href = url;
      }
      ready = true;
    } catch {
      $('price').textContent = '';
      $('error').textContent = 'Checkout is unavailable right now. Please try again later.';
    }
    update();
  }

  async function buy() {
    $('error').textContent = '';
    $('buy').disabled = true;
    try {
      const res = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agreed: true }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
      const host = new URL(data.url).hostname;
      if (!(host === 'stripe.com' || host.endsWith('.stripe.com'))) throw new Error('Unexpected checkout address.'); // only ever send people to Stripe
      location.assign(data.url);
    } catch (error) {
      $('error').textContent = error.message;
      update();
    }
  }

  $('agree').addEventListener('change', update);
  $('buy').addEventListener('click', buy);
  load();
})();
