const SESSION_COOKIE = 'medembed_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        return login(request, env);
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        verifySameOrigin(request);
        return json({ ok: true }, 200, {
          'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        });
      }

      const session = await readSession(request, env.SESSION_SECRET);
      if (!session) return json({ error: 'unauthorized' }, 401);

      if (url.pathname === '/api/auth/session' && request.method === 'GET') {
        return json({ authenticated: true, user: { name: env.LOGIN_NAME || 'Workspace owner' } });
      }

      if (url.pathname === '/api/jobs' && request.method === 'GET') {
        return proxyToVps(request, env, '/api/jobs');
      }

      if (url.pathname.startsWith('/api/jobs/') && request.method === 'GET') {
        return proxyToVps(request, env, url.pathname);
      }

      if (url.pathname.startsWith('/api/jobs/') && request.method === 'DELETE') {
        verifySameOrigin(request);
        return proxyToVps(request, env, url.pathname);
      }

      if (url.pathname === '/api/query' && request.method === 'POST') {
        verifySameOrigin(request);
        return proxyToVps(request, env, '/api/query');
      }

      if (url.pathname.startsWith('/api/points/') && request.method === 'DELETE') {
        verifySameOrigin(request);
        return proxyToVps(request, env, url.pathname);
      }

      if (url.pathname === '/api/upload' && request.method === 'POST') {
        verifySameOrigin(request);
        return upload(request, env);
      }

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      const status = error.status || 500;
      return json({ error: status === 500 ? 'internal_error' : error.message }, status);
    }
  },
};

async function login(request, env) {
  verifySameOrigin(request);
  if (!env.LOGIN_PASSWORD || !env.SESSION_SECRET) {
    throw httpError(500, 'Authentication secrets are not configured');
  }

  const body = await request.json().catch(() => ({}));
  if (typeof body.password !== 'string' || !(await secureEqual(body.password, env.LOGIN_PASSWORD, env.SESSION_SECRET))) {
    return json({ error: 'invalid_credentials' }, 401);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await createSession({ sub: 'owner', exp: expiresAt }, env.SESSION_SECRET);
  return json({ authenticated: true, user: { name: env.LOGIN_NAME || 'Workspace owner' } }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`,
  });
}

async function upload(request, env) {
  if (!env.ATTACHMENTS) throw httpError(500, 'R2 binding is not configured');
  const form = await request.formData();
  const files = form.getAll('files');
  const collection = String(form.get('collection') || '');
  const documentType = String(form.get('document_type') || 'reference');
  const mode = String(form.get('mode') || '');
  const notify = String(form.get('notify') || 'true') === 'true';

  const allowedCollections = new Set(['medical_knowledge', 'law_lectures', 'dhamma_lectures']);
  const allowedDocumentTypes = new Set(['guideline', 'journal', 'medical_lecture', 'law_lecture', 'dhamma_lecture', 'reference']);
  if (!files.length || !allowedCollections.has(collection) || !allowedDocumentTypes.has(documentType) || mode !== 'text') {
    throw httpError(400, 'Invalid upload request');
  }

  const jobs = [];
  for (const file of files) {
    const extension = file instanceof File
      ? Object.keys(ALLOWED_CONTENT_TYPES).find(candidate => file.name.toLowerCase().endsWith(candidate))
      : undefined;
    if (!extension) {
      throw httpError(400, 'Only PDF, DOCX, or TXT files are accepted');
    }
    if (file.size > MAX_FILE_BYTES) throw httpError(413, `${file.name} exceeds 100 MB`);

    const jobId = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const r2Key = `medical-embed/${new Date().toISOString().slice(0, 10)}/${jobId}/${safeName}`;
    await env.ATTACHMENTS.put(r2Key, file.stream(), {
      httpMetadata: { contentType: ALLOWED_CONTENT_TYPES[extension] },
      customMetadata: { originalFilename: file.name, collection, documentType, mode, jobId },
    });

    const response = await callVps(env, '/api/embed-job', {
      method: 'POST',
      body: JSON.stringify({ id: jobId, filename: file.name, r2_key: r2Key, collection, document_type: documentType, mode, notify }),
    });
    if (!response.ok) {
      await env.ATTACHMENTS.delete(r2Key);
      throw httpError(502, `VPS rejected ${file.name}`);
    }
    jobs.push(await response.json());
  }

  return json({ jobs }, 202);
}

async function proxyToVps(request, env, path) {
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const response = await callVps(env, path, {
    method: request.method,
    headers,
    body: request.method === 'GET' ? undefined : request.body,
    duplex: request.method === 'GET' ? undefined : 'half',
  });
  return new Response(response.body, {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') || 'application/json' },
  });
}

function callVps(env, path, init) {
  if (!env.VPS_API_URL || !env.VPS_API_TOKEN) throw httpError(500, 'VPS connection is not configured');
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${env.VPS_API_TOKEN}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${env.VPS_API_URL.replace(/\/$/, '')}${path}`, { ...init, headers });
}

function verifySameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw httpError(403, 'Invalid origin');
}

async function secureEqual(left, right, secret) {
  const [a, b] = await Promise.all([sign(left, secret), sign(right, secret)]);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function createSession(payload, secret) {
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await sign(encoded, secret));
  return `${encoded}.${signature}`;
}

async function readSession(request, secret) {
  if (!secret) return null;
  const cookie = request.headers.get('cookie') || '';
  const token = cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = base64UrlEncode(await sign(payload, secret));
  if (!(await secureEqual(signature, expected, secret))) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    return parsed.exp > Math.floor(Date.now() / 1000) ? parsed : null;
  } catch {
    return null;
  }
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
