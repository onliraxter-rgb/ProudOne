/**
 * ProudOne — Cloudflare Worker API
 * 
 * Endpoints:
 *   POST /api/auth/register   — Create account (username + password + invite code)
 *   POST /api/auth/login      — Login → returns session token
 *   GET  /api/auth/me         — Get current user from token
 *   GET  /api/workspace       — Fetch user's full workspace
 *   POST /api/workspace/save  — Save workspace data to D1
 *   POST /api/ai/chat         — Groq proxy (server-side key, user never sees it)
 *   POST /api/admin/invite    — Generate invite code (admin only)
 *   GET  /api/admin/users     — List all users (admin only)
 * 
 * Secrets (set via: npx wrangler secret put GROQ_API_KEY):
 *   GROQ_API_KEY — Your Groq API key (users never enter this)
 * 
 * Bindings:
 *   DB — Cloudflare D1 database
 */

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }), env);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // --- AUTH ROUTES ---
      if (path === '/api/auth/register' && request.method === 'POST') {
        return corsResponse(await handleRegister(request, env), env);
      }
      if (path === '/api/auth/login' && request.method === 'POST') {
        return corsResponse(await handleLogin(request, env), env);
      }
      if (path === '/api/auth/me' && request.method === 'GET') {
        return corsResponse(await handleMe(request, env), env);
      }

      // --- WORKSPACE ROUTES ---
      if (path === '/api/workspace' && request.method === 'GET') {
        return corsResponse(await handleGetWorkspace(request, env), env);
      }
      if (path === '/api/workspace/save' && request.method === 'POST') {
        return corsResponse(await handleSaveWorkspace(request, env), env);
      }

      // --- AI PROXY ---
      if (path === '/api/ai/chat' && request.method === 'POST') {
        return corsResponse(await handleAIChat(request, env), env);
      }

      // --- ADMIN ROUTES ---
      if (path === '/api/admin/invite' && request.method === 'POST') {
        return corsResponse(await handleCreateInvite(request, env), env);
      }
      if (path === '/api/admin/users' && request.method === 'GET') {
        return corsResponse(await handleListUsers(request, env), env);
      }

      return corsResponse(json({ error: 'Not found' }, 404), env);
    } catch (err) {
      console.error('Worker error:', err);
      return corsResponse(json({ error: err.message || 'Internal server error' }, 500), env);
    }
  }
};

// ── HELPERS ──────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function corsResponse(response, env) {
  const origin = env.CORS_ORIGIN || '*';
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Access-Control-Request-Private-Network');
  headers.set('Access-Control-Allow-Private-Network', 'true');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(salt + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function generateSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'PO-';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;

  const session = await env.DB.prepare(
    'SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime("now")'
  ).bind(token).first();
  if (!session) return null;

  const user = await env.DB.prepare(
    'SELECT id, username, email, is_admin FROM users WHERE id = ?'
  ).bind(session.user_id).first();
  return user;
}

// ── AUTH HANDLERS ────────────────────────────────────────

async function handleRegister(request, env) {
  const body = await request.json();
  const { username, password, invite_code, email } = body;

  if (!username || !password) {
    return json({ error: 'Username and password required' }, 400);
  }
  if (username.length < 3 || username.length > 20) {
    return json({ error: 'Username must be 3-20 characters' }, 400);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return json({ error: 'Username: letters, numbers, underscore only' }, 400);
  }
  if (password.length < 6) {
    return json({ error: 'Password must be at least 6 characters' }, 400);
  }

  // Validate invite code
  if (invite_code) {
    const code = await env.DB.prepare(
      'SELECT * FROM invite_codes WHERE code = ? AND active = 1 AND used_by IS NULL'
    ).bind(invite_code.trim().toUpperCase()).first();
    if (!code) {
      return json({ error: 'Invalid or used invite code' }, 400);
    }
  }

  // Check if username exists
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE username = ?'
  ).bind(username.trim()).first();
  if (existing) {
    return json({ error: 'Username already taken' }, 409);
  }

  // Create user
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  const result = await env.DB.prepare(
    'INSERT INTO users (username, email, password_hash, salt, invite_code) VALUES (?, ?, ?, ?, ?)'
  ).bind(username.trim(), email || null, hash, salt, invite_code || null).run();

  const userId = result.meta.last_row_id;

  // Create empty workspace
  await env.DB.prepare(
    'INSERT INTO workspaces (user_id) VALUES (?)'
  ).bind(userId).run();

  // Mark invite code as used
  if (invite_code) {
    await env.DB.prepare(
      'UPDATE invite_codes SET used_by = ?, used_at = datetime("now"), active = 0 WHERE code = ?'
    ).bind(userId, invite_code.trim().toUpperCase()).run();
  }

  // Create session
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, userId, expiresAt).run();

  return json({ token, username: username.trim(), user_id: userId });
}

async function handleLogin(request, env) {
  const body = await request.json();
  const { username, password } = body;

  if (!username || !password) {
    return json({ error: 'Username and password required' }, 400);
  }

  const user = await env.DB.prepare(
    'SELECT id, username, password_hash, salt, is_admin FROM users WHERE username = ?'
  ).bind(username.trim()).first();

  if (!user) {
    return json({ error: 'Invalid username or password' }, 401);
  }

  const hash = await hashPassword(password, user.salt);
  if (hash !== user.password_hash) {
    return json({ error: 'Invalid username or password' }, 401);
  }

  // Create session
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, user.id, expiresAt).run();

  // Clean old sessions for this user (keep last 5)
  await env.DB.prepare(
    'DELETE FROM sessions WHERE user_id = ? AND token NOT IN (SELECT token FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5)'
  ).bind(user.id, user.id).run();

  return json({ token, username: user.username, user_id: user.id, is_admin: !!user.is_admin });
}

