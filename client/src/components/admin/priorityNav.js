// Stage 10A Part 2: the admin console entry for priority requests. Admin-only (the route sits behind the admin session guard).
export const priorityNavItem = (icon) => ({ label: 'Priority Certificates', to: '/admin/priority-certificates', icon });
export const priorityPricingNavItem = (icon) => ({ label: 'Priority Pricing & UPI', to: '/admin/priority-pricing', icon });
export const paymentVerificationNavItem = (icon) => ({ label: 'UPI Payment Verification', to: '/admin/payment-verification', icon });
