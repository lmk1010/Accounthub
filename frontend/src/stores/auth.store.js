/**
 * 认证状态管理
 */

import { create } from 'zustand';
import { authService } from '../services/auth.service';

export const useAuthStore = create((set) => ({
  isAuthenticated: authService.isAuthenticated(),
  user: null,
  loading: false,

  login: async (password) => {
    set({ loading: true });
    try {
      const response = await authService.login(password);
      if (response.success) {
        set({ isAuthenticated: true, user: { username: 'admin' } });
      }
      return response;
    } finally {
      set({ loading: false });
    }
  },

  logout: async () => {
    await authService.logout();
    set({ isAuthenticated: false, user: null });
  },

  checkAuth: async () => {
    if (!authService.isAuthenticated()) {
      set({ isAuthenticated: false });
      return false;
    }
    try {
      await authService.verifyToken();
      set({ isAuthenticated: true });
      return true;
    } catch {
      set({ isAuthenticated: false });
      return false;
    }
  },
}));
