import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

type RecItem = {
  symbol: string;
  name: string;
  score?: number;
  price?: number;
  signals?: string[];
  change_pct?: number;
  eligible_for_paper?: boolean;
  score_detail?: { pool_match?: boolean; missing?: string[] };
};
type RecRow = {
  id: string;
  date: string;
  stage: string;
  createdAt: string;
  marketEmotion?: string;
  source?: string;
  model_status?: string;
  items: RecItem[];
};
type Quote = { symbol: string; price?: number };
type Auction = {
  state?: string;
  trade_date?: string;
  items?: Array<{
    thscode?: string;
    ticker?: string;
    name?: string;
    auction_pct?: number;
    tags?: string[];
  }>;
};
type Abnormal = {
  symbol: string;
  name?: string;
  change_pct?: number;
  vol_ratio_5d?: number;
  signals?: string[];
  consecutive_limit_ups?: number;
};

const API = "/quant/api";
const advice = (row: Abnormal) =>
  row.signals?.includes("broken")
    ? "炸板分歧：谨慎，优先看龙头承接"
    : row.signals?.some((x) => /limit|new_high/.test(x))
      ? "强势异动：观察板块龙头与量能，不追高"
      : row.vol_ratio_5d && row.vol_ratio_5d >= 2
        ? "放量异动：关注是否带动同板块"
        : "价格异动：等待确认";
const recommendationReturn = (entry?: number, current?: number) => {
  const base = Number(entry),
    latest = Number(current);
  if (
    !Number.isFinite(base) ||
    base <= 0 ||
    !Number.isFinite(latest) ||
    latest <= 0
  )
    return null;
  return (latest / base - 1) * 100;
};

