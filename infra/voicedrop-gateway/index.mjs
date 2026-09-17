// Bind AGENT and RECO to the services for this environment. Pages remains the
// origin for Files API and website requests. No credentials or data live here.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/agent' || path.startsWith('/agent/')) {
      // Return the original response, including streaming bodies and WebSockets.
      return env.AGENT.fetch(request);
    }
    if (path === '/reco' || path.startsWith('/reco/')) {
      return env.RECO.fetch(request);
    }
    if (path === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      url.pathname = '/voicedrop/';
      return Response.redirect(url.toString(), 302);
    }

    const pages = new URL(env.PAGES_ORIGIN);
    const upstreamUrl = new URL(request.url);
    upstreamUrl.protocol = pages.protocol;
    upstreamUrl.host = pages.host;
    const upstream = new Request(upstreamUrl, request);
    upstream.headers.set('X-Forwarded-Host', url.hostname);
    const response = await fetch(upstream, { redirect: 'manual' });

    // Keep Pages canonical-path redirects on the public gateway. Never follow
    // upstream redirects with the user's authorization headers or request body.
    const location = response.headers.get('Location');
    if (location && response.status >= 300 && response.status < 400) {
      const target = new URL(location, upstreamUrl);
      if (target.origin === pages.origin) {
        target.protocol = url.protocol;
        target.host = url.host;
        const outgoing = new Response(response.body, response);
        outgoing.headers.set('Location', target.toString());
        return outgoing;
      }
    }
    return response;
  },
};
