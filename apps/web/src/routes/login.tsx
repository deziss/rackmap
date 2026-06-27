import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { CloudCog, Eye, EyeOff, Loader2 } from "lucide-react";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await authClient.signIn.email({ email, password });
      if (error) {
        toast.error(error.message ?? "Sign in failed");
        return;
      }
      await router.navigate({ to: "/" });
    } catch {
      toast.error("Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await authClient.signUp.email({ name, email, password });
      if (error) {
        toast.error(error.message ?? "Registration failed");
        return;
      }
      toast.success("Account created — you have Viewer access. Contact admin to upgrade.");
      await router.navigate({ to: "/" });
    } catch {
      toast.error("Registration failed");
    } finally {
      setLoading(false);
    }
  }

  const isRegister = mode === "register";

  return (
    <div className="mesh-bg relative flex min-h-screen items-center justify-center p-4 bg-background">
      <div className="w-full max-w-sm animate-fade-up">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8 gap-3">
          <div className="flex items-center justify-center rounded-2xl bg-primary/90 w-14 h-14 text-primary-foreground shadow-2xl shadow-primary/30">
            <CloudCog className="h-7 w-7" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">RackMap</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {isRegister ? "Create an account to get started" : "Sign in to manage your infrastructure"}
            </p>
          </div>
        </div>

        {/* Glass card */}
        <div className="rounded-2xl border border-white/10 bg-card/80 backdrop-blur-xl shadow-2xl shadow-black/20 p-6">
          <form onSubmit={isRegister ? handleRegister : handleSignIn} className="space-y-5">
            {isRegister && (
              <div className="space-y-1.5">
                <Label htmlFor="name" className="text-sm font-medium">Full name</Label>
                <Input
                  id="name"
                  type="text"
                  autoComplete="name"
                  placeholder="Jane Smith"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={loading}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-sm font-medium">Email address</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-sm font-medium">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={isRegister ? "new-password" : "current-password"}
                  placeholder="••••••••"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  className="pr-9"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {isRegister ? "Creating account…" : "Signing in…"}
                </>
              ) : (
                isRegister ? "Create account" : "Sign in"
              )}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {isRegister ? (
            <>
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => setMode("signin")}
                className="text-primary hover:underline font-medium"
              >
                Sign in
              </button>
            </>
          ) : (
            <>
              Don&apos;t have an account?{" "}
              <button
                type="button"
                onClick={() => setMode("register")}
                className="text-primary hover:underline font-medium"
              >
                Register
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
