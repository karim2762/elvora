import { useRemote } from './useApplications';
import { listMyInternships } from '../services/studentService';

export const useMyInternships = () => useRemote(listMyInternships, []);
