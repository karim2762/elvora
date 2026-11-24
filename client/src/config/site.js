// Single source of truth for landing-page content.
// Edit values here; no component changes needed. Nothing below is a claim of
// achievement: unknown values are empty/placeholder until the organization fills them in.
import {
  Terminal, Coffee, Globe, Layers, Bot, Brain, BarChart3, ShieldCheck, Cloud, Palette,
  Laptop, FolderKanban, Binary, Code2, Users, FileText, Award, TrendingUp,
  Compass, UserPlus, Send, LayoutDashboard,
} from 'lucide-react';

export const brand = {
  name: 'ELVORA',
  tagline: 'Elevate Your Skills. Build Your Future.',
  description:
    'ELVORA is a student-focused internship platform providing practical Computer Science and Engineering internship opportunities.',
};

// Leave empty to show "Coming soon". Social icons only render when a url is set.
export const contact = { email: '', phone: '', address: '' };
export const socials = [
  { platform: 'LinkedIn', url: '' },
  { platform: 'Instagram', url: '' },
  { platform: 'YouTube', url: '' },
  { platform: 'GitHub', url: '' },
  { platform: 'X', url: '' },
];

export const routes = {
  home: '/', internships: '/internships', login: '/login', signup: '/signup',
  forgotPassword: '/forgot-password', resetPassword: '/reset-password', profile: '/student/profile',
  applications: '/student/applications', dashboard: '/student/dashboard',
  privacy: '/privacy', terms: '/terms',
};

export const navLinks = [
  { label: 'Home', to: '/' },
  { label: 'Internships', to: '/internships' },
  { label: 'About Us', to: '/#about' },
  { label: 'Services', to: '/#services' },
  { label: 'Contact', to: '/#contact' },
];

export const domains = [
  { slug: 'python-development', title: 'Python Development', icon: Terminal, text: 'Scripting, automation and backend foundations with Python.' },
  { slug: 'java-development', title: 'Java Development', icon: Coffee, text: 'Object-oriented design and application development in Java.' },
  { slug: 'web-development', title: 'Web Development', icon: Globe, text: 'Build responsive websites with HTML, CSS and JavaScript.' },
  { slug: 'full-stack-development', title: 'Full Stack Development', icon: Layers, text: 'Connect frontends, APIs and databases into complete apps.' },
  { slug: 'artificial-intelligence', title: 'Artificial Intelligence', icon: Bot, text: 'Explore intelligent systems and practical AI applications.' },
  { slug: 'machine-learning', title: 'Machine Learning', icon: Brain, text: 'Train and evaluate models on real datasets.' },
  { slug: 'data-science', title: 'Data Science', icon: BarChart3, text: 'Analyze data and turn it into clear insights.' },
  { slug: 'cybersecurity', title: 'Cybersecurity', icon: ShieldCheck, text: 'Learn core security concepts and safe development practices.' },
  { slug: 'cloud-computing', title: 'Cloud Computing', icon: Cloud, text: 'Understand cloud fundamentals, deployment and scaling.' },
  { slug: 'ui-ux-design', title: 'UI/UX Design', icon: Palette, text: 'Design intuitive interfaces and user-centered experiences.' },
  { slug: 'c-programming', title: 'C Programming', icon: Binary, text: 'Master the fundamentals of programming and memory with C.' },
  { slug: 'software-development', title: 'Software Development', icon: Code2, text: 'Learn professional practices for building maintainable software.' },
];
export const domainBySlug = (slug) => domains.find((d) => d.slug === slug);

// `available: false` shows a "Coming soon" badge instead of implying the service exists.
export const services = [
  { title: 'Technical Internships', icon: Laptop, available: true, text: 'Practical CSE internships across modern technology domains.' },
  { title: 'Hands-on Projects', icon: FolderKanban, available: true, text: 'Apply what you learn through project-based work.' },
  { title: 'Professional Mentorship', icon: Users, available: false, text: 'Guidance from experienced professionals.' },
  { title: 'Internship Offer Letters', icon: FileText, available: true, text: 'Digital offer letters for accepted applications.' },
  { title: 'Completion Certificates', icon: Award, available: true, text: 'Certificates for successfully completed internships.' },
  { title: 'Career Development', icon: TrendingUp, available: false, text: 'Resources to prepare for your technology career.' },
];

// Placeholders only. Replace '—' with real numbers once they are verified.
// Domain and duration counts are derived from the lists in this file.
export const stats = [
  { label: 'Internship Domains', value: String(domains.length) },
  { label: 'Flexible Durations', value: 'auto' },
  { label: 'Student Opportunities', value: '—' },
  { label: 'Learning Resources', value: '—' },
];

// Durations are stored internally in days. 7 Days is the only week-length option (no separate "1 Week").
export const durations = [
  { days: 7, label: '7 Days', enabled: true, text: 'A short, focused introduction.' },
  { days: 30, label: '1 Month', enabled: true, text: 'Build a solid practical foundation.' },
  { days: 60, label: '2 Months', enabled: true, text: 'Go deeper with a larger project.' },
  { days: 90, label: '3 Months', enabled: true, text: 'A full-length, in-depth experience.' },
];
export const activeDurations = durations.filter((d) => d.enabled);
stats[1].value = String(activeDurations.length);

// Show a badge only when verified === true AND a number is provided.
export const msme = {
  verified: false,
  registrationNumber: '', // e.g. the Udyam number, only after official registration
  verifyUrl: '',
};

// Sample/demo content. Replace with consented, genuine reviews and set isSample to false.
export const testimonials = [
  { name: 'Sample Student A', role: 'Demo role · Python Development', quote: 'Placeholder text showing how a student review will look here.', isSample: true },
  { name: 'Sample Student B', role: 'Demo role · Web Development', quote: 'Placeholder text showing how a student review will look here.', isSample: true },
  { name: 'Sample Student C', role: 'Demo role · Data Science', quote: 'Placeholder text showing how a student review will look here.', isSample: true },
];

export const howItWorks = [
  { icon: Compass, title: 'Explore Internships', text: 'Browse domains and find the right fit.' },
  { icon: UserPlus, title: 'Register Your Account', text: 'Create your student account.' },
  { icon: Send, title: 'Apply for an Internship', text: 'Choose a domain and duration, then apply.' },
  { icon: LayoutDashboard, title: 'Access Your Dashboard', text: 'Track your internship and documents.' },
];

export const faqs = [
  { q: 'What is ELVORA?', a: brand.description },
  { q: 'Who can apply?', a: 'ELVORA is built for students, especially in Computer Science and Engineering. Eligibility for each internship is shown on its listing.' },
  { q: 'What internship domains are available?', a: `Current domains: ${domains.map((d) => d.title).join(', ')}.` },
  { q: 'What are the internship durations?', a: `Duration options: ${activeDurations.map((d) => d.label).join(', ')}.` },
  { q: 'How can I apply?', a: 'Explore the internships, create your account, choose an internship and submit your application from your student dashboard.' },
  { q: 'Where can I download my offer letter?', a: 'Offer letters for accepted applications will be available in your student dashboard.' },
  { q: 'How can I get my completion certificate?', a: 'After you complete your internship, your certificate can be downloaded from your student dashboard, subject to the program’s completion requirements.' },
  { q: 'How can I contact support?', a: contact.email ? `Email us at ${contact.email}.` : 'Support contact details will be published here soon. Use the contact section at the bottom of the page.' },
];
