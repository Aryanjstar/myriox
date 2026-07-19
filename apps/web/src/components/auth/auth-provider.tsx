"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  type AuthSession,
  type AuthUser,
  authApi,
  clearSession,
  loadSession,
  saveSession,
} from "@/lib/auth-client";

interface AuthContextValue {
  user: AuthUser | null;
  isLoaded: boolean;
  isSignedIn: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  signup: (params: { email: string; password: string; name: string; orgName: string }) => Promise<AuthUser>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setSession(loadSession());
    setIsLoaded(true);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      isLoaded,
      isSignedIn: Boolean(session),
      login: async (email: string, password: string) => {
        const next = await authApi.login({ email, password });
        saveSession(next);
        setSession(next);
        return next.user;
      },
      signup: async ({ email, password, name, orgName }) => {
        const next = await authApi.signup({ email, password, name, org_name: orgName });
        saveSession(next);
        setSession(next);
        return next.user;
      },
      logout: () => {
        clearSession();
        setSession(null);
        router.push("/");
      },
    }),
    [session, isLoaded, router]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
