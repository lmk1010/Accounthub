#!/usr/bin/env python3

import argparse
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("--extra", type=int, default=1)
parser.add_argument("--threads")
parser.add_argument("--mint-workers")
parser.add_argument("--accounts-file", required=True)
parser.add_argument("--no-fast", action="store_true")
parser.add_argument("--no-browser-reuse", action="store_true")
args = parser.parse_args()

output = Path(args.accounts_file)
lines = [
    f"user{index}@example.com----password-{index}----fake-sso-{index}"
    for index in range(1, args.extra + 1)
]
output.write_text("\n".join(lines) + "\n", encoding="utf-8")
for index in range(1, args.extra + 1):
    print(f"[W1] + registered: user{index}@example.com", flush=True)
print(f"=== complete: registered {args.extra}, failed 0 ===", flush=True)
