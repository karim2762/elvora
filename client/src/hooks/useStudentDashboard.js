import { useRemote } from './useApplications';
import { getDashboard } from '../services/studentService';

export const useStudentDashboard = () => useRemote(getDashboard, []);
