/** B站直播长连帧编解码。改写自 Cortico 内置 bilibili World（MIT）。 */
import { brotliDecompressSync, inflateSync } from 'node:zlib';

export const OP = { HEARTBEAT: 2, HEARTBEAT_REPLY: 3, MESSAGE: 5, AUTH: 7, AUTH_REPLY: 8 } as const;
const HEADER_LEN = 16;

export function encodePacket(op: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(HEADER_LEN + payload.length);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt16BE(HEADER_LEN, 4);
  packet.writeUInt16BE(1, 6);
  packet.writeUInt32BE(op, 8);
  packet.writeUInt32BE(1, 12);
  payload.copy(packet, HEADER_LEN);
  return packet;
}

export type Frame = { kind: 'auth'; code: number } | { kind: 'cmd'; msg: Record<string, unknown> };

export function parseFrames(buffer: Buffer): Frame[] {
  const frames: Frame[] = [];
  collect(buffer, frames);
  return frames;
}

function collect(buffer: Buffer, frames: Frame[]): void {
  let offset = 0;
  while (offset + HEADER_LEN <= buffer.length) {
    const total = buffer.readUInt32BE(offset);
    const head = buffer.readUInt16BE(offset + 4);
    const version = buffer.readUInt16BE(offset + 6);
    const op = buffer.readUInt32BE(offset + 8);
    if (head < HEADER_LEN || total < head || offset + total > buffer.length) return;
    const body = buffer.subarray(offset + head, offset + total);
    offset += total;
    if (op === OP.AUTH_REPLY) {
      const reply = readJson(body);
      frames.push({ kind: 'auth', code: typeof reply?.code === 'number' ? reply.code : -1 });
    } else if (op === OP.MESSAGE && (version === 2 || version === 3)) {
      try { collect(version === 2 ? inflateSync(body) : brotliDecompressSync(body), frames); } catch { /* 丢弃坏帧 */ }
    } else if (op === OP.MESSAGE) {
      const message = readJson(body);
      if (message) frames.push({ kind: 'cmd', msg: message });
    }
  }
}

function readJson(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return isRecord(value) ? value : null;
  } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