export function RecommendationPage() {
  const [rows, setRows] = useState<RecRow[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [auction, setAuction] = useState<Auction | null>(null);
  const [intraday, setIntraday] = useState<Abnormal[]>([]);
  const [refreshSec, setRefreshSec] = useState(5);
  const [stage, setStage] = useState("全部");
  const [message, setMessage] = useState("");
  const load = () => {
    fetch(`${API}/myagent/recommendations`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const b = await r.json();
        setRows(Array.isArray(b.items) ? b.items : []);
      })
      .catch(() => setRows([]));
    fetch(`${API}/market-recap/auction-benchmark`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setAuction)
      .catch(() => setAuction(null));
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    const refresh = () =>
      fetch(`${API}/abnormal/intraday?limit=30`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => setIntraday(b?.rows || []))
        .catch(() => setIntraday([]));
    refresh();
    const timer = window.setInterval(refresh, refreshSec * 1000);
    return () => window.clearInterval(timer);
  }, [refreshSec]);
  useEffect(() => {
    const symbols = [
      ...new Set(rows.flatMap((r) => r.items.map((i) => i.symbol))),
    ].join(",");
    if (!symbols) return;
    fetch(
      `${API}/myagent/quant/quotes?symbols=${encodeURIComponent(symbols)}`,
      { credentials: "include" },
    )
      .then((r) => r.json())
      .then((b) =>
        setQuotes(
          Object.fromEntries((b.items || []).map((x: Quote) => [x.symbol, x])),
        ),
      )
      .catch(() => setQuotes({}));
  }, [rows]);
  const today = new Date().toLocaleDateString("sv-SE");
  const visible = rows.filter(
    (r) => r.date === today && (stage === "全部" || r.stage === stage),
  );
  const performance = useMemo(() => {
    const points = visible
      .flatMap((row) =>
        row.items.map((item) => ({
          stage: row.stage,
          change: recommendationReturn(item.price, quotes[item.symbol]?.price),
        })),
      )
      .filter(
        (item): item is { stage: string; change: number } =>
          item.change != null,
      );
    const summarize = (values: number[]) => ({
      count: values.length,
      wins: values.filter((value) => value >= 0).length,
      average: values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null,
      best: values.length ? Math.max(...values) : null,
      worst: values.length ? Math.min(...values) : null,
    });
    const byStage = ["集合竞价", "盘中推荐", "其他时间轮动"]
      .map((stageName) => ({
        stage: stageName,
        ...summarize(
          points
            .filter((point) => point.stage === stageName)
            .map((point) => point.change),
        ),
      }))
      .filter((item) => item.count > 0);
    return { ...summarize(points.map((point) => point.change)), byStage };
  }, [visible, quotes]);
  const execute = async (id: string) => {
    setMessage("正在提交到暗黑模拟盘…");
    try {
      const r = await fetch(
        `${API}/myagent/recommendations/${encodeURIComponent(id)}/paper-execute?account=default`,
        { method: "POST", credentials: "include" },
      );
      const b = await r.json();
      if (!r.ok) throw new Error(b.detail);
      setMessage(`已提交 ${b.orders?.length || 0} 笔模拟委托`);
    } catch (e) {
      setMessage(`执行失败：${e instanceof Error ? e.message : "未知错误"}`);
    }
  };
  return (
    <div className="h-full overflow-auto bg-base p-3 text-foreground">
      <header className="mb-3 flex items-center justify-between rounded-card border border-border bg-surface p-4">
        <div>
          <h1 className="text-base font-semibold">今日推荐</h1>
          <p className="mt-1 text-xs text-muted">
            竞价、盘中异动和拾贝候选独立展示；不相互替代。
          </p>
        </div>
        <button
          onClick={load}
          className="rounded border border-accent/60 px-3 py-2 text-xs text-accent"
        >
          刷新
        </button>
      </header>
      <section className="mb-3 rounded-card border border-warning/30 bg-warning/5 p-3">
        <div className="flex justify-between">
          <b className="text-warning">集合竞价风向标</b>
          <span className="text-[10px] text-muted">
            {auction?.trade_date || "今日"} · {auction?.state || "读取中"}
          </span>
        </div>
        {auction?.state === "ok" && auction.items?.length ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {auction.items.slice(0, 10).map((x) => (
              <Link
                key={x.thscode || x.ticker}
                to={`/stock-analysis?symbol=${encodeURIComponent(x.thscode || x.ticker || "")}`}
                className="rounded border border-border p-2 text-xs"
              >
                <b>{x.name || x.ticker}</b>
                <div className="text-warning">
                  竞价{" "}
                  {x.auction_pct == null
                    ? "—"
                    : `${Number(x.auction_pct).toFixed(2)}%`}
                </div>
                <div className="text-muted">
                  {(x.tags || []).slice(0, 2).join(" · ")}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">
            竞价源暂无可核验名单，不用拾贝替代。
          </p>
        )}
      </section>
      <section className="mb-3 rounded-card border border-sky-400/30 bg-sky-400/5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <b className="text-sky-300">盘中实时异动推荐</b>
          <label className="text-[10px] text-muted">
            刷新{" "}
            <select
              value={refreshSec}
              onChange={(e) => setRefreshSec(Number(e.target.value))}
              className="ml-1 rounded border border-border bg-base px-1 py-0.5"
            >
              <option value={1}>1秒</option>
              <option value={3}>3秒</option>
              <option value={5}>5秒</option>
              <option value={10}>10秒</option>
              <option value={30}>30秒</option>
            </select>
          </label>
        </div>
        {intraday.length ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {intraday.slice(0, 12).map((x) => (
              <Link
                key={x.symbol}
                to={`/stock-analysis?symbol=${encodeURIComponent(x.symbol)}`}
                className="rounded border border-border bg-base/50 p-2 text-xs"
              >
                <div className="flex justify-between">
                  <b>{x.name || x.symbol}</b>
                  <span
                    className={
                      Number(x.change_pct) >= 0 ? "text-bull" : "text-bear"
                    }
                  >
                    {x.change_pct == null
                      ? "—"
                      : `${Number(x.change_pct).toFixed(2)}%`}
                  </span>
                </div>
                <div className="mt-1 text-[10px] text-muted">
                  {(x.signals || []).join(" · ") || "价格异动"} · 量比{" "}
                  {x.vol_ratio_5d == null
                    ? "—"
                    : Number(x.vol_ratio_5d).toFixed(2)}
                </div>
                <div className="mt-1 text-[10px] text-sky-300">{advice(x)}</div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">当前没有可核验盘中异动。</p>
        )}
      </section>
      <div className="mb-3 flex gap-2">
        {["全部", "集合竞价", "盘中推荐", "其他时间轮动"].map((v) => (
          <button
            key={v}
            onClick={() => setStage(v)}
            className={`rounded border px-3 py-1 text-xs ${stage === v ? "border-accent text-accent" : "border-border text-muted"}`}
          >
            {v}
          </button>
        ))}
        <Link
          to="/pick-model"
          className="rounded border border-border px-3 py-1 text-xs text-accent"
        >
          拾贝模型
        </Link>
      </div>
      {message && <p className="mb-2 text-xs text-accent">{message}</p>}
      <section className="mb-3 rounded-card border border-border bg-surface p-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <b>今日推荐效果</b>
          <span className="text-muted">
            以推荐价到最新报价计算，未成交、手续费和隔夜风险不计入。
          </span>
        </div>
        {performance.count ? (
          <>
            <div className="mt-2 grid gap-2 sm:grid-cols-4">
              <span className="rounded bg-elevated p-2">
                已跟踪
                <br />
                <b>{performance.count} 只</b>
              </span>
              <span className="rounded bg-elevated p-2">
                浮动胜率
                <br />
                <b>
                  {((performance.wins / performance.count) * 100).toFixed(1)}%
                </b>
              </span>
              <span className="rounded bg-elevated p-2">
                平均涨跌
                <br />
                <b
                  className={
                    Number(performance.average) >= 0 ? "text-bull" : "text-bear"
                  }
                >
                  {Number(performance.average) >= 0 ? "+" : ""}
                  {performance.average!.toFixed(2)}%
                </b>
              </span>
              <span className="rounded bg-elevated p-2">
                最佳 / 最差
                <br />
                <b>
                  {performance.best!.toFixed(2)}% /{" "}
                  {performance.worst!.toFixed(2)}%
                </b>
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted">
              {performance.byStage.map((item) => (
                <span
                  key={item.stage}
                  className="rounded border border-border px-2 py-1"
                >
                  {item.stage}：{item.count} 只 · 胜率{" "}
                  {((item.wins / item.count) * 100).toFixed(0)}% · 均值{" "}
                  {item.average! >= 0 ? "+" : ""}
                  {item.average!.toFixed(2)}%
                </span>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-2 text-muted">
            当前没有同时具备推荐价和最新报价的股票，暂不计算胜率。
          </p>
        )}
      </section>
      <div className="space-y-2">
        {visible.map((row) => (
          <section
            key={row.id}
            className="rounded-card border border-border bg-surface p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <b>{row.stage}</b>
                <span className="ml-2 text-[10px] text-muted">
                  {row.createdAt.slice(11, 16)} · {row.source || "页面快照"}
                </span>
              </div>
              <button
                onClick={() => void execute(row.id)}
                className="rounded border border-accent/60 px-2 py-1 text-[10px] text-accent"
              >
                执行到暗黑模拟盘
              </button>
            </div>
            <p className="mt-1 text-[10px] text-warning">
              {row.model_status || "请展开个股查看依据；推荐不等于买入指令。"}
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {row.items.map((i) =>
                (() => {
                  const currentPrice = quotes[i.symbol]?.price;
                  const change = recommendationReturn(i.price, currentPrice);
                  return (
                    <Link
                      key={i.symbol}
                      to={`/stock-analysis?symbol=${encodeURIComponent(i.symbol)}`}
                      className="rounded border border-border p-2 text-xs"
                    >
                      <b>{i.name}</b>
                      <div className="text-muted">
                        {row.createdAt.slice(11, 16)} 推荐 {i.price ?? "—"} ·
                        当前 {currentPrice ?? "—"}
                      </div>
                      <div className="text-accent">
                        信号 {i.signals?.join(" · ") || "拾贝评分"}{" "}
                        {i.signals?.length ? "" : (i.score ?? "—")}
                      </div>
                      <div
                        className={
                          change == null
                            ? "mt-1 text-[10px] text-muted"
                            : change >= 0
                              ? "mt-1 text-[10px] text-bull"
                              : "mt-1 text-[10px] text-bear"
                        }
                      >
                        推荐后{" "}
                        {change == null
                          ? "待当前报价"
                          : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}{" "}
                        · 准入 {i.score ?? "—"}
                        {i.eligible_for_paper ? " · 可进模拟池" : " · 仅观察"}
                        {i.score_detail?.pool_match ? " · 资料池命中" : ""}
                      </div>
                    </Link>
                  );
                })(),
              )}
            </div>
          </section>
        ))}
        {!visible.length && (
          <div className="rounded-card border border-border p-8 text-center text-xs text-muted">
            今日还没有保存的候选快照；后端会在竞价与盘中窗口自动记录可核验信号。
          </div>
        )}
      </div>
    </div>
  );
}
