import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useState } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import { ScreenSkeleton } from './components/Skeleton'
import { createQueryClient } from './lib/api'
import { AppProvider } from './lib/app-context'
import { RequireAuth } from './lib/auth'
import { LOGIN_PATH } from './lib/session'
import Login from './screens/Login'

const Analytics = lazy(() => import('./screens/Analytics'))
const AutoReply = lazy(() => import('./screens/AutoReply'))
const CampaignWizard = lazy(() => import('./screens/CampaignWizard'))
const Campaigns = lazy(() => import('./screens/Campaigns'))
const Composer = lazy(() => import('./screens/Composer'))
const Contacts = lazy(() => import('./screens/Contacts'))
const ContentCalendar = lazy(() => import('./screens/ContentCalendar'))
const Dashboard = lazy(() => import('./screens/Dashboard'))
const GroupDetail = lazy(() => import('./screens/GroupDetail'))
const Inbox = lazy(() => import('./screens/Inbox'))
const PageDetail = lazy(() => import('./screens/PageDetail'))
const PagesGroups = lazy(() => import('./screens/PagesGroups'))
const Settings = lazy(() => import('./screens/Settings'))
const Welcome = lazy(() => import('./screens/Welcome'))

export default function App() {
  const [queryClient] = useState(createQueryClient)
  return (
    <QueryClientProvider client={queryClient}>
      <AppProvider>
        <BrowserRouter>
          <Suspense fallback={<ScreenSkeleton />}>
            <Routes>
              <Route path={LOGIN_PATH} element={<Login />} />
              <Route element={<RequireAuth />}>
                <Route path="/bat-dau" element={<Welcome />} />
                <Route element={<AppShell />}>
                  <Route index element={<Dashboard />} />
                  <Route path="hop-thu" element={<Inbox />} />
                  <Route path="khach-hang" element={<Contacts />} />
                  <Route path="soan-bai" element={<Composer />} />
                  <Route path="lich" element={<ContentCalendar />} />
                  <Route path="chien-dich" element={<Campaigns />} />
                  <Route path="chien-dich/tao" element={<CampaignWizard />} />
                  <Route path="hieu-suat" element={<Analytics />} />
                  <Route path="trang-nhom" element={<PagesGroups />} />
                  <Route path="trang-nhom/trang/:id" element={<PageDetail />} />
                  <Route path="trang-nhom/nhom/:id" element={<GroupDetail />} />
                  <Route path="ai-tra-loi" element={<AutoReply />} />
                  <Route path="cai-dat" element={<Settings />} />
                </Route>
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AppProvider>
    </QueryClientProvider>
  )
}
