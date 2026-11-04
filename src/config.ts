import type { ConfigGroup } from 'cortico/core/types.ts';

export interface BilibiliLiveConfigSection {
  enabled: boolean;
  roomId: number;
  replyEvery: number;
  replyCooldownSeconds: number;
}

export const BILIBILI_LIVE_DEFAULTS: BilibiliLiveConfigSection = {
  enabled: false,
  roomId: 0,
  replyEvery: 5,
  replyCooldownSeconds: 30,
};

export const BILIBILI_LIVE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:bilibili-live',
  owner: 'world:bilibili-live',
  schema: {
    type: 'object',
    title: 'B站直播弹幕',
    description: '只读监听公开直播间的普通文字弹幕、礼物和上舰事件。',
    properties: {
      'worlds.bilibili-live.roomId': {
        type: 'integer', title: '直播间号', minimum: 1, maximum: 4294967295,
        description: 'B站直播间短号或真实房间号。修改后需重启 World。', 'x-hot': false,
      },
      'worlds.bilibili-live.replyEvery': {
        type: 'integer', title: '累计弹幕条数', minimum: 1, maximum: 100,
        description: '至少累计这么多条普通文字弹幕后才交给 Coopanion；礼物和上舰不受此门槛限制。', 'x-hot': true,
      },
      'worlds.bilibili-live.replyCooldownSeconds': {
        type: 'integer', title: '回复冷却', minimum: 0, maximum: 3600,
        description: '两批直播事件之间的最短间隔；冷却期间的内容合并到下一批。', 'x-suffix': 's', 'x-hot': true,
      },
    },
  },
};
