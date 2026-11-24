import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import Layout from './components/layout/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import PageLoader from './components/PageLoader';
import ProtectedRoute from './auth/ProtectedRoute';
import AdminRoute from './auth/AdminRoute';
import Home from './pages/Home';
import { routes } from './config/site';

// Secondary pages are code-split; the landing page ships in the main bundle.
const InternshipsPage = lazy(() => import('./pages/InternshipsPage'));
const named = (name) => lazy(() => import('./pages/Placeholders').then((m) => ({ default: m[name] })));
const InternshipDetailsPage = lazy(() => import('./pages/InternshipDetailsPage'));
const ApplyPage = lazy(() => import('./pages/ApplyPage'));
const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const SignupPage = lazy(() => import('./pages/auth/SignupPage'));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'));
const ApplicationSuccessPage = lazy(() => import('./pages/ApplicationSuccessPage'));
const PrivacyPage = named('PrivacyPage');
const TermsPage = named('TermsPage');
const NotFoundPage = named('NotFoundPage');
const VerifyPage = lazy(() => import('./pages/VerifyPage'));
const DashboardLayout = lazy(() => import('./components/dashboard/DashboardLayout'));
const OverviewPage = lazy(() => import('./pages/student/OverviewPage'));
const MyApplicationsPage = lazy(() => import('./pages/student/MyApplicationsPage'));
const ApplicationDetailsPage = lazy(() => import('./pages/student/ApplicationDetailsPage'));
const MyInternshipPage = lazy(() => import('./pages/student/MyInternshipPage'));
const MyTasksPage = lazy(() => import('./pages/student/MyTasksPage'));
const TaskDetailPage = lazy(() => import('./pages/student/TaskDetailPage'));
const AdminTaskLibraryPage = lazy(() => import('./pages/admin/AdminTaskLibraryPage'));
const AdminProjectsPage = lazy(() => import('./pages/admin/AdminProjectsPage'));
const AdminProjectEvaluationPage = lazy(() => import('./pages/admin/AdminProjectEvaluationPage'));
const PriorityCertificatePage = lazy(() => import('./pages/student/PriorityCertificatePage')); // Stage 10A: private, unlinked
const DocumentsPage = lazy(() => import('./pages/student/DocumentsPage'));
const NotificationsPage = lazy(() => import('./pages/student/NotificationsPage'));
const AdminPage = lazy(() => import('./pages/admin/AdminPage'));
const AdminLayout = lazy(() => import('./components/admin/AdminLayout'));
const AdminLoginPage = lazy(() => import('./pages/admin/AdminLoginPage'));
const AdminOverviewPage = lazy(() => import('./pages/admin/AdminOverviewPage'));
const AdminInternshipsPage = lazy(() => import('./pages/admin/AdminInternshipsPage'));
const AdminApplicationsPage = lazy(() => import('./pages/admin/AdminApplicationsPage'));
const AdminStudentsPage = lazy(() => import('./pages/admin/AdminStudentsPage'));
const AdminDocumentsPage = lazy(() => import('./pages/admin/AdminDocumentsPage'));
const AdminNotificationsPage = lazy(() => import('./pages/admin/AdminNotificationsPage'));
const AdminPriorityPage = lazy(() => import('./pages/admin/AdminPriorityPage'));
const AdminPriorityPricingPage = lazy(() => import('./pages/admin/AdminPriorityPricingPage'));
const AdminPaymentVerificationPage = lazy(() => import('./pages/admin/AdminPaymentVerificationPage'));
const AdminAuditPage = lazy(() => import('./pages/admin/AdminAuditPage'));
const AdminSettingsPage = lazy(() => import('./pages/admin/AdminSettingsPage'));
const AdminSectionPage = lazy(() => import('./pages/admin/AdminSectionPage'));
const MyProfilePage = lazy(() => import('./pages/student/MyProfilePage'));
const SettingsPage = lazy(() => import('./pages/student/SettingsPage'));

