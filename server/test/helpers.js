import http from 'node:http';

export async function startServer(env = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'file::memory:', SESSION_SECRET: 'test-secret-test-secret-test-secret-1234',
    CORS_ORIGIN: 'http://localhost:5173', CLIENT_URL: 'http://localhost:5173',
    RATE_LIMIT_LOGIN_MAX: '1000', RATE_LIMIT_LOGIN_ACCOUNT_MAX: '1000', RATE_LIMIT_REGISTER_MAX: '1000',
    RATE_LIMIT_FORGOT_MAX: '1000', RATE_LIMIT_RESET_MAX: '1000',
    AUTO_LIBRARY_TASKS: 'false', // Stage 10C: older suites expect "no tasks configured" to mean "no tasks assigned"; stage10c.test.js turns it on
    AUTOMATION_ENABLED: 'false', // the background worker never runs by itself in tests; tests call runCycle() directly
    RATE_LIMIT_ADMIN_MAX: '1000', // many tests probe 401s on purpose; the limiter itself is covered by ratelimit.test.js
    ADMIN_API_KEY_ALLOW_WRITES: 'true', // Stage 08A: the older suites still drive writes with the shared key; stage08a.adminsecurity.test.js turns this off to prove the real default
    ADMIN_API_KEY: '', // tests never read the developer's real key from .env; a test that needs one passes it in
    ...env,
  });
  const { default: app } = await import('../src/app.js');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  return { base, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// Tiny cookie-aware client.
export function client(base) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) { const [pair] = c.split(';'); cookie = pair.endsWith('=') || /Expires=Thu, 01 Jan 1970/i.test(c) ? '' : pair; }
    return { status: res.status, headers: res.headers, setCookie: set, data: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  return { get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b, h), put: (p, b) => call('PUT', p, b), patch: (p, b, h) => call('PATCH', p, b, h), del: (p, h) => call('DELETE', p, undefined, h), reset: () => { cookie = ''; } };
}

export const validStudent = (over = {}) => ({
  fullName: 'Asha Verma', email: 'asha@example.com', phone: '+91 98765 43210', password: 'Str0ng!Pass1', confirmPassword: 'Str0ng!Pass1',
  college: 'IIT Madras', degree: 'B.Tech', branch: 'Computer Science', academicYear: '3rd Year',
  graduationYear: new Date().getFullYear() + 1, skills: ['Python', 'React'], github: '', linkedin: '', ...over,
});

// Stage 04B: a valid application body. ELV-PY-001 is open in the server catalog until 2027-01-15.
export const validApplication = (over = {}) => ({
  internshipId: 'ELV-PY-001', fullName: 'Asha Verma', phone: '98765 43210', college: 'IIT Madras', degree: 'B.Tech',
  branch: 'Computer Science', academicYear: '3rd Year', skills: ['Python', 'SQL'],
  motivation: 'I want to build a strong Python foundation and finish a real project I can show to recruiters.',
  termsAccepted: true, privacyAccepted: true, ...over,
});
