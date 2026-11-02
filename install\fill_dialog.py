#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""首次安装第 2 步：填 ego 的「扩展程序目录」原生文件夹对话框。

用法：python fill.py "<扩展目录绝对路径>" [等待秒数]

只在 ego 窗口处于当前登录桌面时有效；SSH / 无桌面会话拿不到这个对话框。
"""
import ctypes
import ctypes.wintypes as w
import csv
import io
import os
import subprocess
import sys
import time

u = ctypes.windll.user32
EP = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
SMTO = 0x0002
WM_GETTEXT, WM_SETTEXT, BM_CLICK = 0x000D, 0x000C, 0x00F5

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def ego_pids():
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq ego.exe", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, encoding="gbk", errors="replace",
    ).stdout
    pids = set()
    for row in csv.reader(io.StringIO(out)):
        if len(row) > 1:
            try:
                pids.add(int(row[1]))
            except ValueError:
                pass
    return pids


def text(h, n=800):
    b = ctypes.create_unicode_buffer(n)
    u.SendMessageTimeoutW(h, WM_GETTEXT, n, ctypes.cast(b, ctypes.c_void_p), SMTO, 800, None)
    return b.value


def dialogs():
    res, pids = [], ego_pids()

    def cb(h, l):
        if not u.IsWindowVisible(h):
            return True
        c = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(h, c, 256)
        if c.value != "#32770":
            return True
        pid = w.DWORD()
        u.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value not in pids:
            return True
        res.append(h)
        return True

    u.EnumWindows(EP(cb), 0)
    return res


def kids(dlg, want=("Edit", "Button")):
    out = []

    def cb(h, l):
        c = ctypes.create_unicode_buffer(128)
        u.GetClassNameW(h, c, 128)
        if c.value in want:
            out.append((h, c.value, u.GetDlgCtrlID(h), text(h)))
        return True

    u.EnumChildWindows(dlg, EP(cb), 0)
    return out


def fill(path, secs):
    end = time.time() + secs
    while time.time() < end:
        ds = dialogs()
        if ds:
            d = ds[0]
            rows = kids(d)
            edits = [r for r in rows if r[1] == "Edit" and u.IsWindowVisible(r[0])]
            if not edits:
                time.sleep(0.3)
                continue
            e = next((r for r in edits if r[2] in (1152, 1148)), edits[0])
            u.SendMessageTimeoutW(e[0], WM_SETTEXT, 0, ctypes.c_wchar_p(path), SMTO, 1500, None)
            time.sleep(0.4)
            if text(e[0]) != path:
                time.sleep(0.3)
                continue
            btn = next((r for r in rows if r[1] == "Button" and (r[2] == 1 or "选择文件夹" in r[3])), None)
            if not btn:
                time.sleep(0.3)
                continue
            u.PostMessageW(btn[0], BM_CLICK, 0, 0)
            time.sleep(2.5)
            print("OK " + path)
            return 0
        time.sleep(0.4)
    print("NO_DIALOG")
    return 2


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python fill.py <ext-dir> [seconds]")
        sys.exit(1)
    target = os.path.abspath(sys.argv[1])
    secs = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    sys.exit(fill(target, secs))
