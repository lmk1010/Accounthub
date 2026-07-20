#!/usr/bin/env python3
"""Codex Pro 池定价/保本/利润反算计算器

公式基础（详见 .claude/skills/codex-pricing/SKILL.md）：
  月收入 = N × K × U × P × M
  月净利 = N × (K × U × P × M − C)

  保本定价：P_min = (C × S) / (K × U × M)
  保本利用率：U_min = (C × S) / (K × P × M)
  目标利润反推 P：P = (C + G/N) × S / (K × U × M)
  目标利润反推 U：U = (C + G/N) × S / (K × P × M)

基准实测（2026-04-24）：
  C = ¥160/账号/月（Pro 灰产采购价）
  K = $12,266/账号/月（rebekah 12%/7d 实测反推）
  N = 3（账号数）
  M = 1.0（客户主力用 gpt-5.4；若大量用 gpt-5.5 降到 0.5）
  S = 1.3（安全系数，含封号/退款/客服缓冲）
"""

import argparse
import sys


DEFAULTS = {
    "cost": 160.0,          # ¥/account/month
    "capacity": 12266.0,    # customer $/account/month
    "accounts": 3,
    "model_mix": 1.0,
    "safety": 1.3,
}


def breakeven_price(cost, capacity, utilization, model_mix, safety):
    return (cost * safety) / (capacity * utilization * model_mix)


def breakeven_utilization(cost, capacity, price, model_mix, safety):
    return (cost * safety) / (capacity * price * model_mix)


def target_price(cost, capacity, utilization, model_mix, safety, target_profit, accounts):
    return (cost + target_profit / accounts) * safety / (capacity * utilization * model_mix)


def target_utilization(cost, capacity, price, model_mix, safety, target_profit, accounts):
    return (cost + target_profit / accounts) * safety / (capacity * price * model_mix)


def monthly_profit(cost, capacity, accounts, utilization, price, model_mix):
    revenue = accounts * capacity * utilization * price * model_mix
    total_cost = accounts * cost
    return revenue - total_cost, revenue, total_cost


def fmt_money(x):
    return f"¥{x:,.2f}"


def fmt_price(x):
    return f"¥{x:.4f}/$1"


def fmt_pct(x):
    return f"{x*100:.1f}%"


def scan(args):
    C, K, N, M = args.cost, args.capacity, args.accounts, args.model_mix
    print(f"\n=== 基准 ===")
    print(f"单号月成本 C = ¥{C}  单号月容量 K = ${K:,.0f}  账号数 N = {N}  模型混合 M = {M}  安全系数 S = {args.safety}\n")

    print("### 1) 各利用率下的保本定价（纯保本 S=1 / 安全保本 S=1.3）")
    print(f"{'利用率 U':>10} | {'纯保本 (¥/$1)':>18} | {'安全保本 (¥/$1)':>18}")
    print("-" * 55)
    for u in [0.10, 0.25, 0.50, 0.75, 1.00]:
        p_pure = breakeven_price(C, K, u, M, 1.0)
        p_safe = breakeven_price(C, K, u, M, 1.3)
        print(f"{fmt_pct(u):>10} | {fmt_price(p_pure):>18} | {fmt_price(p_safe):>18}")

    print("\n### 2) 各定价下的保本利用率")
    print(f"{'定价 (RMB/$1)':>14} | {'纯保本 U':>12} | {'安全 U':>12}")
    print("-" * 45)
    for p in [0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20]:
        u_pure = breakeven_utilization(C, K, p, M, 1.0)
        u_safe = breakeven_utilization(C, K, p, M, 1.3)
        print(f"{fmt_price(p):>14} | {fmt_pct(u_pure):>12} | {fmt_pct(u_safe):>12}")

    print("\n### 3) 定价 × 利用率矩阵下的 3 号月净利 (¥)")
    header = f"{'U \\ P':>8} |"
    for p in [0.05, 0.08, 0.10, 0.12, 0.15, 0.20]:
        header += f" {p:>7.2f} |"
    print(header)
    print("-" * len(header))
    for u in [0.10, 0.25, 0.50, 0.75, 1.00]:
        line = f"{fmt_pct(u):>8} |"
        for p in [0.05, 0.08, 0.10, 0.12, 0.15, 0.20]:
            profit, _, _ = monthly_profit(C, K, N, u, p, M)
            line += f" {profit:>7.0f} |"
        print(line)

    print("\n### 4) 关键对比：现在定价 0.15 RMB/$1 vs 同利用率下安全保本线")
    print(f"{'利用率':>10} | {'现行 P=0.15 月净利':>22} | {'保本 P_min(S=1.3)':>22} | {'P 裕度':>10}")
    print("-" * 75)
    for u in [0.10, 0.25, 0.50, 0.75, 1.00]:
        profit, _, _ = monthly_profit(C, K, N, u, 0.15, M)
        p_safe = breakeven_price(C, K, u, M, 1.3)
        margin = 0.15 / p_safe
        print(f"{fmt_pct(u):>10} | {fmt_money(profit):>22} | {fmt_price(p_safe):>22} | {margin:>9.2f}x")


