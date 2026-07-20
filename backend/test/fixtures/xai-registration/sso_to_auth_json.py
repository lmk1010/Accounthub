#!/usr/bin/env python3

import argparse
import json
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("--sso", required=True)
parser.add_argument("--email", required=True)
parser.add_argument("--cpa-auth-dir", required=True)
parser.add_argument("--proxy", default="")
args = parser.parse_args()

auth_dir = Path(args.cpa_auth_dir)
auth_dir.mkdir(parents=True, exist_ok=True)
record = {
    "type": "xai",
    "auth_kind": "oauth",
    "email": args.email,
    "access_token": f"access-{args.email}",
    "refresh_token": f"refresh-{args.email}",
    "base_url": "https://cli-chat-proxy.grok.com/v1",
}
output = auth_dir / f"xai-{args.email}.json"
output.write_text(json.dumps(record), encoding="utf-8")
print(f"generated {output.name}", flush=True)
