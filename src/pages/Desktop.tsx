import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BellRing, Check, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDesktopPreferredWindowSize } from "@/hooks/use-desktop-preferred-window-size";
import { supabase } from "@/integrations/supabase/client";
import { buildJsonRequestInit, getDesktopConfig, getEdgeFunctionsBaseUrl, getSupabaseAnonKey, parseApiResponse, postDesktopHostMessage } from "@/lib/api";

type DesktopAlertStatus = "PENDING" | "DELIVERED" | "READ" | "ACKNOWLEDGED";

interface DesktopSessionUser {
  id: string;
  username: string;
  displayName: string | null;
  status: "ACTIVE" | "DISABLED";
}

interface DesktopAlert {
  id: string;
  title: string | null;
  message: string;
  status: DesktopAlertStatus;
  senderEmail?: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  acknowledgedAt: string | null;
}

interface DesktopAuthResponse {
  user: DesktopSessionUser;
  tokens: {
    accessToken: string;
    refreshToken: string;
  };
}

interface DesktopAlertsResponse {
  alerts: DesktopAlert[];
}

const DESKTOP_STORAGE_KEY = "gentle-control-room.desktop.auth";

function getNotifiedAlertsStorageKey(userId: string) {
  return `gentle-control-room.desktop.notified-alerts.${userId}`;
}