// Stage 04B URLs (/applications, /applications/:id) now live inside the dashboard; old links and bookmarks keep working.
const ToStudentApplication = () => { const { id } = useParams(); return <Navigate to={`/student/applications/${encodeURIComponent(id)}`} replace />; };

export default function App() {
  const { pathname } = useLocation();

  // The student dashboard has its own shell (sidebar + header), so it renders instead of the public navbar/footer.
  if (pathname === '/student' || pathname.startsWith('/student/')) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/student" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard" element={<OverviewPage />} />
              <Route path="profile" element={<MyProfilePage />} />
              <Route path="applications" element={<MyApplicationsPage />} />
              <Route path="applications/:id" element={<ApplicationDetailsPage />} />
              <Route path="internship" element={<MyInternshipPage />} />
              <Route path="tasks" element={<MyTasksPage />} />
              <Route path="tasks/:id" element={<TaskDetailPage />} />
              <Route path="documents" element={<DocumentsPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="dashboard" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
    );
  }

  // The admin console has its own plain shell (no student navbar/footer). It is not linked from the public site.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Stage 07A: role-based admin dashboard. /admin itself stays the existing console (admin session or ADMIN_API_KEY). */}
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/login" element={<AdminLoginPage />} />
            <Route element={<AdminRoute><AdminLayout /></AdminRoute>}>
              <Route path="/admin/dashboard" element={<AdminOverviewPage />} />
              <Route path="/admin/internships" element={<AdminInternshipsPage />} />
              <Route path="/admin/applications" element={<AdminApplicationsPage />} />
              <Route path="/admin/task-library" element={<AdminTaskLibraryPage />} />
              <Route path="/admin/projects" element={<AdminProjectsPage />} />
              <Route path="/admin/projects/:id" element={<AdminProjectEvaluationPage />} />
              <Route path="/admin/students" element={<AdminStudentsPage />} />
              <Route path="/admin/documents" element={<AdminDocumentsPage />} />
              <Route path="/admin/notifications" element={<AdminNotificationsPage />} />
              <Route path="/admin/priority-certificates" element={<AdminPriorityPage />} />
              <Route path="/admin/priority-pricing" element={<AdminPriorityPricingPage />} />
              <Route path="/admin/payment-verification" element={<AdminPaymentVerificationPage />} />
              <Route path="/admin/audit-logs" element={<AdminAuditPage />} />
              <Route path="/admin/settings" element={<AdminSettingsPage />} />
              <Route path="/admin/:section" element={<AdminSectionPage />} />
            </Route>
            <Route path="/admin/*" element={<Navigate to="/admin/dashboard" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <Layout>
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          {/* key on pathname only, so filter/search URL changes don't replay the transition */}
          <div key={pathname} className="page-enter">
          <Routes>
            <Route path={routes.home} element={<Home />} />
            <Route path={routes.internships} element={<InternshipsPage />} />
            <Route path="/internships/:id" element={<InternshipDetailsPage />} />
            <Route path="/apply/:id" element={<ApplyPage />} />
            <Route path={routes.login} element={<LoginPage />} />
            <Route path={routes.signup} element={<SignupPage />} />
            <Route path={routes.forgotPassword} element={<ForgotPasswordPage />} />
            <Route path={routes.resetPassword} element={<ResetPasswordPage />} />
            <Route path="/profile" element={<Navigate to={routes.profile} replace />} />
            <Route path="/applications" element={<Navigate to={routes.applications} replace />} />
            <Route path="/applications/:id" element={<ToStudentApplication />} />
            <Route path="/priority-certificate" element={<ProtectedRoute><PriorityCertificatePage /></ProtectedRoute>} />
            <Route path="/applications/:id/submitted" element={<ProtectedRoute><ApplicationSuccessPage /></ProtectedRoute>} />
            <Route path="/dashboard" element={<Navigate to={routes.dashboard} replace />} />
            <Route path="/verify/:reference" element={<VerifyPage />} />
            <Route path={routes.privacy} element={<PrivacyPage />} />
            <Route path={routes.terms} element={<TermsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
          </div>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}
