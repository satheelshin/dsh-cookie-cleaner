# dsh-cookie-cleaner

给 DSH 桌面版清掉越攒越多的 `dsh-auth` cookie，治启动时那个
`Web authentication failed`（HTTP 431）。

一个包，两种东西：

- **DSH 插件**（本仓库根目录）：安装 / 修复 / 卸载 / 诊断那个常驻守护；
- **launchd 常驻小守护**（`daemon/monitor.py`）：DSH 完全退出后，先备份、再清空 cookie 库。

只支持 **macOS**。

---

## 它治的是什么

DSH 桌面版每次启动都会签发一条 `dsh-auth-<sha256(host:port)>` cookie：

- 端口每次启动随机 → cookie 名字每次都不同；
- 有效期 30 天，但桌面壳从不主动清理；
- 攒到 **72 条左右**，请求头就超过 16KB，下次启动直接 431。

结果就是：用一阵子突然打不开，清一遍 cookie 又能用，过一阵再犯。

## 它怎么治

守护进程盯住 DSH 进程。检测到它**完全退出**并持续若干秒后：

1. 数一下库里有多少条 cookie；
2. 有条数 → 备份到 `~/.dsh/dsh-cookie-cleaner/backups/`（默认只留最近 3 份）；
3. 删掉 `Cookies` 和 `Cookies-journal`；
4. 0 条 → 直接删，不占备份空间。

下次启动只会重新签发 1 条，永远碰不到阈值。

**为什么不让插件自己干？** 插件活在 DSH 进程里，DSH 一退它也没了；而删除必须发生在退出之后。所以插件只当管理器，脏活交给 launchd 守护——谁也别假装自己能干这件事。

## 安装

要求：macOS + 已装 DSH 桌面版 + `/usr/bin/python3`（系统自带，装了 Command Line Tools 就有）。

### 方式一：让 DSH 里的 agent 装

在 DSH 里说：

> 用 plugin_manager 装这个仓库：https://github.com/satheelshin/dsh-cookie-cleaner

插件的安装方式由 DSH 的 bundle 机制决定；如果面板里没出现，往方式二退。

### 方式二：手动加进 profile

```bash
cd ~/.dsh/profiles/<你的 profile 名>
pnpm add https://codeload.github.com/satheelshin/dsh-cookie-cleaner/tar.gz/refs/heads/main
```

然后把 `dsh-cookie-cleaner` 加进 `package.json` 的 `dsh.profile.bundles` 数组，重启 DSH。
（`fishtalk` 就是这么装的，机制一样。）

### 装完做什么

在 DSH 里说一句「装一下 cookie 清理器」，或者直接调工具 `cookie_cleaner_install`。

## 工具

| 工具 | 干什么 |
| --- | --- |
| `cookie_cleaner_status` | 守护加载没、cookie 现在几条、备份几份、最近日志 |
| `cookie_cleaner_install` | 写入守护脚本 + launchd plist 并加载；重复执行等于修复 |
| `cookie_cleaner_uninstall` | 停掉并移除守护与 plist；默认保留备份，`purge` 才一起删 |
| `cookie_cleaner_log` | 看最近清理记录（什么时候清的、清了几条、备份到哪） |

`install` 可调：`keepBackups`（1–20，默认 3）、`graceSeconds`（1–600，默认 5）、`pollSeconds`（1–60，默认 3）。

## 不用插件，手跑一次

DSH 已经退出时：

```bash
/usr/bin/python3 daemon/monitor.py --once
```

DSH 还在跑时会拒绝执行并返回码 2——库被占用，删了也会被写回。

## 卸载

```bash
launchctl bootout gui/$(id -u)/com.deepseek.dsh-cookie-cleaner
rm -f ~/Library/LaunchAgents/com.deepseek.dsh-cookie-cleaner.plist
rm -rf ~/.dsh/dsh-cookie-cleaner
```

或者调 `cookie_cleaner_uninstall`（先），再删插件。

## 碰哪些文件

- 读 / 删：`~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies`（和 `Cookies-journal`）
- 写：`~/.dsh/dsh-cookie-cleaner/`（守护脚本、日志、备份）
- 写：`~/Library/LaunchAgents/com.deepseek.dsh-cookie-cleaner.plist`
- 不联网；不读账号；不碰 `~/.dsh` 里的会话记录

备份里是 cookie 库的副本，**别提交到公开仓库**。本仓库的 `.gitignore` 已经排掉 `backups/` 和日志。

## 限制

- 只在 macOS 上工作（launchd）；其他平台 `status` 会直接说明不支持。
- 清理只发生在 DSH 退出之后，运行中永远读得到、删不动。
- 库被占用或权限不对时，读不到条数就如实显示「读不到」，不猜。
- 正常退出和崩溃退出都会触发（检测的是进程消失），这是有意的。

## 开发

```bash
node --test          # 15 项：路径生成、plist、条数探测、安装/重装/卸载、插件注册
/usr/bin/python3 test/test_daemon.py   # 9 项：清理、备份轮换、运行中拒绝清理
```

测试全部用假 HOME + 假 `launchctl`，不会碰真实 cookie 库和真实 launchd。

## English summary

The DSH desktop app signs a new `dsh-auth-<host:port hash>` cookie on every launch and never removes old ones; around 72 of them the request header exceeds 16 KB and startup fails with HTTP 431. This package ships a macOS launchd daemon that backs up and clears the cookie database after DSH fully exits, plus a DSH plugin with four tools to install, inspect, repair, and remove that daemon. The plugin cannot do the cleanup itself: it lives inside the DSH process and dies with it, while the deletion has to happen afterwards. macOS only. No network access; it only touches the app's cookie database, `~/.dsh/dsh-cookie-cleaner/`, and one LaunchAgent plist.

## License

MIT
