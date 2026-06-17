// File transfer API backed by R2 (bucket: jianshuo-dev-files, binding: FILES)
// All routes require the FILES_TOKEN secret, via "Authorization: Bearer <token>"
// or "?token=<token>" (so plain curl/wget works from another machine).
//
//   GET    /files/api/list              -> JSON list of files
//   PUT    /files/api/upload/<name>     -> upload (raw body)
//   GET    /files/api/download/<name>   -> download
//   DELETE /files/api/file/<name>       -> delete

export async function onRequest(context) {
  const { request, env, params } = context;
  const segments = Array.isArray(params.path) ? params.path : [params.path || ''];
  const action = segments[0] || '';
  const name = decodeURIComponent(segments.slice(1).join('/'));
  const url = new URL(request.url);

  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  if (!env.FILES_TOKEN || token !== env.FILES_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (request.method === 'GET' && action === 'list') {
    const listed = await env.FILES.list({ limit: 1000 });
    const files = listed.objects.map((o) => ({
      name: o.key,
      size: o.size,
      uploaded: o.uploaded,
    }));
    return json({ files });
  }

  if ((request.method === 'PUT' || request.method === 'POST') && action === 'upload' && name) {
    await env.FILES.put(name, request.body, {
      httpMetadata: {
        contentType: request.headers.get('Content-Type') || 'application/octet-stream',
      },
    });
    return json({ ok: true, name });
  }

  if (request.method === 'GET' && action === 'download' && name) {
    const object = await env.FILES.get(name);
    if (!object) return json({ error: 'not found' }, 404);
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': String(object.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name.split('/').pop())}`,
      },
    });
  }

  if (request.method === 'DELETE' && action === 'file' && name) {
    await env.FILES.delete(name);
    return json({ ok: true });
  }

  return json({ error: 'bad request' }, 400);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
