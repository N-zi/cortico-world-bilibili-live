import { fileURLToPath } from 'node:url';
import type { OutputTap, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { BILIBILI_LIVE_CONFIG_GROUP, type BilibiliLiveConfigSection } from './config.ts';
import { BilibiliLiveClient, type LiveActivity, type LiveSource } from './client.ts';
import { BrowserLogin } from './login.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const MAX_PENDING = 100;
const MAX_LOGS = 200;

interface VisibleLog {
  at: string;
  message: string;
  tone: 'plain' | 'dim' | 'warn' | 'bad';
}

export interface BilibiliLiveWorldOptions {
  cfg: BilibiliLiveConfigSection;
  timezone: string;
  sourceFactory?: (roomId: number, onActivity: (event: LiveActivity) => void) => LiveSource;
  now?: () => number;
  sessdata?: string;
  storeSessdata?: (value: string) => void;
}

export class BilibiliLiveWorld implements World {
  readonly id = 'bilibili-live';
  private host: WorldHost | null = null;
  private source: LiveSource | null = null;
  private pending: LiveActivity[] = [];
  private danmakuCount = 0;
  private urgent = false;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private logs: VisibleLog[] = [];
  private connection = '未启动';
  private readonly now: () => number;
  private sessdata: string;
  private readonly login: BrowserLogin;

  constructor(private readonly opts: BilibiliLiveWorldOptions) {
    this.now = opts.now ?? Date.now;
    this.sessdata = opts.sessdata?.trim() ?? '';
    this.login = new BrowserLogin({ onSessdata: (value) => this.applySessdata(value) });
  }

  envPromptVars(): Record<string, never> { return {}; }
  tools(): [] { return []; }

  outputTap(): OutputTap {
    return {
      onEvent: (event) => {
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          this.visibleLog(`模型选择工具：${event.item.name}`, event.item.name === 'pet_say' ? 'plain' : 'warn');
        }
      },
    };
  }

  webUi(): WorldWebUiDecl {
    return {
      badges: [
        { label: '连接', value: this.connection, tone: this.connection.includes('已连接') ? 'on' : 'plain' },
        { label: '待处理', value: this.pending.length, tone: this.pending.length ? 'on' : 'plain' },
      ],
      panels: [
        { id: 'log', title: '接收日志', description: '查看连接、接收、合批等待和投递情况。' },
        { id: 'login', title: 'B站登录', description: '扫码登录以读取未脱敏的观众昵称。' },
      ],
      invoke: async (panel, method) => {
        if (panel === 'log' && method === 'state') {
          return { connection: this.connection, pending: this.pending.length, danmakuCount: this.danmakuCount, logs: this.logs };
        }
        if (panel === 'login') {
          if (method === 'state') return { ...this.login.current, configured: this.sessdata !== '' };
          if (method === 'start') { await this.login.start(); return { ...this.login.current, configured: this.sessdata !== '' }; }
          if (method === 'cancel') { this.login.cancel(); return { ...this.login.current, configured: this.sessdata !== '' }; }
          if (method === 'logout') {
            this.login.cancel();
            this.opts.storeSessdata?.('');
            this.sessdata = '';
            this.visibleLog('已清除B站登录凭证，切回匿名连接', 'warn');
            await this.reconnect();
            return { ...this.login.current, configured: false };
          }
        }
        throw new Error(`未知面板方法：${panel}.${method}`);
      },
      config: [BILIBILI_LIVE_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.bilibili-live.envPrompt',
        title: 'B站直播弹幕 · 环境提示词',
        description: '告诉 Coopanion 如何理解和回应直播间近期动态。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [],
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    const roomId = Math.trunc(Number(this.opts.cfg.roomId));
    if (!Number.isSafeInteger(roomId) || roomId <= 0) throw new Error('请先填写有效的B站直播间号。');
    this.host = host;
    this.visibleLog('开始监听直播间 ' + roomId);
    this.source = this.createSource(roomId, host);
    await this.source.start();
  }

  private createSource(roomId: number, host: WorldHost): LiveSource {
    return this.opts.sourceFactory?.(roomId, (event) => this.accept(event))
      ?? new BilibiliLiveClient({
        roomId,
        onActivity: (event) => this.accept(event),
        log: host.log,
        sessdata: this.sessdata,
        onStatus: (message, tone) => {
          this.connection = message;
          this.visibleLog(message, tone);
        },
      });
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.login.cancel();
    this.flushTimer = null;
    const source = this.source;
    this.source = null;
    this.host = null;
    this.pending = [];
    this.danmakuCount = 0;
    this.urgent = false;
    this.connection = '已停止';
    this.visibleLog('监听已停止', 'dim');
    await source?.stop();
  }

  private accept(event: LiveActivity): void {
    if (!this.host) return;
    this.pending.push(event);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (event.kind === 'danmaku') this.danmakuCount += 1;
    else this.urgent = true;
    this.visibleLog(formatActivity(event).slice(2), 'dim');
    this.maybeFlush();
  }

  private maybeFlush(): void {
    if (!this.urgent && this.danmakuCount < this.replyEvery()) return;
    const remaining = this.cooldownMs() - (this.now() - this.lastFlushAt);
    if (remaining <= 0) { void this.flush(); return; }
    if (this.flushTimer) return;
    this.visibleLog(`已达到触发条件，等待冷却 ${Math.ceil(remaining / 1000)} 秒`);
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, remaining);
    this.flushTimer.unref?.();
  }

  private async flush(): Promise<void> {
    const host = this.host;
    if (!host || this.pending.length === 0) return;
    if (!this.urgent && this.danmakuCount < this.replyEvery()) return;
    const batch = this.pending.splice(0);
    this.danmakuCount = 0;
    this.urgent = false;
    this.lastFlushAt = this.now();
    try {
      await host.pushEvent({
        type: 'bilibili-live.activity', ts: nowIso(this.opts.timezone), source: this.id,
        origin: 'external', senderKey: `bilibili-live:room:${Math.trunc(Number(this.opts.cfg.roomId))}`,
        text: [
          '[直播回应路由] 处理完本批动态后，必须调用 pet_say 将最终口播显示到桌宠气泡；不得调用 console_send。',
          'B站直播间近期动态：',
          ...batch.map(formatActivity),
        ].join('\n'),
        meta: { roomId: Math.trunc(Number(this.opts.cfg.roomId)), count: batch.length },
      }, { trigger: 'flush' });
      this.visibleLog(`已向Coopanion投递 ${batch.length} 条动态（立即唤醒）`);
    } catch (error) {
      this.visibleLog(`投递失败：${error instanceof Error ? error.message : String(error)}`, 'bad');
      host.log.warn('B站直播动态投递失败', { err: error instanceof Error ? error.message : String(error) });
    }
  }

  private replyEvery(): number { return Math.max(1, Math.trunc(Number(this.opts.cfg.replyEvery) || 1)); }
  private cooldownMs(): number { return Math.max(0, Number(this.opts.cfg.replyCooldownSeconds) || 0) * 1000; }

  private applySessdata(value: string): void {
    this.opts.storeSessdata?.(value);
    this.sessdata = value;
    this.visibleLog('B站扫码登录成功，凭证已存入秘密存储；正在重连');
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    const host = this.host;
    const old = this.source;
    if (!host || !old || this.opts.sourceFactory) return;
    this.source = null;
    await old.stop();
    if (!this.host) return;
    const roomId = Math.trunc(Number(this.opts.cfg.roomId));
    const next = this.createSource(roomId, host);
    this.source = next;
    await next.start();
  }

  private visibleLog(message: string, tone: VisibleLog['tone'] = 'plain'): void {
    this.logs.push({ at: new Date(this.now()).toISOString(), message, tone });
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }
}

function formatActivity(event: LiveActivity): string {
  if (event.kind === 'danmaku') return `- [弹幕] ${event.username}：${event.text}`;
  if (event.kind === 'gift') return `- [礼物] ${event.username}：赠送 ${event.giftName} × ${event.count}`;
  return `- [上舰] ${event.username}：${event.guardName}${event.count > 1 ? ` × ${event.count}` : ''}`;
}
