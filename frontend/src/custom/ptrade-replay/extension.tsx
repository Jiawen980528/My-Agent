import { lazy } from 'react'
import type { FrontendExtension } from '@/extensions/types'
import { IconReview } from '@/components/BrandIcons'

const Page = lazy(() => import('./Page').then(module => ({ default: module.PTradeReplayPage })))

const extension: FrontendExtension = {
  id: 'myagent.ptrade.replay', apiVersion: 1,
  routes: [{ id: 'ptrade-etf-replay', path: '/ptrade-etf-replay', component: Page }],
  navigation: [{ id: 'ptrade-etf-replay', routeId: 'ptrade-etf-replay', label: 'PTrade做T复盘', icon: IconReview }],
}
export default extension
