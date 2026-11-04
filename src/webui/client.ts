import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import QRCode from 'qrcode';

interface LogState {
  connection: string;
  pending: number;
  danmakuCount: number;
  logs: Array<{ at: string; message: string; tone: 'plain' | 'dim' | 'warn' | 'bad' }>;
}

interface LoginState {
  phase: 'idle' | 'waiting' | 'scanned' | 'done' | 'expired' | 'failed';
  url: string | null;
  uid: number | null;
  error: string | null;
  configured: boolean;
}

const bundle: WebUiClientBundle = {
  panels: {
    log: {
      mount(ctx: WebUiPanelContext) {
        const { ui } = ctx;
        const card = ui.sheet({ title: 'B站直播接收日志', en: 'Bilibili live log' });
        const status = ui.msgline('正在读取状态…');
        const view = ui.log({ max: 200, maxHeight: '420px', empty: '尚未收到日志。' });
        card.body.append(status, view.el);
        ctx.root.appendChild(card.el);

        let rendered = 0;
        const refresh = async () => {
          try {
            const state = await ctx.invoke<LogState>('state');
            status.textContent = `${state.connection} · 待处理 ${state.pending} 条 · 其中弹幕 ${state.danmakuCount} 条`;
            if (state.logs.length < rendered) { view.clear(); rendered = 0; }
            for (const line of state.logs.slice(rendered)) {
              view.append(`${ui.fmt.clock(line.at)}  ${line.message}`, line.tone);
            }
            rendered = state.logs.length;
          } catch (error) {
            status.textContent = `日志读取失败：${String(error)}`;
            status.classList.add('bad');
          }
        };
        void refresh();
        ctx.interval(() => { void refresh(); }, 1000);
      },
    },
    login: {
      mount(ctx: WebUiPanelContext) {
        const { ui } = ctx;
        const card = ui.sheet({ title: 'B站扫码登录', en: 'Bilibili QR login' });
        const status = ui.msgline('正在读取登录状态…');
        const qr = document.createElement('img');
        qr.alt = 'B站登录二维码';
        qr.style.cssText = 'display:none;width:220px;height:220px;margin:12px auto;border-radius:8px;background:#fff;padding:8px';
        const hint = ui.msgline('登录后可以读取未脱敏的观众昵称。凭证只保存在 Coopanion 的秘密存储中。');
        const bar = ui.rowbar();
        const start = ui.button('生成二维码', { variant: 'primary', size: 'sm', onClick: () => { void invoke('start'); } });
        const cancel = ui.button('取消', { size: 'sm', onClick: () => { void invoke('cancel'); } });
        const logout = ui.button('退出登录', { size: 'sm', onClick: () => { void invoke('logout'); } });
        bar.append(start, cancel, logout);
        card.body.append(status, qr, hint, bar);
        ctx.root.appendChild(card.el);

        let lastUrl = '';
        const render = async (state: LoginState) => {
          start.disabled = state.phase === 'waiting' || state.phase === 'scanned';
          cancel.disabled = state.phase !== 'waiting' && state.phase !== 'scanned';
          logout.disabled = !state.configured;
          const labels: Record<LoginState['phase'], string> = {
            idle: state.configured ? '已登录；弹幕连接使用登录身份。' : '未登录，当前为匿名连接。',
            waiting: '请使用哔哩哔哩客户端扫描二维码。',
            scanned: '已扫码，请在手机上确认登录。',
            done: `登录成功${state.uid ? `（UID ${state.uid}）` : ''}，正在重连弹幕。`,
            expired: '二维码已过期，请重新生成。',
            failed: `登录失败：${state.error ?? '未知错误'}`,
          };
          status.textContent = labels[state.phase];
          if (state.url && state.url !== lastUrl) {
            lastUrl = state.url;
            qr.src = await QRCode.toDataURL(state.url, { width: 220, margin: 1, errorCorrectionLevel: 'M' });
          }
          qr.style.display = state.url ? 'block' : 'none';
        };
        const invoke = async (method: 'state' | 'start' | 'cancel' | 'logout') => {
          try { await render(await ctx.invoke<LoginState>(method)); }
          catch (error) { status.textContent = `登录操作失败：${String(error)}`; status.classList.add('bad'); }
        };
        void invoke('state');
        ctx.interval(() => { void invoke('state'); }, 2000);
      },
    },
  },
};

export default bundle;
