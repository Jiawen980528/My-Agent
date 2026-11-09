import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

export function SharedAISelector({ compact = false, disabled = false, onSelected }: { compact?: boolean; disabled?: boolean; onSelected?: () => void }) {
  const qc = useQueryClient()
  const profiles = useQuery({ queryKey: QK.sharedAiProfiles, queryFn: api.sharedAiProfiles })
  const selection = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'auto' | 'manual' }) => api.selectSharedAi(id, mode),
    onSuccess: () => {
      onSelected?.()
      qc.invalidateQueries({ queryKey: QK.sharedAiProfiles })
      qc.invalidateQueries({ queryKey: QK.settings })
    },
  })
  if (profiles.isError) return <span className="text-xs text-danger">无法读取统一 AI 配置</span>
  const data = profiles.data
  return <select aria-label="全站 AI 模型" title="所有助手共用此选择；自动模式仅在尚未返回内容时切换备用接口"
    disabled={disabled || selection.isPending || !data?.items.length}
    value={data?.mode === 'manual' ? data.active_id : 'auto'}
    onChange={event => {
      const value = event.target.value
      if (data) selection.mutate({ id: value === 'auto' ? data.active_id : value, mode: value === 'auto' ? 'auto' : 'manual' })
    }}
    className={compact ? 'min-w-0 max-w-40 rounded border border-border bg-base px-1 py-0.5 text-[10px] text-secondary' : 'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-foreground'}>
    <option value="auto">{data?.items.length ? '自动选择（当前配置优先）' : '请先保存 AI 接口配置'}</option>
    {data?.items.map(profile => <option key={profile.id} value={profile.id}>{profile.model} · {profile.label}</option>)}
  </select>
}
