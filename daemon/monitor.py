#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH cookie 库清理器（launchd 常驻）。

背景：DSH 桌面版每次启动都会签发一条 dsh-auth-<sha256(host:port)> cookie，端口
随机，所以名字每次都不同；cookie 30 天过期，但桌面壳从不主动清理。攒到 72 条
左右，请求头就超过 16KB，下次启动报 "Web authentication failed"（431）。

做法：盯住 DSH 进程，等它「完全退出」并持续若干秒后，先备份、再删掉 Electron
默认 session 的 cookie 库（Cookies / Cookies-journal）。下次启动只会重新签发
一条，永远碰不到阈值。只动本地 web 认证库，不碰 ~/.dsh 里的会话和账号。

默认路径都能用参数覆盖，插件安装时会把实际路径写进 launchd 配置。
"""

import argparse
import datetime
import os
import shutil
import signal
import subprocess
import sys
import time

APP_HOME = os.path.expanduser("~/Library/Application Support/@deepseek-ai/dsh-desktop")
DEFAULT_DB = os.path.join(APP_HOME, "Cookies")
DEFAULT_SINGLETON = os.path.join(APP_HOME, "SingletonLock")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BACKUP = os.path.join(BASE_DIR, "backups")
DEFAULT_LOG = os.path.join(BASE_DIR, "monitor.log")

APP_MARK = "DeepSeek Harness.app/Contents/"
LOG_MAX_BYTES = 512 * 1024
SQLITE = "/usr/bin/sqlite3"

_RUNNING = True


def _stop(_signum, _frame):
    global _RUNNING
    _RUNNING = False


def rotate_log(logfile):
    """日志超过 512KB 就只留一个 .1，避免常驻进程把盘写满。"""
    try:
        if os.path.getsize(logfile) <= LOG_MAX_BYTES:
            return
        shutil.move(logfile, logfile + ".1")
    except OSError:
        pass


def log(msg, logfile=DEFAULT_LOG):
    line = "[%s] %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    try:
        rotate_log(logfile)
        with open(logfile, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def ps_entries():
    """返回 [(pid, args)]；ps 不可用或被拒时返回 None。"""
    try:
        out = subprocess.run(
            ["/bin/ps", "-axo", "pid=,args="],
            capture_output=True, text=True, timeout=15,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    entries = []
    for line in out.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        try:
            entries.append((int(parts[0]), parts[1]))
        except ValueError:
            continue
    return entries


def app_pids(app_mark=APP_MARK):
    entries = ps_entries()
    if entries is None:
        return None
    me = os.getpid()
    # 排除自己：守护进程的 argv 里可能就带着 --app-mark，匹配到自己会永远以为 DSH 在跑
    return [pid for pid, args in entries if pid != me and app_mark in args]


def singleton_pid(singleton):
    try:
        return int(os.readlink(singleton).rsplit("-", 1)[-1])
    except (OSError, ValueError):
        return None


def pid_alive(pid):
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def app_running(singleton, app_mark=APP_MARK):
    """返回 (running, notes, certain)。

    certain=False 表示证据不足（比如 ps 被拒、也没有 SingletonLock），这时调用方
    不能当「已退出」处理：删库是不可逆的，宁可这轮不清理。
    """
    notes = []
    pids = app_pids(app_mark)
    certain = True
    if pids is None:
        notes.append("ps 不可用")
        certain = False
    else:
        notes.append("ps 匹配 PID=%s" % (pids or "无"))
        if pids:
            return True, notes, True
    spid = singleton_pid(singleton)
    if spid is not None:
        alive = pid_alive(spid)
        notes.append("SingletonLock PID=%s alive=%s" % (spid, alive))
        # 拿到 lock 就是确定信号：活着在跑，死了就真退了
        return alive, notes, True
    notes.append("无 SingletonLock")
    return False, notes, certain


def cookie_count(db):
    """只读探测 cookie 条数；读不到返回 None。用 immutable 避免抢锁。"""
    if not os.path.exists(db):
        return None
    uri = "file:" + "/".join(_uri_seg(p) for p in db.split("/")) + "?immutable=1"
    try:
        out = subprocess.run(
            [SQLITE, uri, "select count(*) from cookies;"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    try:
        return int(out.stdout.strip())
    except ValueError:
        return None


def _uri_seg(seg):
    from urllib.parse import quote
    return quote(seg, safe="")


def rotate(backup_dir, keep):
    try:
        names = sorted(
            (d for d in os.listdir(backup_dir) if d.startswith("cookies-")),
            reverse=True,
        )
    except OSError:
        return
    for name in names[max(1, keep):]:
        shutil.rmtree(os.path.join(backup_dir, name), ignore_errors=True)


def cleanup(db, backup_dir, keep, logfile):
    journal = db + "-journal"
    if not (os.path.exists(db) or os.path.exists(journal)):
        log("没有 cookie 库，跳过", logfile)
        return {"cleaned": False, "reason": "no-db"}

    count = cookie_count(db)
    if count == 0:
        # 空库没有备份价值：直接删，省得备份目录堆满空文件。
        removed = []
        for src in (db, journal):
            try:
                os.remove(src)
                removed.append(os.path.basename(src))
            except FileNotFoundError:
                pass
            except OSError as exc:
                log("删除失败 %s: %s" % (src, exc), logfile)
        log("库内 0 条 cookie，直接删除（不备份）：%s" % removed, logfile)
        return {"cleaned": True, "reason": "empty", "removed": removed, "count": 0}

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = os.path.join(backup_dir, "cookies-" + stamp)
    os.makedirs(target, exist_ok=True)
    saved = []
    for src in (db, journal):
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(target, os.path.basename(src)))
            saved.append(os.path.basename(src))
    removed = []
    for src in (db, journal):
        try:
            os.remove(src)
            removed.append(os.path.basename(src))
        except FileNotFoundError:
            pass
        except OSError as exc:
            log("删除失败 %s: %s" % (src, exc), logfile)
    rotate(backup_dir, keep)
    log("已清理 %s 条：备份 %s → %s；删除 %s" % (count, saved, target, removed), logfile)
    return {"cleaned": True, "reason": "cleaned", "removed": removed, "backup": target, "count": count}


def build_parser():
    parser = argparse.ArgumentParser(description="DSH cookie 库清理器")
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--singleton", default=DEFAULT_SINGLETON)
    parser.add_argument("--backup-dir", default=DEFAULT_BACKUP)
    parser.add_argument("--log", default=DEFAULT_LOG)
    parser.add_argument("--grace-seconds", type=float, default=5.0)
    parser.add_argument("--poll-seconds", type=float, default=3.0)
    parser.add_argument("--keep-backups", type=int, default=3)
    parser.add_argument("--app-mark", default=APP_MARK, help="进程命令行里出现这个字符串就当 DSH 在跑（测试用）")
    parser.add_argument("--once", action="store_true", help="只做一次：DSH 在跑就退出 2，否则立刻清理")
    parser.add_argument("--version", action="version", version="dsh-cookie-cleaner 0.2.0")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.once:
        running, notes, certain = app_running(args.singleton, args.app_mark)
        if running:
            log("DSH 正在运行（%s），不清理：库被占用，删了也会被写回" % "; ".join(notes), args.log)
            return 2
        if not certain:
            log("判不准 DSH 是否已退出（%s），不清理" % "; ".join(notes), args.log)
            return 3
        os.makedirs(args.backup_dir, exist_ok=True)
        result = cleanup(args.db, args.backup_dir, args.keep_backups, args.log)
        return 0 if result["cleaned"] else 1

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    os.makedirs(args.backup_dir, exist_ok=True)
    log("常驻清理器启动 pid=%s（等待 DSH 退出）" % os.getpid(), args.log)

    last_running = time.time()
    last_unsure = 0.0
    while _RUNNING:
        running, notes, certain = app_running(args.singleton, args.app_mark)
        now = time.time()
        if running:
            last_running = now
        elif not certain:
            # 证据不足时不清理，最多每 5 分钟说一次，免得刷爆日志
            if now - last_unsure >= 300:
                log("判不准 DSH 是否已退出（%s），这轮跳过" % "; ".join(notes), args.log)
                last_unsure = now
        elif now - last_running >= args.grace_seconds and (
            os.path.exists(args.db) or os.path.exists(args.db + "-journal")
        ):
            log("检测到 DSH 已退出（%s），执行清理" % "; ".join(notes), args.log)
            cleanup(args.db, args.backup_dir, args.keep_backups, args.log)
            last_running = time.time()
        time.sleep(args.poll_seconds)

    log("常驻清理器退出", args.log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
