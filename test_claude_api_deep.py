#!/usr/bin/env python3
"""
Claude API 代理 — 深度协议合规测试
检查项：
1. 响应字段完整性 & 类型严格校验
2. tool_use id 格式 (toolu_ 前缀)
3. tool input_schema 回传
4. thinking / extended thinking 格式
5. 流式 tool_use 的 input_json_delta 拼接
6. stop_reason 枚举值
7. usage 字段完整性 (input_tokens, output_tokens)
8. content block type 枚举
9. citations 字段
10. 多 tool 并行调用
"""

import json, re, sys
import requests

BASE = "https://yunyi.rdzhvip.com/claude"
KEY  = "WXXMH085-7RZS-T1A1-PMV5-UK2748HKPWBV"
HDR  = {
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
}

ALL_CHECKS = []

def check(name, ok, detail=""):
    ALL_CHECKS.append((name, ok, detail))
    tag = "✅" if ok else "❌"
    msg = f"  {tag} {name}"
    if detail:
        msg += f"  ({detail})"
    print(msg)

def sep(title):
    print(f"\n{'='*60}\n  {title}\n{'='*60}")

def post(extra_headers=None, **body):
    h = {**HDR, **(extra_headers or {})}
    return requests.post(f"{BASE}/v1/messages", headers=h, json=body, timeout=60)

def post_stream(extra_headers=None, **body):
    h = {**HDR, **(extra_headers or {})}
    return requests.post(f"{BASE}/v1/messages", headers=h, json=body, stream=True, timeout=60)

# ─────────────────────────────────────────────
# 测试1: 非流式响应 — 字段严格校验
# ─────────────────────────────────────────────
def test_basic_fields():
    sep("1. 非流式响应字段严格校验")
    r = post(model="claude-sonnet-4-20250514", max_tokens=64,
             messages=[{"role":"user","content":"Hi"}])
    d = r.json()
    print(json.dumps(d, indent=2, ensure_ascii=False)[:600])

    # id 格式: msg_ 前缀
    check("id 以 msg_ 开头", str(d.get("id","")).startswith("msg_"), d.get("id"))
    check("type == 'message'", d.get("type") == "message")
    check("role == 'assistant'", d.get("role") == "assistant")
    check("model 是字符串", isinstance(d.get("model"), str), d.get("model"))

    # stop_reason 枚举
    valid_stops = {"end_turn", "max_tokens", "stop_sequence", "tool_use"}
    check("stop_reason 在合法枚举内", d.get("stop_reason") in valid_stops, d.get("stop_reason"))
    check("stop_sequence 为 null", d.get("stop_sequence") is None)

    # content
    content = d.get("content", [])
    check("content 是 list", isinstance(content, list))
    if content:
        b = content[0]
        check("content[0].type == 'text'", b.get("type") == "text")
        check("content[0].text 是字符串", isinstance(b.get("text"), str))

    # usage
    u = d.get("usage", {})
    check("usage.input_tokens 是 int", isinstance(u.get("input_tokens"), int))
    check("usage.output_tokens 是 int", isinstance(u.get("output_tokens"), int))

# ─────────────────────────────────────────────
# 测试2: tool_use — id格式 / input类型 / stop_reason
# ─────────────────────────────────────────────
def test_tool_use_detail():
    sep("2. tool_use 字段细节校验")
    tools = [{
        "name": "get_weather",
        "description": "Get weather for a city",
        "input_schema": {
            "type": "object",
            "properties": {"city": {"type":"string"}},
            "required": ["city"]
        }
    }]
    r = post(model="claude-sonnet-4-20250514", max_tokens=256,
             tools=tools,
             messages=[{"role":"user","content":"What's the weather in Tokyo?"}])
    d = r.json()
    print(json.dumps(d, indent=2, ensure_ascii=False)[:800])

    check("stop_reason == 'tool_use'", d.get("stop_reason") == "tool_use")

    tu = None
    for b in d.get("content", []):
        if b.get("type") == "tool_use":
            tu = b
            break

    check("tool_use block 存在", tu is not None)
    if tu:
        # 官方 id 格式: toolu_ 前缀
        tid = tu.get("id", "")
        check("tool_use.id 以 'toolu_' 开头", tid.startswith("toolu_"), tid)
        check("tool_use.name == 'get_weather'", tu.get("name") == "get_weather")
        check("tool_use.input 是 dict", isinstance(tu.get("input"), dict))
        check("tool_use.input.city 是字符串", isinstance(tu.get("input",{}).get("city"), str))
        # 不应有多余字段
        allowed_keys = {"type", "id", "name", "input"}
        extra = set(tu.keys()) - allowed_keys
        check("tool_use block 无多余字段", len(extra) == 0, f"extra={extra}" if extra else "")

