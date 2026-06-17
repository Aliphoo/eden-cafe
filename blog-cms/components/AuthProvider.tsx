'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { auth, googleProvider } from '@/lib/firebase';
import { getCurrentBlogUser } from '@/lib/blogRepository';
import type { BlogUser } from '@/lib/types';

type AuthContextValue = {
  user: User | null;
  blogUser: BlogUser | null;
  loading: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  canPublish: boolean;
  canManage: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [blogUser, setBlogUser] = useState<BlogUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (!nextUser) {
        setBlogUser(null);
        setLoading(false);
        return;
      }
      setBlogUser(await getCurrentBlogUser(nextUser.uid, nextUser.email, nextUser.displayName));
      setLoading(false);
    });
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    blogUser,
    loading,
    login: () => signInWithPopup(auth, googleProvider).then(() => undefined),
    logout: () => signOut(auth),
    canPublish: blogUser?.role === 'admin' || blogUser?.role === 'editor',
    canManage: blogUser?.role === 'admin'
  }), [blogUser, loading, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
