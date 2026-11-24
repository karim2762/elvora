import { useRemote } from './useApplications';
import { getAdminDashboard } from '../services/adminDashboardService';

export const useAdminDashboard = () => useRemote(getAdminDashboard, []);
