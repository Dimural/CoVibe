/* eslint-disable no-console */
/**
 * Load test: simulates N sessions × M participants × ops/sec.
 *
 * Usage:
 *   RELAY_URL=ws://localhost:3000 SESSIONS=10 PARTICIPANTS=4 OPS_PER_SEC=20 \
 *     npx tsx tests/load/load.ts
 *
 * Output: connection success rate, op throughput, P50/P95/P99 round-trip latency.
 */
import WebSocket from 'ws';

interface Config {
  relayUrl: string;
  sessions: number;
  participantsPerSession: number;
  opsPerSecPerClient: number;
  durationMs: number;
}

const cfg: Config = {
  relayUrl: process.env['RELAY_URL'] ?? 'ws://localhost:3000',
  sessions: parseInt(process.env['SESSIONS'] ?? '10', 10),
  participantsPerSession: parseInt(process.env['PARTICIPANTS'] ?? '4', 10),
  opsPerSecPerClient: parseInt(process.env['OPS_PER_SEC'] ?? '20', 10),
  durationMs: parseInt(process.env['DURATION_MS'] ?? '30000', 10),
};

const latencies: number[] = [];
let opsReceived = 0;
let opsSent = 0;
let connections = 0;
let connectionErrors = 0;

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

async function connectParticipant(
  sessionId: string,
  token: string,
  userId: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `${cfg.relayUrl}/ws?session=${sessionId}&token=${token}&user=${userId}&branch=main&color=%23ff0000`;
    const ws = new WebSocket(url);
    ws.on('open', () => {
      connections++;
      resolve(ws);
    });
    ws.on('error', (err) => {
      connectionErrors++;
      reject(err);
    });
  });
}

async function runSession(sessionIndex: number): Promise<void> {
  const sessionId = `load-sess-${sessionIndex}`;
  const token = `load-token-${sessionIndex}`;
  const participants: WebSocket[] = [];

  for (let p = 0; p < cfg.participantsPerSession; p++) {
    try {
      const ws = await connectParticipant(sessionId, token, `user-${sessionIndex}-${p}`);
      participants.push(ws);
      // Drain session.state
      await new Promise<void>((res) => {
        ws.once('message', () => res());
      });
    } catch {
      // Connection failed — continue without this participant
    }
  }

  if (participants.length === 0) return;

  const pendingAcks = new Map<string, number>();

  participants.forEach((ws) => {
    ws.on('message', (data: Buffer | string) => {
      opsReceived++;
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        const msg = JSON.parse(raw) as { type: string; id: string };
        if (msg.type === 'doc.ack' && pendingAcks.has(msg.id)) {
          const sentAt = pendingAcks.get(msg.id)!;
          latencies.push(Date.now() - sentAt);
          pendingAcks.delete(msg.id);
        }
      } catch {
        // Ignore parse errors in load test
      }
    });
  });

  const intervalMs = 1000 / cfg.opsPerSecPerClient;
  const intervals: ReturnType<typeof setInterval>[] = [];

  participants.forEach((ws) => {
    const iv = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const msgId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      pendingAcks.set(msgId, Date.now());
      const envelope = JSON.stringify({
        v: 1,
        id: msgId,
        ts: Date.now(),
        type: 'doc.delta',
        payload: { path: 'src/app.ts', baseVersion: 0, op: [1, 'x'] },
      });
      ws.send(envelope);
      opsSent++;
    }, intervalMs);
    intervals.push(iv);
  });

  await new Promise<void>((res) => setTimeout(res, cfg.durationMs));
  intervals.forEach((iv) => clearInterval(iv));
  participants.forEach((ws) => ws.close());
}

async function main(): Promise<void> {
  console.log('Load test config:', cfg);
  const startTime = Date.now();

  const sessionPromises = Array.from({ length: cfg.sessions }, (_, i) => runSession(i));
  await Promise.all(sessionPromises);

  const elapsedSec = (Date.now() - startTime) / 1000;
  latencies.sort((a, b) => a - b);

  console.log('\n=== Results ===');
  console.log(`Duration:         ${elapsedSec.toFixed(1)}s`);
  console.log(`Connections:      ${connections} success, ${connectionErrors} errors`);
  console.log(`Ops sent:         ${opsSent} (${(opsSent / elapsedSec).toFixed(0)}/s)`);
  console.log(`Ops received:     ${opsReceived} (${(opsReceived / elapsedSec).toFixed(0)}/s)`);
  console.log('Latency (ack round-trip):');
  console.log(`  P50: ${percentile(latencies, 50)}ms`);
  console.log(`  P95: ${percentile(latencies, 95)}ms`);
  console.log(`  P99: ${percentile(latencies, 99)}ms`);
  console.log(`  Max: ${latencies[latencies.length - 1] ?? 0}ms`);
}

void main();
