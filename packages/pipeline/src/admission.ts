import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { PipelineError, SIGNED_UPLOAD_SECONDS, UPLOAD_TTL_SECONDS } from './contracts.js';

export const UPLOAD_BUSY_MESSAGE = 'Upload queue is busy. Try again later.';
export const MAX_PENDING_UPLOADS = 20;

/** Called only with the dedicated proxy's overwritten socket-peer header. */
export function networkIdentity(address: string | null, secret: string): string {
  if (secret.length < 32 || !address || address.includes('%') || !isIP(address))
    throw new PipelineError(503, 'Upload visitor identity is unavailable.');
  let network = address;
  if (isIP(address) === 6) {
    // Expand validated IPv6, including embedded IPv4, before taking a /64.
    let ipv6 = address.toLowerCase();
    if (ipv6.includes('.')) {
      const start = ipv6.lastIndexOf(':') + 1;
      const octets = ipv6.slice(start).split('.').map(Number);
      ipv6 = ipv6.slice(0, start) +
        ((octets[0]! << 8) | octets[1]!).toString(16) + ':' +
        ((octets[2]! << 8) | octets[3]!).toString(16);
    }
    const [left, right] = ipv6.split('::');
    const head = left ? left.split(':') : [];
    const tail = right ? right.split(':') : [];
    const words = right !== undefined
      ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
    const canonical = words.map(word => parseInt(word, 16));
    // IPv4-mapped IPv6 must share its ordinary IPv4 quota.
    network = canonical.slice(0, 5).every(word => word === 0) && canonical[5] === 0xffff
      ? `${canonical[6]! >> 8}.${canonical[6]! & 255}.${canonical[7]! >> 8}.${canonical[7]! & 255}`
      : canonical.slice(0, 4).map(word => word.toString(16)).join(':') + '::/64';
  }
  return createHmac('sha256', secret).update(`upload-network:${network}`).digest('hex');
}

// Capacity and counters are reserved together: concurrent web processes cannot
// all observe an empty queue and over-admit. Awaiting-body tickets consume slots
// too. BullMQ's actual active/waiting/paused/deferred collections are counted.
// Completing reservations never expire: an ambiguous late queue write must not
// outlive its capacity lease. A successful/idempotent queue add releases it.
const RESERVE = `
local now = redis.call('TIME')
local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ms)
local own = redis.call('ZSCORE', KEYS[1], ARGV[1]) and 1 or 0
local pending = redis.call('ZCARD', KEYS[1]) - own
for i = 3, 5 do pending = pending + redis.call('LLEN', KEYS[i]) end
for i = 6, 8 do pending = pending + redis.call('ZCARD', KEYS[i]) end
if pending >= tonumber(ARGV[3]) then return -1 end
if ARGV[2] == 'create' then
  if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[7]) then return -2 end
  if ARGV[9] == 'hosted' and tonumber(redis.call('GET', KEYS[11]) or '0') >= 500 then return -5 end
  if ARGV[4] == 'visitor' then
    if tonumber(redis.call('GET', KEYS[9]) or '0') >= 5 then return -3 end
    if tonumber(redis.call('GET', KEYS[10]) or '0') >= tonumber(ARGV[8]) then return -4 end
  end
  redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], ARGV[5])
  if ARGV[9] == 'hosted' then
    redis.call('INCR', KEYS[11])
    redis.call('EXPIRE', KEYS[11], 3024000)
  end
  if ARGV[4] == 'visitor' then
    redis.call('INCR', KEYS[9])
    redis.call('EXPIRE', KEYS[9], 7200)
    redis.call('INCR', KEYS[10])
    redis.call('EXPIRE', KEYS[10], 172800)
  end
  redis.call('ZADD', KEYS[1], ms + tonumber(ARGV[6]) * 1000, ARGV[1])
elseif ARGV[2] == 'complete' then
  redis.call('ZADD', KEYS[1], '+inf', ARGV[1])
else
  redis.call('ZADD', KEYS[1], ms + 660000, ARGV[1])
end
return 1
`;

export async function reserveAdmission(
  redis: Redis, queue: Queue, prefix: string, id: string,
  mode: 'create' | 'complete' | 'transfer', identity?: string, hosted = false,
) {
  if (identity !== undefined && !/^[a-f0-9]{64}$/u.test(identity))
    throw new PipelineError(503, 'Upload visitor identity is unavailable.');
  const hour = Math.floor(Date.now() / 3600000);
  const day = Math.floor(hour / 24);
  const month = new Date().toISOString().slice(0, 7);
  const result = await redis.eval(RESERVE, 11,
    `${prefix}:admission-pending`, `${prefix}:admission:${day}`,
    ...['wait', 'paused', 'active', 'delayed', 'prioritized', 'waiting-children'].map(key => queue.toKey(key)),
    `${prefix}:visitor:${identity ?? 'owner'}:hour:${hour}`,
    `${prefix}:visitor:${identity ?? 'owner'}:day:${day}`,
    `${prefix}:admission-month:${month}`,
    id, mode, MAX_PENDING_UPLOADS, identity === undefined ? 'owner' : 'visitor',
    UPLOAD_TTL_SECONDS, SIGNED_UPLOAD_SECONDS,
    hosted ? 25 : 100, hosted ? 3 : 15, hosted ? 'hosted' : 'beta',
  ) as number;
  if (result === -1) throw new PipelineError(503, UPLOAD_BUSY_MESSAGE);
  if (result === -2) throw new PipelineError(429, 'The daily upload limit has been reached.');
  if (result === -3) throw new PipelineError(429, 'Your hourly upload limit has been reached. Try again later.');
  if (result === -4) throw new PipelineError(429, 'Your daily upload limit has been reached. Try again tomorrow.');
  if (result === -5) throw new PipelineError(429, 'The monthly upload allowance has been reached.');
  if (result !== 1) throw new PipelineError(503, 'Upload admission is unavailable.');
}
