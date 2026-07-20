/**
 * 路由配置
 */

import { createBrowserRouter } from 'react-router-dom';
import Layout from './layouts/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Providers from './pages/Providers';
import ProviderDetail from './pages/ProviderDetail';
import GrokRegistration from './pages/GrokRegistration';
import EmailManagement from './pages/EmailManagement';
import Config from './pages/Config';
import Usage from './pages/Usage';
import Docs from './pages/Docs';
import Logs from './pages/Logs';
import PotluckAdmin from './pages/PotluckAdmin';
import PotluckUser from './pages/PotluckUser';
import BadAccounts from './pages/BadAccounts';
import PoolRequestLogs from './pages/PoolRequestLogs';
import Monitor from './pages/Monitor';
import RequestTracing from './pages/RequestTracing';
import PricingCalculator from './pages/PricingCalculator';
import ProtectedRoute from './components/ProtectedRoute';

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/potluck-user',
    element: <PotluckUser />,
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <Layout />
      </ProtectedRoute>
    ),
    children: [
      {
        index: true,
        element: <Dashboard />,
      },
      {
        path: 'providers',
        element: <Providers />,
      },
      {
        path: 'providers/openai-xai-oauth/register',
        element: <GrokRegistration />,
      },
      {
        path: 'providers/:providerType',
        element: <ProviderDetail />,
      },
      {
        path: 'emails',
        element: <EmailManagement />,
      },
      {
        path: 'config',
        element: <Config />,
      },
      {
        path: 'docs',
        element: <Docs />,
      },
      {
        path: 'usage',
        element: <Usage />,
      },
      {
        path: 'logs',
        element: <Logs />,
      },
      {
        path: 'potluck-admin',
        element: <PotluckAdmin />,
      },
      {
        path: 'bad-accounts',
        element: <BadAccounts />,
      },
      {
        path: 'pool-request-logs',
        element: <PoolRequestLogs />,
      },
      {
        path: 'monitor',
        element: <Monitor />,
      },
      {
        path: 'tracing',
        element: <RequestTracing />,
      },
      {
        path: 'pricing',
        element: <PricingCalculator />,
      },
    ],
  },
]);
