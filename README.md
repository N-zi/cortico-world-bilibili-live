# cortico-world-bilibili-live

一个精简、只读的 Cortico World：匿名连接公开的 B 站直播间，接收普通文字弹幕、礼物和上舰事件，并按“累计条数 + 冷却时间”整理后交给 Coopanion。

## 配置

- `roomId`：B站直播间短号或真实房间号。
- `replyEvery`：普通弹幕累计门槛，默认 5 条。
- `replyCooldownSeconds`：两批事件之间的最短间隔，默认 30 秒。

礼物和上舰会跳过累计条数门槛，但仍遵守冷却时间；冷却期间的新动态合并到下一批。

World 页面提供“接收日志”面板，显示连接、接收、冷却等待和向 Coopanion 投递的状态。日志只保留在进程内存中，最多 200 行，重启后清空。达到条件的批次使用 `flush` 立即唤醒 Coopanion。

“B站登录”面板可以生成二维码。使用哔哩哔哩客户端扫码并确认后，扩展只提取 `SESSDATA`，通过 Cortico 的秘密存储保存，然后重建弹幕连接。凭证不会进入普通配置、日志或面板响应；退出登录会清除它。登录后 B 站通常会返回未脱敏昵称，但最终仍取决于平台协议和风控。

## 隐私与网络

扩展不读取 Cookie、SESSDATA、API Key 或本地文件，不向 B 站发送弹幕。它只连接：

- `https://api.bilibili.com`：取得匿名设备标识和 WBI 签名材料。
- `https://api.live.bilibili.com`：解析房间号并取得弹幕服务器。
- `https://passport.bilibili.com`：仅在用户主动生成登录二维码及等待扫码确认时访问。
- B站接口返回的 `wss://...` 弹幕服务器：接收公开直播事件。

事件正文会进入 Cortico 的正常事件记录，以便 Coopanion 获得上下文。扩展不另存原始帧、UID、昵称或消息历史。

## 开发与测试

```bash
corepack pnpm install
pnpm test
pnpm typecheck
```

协议是 B 站 Web 直播协议，不是稳定的官方开放平台契约，未来可能因字段或风控变化失效。

第三方参考与许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