def main():
    ap = argparse.ArgumentParser(description="Codex Pro 池定价/保本/利润计算器")
    ap.add_argument("--cost", type=float, default=DEFAULTS["cost"], help="单 Pro 账号月成本 (¥)")
    ap.add_argument("--capacity", type=float, default=DEFAULTS["capacity"], help="单 Pro 月容量（客户 $）")
    ap.add_argument("--accounts", type=int, default=DEFAULTS["accounts"], help="Pro 账号数")
    ap.add_argument("--model-mix", type=float, default=DEFAULTS["model_mix"], help="模型混合系数（5.4=1.0，全 5.5=0.5）")
    ap.add_argument("--safety", type=float, default=DEFAULTS["safety"], help="安全系数（默认 1.3）")
    ap.add_argument("--util", type=float, help="利用率（0-1），用于算保本价 P_min")
    ap.add_argument("--price", type=float, help="定价 (RMB/$1)，用于算保本利用率 U_min 或月净利")
    ap.add_argument("--target-profit", type=float, help="目标月净利 (¥)（跨 N 个账号）")
    ap.add_argument("--scan", action="store_true", help="扫描常见场景生成对比表")
    args = ap.parse_args()

    if args.scan:
        scan(args)
        return

    C, K, N, M, S = args.cost, args.capacity, args.accounts, args.model_mix, args.safety

    if args.util and args.price and args.target_profit is None:
        profit, rev, cost = monthly_profit(C, K, N, args.util, args.price, M)
        print(f"\n利用率 {fmt_pct(args.util)} + 定价 {fmt_price(args.price)}：")
        print(f"  月收入 {fmt_money(rev)}，月成本 {fmt_money(cost)}")
        print(f"  **月净利 {fmt_money(profit)}**")

    elif args.util and args.target_profit is not None:
        p = target_price(C, K, args.util, M, S, args.target_profit, N)
        print(f"\n达到月净利 {fmt_money(args.target_profit)}，在 {fmt_pct(args.util)} 利用率下：")
        print(f"  需要定价 ≥ {fmt_price(p)}")

    elif args.price and args.target_profit is not None:
        u = target_utilization(C, K, args.price, M, S, args.target_profit, N)
        if u > 1:
            print(f"\n⚠️  定价 {fmt_price(args.price)} 不可能达到月净利 {fmt_money(args.target_profit)}（需要 {fmt_pct(u)} 超过 100%）")
        else:
            print(f"\n达到月净利 {fmt_money(args.target_profit)}，在定价 {fmt_price(args.price)} 下：")
            print(f"  需要利用率 ≥ {fmt_pct(u)}")

    elif args.util:
        p_pure = breakeven_price(C, K, args.util, M, 1.0)
        p_safe = breakeven_price(C, K, args.util, M, 1.3)
        print(f"\n利用率 {fmt_pct(args.util)} 下的保本定价：")
        print(f"  纯保本 (S=1.0)：    {fmt_price(p_pure)}")
        print(f"  安全保本 (S=1.3)：  {fmt_price(p_safe)}")
        print(f"  （参考：目前定价 ¥0.15，倍数 {0.15/p_safe:.2f}x 安全保本线）")

    elif args.price:
        u_pure = breakeven_utilization(C, K, args.price, M, 1.0)
        u_safe = breakeven_utilization(C, K, args.price, M, 1.3)
        print(f"\n定价 {fmt_price(args.price)} 的保本利用率：")
        print(f"  纯保本 (S=1.0)：    {fmt_pct(u_pure)}")
        print(f"  安全保本 (S=1.3)：  {fmt_pct(u_safe)}")
        profit_50, _, _ = monthly_profit(C, K, N, 0.5, args.price, M)
        profit_100, _, _ = monthly_profit(C, K, N, 1.0, args.price, M)
        print(f"  在 50% 利用率下月净利：{fmt_money(profit_50)}")
        print(f"  在 100% 利用率下月净利：{fmt_money(profit_100)}")

    else:
        print("没有传参数，跑默认扫描表。下次用 --util 0.5 或 --price 0.10 或 --scan")
        scan(args)


if __name__ == "__main__":
    main()
