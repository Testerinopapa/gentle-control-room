import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bell,
  Shield,
  Monitor,
  Send,
  Users,
  CheckCircle,
  ArrowRight,
  Zap,
  Eye,
  Clock,
  Download,
  LogIn,
  KeyRound,
  UserPlus,
  Play,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/* ------------------------------------------------------------------ */
/*  Animated notification toast that slides in from the right          */
/* ------------------------------------------------------------------ */
interface NotificationToastProps {
  title: string;
  message: string;
  time: string;
  delay: number;
  color: string;
}

const NotificationToast = ({ title, message, time, delay, color }: NotificationToastProps) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = setTimeout(() => setVisible(true), delay);
    const hide = setTimeout(() => setVisible(false), delay + 4000);
    const loop = setInterval(() => {
      setTimeout(() => setVisible(true), delay);
      setTimeout(() => setVisible(false), delay + 4000);
    }, 8000);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
      clearInterval(loop);
    };
  }, [delay]);

  return (
    <div
      className={`absolute right-0 transition-all duration-500 ease-out ${
        visible
          ? "translate-x-0 opacity-100"
          : "translate-x-[120%] opacity-0"
      }`}
      style={{ top: `${delay / 40}px` }}
    >
      <div className="flex items-start gap-3 bg-card border border-border rounded-xl px-4 py-3 shadow-elevated w-72">
        <div
          className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: color }}
        >
          <Bell className="w-4 h-4 text-primary-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{title}</p>
          <p className="text-xs text-muted-foreground truncate">{message}</p>
          <p className="text-[10px] text-muted-foreground mt-1">{time}</p>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Fake dashboard preview                                             */
/* ------------------------------------------------------------------ */
const fakeUsers = [
  { name: "john.doe", display: "John Doe", status: "Active", alerts: 12 },
  { name: "sarah.connor", display: "Sarah Connor", status: "Active", alerts: 8 },
  { name: "mike.chen", display: "Mike Chen", status: "Disabled", alerts: 3 },
  { name: "lisa.park", display: "Lisa Park", status: "Active", alerts: 21 },
];

const fakeAlerts = [
  { user: "john.doe", title: "System Update", status: "READ", time: "2 min ago" },
  { user: "sarah.connor", title: "Meeting Reminder", status: "DELIVERED", time: "5 min ago" },
  { user: "lisa.park", title: "Urgent: Server Down", status: "PENDING", time: "Just now" },
  { user: "john.doe", title: "Weekly Report Due", status: "READ", time: "1 hour ago" },
];

const statusColor: Record<string, string> = {
  READ: "bg-muted text-muted-foreground",
  DELIVERED: "bg-primary/10 text-primary",
  PENDING: "bg-warning/10 text-warning",
};

const DashboardPreview = () => (
  <div className="rounded-2xl border border-border bg-card shadow-elevated overflow-hidden">
    {/* Title bar */}
    <div className="flex items-center gap-2 px-4 py-2.5 bg-sidebar-background">
      <div className="flex gap-1.5">
        <span className="w-3 h-3 rounded-full bg-destructive/70" />
        <span className="w-3 h-3 rounded-full bg-warning/70" />
        <span className="w-3 h-3 rounded-full bg-success/70" />
      </div>
      <span className="text-xs text-sidebar-foreground ml-2 font-medium">
        Emergency Staff Alert — Dashboard
      </span>
    </div>

    <div className="flex">
      {/* Sidebar */}
      <div className="w-44 bg-sidebar-background border-r border-sidebar-border p-3 space-y-1 hidden md:block">
        {[
          { icon: Monitor, label: "Dashboard", active: false },
          { icon: Users, label: "Users", active: true },
          { icon: Send, label: "Send Alert", active: false },
          { icon: Clock, label: "Alert History", active: false },
        ].map((item) => (
          <div
            key={item.label}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium ${
              item.active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-muted"
            }`}
          >
            <item.icon className="w-3.5 h-3.5" />
            {item.label}
          </div>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 p-4 space-y-4 min-h-[280px]">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-foreground">User Management</h3>
          <span className="text-[10px] px-2 py-1 rounded-full gradient-primary text-primary-foreground font-medium">
            + Add User
          </span>
        </div>

        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/50">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Username</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden sm:table-cell">Display</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Alerts</th>
              </tr>
            </thead>
            <tbody>
              {fakeUsers.map((u) => (
                <tr key={u.name} className="border-t border-border">
                  <td className="px-3 py-2 font-medium text-foreground">{u.name}</td>
                  <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell">{u.display}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                        u.status === "Active"
                          ? "bg-success/10 text-success"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {u.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">{u.alerts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
);

const AlertHistoryPreview = () => (
  <div className="rounded-2xl border border-border bg-card shadow-elevated overflow-hidden">
    <div className="px-4 py-3 border-b border-border">
      <h3 className="text-sm font-bold text-foreground">Recent Alerts</h3>
    </div>
    <div className="divide-y divide-border">
      {fakeAlerts.map((a, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="w-7 h-7 rounded-lg gradient-primary flex items-center justify-center flex-shrink-0">
            <Bell className="w-3.5 h-3.5 text-primary-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground truncate">{a.title}</p>
            <p className="text-[10px] text-muted-foreground">
              To: {a.user} · {a.time}
            </p>
          </div>
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${statusColor[a.status]}`}>
            {a.status}
          </span>
        </div>
      ))}
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/*  Main landing page                                                  */
/* ------------------------------------------------------------------ */
const features = [
  {
    icon: Send,
    title: "Instant Notifications",
    description: "Send alerts from the web dashboard and have them appear instantly on any connected Windows desktop.",
  },
  {
    icon: Users,
    title: "User Management",
    description: "Create accounts, set permissions, and monitor activity — all from a single admin panel.",
  },
  {
    icon: Eye,
    title: "Delivery Tracking",
    description: "See exactly when each notification was delivered and read in real-time.",
  },
  {
    icon: Shield,
    title: "Secure by Design",
    description: "End-to-end authentication with session management keeps your communications private.",
  },
  {
    icon: Zap,
    title: "Lightweight Agent",
    description: "The Windows app runs silently in the system tray using minimal resources.",
  },
  {
    icon: Monitor,
    title: "Cross-Platform Dashboard",
    description: "Manage everything from any browser — no installation required for admins.",
  },
];

