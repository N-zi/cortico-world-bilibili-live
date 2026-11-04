/** B站网页二维码登录。改写自 Cortico 内置 bilibili World（MIT）。 */
import { USER_AGENT } from './client.ts';

const PASSPORT = 'https://passport.bilibili.com';
const POLL_MS = 2_000;
const GIVE_UP_MS = 180_000;

export type LoginPhase = 'idle' | 'waiting' | 'scanned' | 'done' | 'expired' | 'failed';
export interface LoginState { phase: LoginPhase; url: string | null; uid: number | null; error: string | null; }
export interface BrowserLoginOptions { onSessdata(value: string): void; pollMs?: number; passportBase?: string; }
const IDLE: LoginState = { phase: 'idle', url: null, uid: null, error: null };

export class BrowserLogin {
  private state: LoginState = { ...IDLE };
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly opts: BrowserLoginOptions) {}
  get current(): LoginState { return { ...this.state }; }

  async start(): Promise<LoginState> {
    const generation = this.reset();
    const body = await this.request('/x/passport-login/web/qrcode/generate');
    const data = record(body.data);
    const url = string(data.url);
    const key = string(data.qrcode_key);
    if (body.code !== 0 || !url || !key) throw new Error(`B站没有返回登录二维码：${String(body.message ?? body.code)}`);
    if (generation !== this.generation) return this.current;
    this.state = { phase: 'waiting', url, uid: null, error: null };
    this.schedule(generation, key, Date.now());
    return this.current;
  }

  cancel(): LoginState { this.reset(); return this.current; }

  private reset(): number {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = { ...IDLE };
    return ++this.generation;
  }

  private schedule(generation: number, key: string, lastOkAt: number): void {
    this.timer = setTimeout(() => { void this.poll(generation, key, lastOkAt); }, this.opts.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  private async poll(generation: number, key: string, lastOkAt: number): Promise<void> {
    try {
      const response = await this.fetch(`/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`);
      const body = record(await response.json());
      if (generation !== this.generation) return;
      const data = record(body.data);
      const code = data.code;
      if (code === 86101 || code === 86090) {
        this.state = { ...this.state, phase: code === 86090 ? 'scanned' : 'waiting' };
        this.schedule(generation, key, Date.now());
        return;
      }
      if (code === 86038) { this.state = { ...IDLE, phase: 'expired' }; return; }
      if (code !== 0) { this.state = { ...IDLE, phase: 'failed', error: `B站登录返回：${String(data.message ?? code)}` }; return; }
      const cookies = response.headers.getSetCookie();
      const sessdata = cookieValue(cookies, 'SESSDATA');
      if (!sessdata) { this.state = { ...IDLE, phase: 'failed', error: '登录成功响应缺少 SESSDATA' }; return; }
      this.opts.onSessdata(sessdata);
      const uid = Number(cookieValue(cookies, 'DedeUserID'));
      this.state = { ...IDLE, phase: 'done', uid: Number.isSafeInteger(uid) && uid > 0 ? uid : null };
    } catch (error) {
      if (generation !== this.generation) return;
      if (Date.now() - lastOkAt > GIVE_UP_MS) {
        this.state = { ...IDLE, phase: 'failed', error: `查询登录状态失败：${errorText(error)}` };
      } else {
        this.schedule(generation, key, lastOkAt);
      }
    }
  }

  private async request(path: string): Promise<Record<string, unknown>> {
    const response = await this.fetch(path);
    if (!response.ok) throw new Error(`B站账号接口 HTTP ${response.status}`);
    return record(await response.json());
  }

  private fetch(path: string): Promise<Response> {
    return fetch(`${this.opts.passportBase ?? PASSPORT}${path}`, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(10_000),
    });
  }
}

function cookieValue(lines: readonly string[], name: string): string | null {
  for (const line of lines) {
    const pair = line.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim() || null;
  }
  return null;
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
