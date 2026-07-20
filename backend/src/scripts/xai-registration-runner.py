#!/usr/bin/env python3
"""Isolated Grok registration runner used by AccountHub."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


EVENT_PREFIX = "@@ACCOUNTHUB_EVENT@@"


def emit_event(event_type: str, **data) -> None:
    payload = {"type": event_type, **data}
    print(f"{EVENT_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True)


def read_options(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        options = json.load(handle)
    try:
        path.unlink()
    except OSError:
        pass
    return options


def copy_registration_engine(source: Path, destination: Path) -> None:
    ignored_names = {
        ".env",
        ".git",
        ".venv",
        "__pycache__",
        "accounts_cli.txt",
        "config.json",
        "cookies",
        "cpa_auths",
        "emails_error.txt",
        "emails_used.txt",
        "screenshots",
    }

    def ignore(_directory: str, names: list[str]) -> set[str]:
        return {name for name in names if name in ignored_names or name.endswith(".pyc")}

    shutil.copytree(source, destination, ignore=ignore)


def build_engine_config(options: dict, engine_dir: Path) -> dict:
    email = options.get("email") or {}
    cloudflare = email.get("cloudflare") or {}
    cloudmail = email.get("cloudmail") or {}
    hotmail = email.get("hotmail") or {}
    config = {
        "email_provider": email.get("provider", "cloudmail"),
        "defaultDomains": email.get("domains", ""),
        "proxy": options.get("proxy", ""),
        "enable_nsfw": bool(options.get("enableNsfw", True)),
        "register_count": int(options.get("count", 1)),
        "register_threads": int(options.get("threads", 1)),
        "show_tutorial_on_start": False,
        "grok2api_auto_add_local": False,
        "grok2api_auto_add_remote": False,
        "cpa_export_enabled": False,
        "cpa_mint_workers": 0,
        "cloudmail_url": cloudmail.get("url", ""),
        "cloudmail_admin_email": cloudmail.get("adminEmail", ""),
        "cloudmail_password": cloudmail.get("password", ""),
        "cloudflare_api_base": cloudflare.get("apiBase", ""),
        "cloudflare_api_key": cloudflare.get("apiKey", ""),
        "cloudflare_auth_mode": cloudflare.get("authMode", "bearer"),
        "cloudflare_path_domains": cloudflare.get("pathDomains", "/domains"),
        "cloudflare_path_accounts": cloudflare.get("pathAccounts", "/accounts"),
        "cloudflare_path_token": cloudflare.get("pathToken", "/token"),
        "cloudflare_path_messages": cloudflare.get("pathMessages", "/messages"),
        "duckmail_api_key": (email.get("duckmail") or {}).get("apiKey", ""),
        "yyds_api_key": (email.get("yyds") or {}).get("apiKey", ""),
        "yyds_jwt": (email.get("yyds") or {}).get("jwt", ""),
    }
    if options.get("userAgent"):
        config["user_agent"] = options["userAgent"]

    credentials = str(hotmail.get("accounts", "") or "").strip()
    if credentials:
        credentials_path = engine_dir / "mail_credentials.txt"
        credentials_path.write_text(credentials + "\n", encoding="utf-8")
        os.chmod(credentials_path, 0o600)
        config["hotmail_accounts_file"] = str(credentials_path)

    return config


def stream_command(args: list[str], cwd: Path, on_line=None) -> int:
    process = subprocess.Popen(
        args,
        cwd=str(cwd),
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.rstrip("\r\n")
        if line:
            print(line, flush=True)
            if on_line:
                on_line(line)
    return process.wait()


def parse_accounts(path: Path) -> list[dict]:
    if not path.exists():
        return []
    accounts = []
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("----", 2)
        if len(parts) != 3:
            continue
        email, password, sso = (part.strip() for part in parts)
        if email and sso:
            accounts.append({"email": email, "password": password, "sso": sso})
    return accounts


def run_registration(options: dict, engine_dir: Path, accounts_path: Path) -> tuple[int, dict]:
    progress = {"registered": 0, "registrationFailed": 0}

    def handle_line(line: str) -> None:
        if "+ 注册成功:" in line:
            progress["registered"] += 1
            emit_event("progress", stage="registering", **progress)
            return
        summary = re.search(r"注册成功\s+(\d+).*注册失败\s+(\d+)", line)
        if summary:
            progress["registered"] = int(summary.group(1))
            progress["registrationFailed"] = int(summary.group(2))
            emit_event("progress", stage="registering", **progress)

    command = [
        sys.executable,
        "-u",
        str(engine_dir / "register_cli.py"),
        "--extra",
        str(options.get("count", 1)),
        "--threads",
        str(options.get("threads", 1)),
        "--mint-workers",
        "0",
        "--accounts-file",
        str(accounts_path),
    ]
    if not options.get("fastMode", True):
        command.append("--no-fast")
    if not options.get("browserReuse", True):
        command.append("--no-browser-reuse")

    emit_event("stage", stage="registering")
    return stream_command(command, engine_dir, handle_line), progress


def run_conversion(
    accounts: list[dict],
    converter_script: Path,
    task_dir: Path,
    proxy: str,
) -> tuple[int, int, list[str]]:
    auth_dir = task_dir / "auths"
    auth_dir.mkdir(parents=True, exist_ok=True)
    converted = 0
    failed = 0

    emit_event("stage", stage="converting")
    for index, account in enumerate(accounts, 1):
        input_path = task_dir / f".convert-{index}.txt"
        input_path.write_text(
            f"{account['email']}----{account['password']}----{account['sso']}\n",
            encoding="utf-8",
        )
        os.chmod(input_path, 0o600)
        command = [
            sys.executable,
            "-u",
            str(converter_script),
            "--sso",
            str(input_path),
            "--email",
            account["email"],
            "--cpa-auth-dir",
            str(auth_dir),
        ]
        if proxy:
            command.extend(["--proxy", proxy])

        print(f"[AccountHub] Converting OAuth JSON {index}/{len(accounts)}: {account['email']}", flush=True)
        exit_code = stream_command(command, converter_script.parent)
        try:
            input_path.unlink()
        except OSError:
            pass

        if exit_code == 0:
            converted += 1
        else:
            failed += 1
        emit_event(
            "progress",
            stage="converting",
            registered=len(accounts),
            converted=converted,
            conversionFailed=failed,
        )

    files = sorted(path.name for path in auth_dir.glob("xai-*.json"))
    return converted, failed, files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-dir", required=True)
    parser.add_argument("--register-engine", required=True)
    parser.add_argument("--converter-script", required=True)
    parser.add_argument("--options-file", required=True)
    args = parser.parse_args()

    task_dir = Path(args.task_dir).resolve()
    register_source = Path(args.register_engine).resolve()
    converter_script = Path(args.converter_script).resolve()
    options_path = Path(args.options_file).resolve()
    engine_dir = task_dir / "registration-engine"
    accounts_path = task_dir / "accounts.txt"

    options = read_options(options_path)
    emit_event("stage", stage="preparing")
    copy_registration_engine(register_source, engine_dir)
    config = build_engine_config(options, engine_dir)
    config_path = engine_dir / "config.json"
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(config_path, 0o600)

    registration_code, registration_progress = run_registration(options, engine_dir, accounts_path)
    accounts = parse_accounts(accounts_path)

    try:
        accounts_path.unlink()
    except OSError:
        pass
    shutil.rmtree(engine_dir, ignore_errors=True)

    if not accounts:
        emit_event(
            "result",
            registered=0,
            registrationFailed=max(
                int(registration_progress.get("registrationFailed", 0)),
                int(options.get("count", 1)),
            ),
            converted=0,
            conversionFailed=0,
            authFiles=[],
        )
        return registration_code or 1

    converted, conversion_failed, auth_files = run_conversion(
        accounts,
        converter_script,
        task_dir,
        str(options.get("proxy", "") or ""),
    )
    emit_event(
        "result",
        registered=len(accounts),
        registrationFailed=int(registration_progress.get("registrationFailed", 0)),
        converted=converted,
        conversionFailed=conversion_failed,
        authFiles=auth_files,
    )
    return 0 if converted > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
