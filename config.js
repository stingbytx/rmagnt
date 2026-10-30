/* ============================================================
   REMY AGENT — public runtime config
   ------------------------------------------------------------
   This file is safe to commit and ships to the browser.
   It contains NO secrets. Never put an API key here.

   The NVIDIA key lives only in your Cloudflare Worker
   (wrangler secret put NVIDIA_API_KEY), so the site never
   carries a credential.

   Edit `proxyUrl` to your Worker's custom domain after you
   connect it in Cloudflare, then commit and redeploy Pages.
   ============================================================ */
window.REMY_CONFIG = {
  // Your Worker's custom domain. app.js also has this as a built-in
  // fallback, so visitors connect even if this file is stale.
  proxyUrl: 'https://api.remyagent.cc',

  // Optional. Only useful if your Worker checks CLIENT_TOKEN.
  // Anything in this file is public, so treat it as a door code,
  // not a secret. Leave empty and rely on Cloudflare WAF if unsure.
  appToken: '',

  // Default model shown on first load. Any chat-completions model
  // available to your NVIDIA account works.
  model: 'nvidia/llama-3.1-nemotron-70b-instruct'
};