function sortAlertsByNewest(alerts: DesktopAlert[]) {
  return [...alerts].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

const badgeVariant: Record<DesktopAlertStatus, "outline" | "default" | "secondary"> = {
  PENDING: "outline",
  DELIVERED: "default",
  READ: "secondary",
  ACKNOWLEDGED: "secondary",
};

const CONFIRM_DELAY_SECONDS = 5;

const ConfirmCountdownButton = ({ alertId, onConfirm }: { alertId: string; onConfirm: (id: string) => Promise<void> }) => {
  const [countdown, setCountdown] = useState(CONFIRM_DELAY_SECONDS);
  const [isConfirming, setIsConfirming] = useState(false);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const handleClick = async () => {
    setIsConfirming(true);
    try {
      await onConfirm(alertId);
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 text-xs shrink-0"
      disabled={countdown > 0 || isConfirming}
      onClick={() => void handleClick()}
    >
      {isConfirming ? "..." : countdown > 0 ? `Confirm (${countdown}s)` : "Confirm"}
    </Button>
  );
};

const Desktop = () => {
  const edgeFunctionsBaseUrl = useMemo(() => getEdgeFunctionsBaseUrl(), []);
  const anonKey = useMemo(() => getSupabaseAnonKey(), []);
  const desktopConfig = useMemo(() => getDesktopConfig(), []);
  const pollingMs = Math.max((desktopConfig?.alertPollingSeconds ?? 15) * 1000, 5000);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackTone, setFeedbackTone] = useState<"error" | "success">("success");
  const [isLoading, setIsLoading] = useState(false);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);
  const [alerts, setAlerts] = useState<DesktopAlert[]>([]);
  const [sessionUser, setSessionUser] = useState<DesktopSessionUser | null>(null);
  const notifiedAlertIdsRef = useRef<Set<string>>(new Set());
  const authRef = useRef<{ accessToken: string | null; refreshToken: string | null }>({
    accessToken: null,
    refreshToken: null,
  });
  const preferredWindowSizeRef = useDesktopPreferredWindowSize(Boolean(sessionUser));

  // --- Edge function request helpers ---

  function edgeFunctionHeaders(extraHeaders?: HeadersInit): Headers {
    const headers = new Headers(extraHeaders);
    headers.set("apikey", anonKey);
    headers.set("Content-Type", "application/json");
    return headers;
  }

  const syncAuth = (nextAuth: { accessToken: string | null; refreshToken: string | null }, nextUser: DesktopSessionUser | null) => {
    authRef.current = nextAuth;
    setSessionUser(nextUser);

    if (nextAuth.accessToken && nextAuth.refreshToken && nextUser) {
      localStorage.setItem(
        DESKTOP_STORAGE_KEY,
        JSON.stringify({
          accessToken: nextAuth.accessToken,
          refreshToken: nextAuth.refreshToken,
          user: nextUser,
        }),
      );
      return;
    }

    localStorage.removeItem(DESKTOP_STORAGE_KEY);
  };

  const refreshDesktopSession = async () => {
    const refreshToken = authRef.current.refreshToken;
    if (!refreshToken) return false;

    try {
      const response = await fetch(`${edgeFunctionsBaseUrl}/desktop-auth`, {
        method: "POST",
        headers: edgeFunctionHeaders(),
        body: JSON.stringify({ action: "refresh", refreshToken }),
      });

      if (!response.ok) {
        syncAuth({ accessToken: null, refreshToken: null }, null);
        return false;
      }

      const payload = await parseApiResponse<DesktopAuthResponse>(response);
      syncAuth(
        { accessToken: payload.tokens.accessToken, refreshToken: payload.tokens.refreshToken },
        payload.user,
      );

      // Notify the native Windows host of the refreshed session
      postDesktopHostMessage({
        type: "desktop.auth.session",
        payload: {
          accessToken: payload.tokens.accessToken,
          refreshToken: payload.tokens.refreshToken,
          apiKey: anonKey,
          userId: payload.user.id,
          username: payload.user.username,
        },
      });

      return true;
    } catch {
      syncAuth({ accessToken: null, refreshToken: null }, null);
      return false;
    }
  };

  const desktopAlertRequest = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers = edgeFunctionHeaders();
    if (authRef.current.accessToken) {
      headers.set("Authorization", `Bearer ${authRef.current.accessToken}`);
    }

    const response = await fetch(`${edgeFunctionsBaseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401 && (await refreshDesktopSession())) {
      const retryHeaders = edgeFunctionHeaders();
      if (authRef.current.accessToken) {
        retryHeaders.set("Authorization", `Bearer ${authRef.current.accessToken}`);
      }
      const retryResponse = await fetch(`${edgeFunctionsBaseUrl}${path}`, {
        method,
        headers: retryHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return parseApiResponse<T>(retryResponse);
    }

    return parseApiResponse<T>(response);
  };

  const markAlertDelivered = async (alertId: string) => {
    return desktopAlertRequest<{ alert: DesktopAlert }>(
      "PATCH",
      `/desktop-alerts/${alertId}`,
      { status: "DELIVERED" },
    );
  };

  const upsertAlert = (nextAlert: DesktopAlert) => {
    setAlerts((currentAlerts) => {
      const existingAlert = currentAlerts.find((alert) => alert.id === nextAlert.id);
      if (!existingAlert) {
        return sortAlertsByNewest([nextAlert, ...currentAlerts]);
      }
      return sortAlertsByNewest(
        currentAlerts.map((alert) => (alert.id === nextAlert.id ? { ...alert, ...nextAlert } : alert)),
      );
    });
  };

  const syncNotifiedAlertIds = (ids: Iterable<string>) => {
    const nextSet = new Set(ids);
    notifiedAlertIdsRef.current = nextSet;
    if (!sessionUser) return;
    localStorage.setItem(
      getNotifiedAlertsStorageKey(sessionUser.id),
      JSON.stringify(Array.from(nextSet).slice(-200)),
    );
  };

  const noteAlertNotified = (alertId: string) => {
    const knownIds = new Set(notifiedAlertIdsRef.current);
    knownIds.add(alertId);
    syncNotifiedAlertIds(knownIds);
  };

  const notifyNativeHost = (alert: DesktopAlert) => {
    // Skip only if config explicitly disables notifications
    if (desktopConfig && desktopConfig.enableNativeNotifications === false) return;
    // Skip if no bridge available
    if (!window.chrome?.webview?.postMessage) return;
    postDesktopHostMessage({
      type: "desktop.alert.received",
      payload: {
        id: alert.id,
        title: alert.title ?? "New alert",
        message: alert.message,
        senderEmail: alert.senderEmail ?? "",
        createdAt: alert.createdAt,
      },
    });
  };

  const requestHideToTray = () => {
    postDesktopHostMessage({ type: "desktop.window.hideToTray" });
  };

  const handleIncomingRealtimeAlert = (row: Record<string, unknown>) => {
    const incomingAlert: DesktopAlert = {
      id: row.id as string,
      title: (row.title as string) ?? "New Alert",
      message: row.message as string,
      status: row.status as DesktopAlertStatus,
      createdAt: row.created_at as string,
      deliveredAt: (row.delivered_at as string) ?? null,
      readAt: (row.read_at as string) ?? null,
      acknowledgedAt: (row.acknowledged_at as string) ?? null,
    };

    if (!notifiedAlertIdsRef.current.has(incomingAlert.id)) {
      notifyNativeHost(incomingAlert);
      noteAlertNotified(incomingAlert.id);
    }

    const optimisticAlert: DesktopAlert =
      incomingAlert.status === "PENDING"
        ? { ...incomingAlert, status: "DELIVERED", deliveredAt: new Date().toISOString() }
        : incomingAlert;

    upsertAlert(optimisticAlert);

    void markAlertDelivered(incomingAlert.id)
      .then((payload) => upsertAlert(payload.alert))
      .catch(() => void fetchAlerts());
  };

  const fetchAlerts = async () => {
    if (!sessionUser) {
      setAlerts([]);
      return;
    }

    const payload = await desktopAlertRequest<DesktopAlertsResponse>(
      "GET",
      `/desktop-alerts?userId=${sessionUser.id}`,
    );
    const pendingAlerts = payload.alerts.filter((item) => item.status === "PENDING");

    for (const alert of pendingAlerts) {
      await markAlertDelivered(alert.id);
    }

    const latestPayload = pendingAlerts.length > 0
      ? await desktopAlertRequest<DesktopAlertsResponse>("GET", `/desktop-alerts?userId=${sessionUser.id}`)
      : payload;

    // Notify for ALL unseen alerts, not just pending ones
    const knownIds = new Set(notifiedAlertIdsRef.current);
    const unseenAlerts = latestPayload.alerts.filter(
      (alert) => !knownIds.has(alert.id),
    );
    for (const alert of unseenAlerts) {
      notifyNativeHost(alert);
      knownIds.add(alert.id);
    }
    syncNotifiedAlertIds(knownIds);

    setAlerts(sortAlertsByNewest(latestPayload.alerts));
  };

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setFeedback(null);

    try {
      const response = await fetch(`${edgeFunctionsBaseUrl}/desktop-auth`, {
        method: "POST",
        headers: edgeFunctionHeaders(),
        body: JSON.stringify({ action: "login", username, password }),
      });
      const payload = await parseApiResponse<DesktopAuthResponse>(response);

      syncAuth(
        { accessToken: payload.tokens.accessToken, refreshToken: payload.tokens.refreshToken },
        payload.user,
      );

      // Notify the native Windows host of the authenticated session
      postDesktopHostMessage({
        type: "desktop.auth.session",
        payload: {
          accessToken: payload.tokens.accessToken,
          refreshToken: payload.tokens.refreshToken,
          apiKey: anonKey,
          userId: payload.user.id,
          username: payload.user.username,
        },
      });

      setFeedback("Signed in. The app will continue running in the background.");
      setFeedbackTone("success");
      setUsername("");
      setPassword("");
      await fetchAlerts();
      window.setTimeout(() => requestHideToTray(), 400);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Unable to sign in.");
      setFeedbackTone("error");
      setAlerts([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    const refreshToken = authRef.current.refreshToken;
    try {
      if (refreshToken) {
        await fetch(`${edgeFunctionsBaseUrl}/desktop-auth`, {
          method: "POST",
          headers: edgeFunctionHeaders(),
          body: JSON.stringify({ action: "logout", refreshToken }),
        });
      }
    } finally {
      syncAuth({ accessToken: null, refreshToken: null }, null);
      setAlerts([]);
      setFeedback("Signed out.");
      setFeedbackTone("success");
    }
  };

  const handleAcknowledge = async (alertId: string) => {
    try {
      const payload = await desktopAlertRequest<{ alert: DesktopAlert }>(
        "PATCH",
        `/desktop-alerts/${alertId}`,
        { status: "ACKNOWLEDGED" },
      );
      upsertAlert(payload.alert);
      // Immediately refetch to stay in sync with backend
      await fetchAlerts();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Unable to acknowledge alert.");
      setFeedbackTone("error");
    }
  };

  // Restore session from localStorage
  useEffect(() => {
    const storedSession = localStorage.getItem(DESKTOP_STORAGE_KEY);
    if (!storedSession) return;

    try {
      const parsed = JSON.parse(storedSession) as {
        accessToken?: string;
        refreshToken?: string;
        user?: DesktopSessionUser;
      };
      syncAuth(
        { accessToken: parsed.accessToken ?? null, refreshToken: parsed.refreshToken ?? null },
        parsed.user ?? null,
      );
    } catch {
      syncAuth({ accessToken: null, refreshToken: null }, null);
    }
  }, []);

  // Load notified alert IDs
  useEffect(() => {
    if (!sessionUser) {
      notifiedAlertIdsRef.current = new Set();
      return;
    }
    const storedIds = localStorage.getItem(getNotifiedAlertsStorageKey(sessionUser.id));
    if (!storedIds) {
      notifiedAlertIdsRef.current = new Set();
      return;
    }
    try {
      notifiedAlertIdsRef.current = new Set(JSON.parse(storedIds) as string[]);
    } catch {
      notifiedAlertIdsRef.current = new Set();
    }
  }, [sessionUser]);

  // Supabase Realtime subscription
  useEffect(() => {
    if (!sessionUser) {
      setIsRealtimeConnected(false);
      return;
    }

    const channel = supabase
      .channel("desktop-presence")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "alerts",
          filter: `recipient_id=eq.${sessionUser.id}`,
        },
        (payload) => {
          handleIncomingRealtimeAlert(payload.new as Record<string, unknown>);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "alerts",
          filter: `recipient_id=eq.${sessionUser.id}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          upsertAlert({
            id: row.id as string,
            title: (row.title as string) ?? "New Alert",
            message: row.message as string,
            status: row.status as DesktopAlertStatus,
            createdAt: row.created_at as string,
            deliveredAt: (row.delivered_at as string) ?? null,
            readAt: (row.read_at as string) ?? null,
            acknowledgedAt: (row.acknowledged_at as string) ?? null,
          });
        },
      )
      .subscribe(async (status) => {
        setIsRealtimeConnected(status === "SUBSCRIBED");
        if (status === "SUBSCRIBED") {
          await channel.track({
            user_id: sessionUser.id,
            username: sessionUser.username,
            display_name: sessionUser.displayName,
            online_at: new Date().toISOString(),
          });
        }
      });

    return () => {
      supabase.removeChannel(channel);
      setIsRealtimeConnected(false);
    };
  }, [sessionUser]);

  // Native host bridge: listen for toast confirm events from Windows app
  useEffect(() => {
    if (!sessionUser) return;

    const handleHostConfirm = async (event: Event) => {
      const detail = (event as CustomEvent<{ alertId: string; acknowledgedAt?: string }>).detail;
      if (!detail?.alertId) return;

      // Optimistic local update
      setAlerts((current) =>
        sortAlertsByNewest(
          current.map((a) =>
            a.id === detail.alertId
              ? { ...a, status: "ACKNOWLEDGED" as DesktopAlertStatus, acknowledgedAt: detail.acknowledgedAt ?? new Date().toISOString() }
              : a,
          ),
        ),
      );

      // The native host may have already PATCHed the backend, so just refetch
      try {
        await fetchAlerts();
      } catch {
        // polling will catch up
      }
    };

    window.addEventListener("desktop-host-alert-confirmed", handleHostConfirm);
    window.addEventListener("desktop-host-confirm-alert", handleHostConfirm);
    return () => {
      window.removeEventListener("desktop-host-alert-confirmed", handleHostConfirm);
      window.removeEventListener("desktop-host-confirm-alert", handleHostConfirm);
    };
  }, [sessionUser]);

  // Polling fallback
  useEffect(() => {
    if (!sessionUser) return;
    void fetchAlerts();
    const timer = window.setInterval(() => void fetchAlerts(), pollingMs);
    return () => window.clearInterval(timer);
  }, [sessionUser, pollingMs]);

  if (!sessionUser) {
    return (
      <div className="desktop-workspace bg-background px-3 py-2">
        <div ref={preferredWindowSizeRef} className="mx-auto max-w-2xl">
          <Card className="w-full shadow-card">
            <CardHeader className="space-y-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl gradient-primary text-2xl font-bold text-primary-foreground">
                G
              </div>
              <div className="space-y-2">
                <p className="text-sm uppercase tracking-[0.18em] text-primary">Gentle Control Room</p>
                <CardTitle className="text-4xl">Desktop alert client</CardTitle>
                <CardDescription className="mx-auto max-w-md text-base">
                  Sign in once and the app will stay in the background to receive alerts automatically.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <form className="grid gap-4" onSubmit={handleLogin}>
                <div className="space-y-2">
                  <Label htmlFor="desktop-username">Username</Label>
                  <Input
                    id="desktop-username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="desktop-password">Password</Label>
                  <Input
                    id="desktop-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                  />
                </div>
                <Button type="submit" className="gradient-primary text-primary-foreground" disabled={isLoading}>
                  {isLoading ? "Signing in..." : "Sign in"}
                </Button>
              </form>

              {feedback && (
                <p className={`text-sm ${feedbackTone === "error" ? "text-destructive" : "text-success"}`}>
                  {feedback}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="desktop-workspace bg-background px-3 py-2">
      <div ref={preferredWindowSizeRef} className="mx-auto max-w-2xl">
        <Card className="shadow-card overflow-hidden">
          <div className="flex flex-col sm:flex-row">
            {/* Left sidebar */}
            <div className="flex w-full sm:w-[180px] shrink-0 flex-col justify-between border-b sm:border-b-0 sm:border-r px-3 py-3">
              <div className="flex flex-col items-center gap-1.5 text-center">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <User className="h-4 w-4" />
                </div>
                <div className="leading-tight">
                  <p className="text-sm font-semibold">{sessionUser.displayName ?? sessionUser.username}</p>
                  <p className="text-xs text-muted-foreground">{sessionUser.username}</p>
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-1.5">
                <Button size="sm" onClick={requestHideToTray} className="gradient-primary text-primary-foreground w-full text-xs">
                  Run In Background
                </Button>
                <Button variant="ghost" size="sm" onClick={handleLogout} className="w-full text-xs">
                  Sign out
                </Button>
              </div>
            </div>

            {/* Right content */}
            <div className="flex-1 min-w-0">
              <div className="px-3 py-2.5 pb-1.5">
                <h3 className="text-base font-semibold leading-none tracking-tight">Latest alerts</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Recent messages delivered to this device.
                </p>
              </div>
              <div className="px-3 pb-3 pt-0">
                {feedback && (
                  <p className={`mb-2 text-xs ${feedbackTone === "error" ? "text-destructive" : "text-success"}`}>
                    {feedback}
                  </p>
                )}

                {alerts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No alerts have arrived yet.</p>
                ) : (
                  <div className="max-h-[280px] overflow-y-auto pr-2" tabIndex={0} aria-label="Recent alerts">
                    <div className="space-y-1.5">
                      {alerts.map((alert) => (
                        <div key={alert.id} className="rounded-lg border bg-card/80 px-3 py-2 shadow-sm">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <BellRing className="h-3.5 w-3.5 shrink-0 text-primary" />
                                <p className="truncate text-sm font-medium">{alert.title ?? "Alert"}</p>
                                <Badge variant={badgeVariant[alert.status]} className="text-[0.65rem] px-1.5 py-0">{alert.status}</Badge>
                              </div>
                              <p className="text-xs leading-snug text-muted-foreground">{alert.message}</p>
                              <p className="text-[0.65rem] text-muted-foreground">
                                {new Date(alert.createdAt).toLocaleString()}
                              </p>
                            </div>
                            {alert.status === "DELIVERED" && (
                              <ConfirmCountdownButton alertId={alert.id} onConfirm={handleAcknowledge} />
                            )}
                            {alert.status === "ACKNOWLEDGED" && (
                              <Badge variant="secondary" className="text-[0.65rem] px-1.5 py-0 bg-green-100 text-green-700">
                                <Check className="h-3 w-3 mr-0.5" /> Confirmed
                              </Badge>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default Desktop;
