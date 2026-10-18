import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { AuthError, TransportError } from './errors.js';

export interface SessionOptions {
  host: string;
  login: string;
  password: string;
  timeoutMs?: number;
}

/**
 * The Keenetic LAN handshake: MD5 over the credential triple, then SHA256 over
 * the challenge concatenated with that digest. Both digests are lowercase hex.
 */
export function deriveAuthKey(
  login: string,
  realm: string,
  password: string,
  challenge: string
): string {
  const md5 = createHash('md5').update(`${login}:${realm}:${password}`).digest('hex');
  return createHash('sha256').update(`${challenge}${md5}`).digest('hex');
}

/* ------------------------------------------------------------------ *
 * NDW4: the three-phase handshake of KeeneticOS 5.x.                  *
 *                                                                     *
 * Recovered from the router's own web panel bundle (the flow the     *
 * browser runs):                                                      *
 *   1. POST {login, nonce}              -> 401 + x-ndm-data           *
 *      {salt, nonce, iter, memcost}    (base64-encoded JSON header)   *
 *   2. key       = Argon2id(password, salt, iter, memcost, 64 bytes)  *
 *      clientKey = HMAC-SHA3-512(key, 'NDW4 Interactive Client Key')  *
 *      storedKey = SHA3-512(clientKey)                                *
 *      serverKey = HMAC-SHA3-512(key, 'NDW4 Interactive Server Key')  *
 *      POST {login, nonce, proof = clientKey ^ HMAC(storedKey, msg)}  *
 *                                       -> 401 + x-ndm-data           *
 *      {signature}                       (server proves the password) *
 *   3. verify signature = HMAC(serverKey, msg)  - mutual auth: a      *
 *      mismatch means the password is wrong BEFORE anything is sent   *
 *      that could lock the account                                    *
 *      POST {login, nonce, signature-proof}     -> 200 + session      *
 * ------------------------------------------------------------------ */

const NDW4_DATA_HEADER = 'x-ndm-data';
const NDW4_CLIENT_KEY_INFO = 'NDW4 Interactive Client Key';
const NDW4_SERVER_KEY_INFO = 'NDW4 Interactive Server Key';
/** The marker inside the error the web UI treats as 'do not retry legacy'. */
const NDW4_SIGNATURE_FAILED = 'Server signature verification FAILED';

export interface Ndw4Challenge {
  /** Base64-encoded 16-byte Argon2id salt, exactly as the router sent it. */
  salt: string;
  /** Server nonce, echoed back in phases 2 and 3. */
  serverNonce: string;
  iter: number;
  memcost: number;
}

export interface Ndw4Secrets {
  clientKey: Buffer;
  storedKey: Buffer;
  serverKey: Buffer;
  authMessage: string;
  clientProof: Buffer;
}

function hmacSha3512(key: Uint8Array, data: string): Buffer {
  return createHmac('sha3-512', key).update(data, 'utf8').digest();
}

function xorBytes(a: Uint8Array, b: Uint8Array): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = (a[i] as number) ^ (b[i % b.length] as number);
  return out;
}

/**
 * Everything the client derives after phase 1. Exported so the tests can pin
 * the exact wire values against independently computed vectors.
 */
export async function deriveNdw4Secrets(
  login: string,
  password: string,
  clientNonceB64: string,
  challenge: Ndw4Challenge
): Promise<Ndw4Secrets> {
  const salt = Buffer.from(challenge.salt, 'base64');
  if (salt.length !== 16) {
    throw new AuthError(`NDW4 phase 1: the Argon2id salt must be 16 bytes, got ${salt.length}.`);
  }
  const key = await argon2id({
    password: Buffer.from(password, 'utf8'),
    salt,
    parallelism: 1,
    iterations: challenge.iter,
    memorySize: challenge.memcost,
    hashLength: 64,
    outputType: 'binary'
  });
  const clientKey = hmacSha3512(key, NDW4_CLIENT_KEY_INFO);
  const storedKey = createHash('sha3-512').update(clientKey).digest();
  const serverKey = hmacSha3512(key, NDW4_SERVER_KEY_INFO);
  const authMessage =
    `login1=${login},nonce1=${clientNonceB64}` +
    `;iter2=${challenge.iter},memcost2=${challenge.memcost},` +
    `nonce2=${challenge.serverNonce},salt2=${challenge.salt}` +
    `;login3=${login},nonce3=${challenge.serverNonce}`;
  const clientProof = xorBytes(clientKey, hmacSha3512(storedKey, authMessage));
  return { clientKey, storedKey, serverKey, authMessage, clientProof };
}