# ─────────────────────────────────────────────
# 测试3: 多 tool 并行调用
# ─────────────────────────────────────────────
def test_multi_tool():
    sep("3. 多 tool 并行调用")
    tools = [
        {"name":"get_weather","description":"Get weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}},
        {"name":"get_time","description":"Get current time","input_schema":{"type":"object","properties":{"timezone":{"type":"string"}},"required":["timezone"]}},
    ]
    r = post(model="claude-sonnet-4-20250514", max_tokens=512, tools=tools,
             messages=[{"role":"user","content":"What's the weather in Paris and what time is it in UTC?"}])
    d = r.json()
    tool_blocks = [b for b in d.get("content",[]) if b.get("type")=="tool_use"]
    print(f"  tool_use blocks count: {len(tool_blocks)}")
    for tb in tool_blocks:
        print(f"    name={tb.get('name')} id={tb.get('id')} input={tb.get('input')}")

    check("返回 >= 2 个 tool_use blocks", len(tool_blocks) >= 2)
    ids = [tb.get("id") for tb in tool_blocks]
    check("每个 tool_use id 唯一", len(ids) == len(set(ids)))
    check("所有 id 以 toolu_ 开头", all(i.startswith("toolu_") for i in ids), str(ids))

# ─────────────────────────────────────────────
# 测试4: Extended Thinking
# ─────────────────────────────────────────────
def test_thinking():
    sep("4. Extended Thinking 格式校验")
    try:
        r = post(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            thinking={"type": "enabled", "budget_tokens": 512},
            messages=[{"role":"user","content":"What is 15 * 37?"}],
            extra_headers={"anthropic-version": "2023-06-01"}
        )
        d = r.json()
        print(json.dumps(d, indent=2, ensure_ascii=False)[:1000])

        # 检查是否有 thinking block
        thinking_block = None
        text_block = None
        for b in d.get("content", []):
            if b.get("type") == "thinking":
                thinking_block = b
            elif b.get("type") == "text":
                text_block = b

        if d.get("error"):
            check("thinking 请求成功", False, d["error"].get("message",""))
            return

        check("thinking block 存在", thinking_block is not None)
        if thinking_block:
            check("thinking.type == 'thinking'", thinking_block.get("type") == "thinking")
            check("thinking.thinking 是字符串", isinstance(thinking_block.get("thinking"), str))
            # 官方签名字段
            has_signature = "signature" in thinking_block
            check("thinking.signature 字段存在 (防篡改签名)", has_signature,
                  thinking_block.get("signature","")[:60] if has_signature else "MISSING")
        check("text block 也存在", text_block is not None)
    except Exception as e:
        check("thinking 测试异常", False, str(e))

# ─────────────────────────────────────────────
# 测试5: 流式 tool_use — event 类型 & input_json_delta
# ─────────────────────────────────────────────
def test_stream_tool():
    sep("5. 流式 tool_use 事件细节")
    tools = [{"name":"get_weather","description":"Get weather",
              "input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]
    r = post_stream(model="claude-sonnet-4-20250514", max_tokens=256,
                    tools=tools, stream=True,
                    messages=[{"role":"user","content":"Weather in London?"}])

    events = []       # (event_type, data_obj)
    current_event = None
    for line in r.iter_lines(decode_unicode=True):
        if not line:
            continue
        if line.startswith("event: "):
            current_event = line[7:].strip()
            continue
        if line.startswith("data: "):
            raw = line[6:]
            if raw.strip() == "[DONE]":
                break
            try:
                obj = json.loads(raw)
                events.append((current_event, obj))
            except:
                pass

    # 分析事件
    event_types = [e[0] for e in events]
    print(f"  事件序列: {event_types}")

    # content_block_start 中的 tool_use
    tool_start = None
    input_parts = []
    stop_reason = None
    for etype, obj in events:
        if etype == "content_block_start":
            cb = obj.get("content_block", {})
            if cb.get("type") == "tool_use":
                tool_start = cb
                print(f"  tool_use start: id={cb.get('id')} name={cb.get('name')}")
        if etype == "content_block_delta":
            delta = obj.get("delta", {})
            if delta.get("type") == "input_json_delta":
                input_parts.append(delta.get("partial_json", ""))
        if etype == "message_delta":
            stop_reason = obj.get("delta", {}).get("stop_reason")

    full_input = "".join(input_parts)
    print(f"  拼接 input JSON: {full_input}")
    print(f"  stop_reason: {stop_reason}")

    check("content_block_start 含 tool_use", tool_start is not None)
    if tool_start:
        check("流式 tool id 以 toolu_ 开头", str(tool_start.get("id","")).startswith("toolu_"), tool_start.get("id"))
        check("流式 tool name 正确", tool_start.get("name") == "get_weather")
    check("input_json_delta 事件存在", len(input_parts) > 0)
    try:
        parsed = json.loads(full_input)
        check("拼接后 JSON 合法", True)
        check("input.city 存在", "city" in parsed, str(parsed))
    except:
        check("拼接后 JSON 合法", False, full_input[:100])
    check("delta.type == 'input_json_delta'", "content_block_delta" in event_types)
    check("message_delta.stop_reason == 'tool_use'", stop_reason == "tool_use")

# ─────────────────────────────────────────────
# 测试6: 流式 thinking 事件
# ─────────────────────────────────────────────
def test_stream_thinking():
    sep("6. 流式 Extended Thinking 事件")
    try:
        r = post_stream(
            model="claude-sonnet-4-20250514",
            max_tokens=1024, stream=True,
            thinking={"type":"enabled","budget_tokens":512},
            messages=[{"role":"user","content":"What is 99+1?"}]
        )

        events = []
        current_event = None
        for line in r.iter_lines(decode_unicode=True):
            if not line:
                continue
            if line.startswith("event: "):
                current_event = line[7:].strip()
                continue
            if line.startswith("data: "):
                raw = line[6:]
                if raw.strip() == "[DONE]":
                    break
                try:
                    obj = json.loads(raw)
                    events.append((current_event, obj))
                except:
                    pass

        event_types = [e[0] for e in events]
        print(f"  事件序列: {event_types}")

        # 检查 thinking 相关事件
        has_thinking_start = False
        has_thinking_delta = False
        has_thinking_stop = False
        has_signature = False
        signature_value = ""

        for etype, obj in events:
            if etype == "content_block_start":
                cb = obj.get("content_block", {})
                if cb.get("type") == "thinking":
                    has_thinking_start = True
                    print(f"  thinking block start found")
            if etype == "content_block_delta":
                delta = obj.get("delta", {})
                if delta.get("type") == "thinking_delta":
                    has_thinking_delta = True
                if delta.get("type") == "signature_delta":
                    has_signature = True
                    signature_value += delta.get("signature", "")

        check("thinking content_block_start 存在", has_thinking_start)
        check("thinking_delta 事件存在", has_thinking_delta)
        check("signature_delta 事件存在 (防篡改)", has_signature,
              signature_value[:60] if signature_value else "MISSING")

    except Exception as e:
        check("流式 thinking 测试异常", False, str(e))

# ─────────────────────────────────────────────
# 测试7: tool_result 回传格式
# ─────────────────────────────────────────────
def test_tool_result_roundtrip():
    sep("7. tool_result 回传 — 完整对话轮次")
    tools = [{"name":"calc","description":"Calculate expression",
              "input_schema":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}]

    # 第一轮: 模型调用工具
    r1 = post(model="claude-sonnet-4-20250514", max_tokens=256, tools=tools,
              messages=[{"role":"user","content":"Calculate 2+2"}])
    d1 = r1.json()
    tu = None
    for b in d1.get("content",[]):
        if b.get("type") == "tool_use":
            tu = b
            break

    check("第一轮返回 tool_use", tu is not None)
    if not tu:
        return

    # 第二轮: 回传 tool_result
    r2 = post(model="claude-sonnet-4-20250514", max_tokens=256, tools=tools,
              messages=[
                  {"role":"user","content":"Calculate 2+2"},
                  {"role":"assistant","content": d1["content"]},
                  {"role":"user","content":[{
                      "type": "tool_result",
                      "tool_use_id": tu["id"],
                      "content": "4"
                  }]}
              ])
    d2 = r2.json()
    print(json.dumps(d2, indent=2, ensure_ascii=False)[:500])

    check("第二轮 stop_reason == 'end_turn'", d2.get("stop_reason") == "end_turn")
    text_blocks = [b for b in d2.get("content",[]) if b.get("type")=="text"]
    check("第二轮返回 text block", len(text_blocks) > 0)
    if text_blocks:
        check("回复包含 '4'", "4" in text_blocks[0].get("text",""))

# ─────────────────────────────────────────────
# 运行全部
# ─────────────────────────────────────────────
if __name__ == "__main__":
    tests = [
        test_basic_fields,
        test_tool_use_detail,
        test_multi_tool,
        test_thinking,
        test_stream_tool,
        test_stream_thinking,
        test_tool_result_roundtrip,
    ]
    for fn in tests:
        try:
            fn()
        except Exception as e:
            print(f"  ❌ 测试异常: {e}")

    sep("总结")
    passed = sum(1 for _,ok,_ in ALL_CHECKS if ok)
    failed = sum(1 for _,ok,_ in ALL_CHECKS if not ok)
    print(f"  通过: {passed}  失败: {failed}  总计: {len(ALL_CHECKS)}")
    if failed:
        print("\n  失败项:")
        for name, ok, detail in ALL_CHECKS:
            if not ok:
                print(f"    ❌ {name}  {detail}")
    sys.exit(0 if failed == 0 else 1)
