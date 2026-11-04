import type { WorldDefinition } from 'cortico/world.ts';
import { BILIBILI_LIVE_DEFAULTS, type BilibiliLiveConfigSection } from './config.ts';
import { BilibiliLiveWorld } from './world.ts';

export const BILIBILI_LIVE_SESSDATA = 'BILIBILI_LIVE_SESSDATA';

export const BILIBILI_LIVE: WorldDefinition<BilibiliLiveConfigSection> = {
  id: 'bilibili-live',
  label: 'B站直播弹幕',
  defaults: () => ({ ...BILIBILI_LIVE_DEFAULTS }),
  create: (ctx) => new BilibiliLiveWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    sessdata: ctx.secret(BILIBILI_LIVE_SESSDATA),
    storeSessdata: (value) => ctx.storeSecret(BILIBILI_LIVE_SESSDATA, value),
  }),
  describe: {
    tools: [],
    events: [{
      type: 'bilibili-live.activity',
      description: {
        zh: '按累计条数与冷却时间合批的B站普通文字弹幕、礼物和上舰动态。',
        en: 'Batched Bilibili text danmaku, gift, and guard activity subject to count and cooldown limits.',
      },
      trigger: 'flush',
      tags: ['speak'],
    }],
  },
};