/** What the client checks against the router's phase-2 signature. */
export function ndw4ExpectedServerSignature(secrets: Ndw4Secrets): Buffer {
  return hmacSha3512(secrets.serverKey, secrets.authMessage);
}

/** The phase-3 proof: clientKey ^ HMAC(storedKey, msg + ';signature4=' + sig). */
export function ndw4FinalProof(secrets: Ndw4Secrets, serverSignatureB64: string): Buffer {
  return xorBytes(
    secrets.clientKey,
    hmacSha3512(secrets.storedKey, `${secrets.authMessage};signature4=${serverSignatureB64}`)
  );
}

/** The schemes a 401 advertises, parsed the way the web panel parses them. */
interface AuthSchemes {
  ndw4: boolean;
  ndw2: boolean;
  endpoint: string;
}

function parseWwwAuthenticate(value: string | null): AuthSchemes {
  const schemes: AuthSchemes = { ndw4: false, ndw2: false, endpoint: '/auth' };
  if (!value) return schemes;
  const lower = value.toLowerCase();
  if (lower.includes('x-ndw4-interactive')) {
    schemes.ndw4 = true;
    const endpoint = lower.match(/endpoint\s*=\s*"([^"]*)"/);
    if (endpoint?.[1]) schemes.endpoint = endpoint[1];
  }
  if (lower.includes('x-ndw2-interactive')) schemes.ndw2 = true;
  return schemes;
}

