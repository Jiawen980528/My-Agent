"""Windows-side PTrade CSV uploader; asks only for TickFlow website password.

Usage: py upload_csv_windows.py PTrade_159558_SZ_20261106.csv
No brokerage account credentials are used or saved.
"""
import getpass
import http.cookiejar
import json
import pathlib
import sys
import urllib.request

BASE = 'https://agent.xdailab.com/quant/api'


def main():
    if len(sys.argv) != 2:
        raise SystemExit('用法: py upload_csv_windows.py <PTrade导出的CSV文件>')
    path = pathlib.Path(sys.argv[1]).resolve()
    raw = path.read_bytes()
    if len(raw) > 300000:
        raise SystemExit('CSV 超过 300 KB')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    password = getpass.getpass('量化网站访问密码（不是券商账户密码）: ')
    login = urllib.request.Request(BASE + '/auth/login',
        data=json.dumps({'password': password}).encode('utf-8'),
        headers={'Content-Type': 'application/json'}, method='POST')
    del password
    with opener.open(login, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError('量化网站登录失败')
    upload = urllib.request.Request(BASE + '/myagent/ptrade/etf-minute/import', data=raw,
        headers={'Content-Type': 'text/csv'}, method='POST')
    with opener.open(upload, timeout=30) as response:
        result = json.load(response)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