async function handleMe(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Not authenticated' }, 401);
  return json({ username: user.username, email: user.email, is_admin: !!user.is_admin });
}

// ── WORKSPACE HANDLERS ──────────────────────────────────

async function handleGetWorkspace(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const ws = await env.DB.prepare(
    'SELECT * FROM workspaces WHERE user_id = ?'
  ).bind(user.id).first();

  if (!ws) {
    // Create workspace if missing (shouldn't happen, but safety)
    await env.DB.prepare('INSERT OR IGNORE INTO workspaces (user_id) VALUES (?)').bind(user.id).run();
    return json({ profile: {}, roadmap: null, tasks: [], habits: {}, habit_names: [], expenses: [], workouts: [], dsa: [], sheet: [], activity: {}, streaks: { study: 0, gym: 0, budget: 0 }, wins: {} });
  }

  // Parse JSON fields
  return json({
    profile: safeJSON(ws.profile, {}),
    roadmap: safeJSON(ws.roadmap, null),
    tasks: safeJSON(ws.tasks, []),
    habits: safeJSON(ws.habits, {}),
    habit_names: safeJSON(ws.habit_names, []),
    expenses: safeJSON(ws.expenses, []),
    workouts: safeJSON(ws.workouts, []),
    dsa: safeJSON(ws.dsa, []),
    sheet: safeJSON(ws.sheet, []),
    activity: safeJSON(ws.activity, {}),
    streaks: safeJSON(ws.streaks, { study: 0, gym: 0, budget: 0 }),
    wins: safeJSON(ws.wins, {})
  });
}

function safeJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

async function handleSaveWorkspace(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const data = await request.json();

  // Build dynamic UPDATE query — only update fields that were sent
  const allowed = ['profile', 'roadmap', 'tasks', 'habits', 'habit_names', 'expenses', 'workouts', 'dsa', 'sheet', 'activity', 'streaks', 'wins'];
  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (data[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(JSON.stringify(data[key]));
    }
  }

  if (sets.length === 0) {
    return json({ error: 'No data to save' }, 400);
  }

  sets.push('updated_at = datetime("now")');
  values.push(user.id);

  await env.DB.prepare(
    `UPDATE workspaces SET ${sets.join(', ')} WHERE user_id = ?`
  ).bind(...values).run();

  return json({ ok: true, saved: Object.keys(data).filter(k => allowed.includes(k)) });
}

// ── AI PROXY ────────────────────────────────────────────

async function handleAIChat(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const body = await request.json();
  const { system, message, max_tokens, temperature } = body;

  if (!message) {
    return json({ error: 'Message is required' }, 400);
  }

  // 1. Use Cloudflare Workers AI (Free & Built-in) if available
  if (env.AI) {
    try {
      const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: system || 'You are a helpful assistant.' },
          { role: 'user', content: message }
        ],
        max_tokens: Math.min(max_tokens || 900, 2000),
        temperature: temperature || 0.7
      });
      if (response && response.response) {
        return json({ reply: response.response });
      }
    } catch (e) {
      console.error('CF AI Error:', e);
    }
  }

  // 2. Fallback to Groq API if configured
  const groqKey = env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: Math.min(max_tokens || 900, 2000),
          temperature: temperature || 0.7,
          messages: [
            { role: 'system', content: system || 'You are a helpful assistant.' },
            { role: 'user', content: message }
          ]
        })
      });

      if (!groqResponse.ok) {
        const status = groqResponse.status;
        if (status === 429) return json({ error: 'RATE_LIMIT' }, 429);
        if (status === 401) return json({ error: 'AI key invalid. Contact admin.' }, 500);
        return json({ error: 'AI service error' }, 502);
      }

      const groqData = await groqResponse.json();
      const reply = groqData.choices?.[0]?.message?.content || '';
      return json({ reply });
    } catch (e) {
      console.error('Groq Error:', e);
    }
  }

  return json({ error: 'AI service not configured. Please check worker deployment.' }, 503);
}

// ── ADMIN HANDLERS ──────────────────────────────────────

async function handleCreateInvite(request, env) {
  const user = await getUser(request, env);
  if (!user || !user.is_admin) return json({ error: 'Admin access required' }, 403);

  const body = await request.json().catch(() => ({}));
  const count = Math.min(body.count || 1, 20); // max 20 at a time
  const codes = [];

  for (let i = 0; i < count; i++) {
    const code = generateInviteCode();
    await env.DB.prepare(
      'INSERT INTO invite_codes (code, created_by, active) VALUES (?, ?, 1)'
    ).bind(code, user.id).run();
    codes.push(code);
  }

  return json({ codes });
}

async function handleListUsers(request, env) {
  const user = await getUser(request, env);
  if (!user || !user.is_admin) return json({ error: 'Admin access required' }, 403);

  const users = await env.DB.prepare(
    'SELECT u.id, u.username, u.email, u.created_at, u.is_admin, w.updated_at as last_active FROM users u LEFT JOIN workspaces w ON u.id = w.user_id ORDER BY u.created_at DESC'
  ).all();

  return json({ users: users.results || [] });
}