/** Reads a base64-encoded JSON header KeeneticOS 5.x uses for NDW4 phases. */
function parseNdw4Data(res: Response, phase: string): Record<string, unknown> {
  const raw = res.headers.get(NDW4_DATA_HEADER);
  if (!raw) {
    throw new AuthError(`NDW4 ${phase}: the router did not return an ${NDW4_DATA_HEADER} header.`);
  }
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AuthError(`NDW4 ${phase}: malformed ${NDW4_DATA_HEADER} header.`);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class Session {
  private readonly opts: SessionOptions;
  /** The router randomises the cookie name, so both parts are stored verbatim. */
  private cookie: string | null = null;
  /** Set while an authentication is in flight so concurrent callers share it. */
  private authInFlight: Promise<void> | null = null;

  constructor(opts: SessionOptions) {
    this.opts = opts;
  }

  /**
   * Lazy authentication: the first 401 drives the handshake, then the call
   * replays exactly once. The session is a 300-second sliding window, so an
   * idle gap between agent turns routinely expires it.
   */
  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const first = await this.send(method, path, body);
    if (first.status !== 401) return first;

    await this.ensureAuthenticated();

    const second = await this.send(method, path, body);
    if (second.status === 401) {
      throw new AuthError(
        `The router rejected credentials for user "${this.opts.login}" after ` +
          `re-authenticating for ${method} ${path}.`
      );
    }
    return second;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.authInFlight) {
      // Cleared in `finally` so a rejected attempt is never cached: the next
      // caller starts a fresh handshake rather than inheriting the failure.
      this.authInFlight = this.authenticate().finally(() => {
        this.authInFlight = null;
      });
    }
    return this.authInFlight;
  }

  protected async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers['cookie'] = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const url = `http://${this.opts.host}${path}`;
    // Built stepwise rather than with a ternary: under exactOptionalPropertyTypes
    // an explicit `body: undefined` is not the same as omitting the property.
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: 'manual'
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (cause) {
      throw new TransportError(`${method} ${url} failed: ${(cause as Error).message}.`);
    }
    this.captureCookie(res);
    return res;
  }

  protected captureCookie(res: Response): void {
    const set = res.headers.getSetCookie();
    for (const raw of set) {
      const pair = raw.split(';', 1)[0];
      if (pair && pair.includes('=')) this.cookie = pair;
    }
  }

  protected async authenticate(): Promise<void> {
    const probe = await this.send('GET', '/auth');
    if (probe.status === 200) return;

    const wwwAuth = probe.headers.get('www-authenticate');
    const schemes = parseWwwAuthenticate(wwwAuth);

    if (schemes.ndw4) {
      try {
        await this.authenticateNdw4(schemes.endpoint);
        return;
      } catch (error) {
        // Mirroring the web panel: a signature mismatch means the password is
        // wrong, so retrying the legacy scheme is pointless. Anything else can
        // be a quirk of the new scheme - fall back to NDW2 when it is offered.
        const legacyOffered =
          schemes.ndw2 || Boolean(probe.headers.get('X-NDM-Challenge')) ||
          Boolean(wwwAuth?.includes('challenge='));
        if (
          !legacyOffered ||
          (error instanceof Error && error.message.includes(NDW4_SIGNATURE_FAILED))
        ) {
          throw error;
        }
      }
    }

    await this.authenticateNdw2(probe, wwwAuth);
  }

  /** The KeeneticOS 5.x handshake: three POSTs, Argon2id, mutual proofs. */
  private async authenticateNdw4(endpoint: string): Promise<void> {
    const login = this.opts.login;
    const clientNonceB64 = randomBytes(16).toString('base64');

    const phase1 = await this.send('POST', endpoint, { login, nonce: clientNonceB64 });
    if (phase1.status !== 401) {
      throw new AuthError(`NDW4 phase 1: unexpected status ${phase1.status}.`);
    }
    const data = parseNdw4Data(phase1, 'phase 1');
    const challenge: Ndw4Challenge = {
      salt: String(data.salt ?? ''),
      serverNonce: String(data.nonce ?? ''),
      iter: Number(data.iter),
      memcost: Number(data.memcost)
    };
    if (!challenge.salt || !challenge.serverNonce || !challenge.iter || !challenge.memcost) {
      throw new AuthError('NDW4 phase 1: missing salt, nonce, iter or memcost.');
    }

    const secrets = await deriveNdw4Secrets(login, this.opts.password, clientNonceB64, challenge);

    const phase2 = await this.send('POST', endpoint, {
      login,
      nonce: challenge.serverNonce,
      proof: secrets.clientProof.toString('base64')
    });
    if (phase2.status !== 401) {
      throw new AuthError(
        `The router rejected the NDW4 proof for user "${login}" ` +
          `(phase 2 returned HTTP ${phase2.status}). Check the password.`
      );
    }
    const signature = String(parseNdw4Data(phase2, 'phase 2').signature ?? '');
    if (!signature) throw new AuthError('NDW4 phase 2: the router sent no signature.');

    // Mutual authentication: only a server that knows the password can produce
    // this signature. With a wrong password the client aborts here, before the
    // final proof is sent - same behaviour as the web panel.
    const expected = ndw4ExpectedServerSignature(secrets);
    const actual = Buffer.from(signature, 'base64');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AuthError(
        `${NDW4_SIGNATURE_FAILED} - the server does not know the password. ` +
          `The password for user "${login}" is wrong.`
      );
    }

    const phase3 = await this.send('POST', endpoint, {
      login,
      nonce: challenge.serverNonce,
      'signature-proof': ndw4FinalProof(secrets, signature).toString('base64')
    });
    if (phase3.status !== 200) {
      throw new AuthError(`NDW4 phase 3: unexpected status ${phase3.status}.`);
    }
  }

  /** The pre-5.x handshake: one POST with SHA256(challenge + MD5(...)). */
  private async authenticateNdw2(probe: Response, wwwAuth: string | null): Promise<void> {
    // The realm and challenge may ride either the dedicated X-NDM-* headers or
    // the parameters of the WWW-Authenticate header.
    const param = (name: string): string | null =>
      wwwAuth?.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
    const realm = probe.headers.get('X-NDM-Realm') ?? param('realm');
    const challenge = probe.headers.get('X-NDM-Challenge') ?? param('challenge');
    if (!realm || !challenge) {
      throw new AuthError(
        `The router at ${this.opts.host} did not return an X-NDM-Challenge. ` +
          'This endpoint does not use the LAN challenge scheme - remote access over ' +
          'KeenDNS is not supported in this version.'
      );
    }

    const password = deriveAuthKey(this.opts.login, realm, this.opts.password, challenge);
    const res = await this.send('POST', '/auth', { login: this.opts.login, password });
    if (res.status !== 200) {
      throw new AuthError(
        `The router rejected credentials for user "${this.opts.login}" (HTTP ${res.status}).`
      );
    }
  }
}
