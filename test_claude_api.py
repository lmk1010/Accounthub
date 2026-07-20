#!/usr/bin/env python3
"""测试 Claude API 代理是否符合官方标准协议"""

import json
import requests

BASE_URL = "https://yunyi.rdzhvip.com/claude"
API_KEY = "WXXMH085-7RZS-T1A1-PMV5-UK2748HKPWBV"
MODEL = "claude-sonnet-4-20250514"

HEADERS = {
    "x-api-key": API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
}

def sep(title):
    print(f"\n{'='*60}\n  {title}\n{'='*60}")

# ── 测试1: 普通对话 ──
def test_basic_message():
    sep("测试1: 基础对话 (非流式)")
    resp = requests.post(f"{BASE_URL}/v1/messages", headers=HEADERS, json={
        "model": MODEL,
        "max_tokens": 128,
        "messages": [{"role": "user", "content": "说一句话证明你是Claude"}],
    }, timeout=30)
    print(f"Status: {resp.status_code}")
    data = resp.json()
    print(json.dumps(data, indent=2, ensure_ascii=False))

    # 校验字段
    checks = {
        "id 存在": data.get("id", "").startswith("msg_"),
        "type=message": data.get("type") == "message",
        "role=assistant": data.get("role") == "assistant",
        "model 存在": bool(data.get("model")),
        "content 是 list": isinstance(data.get("content"), list),
        "stop_reason 存在": data.get("stop_reason") is not None,
        "usage 存在": isinstance(data.get("usage"), dict),
    }
    for k, v in checks.items():
        print(f"  {'✅' if v else '❌'} {k}")
    return all(checks.values())

# ── 测试2: 流式 ──
def test_streaming():
    sep("测试2: 流式对话")
    resp = requests.post(f"{BASE_URL}/v1/messages", headers=HEADERS, json={
        "model": MODEL,
        "max_tokens": 128,
        "stream": True,
        "messages": [{"role": "user", "content": "用一句话介绍自己"}],
    }, stream=True, timeout=30)
    print(f"Status: {resp.status_code}")

    event_types = []
    for line in resp.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            if line and line.startswith("event: "):
                event_types.append(line[7:].strip())
            continue
        payload = line[6:]
        if payload.strip() == "[DONE]":
            break
        try:
            obj = json.loads(payload)
            print(f"  event={obj.get('type', '?')}", end="")
            if obj.get("type") == "content_block_delta":
                delta = obj.get("delta", {})
                print(f"  text={delta.get('text', '')[:30]}", end="")
            print()
        except json.JSONDecodeError:
            print(f"  [raw] {payload[:80]}")

    expected = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]
    found = set(event_types)
    checks = {f"event '{e}' 存在": e in found for e in expected}
    for k, v in checks.items():
        print(f"  {'✅' if v else '❌'} {k}")
    return all(checks.values())

# ── 测试3: 工具调用 ──
def test_tool_use():
    sep("测试3: 工具调用 (tool_use)")
    tools = [{
        "name": "get_weather",
        "description": "获取指定城市的天气",
        "input_schema": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "城市名称"}
            },
            "required": ["city"]
        }
    }]
    resp = requests.post(f"{BASE_URL}/v1/messages", headers=HEADERS, json={
        "model": MODEL,
        "max_tokens": 256,
        "tools": tools,
        "messages": [{"role": "user", "content": "北京今天天气怎么样？"}],
    }, timeout=30)
    print(f"Status: {resp.status_code}")
    data = resp.json()
    print(json.dumps(data, indent=2, ensure_ascii=False))

    # 找 tool_use block
    tool_block = None
    for block in data.get("content", []):
        if block.get("type") == "tool_use":
            tool_block = block
            break

    checks = {
        "stop_reason=tool_use": data.get("stop_reason") == "tool_use",
        "tool_use block 存在": tool_block is not None,
        "tool id 存在": bool((tool_block or {}).get("id")),
        "tool name=get_weather": (tool_block or {}).get("name") == "get_weather",
        "input 是 dict": isinstance((tool_block or {}).get("input"), dict),
        "input.city 存在": bool((tool_block or {}).get("input", {}).get("city")),
    }
    for k, v in checks.items():
        print(f"  {'✅' if v else '❌'} {k}")
    return all(checks.values())

# ── 测试4: 工具调用 + 流式 ──
def test_tool_use_streaming():
    sep("测试4: 工具调用 (流式)")
    tools = [{
        "name": "get_weather",
        "description": "获取指定城市的天气",
        "input_schema": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "城市名称"}
            },
            "required": ["city"]
        }
    }]
    resp = requests.post(f"{BASE_URL}/v1/messages", headers=HEADERS, json={
        "model": MODEL,
        "max_tokens": 256,
        "stream": True,
        "tools": tools,
        "messages": [{"role": "user", "content": "上海今天天气如何？"}],
    }, stream=True, timeout=30)
    print(f"Status: {resp.status_code}")

    event_types = []
    tool_name = None
    input_json = ""
    for line in resp.iter_lines(decode_unicode=True):
        if not line:
            continue
        if line.startswith("event: "):
            event_types.append(line[7:].strip())
            continue
        if not line.startswith("data: "):
            continue
        payload = line[6:]
        if payload.strip() == "[DONE]":
            break
        try:
            obj = json.loads(payload)
            t = obj.get("type", "?")
            if t == "content_block_start" and obj.get("content_block", {}).get("type") == "tool_use":
                tool_name = obj["content_block"].get("name")
                print(f"  tool_use start: name={tool_name}, id={obj['content_block'].get('id')}")
            elif t == "content_block_delta" and obj.get("delta", {}).get("type") == "input_json_delta":
                input_json += obj["delta"].get("partial_json", "")
            elif t == "message_delta":
                print(f"  message_delta: stop_reason={obj.get('delta', {}).get('stop_reason')}")
        except json.JSONDecodeError:
            pass

    if input_json:
        print(f"  拼接后的 tool input: {input_json}")

    checks = {
        "content_block_start 存在": "content_block_start" in event_types,
        "input_json_delta 事件": "content_block_delta" in event_types,
        "tool name 正确": tool_name == "get_weather",
        "input JSON 可解析": False,
    }
    try:
        parsed = json.loads(input_json)
        checks["input JSON 可解析"] = isinstance(parsed, dict)
        checks["input.city 存在"] = bool(parsed.get("city"))
    except Exception:
        pass

    for k, v in checks.items():
        print(f"  {'✅' if v else '❌'} {k}")
    return all(checks.values())

# ── 运行 ──
if __name__ == "__main__":
    results = {}
    for name, fn in [
        ("基础对话", test_basic_message),
        ("流式对话", test_streaming),
        ("工具调用", test_tool_use),
        ("工具调用流式", test_tool_use_streaming),
    ]:
        try:
            results[name] = fn()
        except Exception as e:
            print(f"  ❌ 异常: {e}")
            results[name] = False

    sep("总结")
    for k, v in results.items():
        print(f"  {'✅ PASS' if v else '❌ FAIL'}  {k}")
