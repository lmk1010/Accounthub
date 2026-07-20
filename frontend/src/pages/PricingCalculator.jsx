/**
 * 定价计算器 —— AccountHub 成本/容量 × newapi 售价/销售 的实时分析
 *
 * 公式：
 *   月收入 = N × K × U × P × M
 *   月净利 = N × (K × U × P × M − C)
 *   保本价 P_min = (C × S) / (K × U × M)
 *   保本率 U_min = (C × S) / (K × P × M)
 */

import { useEffect, useMemo, useState, memo } from 'react';
import { pricingService } from '../services/pricing.service';
import './PricingCalculator.css';

// ─── SVG 图标（匹配 Monitor 风格）─────────────────────────────────
const ICONS = {
  calculator: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M16 10h.01M12 10h.01M8 10h.01M12 14h.01M8 14h.01M12 18h.01M8 18h.01"/></svg>,
  refresh:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23,4 23,10 17,10"/><polyline points="1,20 1,14 7,14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  users:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  zap:        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/></svg>,
  trendUp:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23,6 13.5,15.5 8.5,10.5 1,18"/><polyline points="17,6 23,6 23,12"/></svg>,
  trendDown:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23,18 13.5,8.5 8.5,13.5 1,6"/><polyline points="17,18 23,18 23,12"/></svg>,
  dollar:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  package:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27,6.96 12,12.01 20.73,6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  target:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>,
  percent:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>,
  pulse:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12h4l3-9 4 18 3-9h6"/></svg>,
  alert:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  check:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>,
  grid:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  cards:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>,
  chart:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>,
  cpu:        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>,
  shield:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  settings:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  layers:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12,2 2,7 12,12 22,7"/><polyline points="2,17 12,22 22,17"/><polyline points="2,12 12,17 22,12"/></svg>,
  clock:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>,
  fire:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>,
};
const Icon = memo(({ n }) => ICONS[n] || null);

