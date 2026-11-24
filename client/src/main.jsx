import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/landing.css';
import './styles/internships.css';
import './styles/auth.css';
import './styles/applications.css';
import './styles/dashboard.css';
import './styles/tracking.css';
import './styles/student.css';
import './styles/admin.css';
import './styles/admin-dashboard.css';
import './styles/admin-management.css';
import './styles/pay.css';
import './styles/verify.css';
import './styles/tasks.css';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './components/ui/Toast';

createRoot(document.getElementById('root')).render(
  <StrictMode><BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><ToastProvider><App /></ToastProvider></AuthProvider></BrowserRouter></StrictMode>
);
