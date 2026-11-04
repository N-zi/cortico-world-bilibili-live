/** B站公开直播间只读客户端。协议实现参考 Cortico 内置 bilibili World 与 astrbot_plugin_live_stream_companion（均为 MIT）。 */
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import type { Logger } from 'cortico/core/types.ts';
import { encodePacket, OP, parseFrames } from './wire.ts';

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const HEARTBEAT_MS = 30_000;
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

export type LiveActivity =
  | { kind: 'danmaku'; username: string; text: string }
  | { kind: 'gift'; username: string; giftName: string; count: number }
  | { kind: 'guard'; username: string; guardName: string; count: number };

export interface LiveSource { start(): Promise<void>; stop(): Promise<void>; }

export interface BilibiliLiveClientOptions {
  roomId: number;
  onActivity: (activity: LiveActivity) => void;
  log: Logger;
  sessdata?: string;
  onStatus?: (message: string, tone?: 'plain' | 'warn' | 'bad') => void;
}

export class BilibiliLiveClient implements LiveSource {
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private backoff = MIN_BACKOFF_MS;

  constructor(private readonly opts: BilibiliLiveClientOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.retry = null;
    this.heartbeat = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'world stopped');
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.opts.onStatus?.('正在连接B站直播间…');
    try {
      let plan: { url: string; auth: Record<string, unknown> };
      let authenticated = Boolean(this.opts.sessdata);
      try {
        plan = await this.bootstrap(this.opts.sessdata ?? '');
      } catch (error) {
        if (!this.opts.sessdata) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        this.opts.log.warn('B站登录态连接失败，回退匿名连接', { reason });
        this.opts.onStatus?.(`登录态连接失败，已回退匿名连接：${reason}`, 'warn');
        plan = await this.bootstrap('');
        authenticated = false;
      }
      if (this.stopped) return;
      const socket = new WebSocket(plan.url, {
        headers: { 'User-Agent': USER_AGENT, Origin: 'https://live.bilibili.com' },
        handshakeTimeout: 15_000,
      });
      this.socket = socket;
      socket.on('open', () => {
        socket.send(encodePacket(OP.AUTH, JSON.stringify(plan.auth)));
        this.heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(encodePacket(OP.HEARTBEAT, ''));
        }, HEARTBEAT_MS);
        this.heartbeat.unref?.();
      });
      socket.once('open', () => this.opts.onStatus?.(authenticated ? '已使用B站登录身份连接' : '已匿名连接B站直播间'));
      socket.on('message', (raw) => this.onMessage(toBuffer(raw)));
      socket.on('error', (error) => this.opts.log.warn('B站直播长连接出错', { err: error.message }));
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.clearHeartbeat();
        if (!this.stopped) this.scheduleReconnect('长连接断开');
      });
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  private onMessage(buffer: Buffer): void {
    for (const frame of parseFrames(buffer)) {
      if (frame.kind === 'auth') {
        if (frame.code === 0) {
          this.backoff = MIN_BACKOFF_MS;
          this.opts.log.info('B站直播弹幕已连接');
          this.opts.onStatus?.('B站直播弹幕已连接');
        }
        else this.scheduleReconnect(`认证失败 code=${frame.code}`);
      } else {
        const activity = normalizeActivity(frame.msg);
        if (activity) this.opts.onActivity(activity);
      }
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.retry) return;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    const delay = this.backoff;
    this.opts.log.warn(`B站直播接入中断，${Math.round(delay / 1000)} 秒后重连`, { reason });
    this.opts.onStatus?.(`连接中断：${reason}；${Math.round(delay / 1000)}秒后重连`, 'warn');
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
    this.retry.unref?.();
    this.backoff = Math.min(delay * 2, MAX_BACKOFF_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async bootstrap(sessdata: string): Promise<{ url: string; auth: Record<string, unknown> }> {
    const spi = await getJson('https://api.bilibili.com/x/frontend/finger/spi');
    const buvid = text(record(spi.data).b_3);
    const cookie = [buvid ? `buvid3=${buvid}` : '', sessdata ? `SESSDATA=${sessdata}` : ''].filter(Boolean).join('; ');
    const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', cookie);
    const wbi = record(record(nav.data).wbi_img);
    const mixin = mixinKey(fileKey(text(wbi.img_url)), fileKey(text(wbi.sub_url)));
    const info = await getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${this.opts.roomId}`);
    if (number(info.code) !== 0) throw new Error(`读取直播间失败：${text(info.message)}`);
    const realRoomId = number(record(info.data).room_id);
    if (!realRoomId) throw new Error('B站返回的真实直播间号无效');
    const query = wbiQuery({ id: realRoomId, type: 0 }, mixin);
    const selfUid = number(record(nav.data).mid);
    const danmu = await getJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`, cookie);
    if (number(danmu.code) !== 0) throw new Error(`读取弹幕服务器失败：${text(danmu.message)}`);
    const data = record(danmu.data);
    const first = record(Array.isArray(data.host_list) ? data.host_list[0] : null);
    const host = text(first.host);
    if (!host) throw new Error('B站未返回弹幕服务器');
    return {
      url: `wss://${host}:${number(first.wss_port) || 443}/sub`,
      auth: { uid: selfUid, roomid: realRoomId, protover: 3, platform: 'web', type: 2, buvid, key: text(data.token) },
    };
  }
}

export function normalizeActivity(message: Record<string, unknown>): LiveActivity | null {
  const command = text(message.cmd).split(':')[0];
  if (command === 'DANMU_MSG') {
    const info = Array.isArray(message.info) ? message.info : [];
    const user = Array.isArray(info[2]) ? info[2] : [];
    const content = text(info[1]).trim();
    if (!content) return null;
    return { kind: 'danmaku', username: safeName(user[1]), text: content };
  }
  const data = record(message.data);
  if (command === 'SEND_GIFT' || command === 'SEND_GIFT_V2') {
    const giftName = text(data.giftName || data.gift_name).trim();
    if (!giftName) return null;
    return { kind: 'gift', username: safeName(data.uname), giftName, count: positiveInt(data.num) };
  }
  if (command === 'GUARD_BUY') {
    const level = positiveInt(data.guard_level);
    return { kind: 'guard', username: safeName(data.username || data.uname), guardName: guardName(level), count: positiveInt(data.num) };
  }
  return null;
}

async function getJson(url: string, cookie = ''): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: {
      'User-Agent': USER_AGENT, Origin: 'https://live.bilibili.com', Referer: 'https://live.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}),
    } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return record(await response.json());
  } finally { clearTimeout(timeout); }
}

function wbiQuery(params: Record<string, number>, mixin: string): string {
  const values: Record<string, number> = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(values).sort().map((key) => `${encodeURIComponent(key)}=${values[key]}`).join('&');
  return `${query}&w_rid=${createHash('md5').update(query + mixin).digest('hex')}`;
}
function mixinKey(img: string, sub: string): string { const raw = img + sub; return MIXIN_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32); }
function fileKey(url: string): string { return url.split('/').pop()?.split('.')[0] ?? ''; }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0; }
function positiveInt(value: unknown): number { return Math.max(1, Math.trunc(number(value))); }
function safeName(value: unknown): string { return text(value).trim() || '匿名观众'; }
function guardName(level: number): string { return level === 1 ? '总督' : level === 2 ? '提督' : '舰长'; }
function toBuffer(raw: WebSocket.RawData): Buffer { return Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw); }
