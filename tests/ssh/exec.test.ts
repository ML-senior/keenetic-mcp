import { afterEach, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import { createSshClient, MAX_STREAM_BYTES } from '../../src/ssh/client.js';

const { Server, utils } = ssh2;

/**
 * A real SSH server on a loopback port, speaking the real protocol. The client
 * is otherwise only ever exercised through a stub of its own interface, which
 * cannot show whether stdin is delivered, output is bounded or a dropped
 * connection is noticed.
 */
type Behaviour = (
  command: string,
  stream: ssh2.ServerChannel,
  client: ssh2.Connection
) => void;

const servers: ssh2.Server[] = [];

async function serve(behaviour: Behaviour): Promise<number> {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const server = new Server({ hostKeys: [hostKey] }, client => {
    client
      .on('authentication', ctx => {
        if (ctx.method === 'password' && ctx.password === 'secret') ctx.accept();
        else ctx.reject(['password']);
      })
      .on('ready', () => {
        client.on('session', accept => {
          accept().on('exec', (acceptExec, _reject, info) => {
            behaviour(info.command, acceptExec(), client);
          });
        });
      })
      .on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

function clientFor(port: number, password = 'secret') {
  return createSshClient({ host: '127.0.0.1', port, user: 'root', password });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve))));
});

describe('createSshClient against a real SSH server', () => {
  it('returns stdout, stderr and the exit code', async () => {
    const port = await serve((command, stream) => {
      stream.write(`ran: ${command}\n`);
      stream.stderr.write('warning\n');
      stream.exit(7);
      stream.end();
    });
    await expect(clientFor(port).exec('opkg update', 5_000)).resolves.toEqual({
      stdout: 'ran: opkg update\n',
      stderr: 'warning\n',
      code: 7
    });
  });

  it('delivers stdin and closes it, so a command reading to EOF finishes', async () => {
    const port = await serve((_command, stream) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        stream.write(`got ${String(Buffer.concat(chunks).length)} bytes`);
        stream.exit(0);
        stream.end();
      });
    });
    // Larger than any command line could carry.
    const content = 'x'.repeat(300_000);
    const result = await clientFor(port).exec('cat > /tmp/f', 5_000, { stdin: content });
    expect(result.stdout).toBe('got 300000 bytes');
  });

  it('keeps multi-byte text intact across packet boundaries', async () => {
    const text = 'Пылесос';
    const bytes = Buffer.from(text, 'utf8');
    const port = await serve((_command, stream) => {
      // Split in the middle of a two-byte character.
      stream.write(bytes.subarray(0, 3));
      setTimeout(() => {
        stream.write(bytes.subarray(3));
        stream.exit(0);
        stream.end();
      }, 20);
    });
    expect((await clientFor(port).exec('echo', 5_000)).stdout).toBe(text);
  });

  it('stops buffering at the ceiling and says how much it dropped', async () => {
    const extra = 500_000;
    const port = await serve((_command, stream) => {
      stream.write(Buffer.alloc(MAX_STREAM_BYTES + extra, 0x61));
      stream.exit(0);
      stream.end();
    });
    const result = await clientFor(port).exec('cat /dev/zero', 10_000);
    expect(result.stdout).toContain(`${String(extra)} more bytes were discarded`);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(MAX_STREAM_BYTES + 200);
  });

  it('fails at once when the connection drops mid-command, not at the timeout', async () => {
    const port = await serve((_command, _stream, client) => {
      setTimeout(() => client.end(), 20);
    });
    const started = Date.now();
    await expect(clientFor(port).exec('sleep 600', 30_000)).rejects.toThrow(
      /closed before the command finished/
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('times out a command that never finishes and releases the connection', async () => {
    const port = await serve(() => undefined);
    await expect(clientFor(port).exec('sleep 600', 300)).rejects.toThrow(/timed out after 300 ms/);
  });

  it('explains a rejected password', async () => {
    const port = await serve(() => undefined);
    await expect(clientFor(port, 'wrong').exec('id', 5_000)).rejects.toThrow(/rejected the password/);
  });

  it('explains a port nothing listens on', async () => {
    const port = await serve(() => undefined);
    await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve))));
    await expect(clientFor(port).exec('id', 5_000)).rejects.toThrow(/Nothing accepted the connection/);
  });
});
