import { createRootRoute, createRoute, createRouter, Outlet, Link } from "@tanstack/react-router";
import { LoginPage } from "./routes/login";
import { DashboardPage } from "./routes/dashboard";

const rootRoute = createRootRoute({
  component: () => (
    <>
      <nav className="flex gap-4 border-b border-slate-200 p-4 text-sm">
        <Link to="/login">ログイン</Link>
        <Link to="/dashboard">ダッシュボード</Link>
      </nav>
      <Outlet />
    </>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <LoginPage />,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: DashboardPage,
});

const routeTree = rootRoute.addChildren([indexRoute, loginRoute, dashboardRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