// ─── 格式化辅助函数 ─────────────────────────────────────────────────
const fmtRmb = (v, digits = 0) => {
  if (v == null || Number.isNaN(v)) return '--';
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
const fmtRmbSmall = (v) => {
  if (v == null || Number.isNaN(v)) return '--';
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `¥${n.toFixed(4)}/$1`;
};
const fmtUsd = (v, digits = 0) => {
  if (v == null || Number.isNaN(v)) return '--';
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
const fmtPct = (v, digits = 1) => {
  if (v == null || Number.isNaN(v)) return '--';
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${(n * 100).toFixed(digits)}%`;
};
const fmtM = (tokens) => {
  if (!tokens) return '--';
  return `${(tokens / 1e6).toFixed(1)}M`;
};
const fmtDateTime = (v) => {
  if (!v) return '--';
  try {
    const d = new Date(v);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch { return '--'; }
};

// ─── 子组件 ─────────────────────────────────────────────────────────
const StatCard = memo(({ icon, color, label, value, sub, hint, valueColor }) => (
  <div className="p-card">
    <div className={`p-ico ${color}`}><Icon n={icon} /></div>
    <div className="p-body">
      <div className="p-lbl">{label}</div>
      <div className={`p-val ${valueColor || ''}`}>{value}</div>
      {sub && <div className="p-sub">{sub}</div>}
      {hint && <div className="p-hint">{hint}</div>}
    </div>
  </div>
));

const SectionTitle = memo(({ icon, title, hint }) => (
  <div className="p-section">
    <Icon n={icon} />
    <span className="p-sec-title">{title}</span>
    {hint && <span className="p-sec-hint">{hint}</span>}
  </div>
));

const Slider = memo(({ icon, label, min, max, step, value, onChange, format, hint }) => (
  <div className="p-slider">
    <div className="p-slider-head">
      <span className="p-slider-label">
        {icon && <Icon n={icon} />}
        {label}
      </span>
      <span className="p-slider-value">{format ? format(value) : value}</span>
    </div>
    <input
      type="range"
      min={min} max={max} step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
    {hint && <div className="p-slider-hint">{hint}</div>}
  </div>
));

// ─── 主组件 ─────────────────────────────────────────────────────────
const POOL_META = {
  pro:  { icon: 'shield',  label: 'Codex Pro',  color: '#3b82f6', defaultCost: 160 },
  plus: { icon: 'zap',     label: 'Codex Plus', color: '#10b981', defaultCost: 9 },
  free: { icon: 'layers',  label: 'Codex Free', color: '#f97316', defaultCost: 0.3 },
};
const POOL_ORDER = ['pro', 'plus', 'free'];

export default function PricingCalculator() {
  const [loading, setLoading] = useState(true);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [overview, setOverview] = useState(null);
  const [activePool, setActivePool] = useState('pro');

  const [utilization, setUtilization] = useState(0.5);
  const [pricePerUsd, setPricePerUsd] = useState(0.15);
  const [costPerAccount, setCostPerAccount] = useState(160);
  const [accounts, setAccounts] = useState(3);
  const [modelMix, setModelMix] = useState(1.0);
  const [safety, setSafety] = useState(1.3);
  const [targetProfit, setTargetProfit] = useState(3000);
  const [savingTier, setSavingTier] = useState(null); // uuid being saved

  const loadDashboard = async (pool = activePool) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await pricingService.getDashboard({ pool, days: 30, consumptionDays: 7 });
      const payload = resp?.data?.data || resp?.data;
      setData(payload);
      // 优先用实际加权平均成本（含 tier 混合），否则用池子默认
      if (payload?.proPool?.monthlyCostRmb > 0 && payload?.proPool?.totalAccounts > 0) {
        setCostPerAccount(Math.round(payload.proPool.monthlyCostRmb / payload.proPool.totalAccounts));
      } else if (payload?.defaults?.costPerAccountRmb != null) {
        setCostPerAccount(payload.defaults.costPerAccountRmb);
      }
      if (payload?.defaults?.safetyFactor != null) setSafety(payload.defaults.safetyFactor);
      if (payload?.defaults?.modelMix != null) setModelMix(payload.defaults.modelMix);
      if (payload?.proPool?.totalAccounts) setAccounts(payload.proPool.totalAccounts);
    } catch (e) {
      console.error(e);
      setError(e?.response?.data?.error?.message || e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadOverview = async () => {
    setOverviewLoading(true);
    try {
      const resp = await pricingService.getOverview();
      setOverview(resp?.data?.data || resp?.data);
    } catch (e) {
      console.error('[pricing] overview failed', e);
    } finally {
      setOverviewLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
    loadDashboard('pro');
  }, []);

  const handlePoolSwitch = (pool) => {
    if (pool === activePool || loading) return;
    setActivePool(pool);
    loadDashboard(pool);
  };

  const refreshAll = async () => {
    await Promise.all([loadOverview(), loadDashboard(activePool)]);
  };

  const handleTierChange = async (uuid, tier) => {
    if (!uuid) return;
    setSavingTier(uuid);
    try {
      await pricingService.setProviderTier(uuid, tier || null);
      await refreshAll();
    } catch (e) {
      console.error('setProviderTier failed', e);
      alert('更新档位失败: ' + (e?.response?.data?.error?.message || e.message));
    } finally {
      setSavingTier(null);
    }
  };

  const K = data?.proPool?.kMonthlyUsd || (activePool === 'pro' ? 12266 : 400);
  const N = accounts;
  const U = utilization;
  const P = pricePerUsd;
  const M = modelMix;
  const C = costPerAccount;
  const S = safety;

  const monthlyRevenue = N * K * U * P * M;
  const monthlyCost = N * C;
  const monthlyProfit = monthlyRevenue - monthlyCost;
  const breakEvenPrice = (C * S) / (K * U * M || 1);
  const breakEvenPricePure = C / (K * U * M || 1);
  const breakEvenUtilization = (C * S) / (K * P * M || 1);
  const priceSafetyFactor = breakEvenPrice > 0 ? P / breakEvenPrice : 0;

  const matrix = useMemo(() => {
    const utils = [0.10, 0.25, 0.50, 0.75, 1.00];
    const prices = [0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.30];
    return utils.map((u) => ({
      u,
      cells: prices.map((p) => ({ p, profit: N * (K * u * p * M - C) }))
    }));
  }, [N, K, M, C]);

  const breakEvenScans = useMemo(() => {
    const utils = [0.10, 0.25, 0.50, 0.75, 1.00];
    return utils.map((u) => ({
      u,
      pMin: (C * S) / (K * u * M || 1),
      pMinPure: C / (K * u * M || 1),
      profitAtCurrent: N * (K * u * P * M - C)
    }));
  }, [N, K, M, C, S, P]);

  const priceRecsForTargetProfit = useMemo(() => {
    const utils = [0.25, 0.50, 0.75, 1.00];
    return utils.map((u) => {
      const requiredP = (C + targetProfit / N) / (K * u * M || 1);
      return { u, requiredP, feasible: requiredP <= 1.0 };
    });
  }, [N, K, M, C, targetProfit]);

  const planMargin = useMemo(() => {
    if (!data?.plans) return [];
    return data.plans.map((p) => {
      const unitPriceRmb = p.unitPriceRmbPerUsd;
      const cardFullBurnProCost = (p.quotaUsd * C) / (K * M || 1);
      return {
        ...p,
        unitPriceRmb,
        cardFullBurnProCost,
        cardProfitFullBurn: p.priceRmb - cardFullBurnProCost,
        cardProfitHalfBurn: p.priceRmb - cardFullBurnProCost * 0.5
      };
    });
  }, [data, C, K, M]);

  // ── 决策面板数据（4 个核心问题） ──────────────────────────
  const poolOverview = overview?.pools?.[activePool];
  const currentMonthlyNet = poolOverview?.estMonthlyNetRmb ?? 0;
  const currentGap = currentMonthlyNet < 0 ? Math.abs(currentMonthlyNet) : 0;

  // 当前月实际消耗 $，用来估剩余容量
  const monthlyConsumedUsd = (data?.consumption?.totalUsd || 0) * (30 / (data?.consumption?.windowDays || 7));
  const monthlyTotalCapacity = N * K;
  const remainingCapacityUsd = Math.max(0, monthlyTotalCapacity - monthlyConsumedUsd);
  const utilPct = monthlyTotalCapacity > 0 ? monthlyConsumedUsd / monthlyTotalCapacity : 0;

  // 推荐价格
  const recommendPriceMin = (C * S) / (K * U * M || 1);
  const recommendPricePure = C / (K * U * M || 1);
  const recommendPriceComfort = recommendPriceMin * 2;
  const marketCeiling = 0.35;

  // 目标反推：默认=补亏，可自定义
  const [goalTarget, setGoalTarget] = useState(0);
  useEffect(() => {
    // 池子切换或数据加载后，如果用户没改过目标，默认用 "补亏 + 500" 作为起始
    if (goalTarget === 0) {
      const suggested = Math.max(500, Math.ceil((currentGap + 500) / 100) * 100);
      setGoalTarget(suggested);
    }
  }, [activePool, currentGap]); // eslint-disable-line

  const goalShortfall = goalTarget - currentMonthlyNet; // 要多赚多少

  const planPlans = useMemo(() => {
    return planMargin
      .filter(p => p.status === 1 && p.priceRmb > 0 && p.quotaUsd > 0)
      .map(p => {
        const perCardProfit = p.cardProfitFullBurn;
        const cardsNeededForGoal = goalShortfall > 0 && perCardProfit > 0
          ? Math.ceil(goalShortfall / perCardProfit)
          : null;
        const cycleFactor = 30 / Math.max(1, p.durationDays);
        const monthlyCapacityCards = Math.floor(
          (remainingCapacityUsd / Math.max(1, p.quotaUsd)) * cycleFactor
        );
        return { ...p, perCardProfit, cardsNeededForGoal, monthlyCapacityCards };
      })
      .sort((a, b) => b.perCardProfit - a.perCardProfit);
  }, [planMargin, goalShortfall, remainingCapacityUsd]);

  const top3PlansForGoal = planPlans.slice(0, 3);
  const top3PlansForCeiling = [...planPlans]
    .sort((a, b) => b.monthlyCapacityCards - a.monthlyCapacityCards)
    .slice(0, 3);

  const proPoolSales = useMemo(() => data?.sales || [], [data]);
  const proPoolSalesRevenue = proPoolSales.reduce((a, b) => a + (b.revenueRmb || 0), 0);
  const proPoolSalesCount = proPoolSales.reduce((a, b) => a + b.sold, 0);

  const currentPoolMeta = POOL_META[activePool] || POOL_META.pro;

  return (
    <div className="pricing">
      {/* 顶栏 */}
      <div className="p-header">
        <div className="p-title">
          <Icon n="calculator" />
          <div>
            <h1>Codex 池 · 定价计算器</h1>
            <div className="p-sub">{currentPoolMeta.label} · AccountHub 成本容量 × newapi 套餐销售，实时联动</div>
          </div>
        </div>
        <div className="p-ctrl">
          {data?.generatedAt && (
            <span className="p-time">{fmtDateTime(data.generatedAt)}</span>
          )}
          <button className="p-refresh" onClick={refreshAll} disabled={loading || overviewLoading} aria-label="刷新">
            <Icon n="refresh" />
          </button>
        </div>
      </div>

      {/* 业务总览条 */}
      <div className="p-overview">
        <div className="p-over-card totals">
          <div className="p-over-head">
            <Icon n="chart" />
            <span className="p-over-title">业务总览</span>
            <span className="p-over-sub">近 30 天</span>
          </div>
          <div className="p-over-stat">
            <span className="p-over-stat-label">账号总数</span>
            <span className="p-over-stat-val">{overview?.totals?.accounts ?? '--'}</span>
            <span className="p-over-stat-label">月总成本</span>
            <span className="p-over-stat-val neg">{fmtRmb(overview?.totals?.monthlyCostRmb)}</span>
            <span className="p-over-stat-label">月总收入</span>
            <span className="p-over-stat-val pos">{fmtRmb(overview?.totals?.monthlyRevenueRmb)}</span>
            <span className="p-over-stat-label">月消耗</span>
            <span className="p-over-stat-val">{fmtUsd(overview?.totals?.monthlyConsumedUsd, 2)}</span>
          </div>
          <div className="p-over-net">
            <span className="p-over-net-lbl">月净利估算</span>
            <span className={`p-over-net-val ${(overview?.totals?.estNetRmb ?? 0) >= 0 ? 'pos' : 'neg'}`}>
              {fmtRmb(overview?.totals?.estNetRmb)}
            </span>
          </div>
        </div>

        {POOL_ORDER.map((key) => {
          const meta = POOL_META[key];
          const p = overview?.pools?.[key];
          const net = p?.estMonthlyNetRmb ?? 0;
          const netClass = net >= 0 ? 'pos' : 'neg';
          return (
            <div
              key={key}
              className={`p-over-card ${key}${!loading && activePool === key ? ' active' : ''}`}
              onClick={() => handlePoolSwitch(key)}
              style={{ cursor: 'pointer' }}
              title={`点击切换到 ${meta.label}`}
            >
              <div className="p-over-head">
                <Icon n={meta.icon} />
                <span className="p-over-title">{meta.label}</span>
                <span className="p-over-sub">{p?.sharesChannel ? '共享 ch3' : '独占 ch' + (p?.channelKey || '')}</span>
              </div>
              <div className="p-over-stat">
                <span className="p-over-stat-label">账号数</span>
                <span className="p-over-stat-val">{p?.totalAccounts ?? '--'}<span style={{ color: '#94a3b8', fontWeight: 500 }}> / 活 {p?.activeAccounts ?? '--'}</span></span>
                <span className="p-over-stat-label">单号成本</span>
                <span className="p-over-stat-val">
                  {p?.tierBreakdown && Object.keys(p.tierBreakdown).length > 0
                    ? Object.entries(p.tierBreakdown).map(([k, v]) => `${v.label}×${v.count}`).join(' + ')
                    : `¥${p?.defaultCostRmb ?? '--'} × ${p?.totalAccounts ?? '--'}`}
                </span>
                <span className="p-over-stat-label">月成本</span>
                <span className="p-over-stat-val neg">{fmtRmb(p?.monthlyCostRmb)}</span>
                <span className="p-over-stat-label">归属收入 (30d)</span>
                <span className="p-over-stat-val pos">{fmtRmb(p?.recent?.attributedRevenueRmb)}</span>
              </div>
              <div className="p-over-net">
                <span className="p-over-net-lbl">月净利</span>
                <span className={`p-over-net-val ${netClass}`}>{fmtRmb(net)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 池子切换 */}
      <div className="p-tabs">
        {POOL_ORDER.map((key) => {
          const meta = POOL_META[key];
          const p = overview?.pools?.[key];
          return (
            <button
              key={key}
              className={`p-tab pool-${key}${activePool === key ? ' active' : ''}`}
              onClick={() => handlePoolSwitch(key)}
              disabled={loading}
            >
              <Icon n={meta.icon} />
              <span>{meta.label}</span>
              {p?.totalAccounts != null && (
                <span className="p-tab-count">{p.totalAccounts}</span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="p-error">
          <Icon n="alert" />
          加载失败：{error}
        </div>
      )}

      {/* ── 决策面板（4 格，紧凑） ────────────────────────────── */}
      <SectionTitle icon="target" title={`${currentPoolMeta.label} · 决策面板`} hint="4 核心问题" />
      <div className="p-decision">
        {/* 1) 亏多少 */}
        <div className="p-dec-card loss">
          <div className="p-dec-head">
            <Icon n="trendDown" />
            <h3>当前亏多少</h3>
            <span className="p-dec-subtitle">近 30 天</span>
          </div>
          <div className={`p-dec-big ${currentMonthlyNet < 0 ? 'neg' : currentMonthlyNet > 0 ? 'pos' : 'neutral'}`}>
            {currentMonthlyNet < 0 ? fmtRmb(currentMonthlyNet) : `+${fmtRmb(currentMonthlyNet)}`}
          </div>
          <div className="p-dec-sub">
            {currentMonthlyNet < 0 ? '每月净亏（实际销售 × 成本）' : '每月净赚'}
          </div>
          <div className="p-dec-split">
            <div className="p-dec-split-item">
              <div className="p-dec-split-lbl">月成本</div>
              <div className="p-dec-split-val neg">{fmtRmb(poolOverview?.monthlyCostRmb ?? 0)}</div>
            </div>
            <div className="p-dec-split-item">
              <div className="p-dec-split-lbl">归属收入</div>
              <div className="p-dec-split-val pos">{fmtRmb(poolOverview?.recent?.attributedRevenueRmb ?? 0)}</div>
            </div>
          </div>
          {poolOverview?.tierBreakdown && Object.keys(poolOverview.tierBreakdown).length > 0 && (
            <div className="p-tier-mix">
              {Object.entries(poolOverview.tierBreakdown).map(([tierKey, info]) => (
                <span key={tierKey} className="p-tier-mix-item">
                  <span className={`p-tier ${tierKey === '20x' ? 't20' : 't5'}`}>{info.label || tierKey}</span>
                  × {info.count} = {fmtRmb(info.costRmb, 0)}
                </span>
              ))}
            </div>
          )}
          <div className="p-dec-footer">
            {currentGap > 0
              ? `月缺口 ${fmtRmb(currentGap)}`
              : '已盈利'}
          </div>
        </div>

        {/* 2) 定价范围 */}
        <div className="p-dec-card price">
          <div className="p-dec-head">
            <Icon n="dollar" />
            <h3>定价范围</h3>
            <span className="p-dec-subtitle">U={fmtPct(U, 0)} M={M.toFixed(1)}</span>
          </div>
          <div className="p-dec-big neutral">¥{P.toFixed(3)}<small>/$1</small></div>
          <div className="p-dec-sub">当前定价</div>
          <ul className="p-dec-list">
            <li className="p-dec-list-item">
              <span className="name">纯保本 <small>S=1</small></span>
              <span className="val">¥{recommendPricePure.toFixed(4)}</span>
            </li>
            <li className="p-dec-list-item">
              <span className="name">安全保本 <small>S={S.toFixed(1)}</small></span>
              <span className="val">¥{recommendPriceMin.toFixed(4)}</span>
            </li>
            <li className="p-dec-list-item highlight">
              <span className="name">✨ 推荐 <small>2× 保本</small></span>
              <span className="val accent">¥{recommendPriceComfort.toFixed(4)}</span>
            </li>
            <li className="p-dec-list-item">
              <span className="name">市场上限</span>
              <span className="val">≈¥{marketCeiling.toFixed(2)}</span>
            </li>
          </ul>
          <div className="p-dec-footer">
            当前价是保本 <strong>{priceSafetyFactor.toFixed(1)}×</strong>，{priceSafetyFactor > 3 ? '可降价' : priceSafetyFactor > 1.5 ? '安全' : priceSafetyFactor > 1 ? '偏紧' : '亏'}
          </div>
        </div>

        {/* 3) 目标反推 */}
        <div className="p-dec-card goal">
          <div className="p-dec-head">
            <Icon n="target" />
            <h3>要卖多少达目标</h3>
            <span className="p-dec-subtitle">
              <input
                type="number"
                className="p-dec-target-input"
                value={goalTarget}
                min={0}
                step={100}
                onChange={(e) => setGoalTarget(Number(e.target.value))}
              />/月
            </span>
          </div>
          <div className={`p-dec-big ${goalShortfall > 0 ? 'neg' : 'pos'}`}>
            {goalShortfall > 0 ? `还差 ${fmtRmb(goalShortfall)}` : `已超 ${fmtRmb(-goalShortfall)}`}
          </div>
          <div className="p-dec-sub">
            目标 {fmtRmb(goalTarget)} · 当前 {fmtRmb(currentMonthlyNet)}
          </div>
          <div className="p-dec-target-quick">
            {[500, 3000, 5000, 10000].map(v => (
              <button
                key={v}
                className={goalTarget === v ? 'active' : ''}
                onClick={() => setGoalTarget(v)}
              >¥{v >= 1000 ? `${v/1000}k` : v}</button>
            ))}
          </div>
          <ul className="p-dec-list" style={{ marginTop: 6 }}>
            {goalShortfall <= 0 && (
              <li className="p-dec-list-item">
                <span className="name" style={{ color: '#059669' }}>已达目标，多卖即纯赚</span>
              </li>
            )}
            {goalShortfall > 0 && top3PlansForGoal.length === 0 && (
              <li className="p-dec-list-item">
                <span className="name" style={{ color: '#dc2626' }}>⚠ 所有套餐毛利 ≤ 0</span>
              </li>
            )}
            {goalShortfall > 0 && top3PlansForGoal.map(p => (
              <li className="p-dec-list-item" key={p.id}>
                <span className="name">
                  {p.name.replace(/^Codex /, '')}
                  <small>¥{Math.round(p.perCardProfit)}/张</small>
                </span>
                <span className="val accent">{p.cardsNeededForGoal ?? '—'} 张</span>
              </li>
            ))}
          </ul>
          <div className="p-dec-footer">
            按全烧估算；客户半烧需翻倍。
          </div>
        </div>

        {/* 4) 还能卖多少 */}
        <div className="p-dec-card ceiling">
          <div className="p-dec-head">
            <Icon n="package" />
            <h3>还能卖多少</h3>
            <span className="p-dec-subtitle">池容量剩余</span>
          </div>
          <div className="p-dec-big neutral">
            {fmtUsd(remainingCapacityUsd, 0)}<small>/月剩余</small>
          </div>
          <div className="p-dec-sub">
            利用率 {fmtPct(utilPct)}
          </div>
          <div className="p-dec-gauge">
            <div
              className={`p-dec-gauge-fill ${utilPct > 0.85 ? 'danger' : utilPct > 0.6 ? 'warn' : ''}`}
              style={{ width: `${Math.min(100, utilPct * 100).toFixed(1)}%` }}
            />
          </div>
          <ul className="p-dec-list">
            {top3PlansForCeiling.length === 0 && (
              <li className="p-dec-list-item">
                <span className="name" style={{ color: '#94a3b8' }}>K 不可用（无活跃样本）</span>
              </li>
            )}
            {top3PlansForCeiling.map(p => (
              <li className="p-dec-list-item" key={p.id}>
                <span className="name">{p.name.replace(/^Codex /, '')}</span>
                <span className="val accent">{p.monthlyCapacityCards} 张/月</span>
              </li>
            ))}
          </ul>
          <div className="p-dec-footer">
            剩余 = 池总 − 真实消耗
          </div>
        </div>
      </div>

      {/* ── 实时数据 ─────────────────────────────────────────────── */}
      <SectionTitle
        icon="pulse"
        title={`${currentPoolMeta.label} · 实时数据`}
        hint={data?.pool?.description}
      />
      <div className="p-grid">
        <StatCard
          icon="users" color="blue"
          label={`${currentPoolMeta.label} 账号数`}
          value={data?.proPool?.totalAccounts ?? '--'}
          sub={`健康 ${data?.proPool?.activeAccounts ?? '--'} 个`}
        />
        <StatCard
          icon="zap" color="cyan"
          label="单号月容量 K（实测）"
          value={fmtUsd(data?.proPool?.kMonthlyUsd)}
          sub={`周容量 ${fmtUsd(data?.proPool?.kWeeklyUsd)}`}
          hint={data?.proPool?.sampleAccount
            ? `基于 ${data.proPool.sampleAccount.customName?.split('@')[0] || 'sample'} · ${data.proPool.sampleAccount.weeklyPct}%/7d = ${fmtUsd(data.proPool.sampleAccount.dollars7dCustomer || 0, 0)}`
            : (data?.proPool?.totalAccounts > 0 ? '无活跃样本（账号闲置）' : '无账号')}
        />
        <StatCard
          icon="percent" color="orange"
          label="当前利用率"
          value={fmtPct(data?.consumption?.currentUtilization)}
          sub={`${data?.consumption?.windowDays ?? 7} 天消耗 ${fmtUsd(data?.consumption?.totalUsd)}`}
          hint={data?.consumption?.shareOfChannel != null && data.consumption.shareOfChannel < 1
            ? `ch${data?.pool?.newapiChannelId} 分得 ${fmtPct(data.consumption.shareOfChannel)}`
            : `newapi ch${data?.pool?.newapiChannelId} 独占`}
        />
        <StatCard
          icon="cards" color="purple"
          label="近 30 天卡销量"
          value={`${proPoolSalesCount} 张`}
          sub={proPoolSalesCount === 0 ? '无成交' : `${proPoolSales.length} 种套餐`}
        />
        <StatCard
          icon="dollar" color="green"
          label="近 30 天收入"
          value={fmtRmb(proPoolSalesRevenue)}
          valueColor="green"
          sub={proPoolSalesRevenue > 0 ? `均价 ${fmtRmb(proPoolSalesRevenue / proPoolSalesCount, 2)}/张` : '等销量启动'}
        />
      </div>

      {/* ── 调参区 ─────────────────────────────────────────────── */}
      <SectionTitle icon="settings" title="调参区" hint="改参数 → 右边实时出净利和保本线" />
      <div className="p-calc">
        <div className="p-sliders">
          <Slider icon="percent" label="利用率 U" min={0.01} max={1} step={0.01}
            value={utilization} onChange={setUtilization}
            format={(v) => fmtPct(v)} hint="单号平均每月被烧掉的比例" />
          <Slider icon="dollar" label="定价 P（RMB/$1 额度）" min={0.02} max={0.40} step={0.005}
            value={pricePerUsd} onChange={setPricePerUsd}
            format={(v) => `¥${v.toFixed(3)}/$1`} hint="目前 ¥0.15，灰产主流 ¥0.08~0.12" />
          <Slider icon="package" label="单号月成本 C" min={50} max={500} step={10}
            value={costPerAccount} onChange={setCostPerAccount}
            format={(v) => `¥${v}`} hint="灰产 Pro ≈ ¥160；官方 $200 ≈ ¥1,440" />
          <Slider icon="users" label="Pro 账号数 N" min={1} max={30} step={1}
            value={accounts} onChange={setAccounts}
            format={(v) => `${v} 个`} />
          <Slider icon="layers" label="模型系数 M" min={0.3} max={1.5} step={0.05}
            value={modelMix} onChange={setModelMix}
            format={(v) => v.toFixed(2)} hint="全 gpt-5.4 = 1.0；全 gpt-5.5 = 0.5" />
          <Slider icon="shield" label="安全系数 S" min={1.0} max={2.0} step={0.05}
            value={safety} onChange={setSafety}
            format={(v) => v.toFixed(2)} hint="1.0 = 纯保本；1.3 = 含封号/客服缓冲" />
        </div>
        <div className="p-output">
          <div className="p-output-row">
            <div className="p-kpi positive">
              <div className="p-kpi-lbl">月收入</div>
              <div className="p-kpi-val">{fmtRmb(monthlyRevenue)}</div>
            </div>
            <div className="p-kpi negative">
              <div className="p-kpi-lbl">月成本</div>
              <div className="p-kpi-val">{fmtRmb(monthlyCost)}</div>
            </div>
            <div className={`p-kpi ${monthlyProfit >= 0 ? 'positive' : 'negative'}`}>
              <div className="p-kpi-lbl">月净利</div>
              <div className="p-kpi-val">{fmtRmb(monthlyProfit)}</div>
            </div>
          </div>

          <div className="p-output-row">
            <div className="p-kpi neutral" style={{ gridColumn: 'span 2' }}>
              <div className="p-kpi-lbl">保本价 P_min (S = {S.toFixed(1)})</div>
              <div className="p-kpi-val" style={{ fontSize: 18 }}>{fmtRmbSmall(breakEvenPrice)}</div>
              <div className="p-sub">纯保本 {fmtRmbSmall(breakEvenPricePure)}；当前定价是 <strong>{priceSafetyFactor.toFixed(2)}×</strong> 保本线</div>
            </div>
            <div className="p-kpi neutral">
              <div className="p-kpi-lbl">保本率 U_min</div>
              <div className="p-kpi-val">{fmtPct(breakEvenUtilization)}</div>
              <div className="p-sub">定价 ¥{P.toFixed(3)} 下</div>
            </div>
          </div>

          <div className="p-target">
            <div className="p-target-title">
              <Icon n="target" />
              达到目标月净利需要的定价
            </div>
            <Slider icon="dollar" label="目标月净利" min={500} max={30000} step={100}
              value={targetProfit} onChange={setTargetProfit}
              format={(v) => fmtRmb(v)} />
            <div className="p-table-wrap" style={{ marginTop: 10 }}>
              <table className="p-table">
                <thead>
                  <tr>
                    <th>利用率</th>
                    <th className="p-num">需要定价 (RMB/$1)</th>
                    <th style={{ textAlign: 'center' }}>是否可行</th>
                  </tr>
                </thead>
                <tbody>
                  {priceRecsForTargetProfit.map((r) => (
                    <tr key={r.u}>
                      <td>{fmtPct(r.u)}</td>
                      <td className="p-num">{fmtRmbSmall(r.requiredP)}</td>
                      <td style={{ textAlign: 'center' }}>
                        {r.feasible
                          ? <span className="p-badge positive">可行</span>
                          : <span className="p-badge error">不可行 超 ¥1</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* ── 保本扫描 ─────────────────────────────────────────────── */}
      <SectionTitle icon="trendDown" title="保本价扫描" hint={`基于 C=¥${C}  K=$${Math.round(K)}/月/号  M=${M.toFixed(2)}`} />
      <div className="p-table-wrap">
        <table className="p-table">
          <thead>
            <tr>
              <th>利用率 U</th>
              <th className="p-num">纯保本 P_min (S=1.0)</th>
              <th className="p-num">安全保本 P_min (S={S.toFixed(1)})</th>
              <th className="p-num">当前 P={P.toFixed(3)} 月净利</th>
            </tr>
          </thead>
          <tbody>
            {breakEvenScans.map((row) => (
              <tr key={row.u}>
                <td style={{ fontWeight: 600 }}>{fmtPct(row.u)}</td>
                <td className="p-num">{fmtRmbSmall(row.pMinPure)}</td>
                <td className="p-num">{fmtRmbSmall(row.pMin)}</td>
                <td className={`p-num ${row.profitAtCurrent >= 0 ? 'p-pos' : 'p-neg'}`}>
                  {fmtRmb(row.profitAtCurrent)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── U × P 矩阵 ─────────────────────────────────────────── */}
      <SectionTitle icon="grid" title="月净利矩阵（U × P）" hint={`${N} 个账号 · 黄色高亮为当前调参点`} />
      <div className="p-table-wrap" style={{ overflowX: 'auto' }}>
        <table className="p-table">
          <thead>
            <tr>
              <th>U \ P</th>
              {[0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.30].map((p) => (
                <th key={p} className="p-num">¥{p.toFixed(2)}/$1</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row) => (
              <tr key={row.u}>
                <td style={{ fontWeight: 700 }}>{fmtPct(row.u)}</td>
                {row.cells.map((c) => {
                  const isCurrent = Math.abs(c.p - P) < 0.005 && Math.abs(c.u - U) < 0.005;
                  return (
                    <td
                      key={c.p}
                      className={`p-num ${isCurrent ? 'p-cell-hi' : (c.profit >= 0 ? 'p-pos' : 'p-neg')}`}
                    >
                      {c.profit.toFixed(0)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="p-note">单位：¥/月 · 负数 = 亏</div>

      {/* ── 套餐毛利分析 ─────────────────────────────────────── */}
      <SectionTitle icon="cards" title="Pro 池套餐毛利分析" hint="来自 aidistri.plans (channel_ids=[13])" />
      <div className="p-table-wrap" style={{ overflowX: 'auto' }}>
        <table className="p-table">
          <thead>
            <tr>
              <th>套餐</th>
              <th className="p-num">售价</th>
              <th className="p-num">$ 额度</th>
              <th className="p-num">天数</th>
              <th className="p-num">单价 ¥/$</th>
              <th className="p-num">全烧 Pro 成本</th>
              <th className="p-num">全烧毛利</th>
              <th className="p-num">半烧毛利</th>
            </tr>
          </thead>
          <tbody>
            {planMargin.length === 0 && (
              <tr><td colSpan={8} className="p-empty">暂无 Pro 池套餐数据</td></tr>
            )}
            {planMargin.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="p-num">{fmtRmb(p.priceRmb, 2)}</td>
                <td className="p-num">${p.quotaUsd}</td>
                <td className="p-num">{p.durationDays}d</td>
                <td className="p-num">¥{p.unitPriceRmb?.toFixed(3)}</td>
                <td className="p-num">{fmtRmb(p.cardFullBurnProCost, 2)}</td>
                <td className={`p-num ${p.cardProfitFullBurn >= 0 ? 'p-pos' : 'p-neg'}`}>
                  {fmtRmb(p.cardProfitFullBurn, 2)}
                </td>
                <td className={`p-num ${p.cardProfitHalfBurn >= 0 ? 'p-pos' : 'p-neg'}`}>
                  {fmtRmb(p.cardProfitHalfBurn, 2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="p-note">全烧毛利 = 客户完全消耗掉 $ 额度时的毛利；半烧 = 只消耗一半（常见的真实情况）</div>

      {/* ── 销量表 ─────────────────────────────────────────── */}
      <SectionTitle
        icon="trendUp"
        title="最近 30 天销量"
        hint={data?.pool?.sharedChannel ? `共享 channel ${data?.pool?.newapiChannelId}：与其他池共用销售` : null}
      />
      <div className="p-table-wrap">
        <table className="p-table">
          <thead>
            <tr>
              <th>套餐</th>
              <th className="p-num">张数</th>
              <th className="p-num">收入</th>
              <th className="p-num">$ 额度</th>
              <th className="p-num">天数</th>
              <th className="p-num">烧 %</th>
            </tr>
          </thead>
          <tbody>
            {proPoolSales.length === 0 && (
              <tr><td colSpan={6} className="p-empty">
                <span className="p-badge warning">0 销量</span>
                <div style={{ marginTop: 6 }}>这个池子的套餐最近没成交</div>
              </td></tr>
            )}
            {proPoolSales.map((s) => (
              <tr key={s.planId}>
                <td>{s.planName}</td>
                <td className="p-num">{s.sold}</td>
                <td className="p-num">{fmtRmb(s.revenueRmb, 2)}</td>
                <td className="p-num">${s.quotaUsd ?? '--'}</td>
                <td className="p-num">{s.durationDays ?? '--'}d</td>
                <td className="p-num">{s.burnRate != null ? fmtPct(s.burnRate) : '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data?.pool?.sharedChannel && (
        <div className="p-note">
          共享 channel 提示：上表为 channel {data?.pool?.newapiChannelId} 的全部销量；按本池消耗占比 ({fmtPct(data?.consumption?.shareOfChannel)}) 归属给 {currentPoolMeta.label} 的收入 ≈ {fmtRmb((proPoolSalesRevenue || 0) * (data?.consumption?.shareOfChannel || 0))}。
        </div>
      )}

      {/* ── 模型消耗 ─────────────────────────────────────────── */}
      <SectionTitle icon="fire" title={`最近 ${data?.consumption?.windowDays ?? 7} 天 Pro 池按模型消耗`} />
      <div className="p-table-wrap">
        <table className="p-table">
          <thead>
            <tr>
              <th>模型</th>
              <th className="p-num">请求数</th>
              <th className="p-num">prompt tokens</th>
              <th className="p-num">completion tokens</th>
              <th className="p-num">客户扣费</th>
            </tr>
          </thead>
          <tbody>
            {data?.consumption?.byModel?.length
              ? data.consumption.byModel.map((m) => (
                <tr key={m.model}>
                  <td style={{ fontWeight: 600 }}>{m.model}</td>
                  <td className="p-num">{m.reqs.toLocaleString()}</td>
                  <td className="p-num">{fmtM(m.promptTokens)}</td>
                  <td className="p-num">{fmtM(m.completionTokens)}</td>
                  <td className="p-num">{fmtUsd(m.quotaUsd, 2)}</td>
                </tr>
              ))
              : <tr><td colSpan={5} className="p-empty">暂无消耗数据</td></tr>}
          </tbody>
        </table>
      </div>

      {/* ── 账号清单 ─────────────────────────────────────── */}
      <SectionTitle
        icon="cpu"
        title={`${currentPoolMeta.label} 账号实时容量`}
        hint={`${data?.proPool?.accounts?.length || 0} 个${data?.proPool?.accountsTruncated ? ' · 仅显示最活跃 120 个' : ''}`}
      />
      <div className="p-table-wrap">
        <table className="p-table">
          <thead>
            <tr>
              <th>账号</th>
              <th className="p-num">账龄</th>
              <th style={{ textAlign: 'center' }}>状态</th>
              {data?.proPool?.tiersSupported?.length > 0 && (
                <th style={{ textAlign: 'center' }}>档位</th>
              )}
              {data?.proPool?.tiersSupported?.length > 0 && (
                <th className="p-num">月成本</th>
              )}
              <th className="p-num">5h 用掉</th>
              <th className="p-num">7d 用掉</th>
              <th className="p-num">7d 折算 $</th>
              <th className="p-num">快照</th>
            </tr>
          </thead>
          <tbody>
            {data?.proPool?.accounts?.length
              ? data.proPool.accounts.map((a) => (
                <tr key={a.uuid}>
                  <td title={a.uuid}>{a.customName || a.uuid.slice(0, 8)}</td>
                  <td className="p-num">{a.ageDays}d</td>
                  <td style={{ textAlign: 'center' }}>
                    {a.isDisabled
                      ? <span className="p-badge warning">停用</span>
                      : a.isHealthy
                      ? <span className="p-badge positive">健康</span>
                      : <span className="p-badge error">异常</span>}
                  </td>
                  {data?.proPool?.tiersSupported?.length > 0 && (
                    <td style={{ textAlign: 'center' }}>
                      <select
                        className={`p-tier-select ${savingTier === a.uuid ? 'saving' : ''}`}
                        value={a.tier || ''}
                        disabled={savingTier === a.uuid}
                        onChange={(e) => handleTierChange(a.uuid, e.target.value)}
                      >
                        <option value="">未设</option>
                        {data.proPool.tiersSupported.map(t => (
                          <option key={t.key} value={t.key}>{t.label}</option>
                        ))}
                      </select>
                    </td>
                  )}
                  {data?.proPool?.tiersSupported?.length > 0 && (
                    <td className="p-num">{fmtRmb(a.monthlyCostRmb, 0)}</td>
                  )}
                  <td className="p-num">{a.hourlyPct != null ? `${a.hourlyPct}%` : '--'}</td>
                  <td className="p-num">{a.weeklyPct != null ? `${a.weeklyPct}%` : '--'}</td>
                  <td className="p-num">
                    {a.dollars7dCustomer != null
                      ? fmtUsd(a.dollars7dCustomer, 2)
                      : (a.dollars7dApi != null ? <span className="p-muted">API价 {fmtUsd(a.dollars7dApi, 2)}</span> : '--')}
                  </td>
                  <td className="p-num p-muted">{fmtDateTime(a.snapshotAt)}</td>
                </tr>
              ))
              : <tr><td colSpan={9} className="p-empty">无账号</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
