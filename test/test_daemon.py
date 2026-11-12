#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""守护脚本的单测：只碰临时目录，不删真实 cookie 库。"""

import importlib.util
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("monitor", os.path.join(ROOT, "daemon", "monitor.py"))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)

SQLITE = "/usr/bin/sqlite3"


def make_db(path, count):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE cookies (host_key TEXT, name TEXT, expires_utc INTEGER)")
    for i in range(count):
        conn.execute("INSERT INTO cookies VALUES ('localhost', ?, 0)", ("dsh-auth-%d" % i,))
    conn.commit()
    conn.close()
    return path


class CleanupTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="dsh-cookie-py-")
        self.db = os.path.join(self.home, "dsh-desktop", "Cookies")
        self.backups = os.path.join(self.home, "backups")
        self.log = os.path.join(self.home, "monitor.log")
        os.makedirs(self.backups, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def test_counts_cookies_readonly(self):
        make_db(self.db, 4)
        self.assertEqual(monitor.cookie_count(self.db), 4)

    def test_missing_db_returns_none(self):
        self.assertIsNone(monitor.cookie_count(self.db))

    def test_zero_cookies_deleted_without_backup(self):
        make_db(self.db, 0)
        result = monitor.cleanup(self.db, self.backups, 3, self.log)
        self.assertTrue(result["cleaned"])
        self.assertEqual(result["reason"], "empty")
        self.assertFalse(os.path.exists(self.db))
        self.assertEqual(os.listdir(self.backups), [])

    def test_cookies_backed_up_then_removed(self):
        make_db(self.db, 6)
        result = monitor.cleanup(self.db, self.backups, 3, self.log)
        self.assertEqual(result["reason"], "cleaned")
        self.assertFalse(os.path.exists(self.db))
        saved = os.listdir(self.backups)
        self.assertEqual(len(saved), 1)
        self.assertTrue(os.path.exists(os.path.join(self.backups, saved[0], "Cookies")))

    def test_missing_db_is_noop(self):
        result = monitor.cleanup(self.db, self.backups, 3, self.log)
        self.assertFalse(result["cleaned"])
        self.assertEqual(result["reason"], "no-db")

    def test_rotate_keeps_newest(self):
        for i in range(5):
            os.makedirs(os.path.join(self.backups, "cookies-2026010%d-000000" % i))
        monitor.rotate(self.backups, 2)
        left = sorted(os.listdir(self.backups))
        self.assertEqual(left, ["cookies-20260103-000000", "cookies-20260104-000000"])

    def test_app_running_uses_ps_hits(self):
        original = monitor.ps_entries
        monitor.ps_entries = lambda: [(123, "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness")]
        try:
            running, notes, certain = monitor.app_running("/nonexistent/SingletonLock")
        finally:
            monitor.ps_entries = original
        self.assertTrue(running)
        self.assertTrue(certain)
        self.assertTrue(any("ps" in n for n in notes))

    def test_app_pids_ignores_self(self):
        original = monitor.ps_entries
        me = os.getpid()
        monitor.ps_entries = lambda: [(me, "python3 monitor.py --app-mark MAGIC"), (4242, "python3 worker --app-mark MAGIC")]
        try:
            pids = monitor.app_pids("MAGIC")
        finally:
            monitor.ps_entries = original
        self.assertEqual(pids, [4242])

    def test_app_running_falls_back_to_singleton(self):
        original = monitor.ps_entries
        monitor.ps_entries = lambda: []
        link = os.path.join(self.home, "SingletonLock")
        os.symlink("host-%d" % os.getpid(), link)
        try:
            running, _, certain = monitor.app_running(link)
        finally:
            monitor.ps_entries = original
        self.assertTrue(running)
        self.assertTrue(certain)

    def test_app_running_uncertain_without_ps_or_lock(self):
        original = monitor.ps_entries
        monitor.ps_entries = lambda: None
        try:
            running, notes, certain = monitor.app_running(os.path.join(self.home, "no-lock"))
        finally:
            monitor.ps_entries = original
        self.assertFalse(running)
        self.assertFalse(certain, "ps 不可用又没 lock 时必须承认判不准")
        self.assertTrue(any("ps 不可用" in n for n in notes))

    def test_once_refuses_when_uncertain(self):
        make_db(self.db, 2)
        original = monitor.app_running
        monitor.app_running = lambda _s, _m: (False, ["ps 不可用", "无 SingletonLock"], False)
        try:
            code = monitor.main([
                "--once",
                "--db", self.db,
                "--singleton", os.path.join(self.home, "nope"),
                "--backup-dir", self.backups,
                "--log", self.log,
            ])
        finally:
            monitor.app_running = original
        self.assertEqual(code, 3)
        self.assertTrue(os.path.exists(self.db), "判不准时不许动库")

    def test_once_refuses_while_running(self):
        make_db(self.db, 2)
        original = monitor.app_running
        monitor.app_running = lambda _s, _m: (True, ["ps 匹配 PID=[1]"], True)
        try:
            code = monitor.main([
                "--once",
                "--db", self.db,
                "--singleton", os.path.join(self.home, "nope"),
                "--backup-dir", self.backups,
                "--log", self.log,
            ])
        finally:
            monitor.app_running = original
        self.assertEqual(code, 2)
        self.assertTrue(os.path.exists(self.db), "DSH 在跑时不许动库")


if __name__ == "__main__":
    unittest.main(verbosity=2)
