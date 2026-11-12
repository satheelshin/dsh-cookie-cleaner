# dsh-cookie-cleaner

![tests](https://github.com/satheelshin/dsh-cookie-cleaner/actions/workflows/test.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)
![platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

**DSH 桌面版用一阵子，某次启动就打不开了，报 `431` / `Web authentication failed`。这个包治这个。**

病因一句话：它每次启动都签一条新 cookie，旧的从来不删，攒到七十来条，请求头就撑过 16KB 了。

## 为什么会这样

DSH 桌面版启动时会签发一条 `dsh-auth-<sha256(host:port)>`，它的名字由端口算出来：

- 端口每次启动随机 → 名字每次都不一样；
- cookie 有效期 30 天，但桌面壳从不主动清理；
- 每多一条，`Cookie` 请求头就长一截，**约 72 条时超过 16KB**；
- 服务器直接返回 `431 Request Header Fields Too Large`，登录态失效。

手动清一遍 cookie 能好，但过一阵又犯。所以这里不修根因，只把后果兜住。

## 它做什么

装一个 launchd 常驻小守护。DSH **完全退出**若干秒后，它数一下库里有几条 cookie：

- 有条数 → 备份到 `~/.dsh/dsh-cookie-cleaner/backups/`（默认留最近 3 份），再删掉库里那两个文件；
- 0 条 → 直接删，不占备份空间。

下次启动只会重新签发 1 条，永远碰不到阈值。

| 组件 | 在哪 | 干什么 |
| --- | --- | --- |
| DSH 插件 | `index.js` + `lib/manager.mjs` | 安装、修复、卸载、诊断那个守护 |
| 常驻守护 | `daemon/monitor.py` | 等 DSH 退出，备份并清空 cookie 库 |

> [!NOTE]
> 插件自己**不能**清理。它活在 DSH 进程里，DSH 一退它就没了，而删除必须发生在退出之后——所以插件只当管理器，脏活交给 launchd。

## 安装

前置：macOS、已装 DSH 桌面版、系统自带 `python3`（没有就 `xcode-select --install`）。

**方式一：让 DSH 里的 agent 装**

> 用 plugin_manager 装这个仓库：https://github.com/satheelshin/dsh-cookie-cleaner

**方式二：手动加进 profile**

```bash
cd ~/.dsh/profiles/<你的 profile 名>
pnpm add https://codeload.github.com/satheelshin/dsh-cookie-cleaner/tar.gz/refs/heads/main
```

再把 `dsh-cookie-cleaner` 加进 `package.json` 的 `dsh.profile.bundles` 数组，重启 DSH。

装完之后调一次 `cookie_cleaner_install`。重复执行等于修复，不会重复加载。

## 工具

| 工具 | 干什么 | 参数 |
| --- | --- | --- |
| `cookie_cleaner_status` | 守护加载没、cookie 几条、备份几份、最近日志 | — |
| `cookie_cleaner_install` | 写守护脚本 + launchd plist 并加载 | `keepBackups` / `graceSeconds` / `pollSeconds` |
| `cookie_cleaner_uninstall` | 停掉并移除守护与 plist | `purge`（连备份一起删） |
| `cookie_cleaner_log` | 看最近清理记录 | `lines` |

`install` 三个参数的范围：`keepBackups` 1–20（默认 3）、`graceSeconds` 1–600（默认 5）、`pollSeconds` 1–60（默认 3）。

## 怎么确认它在起作用

```text
✅ 常驻守护：已加载（state = running）
✅ cookie 条数：1　|　库大小：20.0 KB　|　最后写入：2026-11-12T10:06:05.937Z
📦 备份：保留 3 份（最新 cookies-20261108-224515，20.0 KB）
🧾 最近日志：
   [2026-11-08 22:45:15] 检测到 DSH 已退出，执行清理
   [2026-11-08 22:45:15] 已清理 3 条：备份 ['Cookies'] → ...；删除 ['Cookies']
```

条数长期停在 1–2 条就是好的。要是每次看都在涨，说明守护没跑起来，先看 `cookie_cleaner_status` 第二行的警告。

## 出问题的时候

| 症状 | 先做什么 |
| --- | --- |
| 报“未加载” | 跑 `cookie_cleaner_install` 重装；还不行看 `~/Library/LaunchAgents/com.deepseek.dsh-cookie-cleaner.plist` 在不在 |
| 报“python3 不可执行” | `xcode-select --install`，装完重装插件 |
| 条数一直涨 | 看 `cookie_cleaner_log` 有没有清理记录；没有就是守护没起来 |
| 日志说“判不准” | `ps` 被系统或安全软件拦了，又没有 `SingletonLock`；这时守护会**选择不清理**，见下 |

## 卸载

```bash
launchctl bootout gui/$(id -u)/com.deepseek.dsh-cookie-cleaner
rm -f ~/Library/LaunchAgents/com.deepseek.dsh-cookie-cleaner.plist
rm -rf ~/.dsh/dsh-cookie-cleaner
```

或者先调 `cookie_cleaner_uninstall`，再删插件。

## 它不做什么

- **不联网**，不读账号，不碰 `~/.dsh` 里的会话、配置和模型设置。
- **不修根因**。每次启动签新 cookie 是上游行为，这里只是定期清场。
- **不能只删 `dsh-auth` 那几条**。Electron 没有对外接口，只能整库删；代价是这个应用内其它网页登录态会一起掉（DSH 自己会重新签发，不影响使用）。
- 备份里是 cookie 库的副本，放在 `~/.dsh/dsh-cookie-cleaner/backups/`，别提交到公开仓库。本仓库 `.gitignore` 已排掉。

## 局限

- 只在 macOS 上工作（launchd）。其它平台 `cookie_cleaner_status` 会直接说“不支持”。
- 清理只发生在 DSH 退出之后。运行中库被占用，删了也会被写回。
- **判不准就不动**：`ps` 不可用、又没有 `SingletonLock` 时，守护宁可这一轮不清理，也不会赌一把把库删了。跳过会写日志，最多每 5 分钟一条。

## 开发

```bash
node --test                          # 21 项：路径/plist/条数探测、安装/重装/卸载、插件注册、端到端守护
/usr/bin/python3 test/test_daemon.py # 11 项：清理、备份轮换、运行中拒绝、判不准拒绝
```

测试全部用假 HOME、假 `launchctl`、临时 cookie 库，不碰真实环境。CI 在 Ubuntu 和 macOS 两个 runner 上各跑一遍（见 badge）。

## English

The DSH desktop app signs a new `dsh-auth-<hash>` cookie on every launch and never removes old ones; around 72 of them the request header passes 16 KB and startup fails with HTTP 431. This package installs a macOS launchd daemon that backs up and clears the app's cookie database after DSH fully exits, plus a DSH plugin that installs, inspects, repairs, and removes that daemon. The plugin cannot do the cleanup itself: it runs inside the DSH process and dies with it, while deletion has to happen afterwards. If the daemon cannot prove DSH is gone (`ps` denied and no `SingletonLock`), it skips the round instead of guessing — a missed cleanup is recoverable, a wrong deletion is not. macOS only. All cookies in that database are cleared, not just `dsh-auth`; no network access.

## License

MIT
