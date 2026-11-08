import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { LoginPage } from "./pages/LoginPage.js";
import { CallbackPage } from "./pages/CallbackPage.js";
import { AppPage } from "./pages/AppPage.js";
import { SessionPage } from "./pages/SessionPage.js";
import { getSession } from "./lib/auth.js";

/**
 * Application router.
 *
 * Routes:
 *   /           → LoginPage (public)
 *   /callback   → CallbackPage (Cognito PKCE redirect target)
 *   /app        → AppPage (requires active session, redirects to / if not)
 *   *           → redirect to /
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const session = getSession();
  if (!session) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/callback" element={<CallbackPage />} />
        <Route
          path="/app"
          element={
            <ProtectedRoute>
              <AppPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/sessions/:sessionId"
          element={
            <ProtectedRoute>
              <SessionPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
