/**
 * 路由鉴权组件
 */

import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth.store';

export default function ProtectedRoute({ children }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
