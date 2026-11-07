import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, Search, Settings2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { HoldingsWidget } from '@/components/dashboard/MyAgentWidgets'
import { setUiPref } from '@/lib/uiPrefs'

type NewsItem = { title: string; url: string; source: string; published_at: string; relevance: string; watch_reason: string;
  bias: '可能利好' | '可能利空' | '待判断'; bias_reason: string; sector_names: string[] }
type Sector = { name: string; theme: string; count: number; positive: number; negative: number }
type Feed = { items: NewsItem[]; sectors: Sector[]; total_items: number; fetched_at: string; status: string; notice: string; source: string }
const API = '/quant/api/myagent/quant/news'
const SECTOR_PREF = 'tf-news-sectors'
const INTERVAL_PREF = 'tf-news-interval'
const DEFAULT_SECTORS = ['CPO光通信', '半导体芯片', 'AI算力硬件', '服务器液冷', '创新药', '人形机器人']
const intervals = [1, 3, 5, 10, 15]
function initialSectors(): string[] {
  try { const value = localStorage.getItem(SECTOR_PREF); return value ? JSON.parse(value) as string[] : DEFAULT_SECTORS } catch { return DEFAULT_SECTORS }
}
function initialInterval(): number {
  const value = Number(localStorage.getItem(INTERVAL_PREF))
  return intervals.includes(value) ? value : 5
}
function dateLabel(value?: string) {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

/** One unified sector newsroom. The backend always collects all sectors. */
export function MarketNews() {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string[]>(initialSectors)
  const [interval, setInterval] = useState<number>(initialInterval)
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [sectorSearch, setSectorSearch] = useState('')
  const [activeSector, setActiveSector] = useState<string>('全部')
  const [bias, setBias] = useState<string>('全部')
  const [scope, setScope] = useState<'全部新闻' | '关注板块' | '持仓相关'>('全部新闻')
  const [sort, setSort] = useState<'最新优先' | '相关优先'>('最新优先')
  const [analysis, setAnalysis] = useState('')
  const [analyzingUrl, setAnalyzingUrl] = useState('')
  const [visibleCount, setVisibleCount] = useState(80)
  const news = useQuery({ queryKey: ['myagent-quant-news', interval], queryFn: async () => {
    const response = await fetch(`${API}?interval=${interval}`, { credentials: 'include' })
    if (!response.ok) throw new Error(`新闻请求失败 ${response.status}`)
    return response.json() as Promise<Feed>
  }, refetchInterval: interval * 60_000 })
  const feed = news.data
  const catalog = feed?.sectors ?? []
  const selectedCatalog = selected.map(name => catalog.find(row => row.name === name) ?? { name, theme: '', count: 0, positive: 0, negative: 0 })
  const filtered = useMemo(() => {
    const rows = (feed?.items ?? []).filter(row =>
      (activeSector === '全部' || row.sector_names.includes(activeSector)) &&
      (bias === '全部' || row.bias === bias) &&
      (scope !== '关注板块' || row.sector_names.some(name => selected.includes(name))) &&
      (scope !== '持仓相关' || row.relevance === '持仓相关'))
    if (sort === '相关优先') {
      const priority: Record<string, number> = { '持仓相关': 0, '板块相关': 1, '市场相关': 2, '其他': 3 }
      rows.sort((a, b) => (priority[a.relevance] ?? 4) - (priority[b.relevance] ?? 4) || b.published_at.localeCompare(a.published_at))
    }
    return rows
  }, [feed, selected, activeSector, bias, scope, sort])
  const changeSectors = (next: string[]) => { setSelected(next); setUiPref(SECTOR_PREF, JSON.stringify(next)); setActiveSector('全部') }
  const changeInterval = (next: number) => { setInterval(next); setUiPref(INTERVAL_PREF, String(next)) }
  const analyze = async (item: NewsItem) => {
    setAnalyzingUrl(item.url); setAnalysis('')
    try {
      const response = await fetch('/quant/api/myagent/chat', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message:
          `请结合我的已记录持仓、当前行情、新闻原文，研判可能影响的板块和股票、影响方向与验证条件。若不能读原文或实时行情请明说。标题关键词初判：${item.bias}；板块：${item.sector_names.join('、')}。新闻：${item.title} ${item.url}` }) })
      const body = await response.json() as { reply?: string; detail?: string }
      if (!response.ok) throw new Error(body.detail ?? `请求失败 ${response.status}`)
      setAnalysis(body.reply ?? '未返回分析')
    } catch (error) { setAnalysis(`AI研判暂不可用：${(error as Error).message}`) } finally { setAnalyzingUrl('') }
  }
  return <div className="h-full overflow-auto bg-base p-4 text-foreground lg:p-5">
    <div className="mx-auto max-w-[1900px] space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-border bg-surface p-4">
        <div><h1 className="text-xl font-semibold">市场资讯中心</h1>
          <p className="mt-1 text-sm text-secondary">全市场新闻库 · 自选板块摘要 · 持仓关联 · 标题方向初判</p>
          <p className="mt-1 text-xs text-muted">来源：{feed?.source ?? '公开新闻源'} · 上次采集 {dateLabel(feed?.fetched_at)} {feed?.status === 'stale' ? '· 数据可能过期' : ''}</p></div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2 rounded border border-border px-2 py-1.5">采样间隔
            <select aria-label="新闻采样间隔" className="bg-base" value={interval} onChange={e => changeInterval(Number(e.target.value))}>{intervals.map(value => <option key={value} value={value}>{value} 分钟</option>)}</select></label>
          <button type="button" className="flex items-center gap-1 rounded border border-border px-3 py-1.5 hover:bg-elevated" onClick={() => void queryClient.invalidateQueries({ queryKey: ['myagent-quant-news'] })}><RefreshCw size={15} />刷新</button>
          <button type="button" className="flex items-center gap-1 rounded border border-border px-3 py-1.5 hover:bg-elevated" onClick={() => setSelectorOpen(!selectorOpen)}><Settings2 size={15} />管理关注板块</button>
          <Link to="/" className="rounded border border-border px-3 py-1.5 hover:bg-elevated">返回看板</Link>
        </div>
      </header>
      {selectorOpen && <section className="rounded-card border border-accent/40 bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">选择显示的板块</h2><p className="text-xs text-muted">仅改变页面摘要，后台仍采集并保存所有板块新闻。点击卡片可筛选新闻。</p></div>
          <label className="flex items-center gap-1 rounded border border-border px-2 py-1"><Search size={14} /><input aria-label="搜索新闻板块" placeholder="搜索板块" className="bg-transparent outline-none" value={sectorSearch} onChange={e => setSectorSearch(e.target.value)} /></label></div>
        <div className="mt-3 flex flex-wrap gap-2">{catalog.filter(row => row.name.includes(sectorSearch) || row.theme.includes(sectorSearch)).map(row => <label key={row.name} className="flex cursor-pointer items-center gap-2 rounded border border-border px-2 py-1.5 text-sm hover:bg-elevated"><input type="checkbox" checked={selected.includes(row.name)} onChange={() => changeSectors(selected.includes(row.name) ? selected.filter(name => name !== row.name) : [...selected, row.name])} />{row.name}<span className="text-xs text-muted">{row.count}</span></label>)}</div>
      </section>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[['新闻库', feed?.total_items ?? '—'], ['覆盖板块', catalog.filter(row => row.count > 0).length], ['关注板块', selected.length], ['持仓相关', feed?.items.filter(row => row.relevance === '持仓相关').length ?? '—']].map(([label, value]) => <div key={label} className="rounded-card border border-border bg-surface p-3"><p className="text-xs text-muted">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>)}
      </div>
      <section className="rounded-card border border-border bg-surface p-4"><div className="flex items-center justify-between"><div><h2 className="font-semibold">关注板块摘要</h2><p className="text-xs text-muted">选择要看的板块；数字为已采集新闻中的标题匹配数</p></div><button className="text-sm text-accent" onClick={() => setSelectorOpen(true)}>添加 / 删除板块</button></div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{selectedCatalog.map(row => {
          const latest = feed?.items.filter(item => item.sector_names.includes(row.name)).slice(0, 2) ?? []
          return <button type="button" key={row.name} onClick={() => { setActiveSector(row.name); setScope('全部新闻') }} className={`min-h-[150px] rounded border p-3 text-left hover:border-accent ${activeSector === row.name ? 'border-accent bg-accent/5' : 'border-border bg-base'}`}>
            <div className="flex items-center justify-between"><h3 className="font-semibold">{row.name}</h3><span className="text-lg font-bold text-accent">{row.count}</span></div><p className="truncate text-xs text-muted">{row.theme || '板块资讯'}</p><p className="mt-2 text-xs"><span className="text-bull">利好线索 {row.positive}</span><span className="ml-3 text-bear">利空线索 {row.negative}</span></p>
            {latest.length ? latest.map(item => <p key={item.url} className="mt-1 truncate text-xs text-secondary">· {item.title}</p>) : <p className="mt-2 text-xs text-muted">当前采集范围内暂无匹配消息</p>}
          </button>})}</div>
      </section>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2.2fr)_minmax(320px,1fr)]">
        <section className="min-w-0 rounded-card border border-border bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">统一新闻流</h2><p className="text-xs text-muted">{filtered.length} 条 · 点击标题核对原文</p></div>
          <div className="flex flex-wrap gap-2 text-xs"><button className="text-accent" onClick={() => setActiveSector('全部')}>{activeSector === '全部' ? '全部板块' : `${activeSector} ×`}</button>
            <select aria-label="新闻范围" className="rounded border border-border bg-base p-1" value={scope} onChange={e => setScope(e.target.value as typeof scope)}>{['全部新闻', '关注板块', '持仓相关'].map(value => <option key={value}>{value}</option>)}</select>
            <select aria-label="利好利空" className="rounded border border-border bg-base p-1" value={bias} onChange={e => setBias(e.target.value)}>{['全部', '可能利好', '可能利空', '待判断'].map(value => <option key={value}>{value}</option>)}</select>
            <select aria-label="新闻排序" className="rounded border border-border bg-base p-1" value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option>最新优先</option><option>相关优先</option></select></div></div>
          {news.isLoading && <p className="py-6 text-sm text-muted">正在采集新闻…</p>}{news.isError && <p className="py-6 text-sm text-danger">{(news.error as Error).message}</p>}
          {analysis && <div className="mt-3 whitespace-pre-wrap rounded border border-accent/40 bg-accent/5 p-3 text-sm">{analysis}</div>}
          {!news.isLoading && !filtered.length && <p className="py-6 text-sm text-muted">当前条件下暂无新闻，请切换板块或范围。</p>}
          <div className="mt-2 max-h-[760px] overflow-auto">{filtered.slice(0, visibleCount).map(item => <article key={item.url} className="border-b border-border py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted"><span className={item.bias === '可能利好' ? 'text-bull' : item.bias === '可能利空' ? 'text-bear' : ''}>{item.bias}</span><span>{item.relevance}</span><span>{item.source}</span><time className="ml-auto">{dateLabel(item.published_at)}</time></div>
            <a href={item.url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-sm font-medium hover:text-accent">{item.title} <ExternalLink size={12} className="inline" /></a>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted"><span>{item.sector_names.join('、') || '未识别板块'}</span><span>· {item.watch_reason}</span><button type="button" disabled={Boolean(analyzingUrl)} onClick={() => void analyze(item)} className="ml-auto text-accent disabled:opacity-50">{analyzingUrl === item.url ? '研判中…' : 'AI研判'}</button></div>
          </article>)}{filtered.length > visibleCount && <button type="button" onClick={() => setVisibleCount(value => value + 80)} className="mt-3 w-full rounded border border-border p-2 text-sm text-accent hover:bg-elevated">加载更多（还有 {filtered.length - visibleCount} 条）</button>}</div><p className="mt-2 text-xs text-muted">{feed?.notice}</p></section>
        <aside className="space-y-3"><div className="min-h-[400px]"><HoldingsWidget /></div><div className="rounded-card border border-border bg-surface p-4"><h2 className="font-semibold">资讯来源</h2><p className="mt-1 text-xs text-muted">东方财富和同花顺公开滚动页已采集标题与链接；金十需授权接口，暂提供原站入口。</p>
          <div className="mt-3 flex flex-wrap gap-2 text-sm"><a target="_blank" rel="noopener noreferrer" href="https://news.10jqka.com.cn/thsgd_list/index.shtml" className="rounded border border-border px-3 py-2 hover:bg-elevated">同花顺滚动新闻 ↗</a><a target="_blank" rel="noopener noreferrer" href="https://www.jin10.com/" className="rounded border border-border px-3 py-2 hover:bg-elevated">金十数据 ↗</a><a target="_blank" rel="noopener noreferrer" href="https://roll.eastmoney.com/" className="rounded border border-border px-3 py-2 hover:bg-elevated">东方财富 ↗</a></div>
        </div></aside>
      </div>
    </div>
  </div>
}
