import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { BILIBILI_LIVE } from '../src/definition.ts';
import { BILIBILI_LIVE_DEFAULTS } from '../src/config.ts';
import { normalizeActivity, type LiveActivity, type LiveSource } from '../src/client.ts';
import { BilibiliLiveWorld } from '../src/world.ts';
import { BrowserLogin } from '../src/login.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'bilibili-live-world-')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(scratchDir, { recursive: true, force: true }); });

class FakeSource implements LiveSource {
  started = false;
  stopped = false;
  constructor(readonly emit: (event: LiveActivity) => void) {}
  async start(): Promise<void> { this.started = true; }
  async stop(): Promise<void> { this.stopped = true; }
}

function setup(config: Partial<typeof BILIBILI_LIVE_DEFAULTS> = {}) {
  const cfg = { ...BILIBILI_LIVE_DEFAULTS, roomId: 123, ...config };
  let source!: FakeSource;
  let now = 0;
  const world = new BilibiliLiveWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    now: () => now,
    sourceFactory: (_roomId, emit) => (source = new FakeSource(emit)),
  });
  const host = new FakeHost();
  return { world, host, get source() { return source; }, setNow(value: number) { now = value; } };
}

describe('Bilibili Live World', () => {
  it('干装载通过，声明为无工具的事件型 World', async () => {
    const report = await dryMountWorld(BILIBILI_LIVE, { scratchDir });
    expect(report.failures).toEqual([]);
    expect(BILIBILI_LIVE.describe?.tools).toEqual([]);
  });

  it('启用时启动监听，停用时关闭监听', async () => {
    const fixture = setup();
    await fixture.world.start(fixture.host);
    expect(fixture.source.started).toBe(true);
    await fixture.world.stop();
    expect(fixture.source.stopped).toBe(true);
  });

  it('普通弹幕达到5条后合批投递', async () => {
    const fixture = setup({ replyEvery: 5, replyCooldownSeconds: 30 });
    await fixture.world.start(fixture.host);
    for (let i = 1; i <= 4; i++) fixture.source.emit({ kind: 'danmaku', username: `观众${i}`, text: `消息${i}` });
    expect(fixture.host.events).toHaveLength(0);
    fixture.source.emit({ kind: 'danmaku', username: '观众5', text: '消息5' });
    await vi.waitFor(() => expect(fixture.host.events).toHaveLength(1));
    expect(fixture.host.events[0].text).toContain('[弹幕] 观众5：消息5');
    expect(fixture.host.events[0].text).toContain('必须调用 pet_say');
    expect(fixture.host.events[0].text).toContain('不得调用 console_send');
    expect(fixture.host.pushOpts[0]?.trigger).toBe('flush');
    const state = await fixture.world.webUi().invoke?.('log', 'state', []) as { logs: Array<{ message: string }> };
    expect(state.logs.some((line) => line.message.includes('已向Coopanion投递 5 条动态'))).toBe(true);
    await fixture.world.stop();
  });

  it('礼物跳过条数门槛，但冷却期内与后续弹幕合批', async () => {
    vi.useFakeTimers();
    const fixture = setup({ replyEvery: 5, replyCooldownSeconds: 30 });
    await fixture.world.start(fixture.host);
    fixture.source.emit({ kind: 'gift', username: '阿蓝', giftName: '辣条', count: 5 });
    await vi.runAllTicks();
    expect(fixture.host.events).toHaveLength(1);
    fixture.setNow(1000);
    fixture.source.emit({ kind: 'guard', username: '星星', guardName: '舰长', count: 1 });
    fixture.source.emit({ kind: 'danmaku', username: '小明', text: '晚上好' });
    expect(fixture.host.events).toHaveLength(1);
    fixture.setNow(30000);
    await vi.advanceTimersByTimeAsync(29000);
    expect(fixture.host.events).toHaveLength(2);
    expect(fixture.host.events[1].text).toContain('[上舰] 星星：舰长');
    expect(fixture.host.events[1].text).toContain('[弹幕] 小明：晚上好');
    await fixture.world.stop();
  });

  it('解析普通弹幕、礼物和上舰，不接受其他事件', () => {
    expect(normalizeActivity({ cmd: 'DANMU_MSG', info: [[], '你好', [1, '小明']] })).toEqual({ kind: 'danmaku', username: '小明', text: '你好' });
    expect(normalizeActivity({ cmd: 'SEND_GIFT', data: { uname: '小红', giftName: '辣条', num: 3 } })).toEqual({ kind: 'gift', username: '小红', giftName: '辣条', count: 3 });
    expect(normalizeActivity({ cmd: 'GUARD_BUY', data: { username: '阿蓝', guard_level: 3, num: 1 } })).toEqual({ kind: 'guard', username: '阿蓝', guardName: '舰长', count: 1 });
    expect(normalizeActivity({ cmd: 'INTERACT_WORD', data: {} })).toBeNull();
  });

  it('模板配置路径都落在自己的 World 段内', () => {
    const ctx = fakeWorldContext(BILIBILI_LIVE, { scratchDir });
    const world = BILIBILI_LIVE.create(ctx);
    const keys = Object.keys(world.webUi?.().config?.[0].schema.properties ?? {});
    expect(keys.every((key) => key.startsWith('worlds.bilibili-live.'))).toBe(true);
  });

  it('环境提示词明确把直播回应投送到桌宠气泡', async () => {
    const prompt = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8'));
    expect(prompt).toContain('pet_say');
    expect(prompt).toContain('桌宠气泡');
  });

  it('扫码登录只把 SESSDATA 交给秘密存储回调', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/generate')) {
        return Response.json({ code: 0, data: { url: 'https://example.test/qr', qrcode_key: 'key' } });
      }
      const headers = new Headers();
      headers.append('set-cookie', 'SESSDATA=secret%2Cvalue; Path=/; HttpOnly');
      headers.append('set-cookie', 'DedeUserID=12345; Path=/');
      return new Response(JSON.stringify({ code: 0, data: { code: 0 } }), { headers });
    });
    vi.stubGlobal('fetch', fetchMock);
    let stored = '';
    const login = new BrowserLogin({ pollMs: 1, onSessdata: (value) => { stored = value; } });
    const initial = await login.start();
    expect(initial.url).toBe('https://example.test/qr');
    await vi.advanceTimersByTimeAsync(1);
    expect(stored).toBe('secret%2Cvalue');
    expect(login.current).toMatchObject({ phase: 'done', uid: 12345 });
    expect(JSON.stringify(login.current)).not.toContain('secret%2Cvalue');
  });
});
