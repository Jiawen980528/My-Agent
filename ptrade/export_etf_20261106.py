"""Run in PTrade research Python or as a read-only strategy. No order functions.

After execution, download the two CSV files from PTrade's research file browser.
PTrade implementations vary; this script reports errors instead of fabricating bars.
"""
import csv
import datetime

DAY = '2026-11-06'
SYMBOLS = ('159558.SZ', '588080.SS')
COLUMNS = ('symbol', 'datetime', 'open', 'high', 'low', 'close', 'volume', 'amount', 'source')


def export():
    for symbol in SYMBOLS:
        # PTrade get_price uses an exclusive end_date per published API description.
        frame = get_price(symbol, start_date=DAY, end_date='2026-11-07',
                          frequency='1m', fields=['open', 'high', 'low', 'close', 'volume', 'money'],
                          fq=None, is_dict=False)
        if frame is None or not hasattr(frame, 'iterrows'):
            raise RuntimeError('PTrade get_price did not return a DataFrame for ' + symbol)
        path = 'PTrade_' + symbol.replace('.', '_') + '_' + DAY.replace('-', '') + '.csv'
        count = 0
        with open(path, 'w') as output:
            writer = csv.writer(output)
            writer.writerow(COLUMNS)
            for index, row in frame.iterrows():
                stamp = str(row.get('datetime', index))[:16].replace(' ', 'T')
                if not stamp.startswith(DAY) or stamp[11:16] < '09:30' or stamp[11:16] > '15:00':
                    continue
                if '11:30' < stamp[11:16] < '13:00':
                    continue
                writer.writerow([symbol, stamp + ':00+08:00', row['open'], row['high'],
                                 row['low'], row['close'], row['volume'], row['money'], 'PTrade'])
                count += 1
        print(symbol, path, count, 'rows; verify volume unit against PTrade client')


def initialize(context):
    pass


def after_trading_end(context):
    export()


# In the research console, paste this file and call export() manually.