const steps = [
  { number: "1", title: "Create accounts", description: "Set up usernames and passwords for your team in the admin dashboard." },
  { number: "2", title: "Install the app", description: "Users download and sign in to the lightweight Windows desktop agent." },
  { number: "3", title: "Send alerts", description: "Compose and send targeted notifications that appear directly on their screens." },
];

const Index = () => {
  const [demoOpen, setDemoOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      {/* -------- NAVBAR -------- */}
      <nav className="sticky top-0 z-50 backdrop-blur-lg bg-background/80 border-b border-border">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center">
              <Shield className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-foreground text-lg">Emergency Staff Alert</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/login">
              <Button variant="ghost" size="sm">
                Sign In
              </Button>
            </Link>
            <Link to="/login">
              <Button size="sm" className="gradient-primary text-primary-foreground">
                Get Started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* -------- HERO -------- */}
      <section className="relative overflow-hidden">
        <div className="max-w-6xl mx-auto px-6 pt-20 pb-24 lg:pt-28 lg:pb-32">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            {/* Left copy */}
            <div className="space-y-6 animate-fade-in">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 text-xs font-medium text-muted-foreground shadow-card">
                <Zap className="w-3.5 h-3.5 text-primary" />
                Now available for Windows
              </div>

              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-foreground leading-[1.1]">
                Send desktop alerts,{" "}
                <span className="bg-clip-text text-transparent bg-gradient-to-r from-primary to-[hsl(250,83%,60%)]">
                  instantly
                </span>
              </h1>

              <p className="text-lg text-muted-foreground max-w-lg leading-relaxed">
                A lightweight Windows app paired with a powerful admin dashboard.
                Manage your team, send targeted notifications, and track delivery
                — all in real time.
              </p>

              <div className="flex flex-wrap gap-3 pt-2">
                <Link to="/login">
                  <Button size="lg" className="gradient-primary text-primary-foreground gap-2">
                    Open Dashboard <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
                <Button size="lg" variant="outline" className="gap-2" onClick={() => setDemoOpen(true)}>
                  <Play className="w-4 h-4" /> Watch Demo
                </Button>
              </div>

              <div className="flex items-center gap-6 pt-4 text-sm text-muted-foreground">
                {["Free to use", "No ads", "Self-hosted"].map((t) => (
                  <span key={t} className="flex items-center gap-1.5">
                    <CheckCircle className="w-4 h-4 text-success" /> {t}
                  </span>
                ))}
              </div>
            </div>

            {/* Right — animated notifications over a mock desktop */}
            <div className="relative h-[380px] lg:h-[420px] animate-fade-in" style={{ animationDelay: "0.2s" }}>
              {/* Desktop silhouette */}
              <div className="absolute inset-0 rounded-2xl border border-border bg-sidebar-background overflow-hidden shadow-elevated">
                <div className="flex items-center gap-1.5 px-4 py-2 border-b border-sidebar-border">
                  <span className="w-2.5 h-2.5 rounded-full bg-destructive/50" />
                  <span className="w-2.5 h-2.5 rounded-full bg-warning/50" />
                  <span className="w-2.5 h-2.5 rounded-full bg-success/50" />
                </div>
                <div className="p-6 space-y-3">
                  {[...Array(6)].map((_, i) => (
                    <div
                      key={i}
                      className="h-3 rounded bg-sidebar-accent"
                      style={{ width: `${70 - i * 8}%`, opacity: 1 - i * 0.12 }}
                    />
                  ))}
                </div>
              </div>

              {/* Floating notifications */}
              <NotificationToast
                title="System Update"
                message="Server maintenance at 10 PM tonight"
                time="Just now"
                delay={500}
                color="hsl(221 83% 53%)"
              />
              <NotificationToast
                title="Meeting Reminder"
                message="Standup in 5 minutes — Room 3B"
                time="2 min ago"
                delay={2500}
                color="hsl(250 83% 60%)"
              />
              <NotificationToast
                title="Urgent Alert"
                message="Production deploy requires approval"
                time="5 min ago"
                delay={4500}
                color="hsl(0 84% 60%)"
              />
            </div>
          </div>
        </div>

        {/* Decorative gradient blobs */}
        <div className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full bg-primary/5 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 w-[400px] h-[400px] rounded-full bg-primary/5 blur-3xl pointer-events-none" />
      </section>

      {/* -------- FEATURES -------- */}
      <section className="py-20 lg:py-28 bg-card/50">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center max-w-2xl mx-auto mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground">
              Everything you need to keep your team in the loop
            </h2>
            <p className="mt-4 text-muted-foreground text-lg">
              Built for simplicity — no bloat, no complexity. Just send alerts
              and track delivery.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f, i) => (
              <Card
                key={f.title}
                className="group hover-scale shadow-card border-border animate-fade-in"
                style={{ animationDelay: `${i * 0.08}s` }}
              >
                <CardContent className="p-6 space-y-3">
                  <div className="w-10 h-10 rounded-xl gradient-primary flex items-center justify-center group-hover:shadow-lg transition-shadow">
                    <f.icon className="w-5 h-5 text-primary-foreground" />
                  </div>
                  <h3 className="font-semibold text-foreground">{f.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {f.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* -------- HOW IT WORKS -------- */}
      <section id="how-it-works" className="py-20 lg:py-28">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center max-w-2xl mx-auto mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground">
              Up and running in 3 steps
            </h2>
            <p className="mt-4 text-muted-foreground text-lg">
              Getting started takes less than five minutes.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {steps.map((s, i) => (
              <div key={s.number} className="text-center space-y-4 animate-fade-in" style={{ animationDelay: `${i * 0.15}s` }}>
                <div className="mx-auto w-12 h-12 rounded-full gradient-primary flex items-center justify-center text-primary-foreground font-bold text-lg">
                  {s.number}
                </div>
                <h3 className="font-semibold text-foreground text-lg">{s.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mx-auto">
                  {s.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* -------- DOWNLOAD & SETUP -------- */}
      <section id="download" className="py-20 lg:py-28 bg-card/50">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center max-w-2xl mx-auto mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground">
              Download the Desktop App
            </h2>
            <p className="mt-4 text-muted-foreground text-lg">
              Get the lightweight Windows agent and start receiving alerts in minutes.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-12 items-start">
            {/* Download card */}
            <div className="animate-fade-in">
              <Card className="shadow-elevated border-border overflow-hidden">
                <CardContent className="p-0">
                  <div className="gradient-primary p-8 text-center space-y-4">
                    <div className="mx-auto w-16 h-16 rounded-2xl bg-primary-foreground/20 flex items-center justify-center">
                      <Monitor className="w-8 h-8 text-primary-foreground" />
                    </div>
                    <h3 className="text-xl font-bold text-primary-foreground">
                      Emergency Staff Alert for Windows
                    </h3>
                    <p className="text-primary-foreground/80 text-sm">
                      Version 0.1.0 · Windows 10/11 (x64)
                    </p>
                    <a
                      href="https://ipwmfdsnzjhzeofwwptk.supabase.co/storage/v1/object/public/downloads/GentleControlRoom-Setup-0.1.0.exe"
                      download
                    >
                      <Button
                        size="lg"
                        className="bg-primary-foreground text-primary hover:bg-primary-foreground/90 gap-2 mt-2 font-semibold"
                      >
                        <Download className="w-5 h-5" />
                        Download Installer
                      </Button>
                    </a>
                  </div>
                  <div className="p-6 space-y-3">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle className="w-4 h-4 text-success flex-shrink-0" />
                      Runs silently in system tray
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle className="w-4 h-4 text-success flex-shrink-0" />
                      Minimal resource usage
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle className="w-4 h-4 text-success flex-shrink-0" />
                      Auto-starts with Windows
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle className="w-4 h-4 text-success flex-shrink-0" />
                      No admin privileges required
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Setup tutorial */}
            <div className="space-y-6 animate-fade-in" style={{ animationDelay: "0.15s" }}>
              <h3 className="text-xl font-bold text-foreground">Quick Setup Guide</h3>

              <div className="space-y-4">
                {[
                  {
                    step: 1,
                    icon: Download,
                    title: "Download & Install",
                    description:
                      "Click the download button and run the installer. Follow the on-screen prompts — it takes less than a minute.",
                  },
                  {
                    step: 2,
                    icon: UserPlus,
                    title: "Get Your Credentials",
                    description:
                      "Your admin will create a username and password for you in the dashboard. Ask them for your login details.",
                  },
                  {
                    step: 3,
                    icon: LogIn,
                    title: "Sign In to the App",
                    description:
                      "Open the app from your system tray and enter the username and password provided by your admin.",
                  },
                  {
                    step: 4,
                    icon: Bell,
                    title: "Start Receiving Alerts",
                    description:
                      "That's it! You'll now receive desktop notifications whenever your admin sends an alert to you.",
                  },
                ].map((item) => (
                  <div key={item.step} className="flex gap-4 items-start group">
                    <div className="flex-shrink-0 w-10 h-10 rounded-xl gradient-primary flex items-center justify-center group-hover:shadow-lg transition-shadow">
                      <item.icon className="w-5 h-5 text-primary-foreground" />
                    </div>
                    <div className="space-y-1">
                      <h4 className="font-semibold text-foreground text-sm">
                        Step {item.step}: {item.title}
                      </h4>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {item.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-border bg-muted/30 p-4 mt-4">
                <div className="flex items-start gap-3">
                  <KeyRound className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-foreground">Need credentials?</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Contact your administrator to get your login details. They can create your
                      account from the{" "}
                      <Link to="/login" className="text-primary hover:underline">
                        admin dashboard
                      </Link>
                      .
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* -------- DASHBOARD PREVIEW -------- */}
      <section className="py-20 lg:py-28">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center max-w-2xl mx-auto mb-14">
            <h2 className="text-3xl md:text-4xl font-bold text-foreground">
              A dashboard that stays out of your way
            </h2>
            <p className="mt-4 text-muted-foreground text-lg">
              Clean, focused, and fast — manage users and alerts without the clutter.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-8 animate-fade-in">
            <DashboardPreview />
            <AlertHistoryPreview />
          </div>
        </div>
      </section>

      {/* -------- CTA -------- */}
      <section className="py-20 lg:py-28">
        <div className="max-w-3xl mx-auto px-6 text-center space-y-6">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground">
            Ready to take control?
          </h2>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Create your admin account in seconds and start sending desktop
            notifications to your team.
          </p>
          <Link to="/login">
            <Button size="lg" className="gradient-primary text-primary-foreground gap-2 mt-4">
              Get Started Free <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* -------- FOOTER -------- */}
      <footer className="border-t border-border py-8">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md gradient-primary flex items-center justify-center">
              <Shield className="w-3 h-3 text-primary-foreground" />
            </div>
            <span className="font-medium text-foreground">Emergency Staff Alert</span>
          </div>
          <p>&copy; {new Date().getFullYear()} All rights reserved.</p>
        </div>
      </footer>

      {/* Demo Video Dialog */}
      {demoOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/80" onClick={() => setDemoOpen(false)} />
          <div className="relative z-10 w-full max-w-3xl mx-4 bg-background border rounded-lg shadow-lg">
            <div className="p-6 pb-0 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Emergency Staff Alert — Demo</h2>
              <button
                onClick={() => setDemoOpen(false)}
                className="rounded-sm opacity-70 hover:opacity-100 transition-opacity"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </button>
            </div>
            <div className="p-6 pt-4">
              <div className="rounded-xl overflow-hidden bg-black aspect-video">
                <iframe
                  src="https://iframe.mediadelivery.net/embed/655691/8aa4431a-c96d-40ce-9bb0-2a2047e6783e?autoplay=true&muted=false&loop=false&preload=true&responsive=true"
                  title="Emergency Staff Alert — Demo"
                  loading="lazy"
                  allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
                  allowFullScreen
                  className="block w-full h-full"
                  frameBorder={0}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Index;
