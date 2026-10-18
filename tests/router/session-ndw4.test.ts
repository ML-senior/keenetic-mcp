import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  Session,
  deriveNdw4Secrets,
  ndw4ExpectedServerSignature,
  ndw4FinalProof
} from '../../src/router/session.js';
import { AuthError } from '../../src/router/errors.js';

const HOST = '192.0.2.1';
const LOGIN = 'admin';
const PASSWORD = 'p4ssw0rd';
const REALM = 'Keenetic Test';
const CHALLENGE = 'abcdef0123456789';

// Cheap Argon2 parameters keep the test fast; the router's own values are
// larger but the code path is identical.
const SALT_B64 = 'AAECAwQFBgcICQoLDA0ODw=='; // bytes 0..15
const SERVER_NONCE = 'srvnonce123';
const ITER = 3;
const MEMCOST = 4096;

/** The two WWW-Authenticate values a KeeneticOS 5.x router sends, joined. */
const WWW_AUTH =
  `x-ndw2-interactive realm="${REALM}" challenge="${CHALLENGE}" session_id="s" session_cookie="c", ` +
  'x-ndw4-interactive endpoint="/auth" data="e30="';

function ndw4Data(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function ndw4ChallengeResponse(): Response {
  return new Response(null, {
    status: 401,
    headers: {
      'x-ndm-data': ndw4Data({
        salt: SALT_B64,
        nonce: SERVER_NONCE,
        iter: ITER,
        memcost: MEMCOST
      })
    }
  });
}

interface AuthPost {
  body: Record<string, string>;
}

function authPosts(calls: Array<{ init?: RequestInit }>): AuthPost[] {
  return calls
    .filter(c => c.init?.method === 'POST')
    .map(c => ({ body: JSON.parse(String(c.init!.body)) as Record<string, string> }));
}

afterEach(() => vi.restoreAllMocks());

describe('deriveNdw4Secrets', () => {
  it('matches independently computed wire values', async () => {
    const secrets = await deriveNdw4Secrets(LOGIN, PASSWORD, 'MDEyMzQ1Njc4OWFiY2RlZg==', {
      salt: SALT_B64,
      serverNonce: SERVER_NONCE,
      iter: ITER,
      memcost: MEMCOST
    });

    expect(secrets.authMessage).toBe(
      'login1=admin,nonce1=MDEyMzQ1Njc4OWFiY2RlZg==' +
        ';iter2=3,memcost2=4096,nonce2=srvnonce123,salt2=AAECAwQFBgcICQoLDA0ODw==' +
        ';login3=admin,nonce3=srvnonce123'
    );
    expect(secrets.clientProof.toString('base64')).toBe(
      '9BcHULjNMd1+letG49SDvvo8alU4FEE8JDjizx3P5imQQryDtlO/ZkvvZgo7wjN67QhRsLjNid8aytQr2qD1Pw=='
    );
    expect(ndw4ExpectedServerSignature(secrets).toString('base64')).toBe(
      'CSWHgrnssGNp1QR3oKel1c4dbtdMb3SyKjIQsHn9PtkAq+AVH04DMH+CffKxG7wy9MO93dFdHgh/oOIQREgXug=='
    );
    expect(
      ndw4FinalProof(secrets, ndw4ExpectedServerSignature(secrets).toString('base64')).toString(
        'base64'
      )
    ).toBe('nQ5X57I2zaUGWq7xtvFTzSuYHLs78P/a7DRmjJmLzOyQ7vHCPQau9l3gvGXBcPu1wW+kZV9FNdjFEVMzR4Q0Cg==');
  });

  it('rejects a salt that is not 16 bytes', async () => {
    await expect(
      deriveNdw4Secrets(LOGIN, PASSWORD, 'AAAA', {
        salt: Buffer.from('short').toString('base64'),
        serverNonce: SERVER_NONCE,
        iter: ITER,
        memcost: MEMCOST
      })
    ).rejects.toThrow(/16 bytes/);
  });
});

describe('Session over NDW4 (KeeneticOS 5.x)', () => {
  it('runs the three-phase handshake and replays the request', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let authPhase = 0;
    let clientNonceB64 = '';
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });

      if (u.endsWith('/auth') && init?.method === 'POST') {
        authPhase += 1;
        const body = JSON.parse(String(init!.body)) as Record<string, string>;
        if (authPhase === 1) {
          clientNonceB64 = body.nonce;
          return ndw4ChallengeResponse();
        }
        const secrets = await deriveNdw4Secrets(LOGIN, PASSWORD, clientNonceB64, {
          salt: SALT_B64,
          serverNonce: SERVER_NONCE,
          iter: ITER,
          memcost: MEMCOST
        });
        if (authPhase === 2) {
          if (body.proof !== secrets.clientProof.toString('base64')) {
            return new Response(null, { status: 401 }); // wrong proof: no signature
          }
          return new Response(null, {
            status: 401,
            headers: {
              'x-ndm-data': ndw4Data({
                signature: ndw4ExpectedServerSignature(secrets).toString('base64')
              })
            }
          });
        }
        const expected = ndw4FinalProof(
          secrets,
          ndw4ExpectedServerSignature(secrets).toString('base64')
        ).toString('base64');
        return new Response(null, {
          status: body['signature-proof'] === expected ? 200 : 401
        });
      }
      if (u.endsWith('/auth')) {
        return new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate': WWW_AUTH,
            'X-NDM-Realm': REALM,
            'X-NDM-Challenge': CHALLENGE
          }
        });
      }
      const authed = authPhase === 3;
      return new Response(JSON.stringify({ title: '5.1.3' }), { status: authed ? 200 : 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    const res = await session.request('GET', '/rci/show/version');

    expect(res.status).toBe(200);
    const posts = authPosts(calls);
    expect(posts).toHaveLength(3);
    expect(posts[0].body).toEqual({ login: LOGIN, nonce: expect.any(String) });
    // The client nonce is 16 random bytes, base64-encoded.
    expect(Buffer.from(posts[0].body.nonce, 'base64')).toHaveLength(16);
    expect(posts[1].body.login).toBe(LOGIN);
    expect(posts[1].body.nonce).toBe(SERVER_NONCE);
    expect(typeof posts[1].body.proof).toBe('string');
    expect(posts[2].body.nonce).toBe(SERVER_NONCE);
    expect(typeof posts[2].body['signature-proof']).toBe('string');
    // NDW2 must not be attempted once NDW4 succeeds.
    expect(posts.some(p => 'password' in p.body)).toBe(false);
  });

  it('aborts on a bad server signature instead of falling back to NDW2', async () => {
    let clientNonceB64 = '';
    const bodies: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/auth') && init?.method === 'POST') {
        const body = JSON.parse(String(init!.body)) as Record<string, string>;
        bodies.push(body);
        if ('nonce' in body && !('proof' in body)) {
          clientNonceB64 = body.nonce;
          return ndw4ChallengeResponse();
        }
        // A signature derived from a DIFFERENT password: what a wrong password
        // produces on the client side.
        const wrong = await deriveNdw4Secrets(LOGIN, 'not-the-password', clientNonceB64, {
          salt: SALT_B64,
          serverNonce: SERVER_NONCE,
          iter: ITER,
          memcost: MEMCOST
        });
        return new Response(null, {
          status: 401,
          headers: {
            'x-ndm-data': ndw4Data({
              signature: ndw4ExpectedServerSignature(wrong).toString('base64')
            })
          }
        });
      }
      return new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': WWW_AUTH, 'X-NDM-Realm': REALM, 'X-NDM-Challenge': CHALLENGE }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    await expect(session.request('GET', '/rci/show/version')).rejects.toThrow(AuthError);
    await expect(session.request('GET', '/rci/show/version')).rejects.toThrow(
      /server does not know the password/i
    );
    // No legacy retry: a signature failure means the password is wrong, and
    // NDW2 would fail identically.
    expect(bodies.some(b => 'password' in b)).toBe(false);
  });

  it('falls back to NDW2 when the NDW4 exchange breaks mid-handshake', async () => {
    const bodies: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/auth') && init?.method === 'POST') {
        const body = JSON.parse(String(init!.body)) as Record<string, string>;
        bodies.push(body);
        if ('password' in body) return new Response(null, { status: 200 });
        return new Response(null, { status: 401 }); // NDW4 phase 1 without x-ndm-data
      }
      if (u.endsWith('/auth')) {
        return new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate': WWW_AUTH,
            'X-NDM-Realm': REALM,
            'X-NDM-Challenge': CHALLENGE
          }
        });
      }
      const authed = bodies.some(b => 'password' in b);
      return new Response(JSON.stringify({ title: '5.1.3' }), { status: authed ? 200 : 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    const res = await session.request('GET', '/rci/show/version');

    expect(res.status).toBe(200);
    const legacy = bodies.find(b => 'password' in b);
    expect(legacy).toBeDefined();
    expect(legacy!.login).toBe(LOGIN);
    expect(legacy!.password).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses NDW4 even when the router only advertises x-ndw4-interactive', async () => {
    let phase = 0;
    let clientNonceB64 = '';
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/auth') && init?.method === 'POST') {
        phase += 1;
        if (phase === 1) {
          const body = JSON.parse(String(init!.body)) as Record<string, string>;
          clientNonceB64 = body.nonce;
          return ndw4ChallengeResponse();
        }
        if (phase === 2) {
          const secrets = await deriveNdw4Secrets(LOGIN, PASSWORD, clientNonceB64, {
            salt: SALT_B64,
            serverNonce: SERVER_NONCE,
            iter: ITER,
            memcost: MEMCOST
          });
          return new Response(null, {
            status: 401,
            headers: {
              'x-ndm-data': ndw4Data({
                signature: ndw4ExpectedServerSignature(secrets).toString('base64')
              })
            }
          });
        }
        return new Response(null, { status: 200 });
      }
      if (u.endsWith('/auth')) {
        // No X-NDM-* headers and no ndw2 token: legacy auth is impossible,
        // so the NDW4 path has to carry the exchange to phase 3 on its own.
        return new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'x-ndw4-interactive endpoint="/auth"' }
        });
      }
      const authed = phase === 3;
      return new Response(JSON.stringify({ title: '5.1.3' }), { status: authed ? 200 : 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    const res = await session.request('GET', '/rci/show/version');
    expect(res.status).toBe(200);
    expect(phase).toBe(3);
  });
});
