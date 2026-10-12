import { Outlet, createRootRoute, createRoute, createRouter, useParams, useSearch } from '@tanstack/react-router'
import { AppShell } from '@/shell/AppShell'
import { DatasetPage, ImportPage, JobsPage, ResourcesPage, SettingsPage } from '@/pages/Connected'
import { OverviewPage } from '@/pages/OverviewPage'
import { JobDetailPage } from '@/pages/JobDetailPage'
import { ResourceDetailPage } from '@/pages/ResourceDetailPage'
import { CleanPage } from '@/pages/CleanPage'
import { ConvertPage } from '@/pages/ConvertPage'
import { JoinPage } from '@/pages/JoinPage'
import { ComparePage } from '@/pages/ComparePage'
import { CompareResultPage } from '@/pages/CompareResultPage'
import { SqlPage } from '@/pages/SqlPage'
import { AnalyzePage } from '@/pages/AnalyzePage'
import { QualityPage } from '@/pages/QualityPage'
import { RecipeBatchPage, RecipesPage } from '@/pages/RecipesPage'
import { SplitPage } from '@/pages/SplitPage'
import { LoginPage } from '@/pages/LoginPage'

const rootRoute = createRootRoute({
  component: () => <AppShell><Outlet /></AppShell>,
  errorComponent: ({ error }) => <div role="alert" className="m-6 rounded-panel bg-danger-soft p-4 text-cell text-danger-ink">页面加载失败：{error instanceof Error ? error.message : String(error)}</div>,
  notFoundComponent: () => <div className="m-6 text-cell text-ink-2">页面不存在。请从左侧导航选择功能。</div>,
})

function DatasetRoute() {
  const { resourceId } = useParams({ from: '/datasets/$resourceId' })
  return <DatasetPage key={resourceId} />
}

function JobRoute() {
  const { jobId } = useParams({ from: '/jobs/$jobId' })
  return <JobDetailPage key={jobId} />
}

function ResourceRoute() {
  const { resourceId } = useParams({ from: '/resources/$resourceId' })
  return <ResourceDetailPage key={resourceId} />
}

function CompareRoute() {
  const { leftId, rightId } = useSearch({ from: '/compare' })
  return <ComparePage key={`${leftId ?? ''}:${rightId ?? ''}`} />
}

const pages = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/resources', component: ResourcesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/resources/$resourceId', component: ResourceRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: '/import', component: ImportPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/datasets/$resourceId',
    validateSearch: (search: Record<string, unknown>): { row?: number } =>
      ({ row: Number.isSafeInteger(Number(search.row)) && Number(search.row) >= 1 ? Number(search.row) : undefined }),
    component: DatasetRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: '/jobs', component: JobsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/jobs/$jobId', component: JobRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/clean',
    validateSearch: (search: Record<string, unknown>): { sourceId?: string } =>
      ({ sourceId: typeof search.sourceId === 'string' ? search.sourceId : undefined }), component: CleanPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/convert',
    validateSearch: (search: Record<string, unknown>): { sourceId?: string } =>
      ({ sourceId: typeof search.sourceId === 'string' ? search.sourceId : undefined }),
    component: ConvertPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/join',
    validateSearch: (search: Record<string, unknown>): { sourceId?: string } =>
      ({ sourceId: typeof search.sourceId === 'string' ? search.sourceId : undefined }), component: JoinPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/split',
    validateSearch: (search: Record<string, unknown>): { resourceId?: string; sourceId?: string } => ({
      resourceId: typeof search.resourceId === 'string' ? search.resourceId : undefined,
      sourceId: typeof search.sourceId === 'string' ? search.sourceId : undefined }), component: SplitPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/compare',
    validateSearch: (search: Record<string, unknown>): { leftId?: string; rightId?: string; copyResultId?: string } => ({
      leftId: typeof search.leftId === 'string' ? search.leftId : undefined,
      rightId: typeof search.rightId === 'string' ? search.rightId : undefined,
      copyResultId: typeof search.copyResultId === 'string' ? search.copyResultId : undefined,
    }), component: CompareRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: '/compare/result',
    validateSearch: (search: Record<string, unknown>): { resourceId?: string } =>
      ({ resourceId: typeof search.resourceId === 'string' ? search.resourceId : undefined }), component: CompareResultPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/quality',
    validateSearch: (search: Record<string, unknown>): { sourceId?: string } =>
      ({ sourceId: typeof search.sourceId === 'string' ? search.sourceId : undefined }), component: QualityPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/analyze',
    validateSearch: (search: Record<string, unknown>): { sourceId?: string } =>
      ({ sourceId: typeof search.sourceId === 'string' ? search.sourceId : undefined }), component: AnalyzePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/sql',
    validateSearch: (search: Record<string, unknown>): { sourceId?: string } =>
      ({ sourceId: typeof search.sourceId === 'string' ? search.sourceId : undefined }), component: SqlPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/recipes',
    validateSearch: (search: Record<string, unknown>): { sourceJobId?: string } =>
      ({ sourceJobId: typeof search.sourceJobId === 'string' ? search.sourceJobId : undefined }),
    component: RecipesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/recipes/batches/$batchId', component: RecipeBatchPage }),
]

export const router = createRouter({ routeTree: rootRoute.addChildren(pages), defaultPreload: 'intent', scrollRestoration: false })
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
