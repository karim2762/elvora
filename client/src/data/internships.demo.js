// DEMO internship records. This is the ONLY place demo internships live.
// Shape matches what the future REST API should return (see internshipService.js).
// Presentation components must never hardcode internships; they read via the service.

const DEFAULT_WHO = {
  Beginner: 'Students new to this area who are ready to learn step by step.',
  Intermediate: 'Students with basic programming knowledge who want to build practical depth.',
  Advanced: 'Students comfortable with programming fundamentals who want to build larger projects.',
};

function buildPlan(days, t) {
  const p = (label, title, detail) => ({ label, title, detail });
  if (days <= 7) return [
    p('Days 1–2', t[0], 'Core concepts with guided exercises.'),
    p('Days 3–5', `${t[1]} and ${t[2]}`, 'Hands-on practice tasks.'),
    p('Days 6–7', 'Mini project and review', 'Complete and submit your mini project.'),
  ];
  if (days <= 30) return [
    p('Week 1', t[0], 'Concepts and guided exercises.'),
    p('Week 2', t[1], 'Practice tasks and a short review.'),
    p('Week 3', t[2], 'Applied exercises building towards the project.'),
    p('Week 4', `${t[3]} and final project`, 'Finish, submit and present your project.'),
  ];
  if (days <= 60) return [
    p('Weeks 1–2', t[0], 'Concepts and weekly tasks.'),
    p('Weeks 3–4', t[1], 'Practice tasks and a milestone review.'),
    p('Weeks 5–6', t[2], 'Applied work on the project.'),
    p('Weeks 7–8', `${t[3]} and final project`, 'Finish, submit and present your project.'),
  ];
  return [
    p('Month 1', `${t[0]} and ${t[1]}`, 'Foundations with weekly tasks.'),
    p('Month 2', t[2], 'Deeper practice and a milestone review.'),
    p('Month 3', `${t[3]} and capstone project`, 'Build, submit and present your capstone project.'),
  ];
}

const assessmentFor = (days) => days <= 7
  ? 'A short quiz and a review of your mini project.'
  : days <= 30
    ? 'Weekly tasks, a mid-point check and a final project evaluation.'
    : 'Weekly tasks, milestone reviews and a final project presentation.';

const COMPLETION = [
  'Complete the assigned learning tasks.',
  'Submit your final project by the program deadline.',
  'Meet the assessment criteria set for the program.',
];
const CERTIFICATE = 'A completion certificate is issued after you meet all completion requirements and your submission has been reviewed.';

function make(o) {
  return {
    id: o.id, title: o.title, category: o.category, description: o.description,
    overview: o.overview || `${o.description} You will learn through structured tasks and finish by completing a practical project.`,
    durationDays: o.days, difficulty: o.difficulty, type: o.type,
    skills: o.skills, technologies: o.tech, outcomes: o.outcomes, keywords: o.keywords || [],
    eligibility: {
      who: o.who || DEFAULT_WHO[o.difficulty],
      knowledge: o.knowledge || ['Basic computer skills', 'Willingness to practice regularly'],
      academic: 'Open to students in engineering, computer science and related technical programs.',
    },
    structure: { plan: buildPlan(o.days, o.topics), project: o.project, assessment: assessmentFor(o.days), completion: COMPLETION },
    certificate: CERTIFICATE,
    status: o.status || 'open', seats: o.seats ?? null, featured: !!o.featured,
    postedAt: o.posted, deadline: o.deadline || null,
  };
}

export const demoInternships = [
  make({ id: 'ELV-PY-001', title: 'Python Programming Essentials', category: 'python-development', days: 30, difficulty: 'Beginner', type: 'Training + Project', featured: true, seats: 40, posted: '2026-10-20', deadline: '2027-01-15',
    description: 'Learn Python from the ground up and build a useful command-line tool.',
    skills: ['Python', 'OOP', 'File Handling', 'Git'], tech: ['Python 3', 'VS Code', 'Git'], keywords: ['coding', 'scripting'],
    outcomes: ['Write clean Python programs using core data structures', 'Apply object-oriented design in small projects', 'Use Git to manage your code'],
    topics: ['Python syntax and data structures', 'Functions, modules and OOP', 'Files, APIs and automation', 'Testing and packaging'],
    project: 'Build a command-line utility that automates an everyday task.', knowledge: ['Basic computer skills', 'Logical thinking'] }),
  make({ id: 'ELV-PY-002', title: 'Python Automation Sprint', category: 'python-development', days: 7, difficulty: 'Beginner', type: 'Project-Based', seats: 60, posted: '2026-11-10', deadline: '2027-01-10',
    description: 'A fast-paced week of Python scripts that automate real tasks.',
    skills: ['Python', 'Automation', 'Scripting'], tech: ['Python 3', 'Command line'],
    outcomes: ['Automate repetitive file and text tasks', 'Read and write CSV and JSON files', 'Package a small script for reuse'],
    topics: ['Python basics refresher', 'Working with files', 'Automating tasks', 'Wrap-up'], project: 'Create a script that organizes and renames files automatically.' }),
  make({ id: 'ELV-JV-001', title: 'Java Application Development', category: 'java-development', days: 60, difficulty: 'Intermediate', type: 'Training + Project', seats: 30, posted: '2026-09-28', deadline: '2027-01-05',
    description: 'Build solid object-oriented foundations and a complete Java application.',
    skills: ['Java', 'OOP', 'Collections', 'JDBC'], tech: ['Java 17', 'IntelliJ IDEA', 'MySQL'], keywords: ['object oriented'],
    outcomes: ['Design applications with OOP principles', 'Use collections and exceptions effectively', 'Connect a Java app to a database'],
    topics: ['Core Java and OOP', 'Collections and exceptions', 'Database connectivity', 'Application design'], project: 'Build a console or desktop management application backed by a database.',
    knowledge: ['Basic programming concepts', 'Familiarity with any programming language'] }),
  make({ id: 'ELV-JV-002', title: 'Java Core Basics', category: 'java-development', days: 30, difficulty: 'Beginner', type: 'Self-Paced', posted: '2026-10-02', deadline: '2027-01-05',
    description: 'Start your Java journey with syntax, classes and simple programs.',
    skills: ['Java', 'OOP Basics', 'Problem Solving'], tech: ['Java 17', 'JDK', 'VS Code'],
    outcomes: ['Write and run Java programs confidently', 'Understand classes and objects', 'Solve beginner coding problems'],
    topics: ['Java syntax and control flow', 'Classes and objects', 'Arrays and strings', 'Inheritance and mini project'], project: 'Create a small library or inventory program.' }),
  make({ id: 'ELV-WD-001', title: 'Responsive Web Development', category: 'web-development', days: 30, difficulty: 'Beginner', type: 'Project-Based', featured: true, seats: 50, posted: '2026-11-02', deadline: '2027-01-20',
    description: 'Design and build modern, responsive websites with HTML, CSS and JavaScript.',
    skills: ['HTML', 'CSS', 'JavaScript', 'Responsive Design'], tech: ['HTML5', 'CSS3', 'JavaScript', 'Git'], keywords: ['frontend', 'website'],
    outcomes: ['Build responsive layouts with Flexbox and Grid', 'Add interactivity using JavaScript', 'Publish a portfolio website'],
    topics: ['HTML and semantic structure', 'CSS layouts and responsiveness', 'JavaScript fundamentals', 'DOM and deployment'], project: 'Build and publish a personal portfolio website.' }),
  make({ id: 'ELV-WD-002', title: 'Frontend Starter Week', category: 'web-development', days: 7, difficulty: 'Beginner', type: 'Self-Paced', posted: '2026-11-15', deadline: '2027-01-20',
    description: 'A one-week introduction to building your first web page.',
    skills: ['HTML', 'CSS', 'Basic JavaScript'], tech: ['HTML5', 'CSS3', 'Browser DevTools'], keywords: ['frontend', 'beginner web'],
    outcomes: ['Create a structured web page', 'Style it with CSS', 'Add a simple interactive feature'],
    topics: ['HTML basics', 'Styling with CSS', 'Intro to JavaScript', 'Wrap-up'], project: 'Build a single-page landing page.' }),
  make({ id: 'ELV-FS-001', title: 'Full Stack Web Application Development', category: 'full-stack-development', days: 90, difficulty: 'Advanced', type: 'Project-Based', featured: true, seats: 20, posted: '2026-10-05', deadline: '2027-01-12',
    description: 'Build a complete web application from database to user interface.',
    skills: ['React', 'Node.js', 'REST APIs', 'SQL'], tech: ['React', 'Node.js', 'Express', 'PostgreSQL', 'Git'], keywords: ['frontend', 'backend', 'mern', 'api'],
    outcomes: ['Design and build REST APIs', 'Create a responsive React frontend', 'Deploy a complete application'],
    topics: ['Frontend with React', 'Backend with Node.js and Express', 'Databases and authentication', 'Testing and deployment'], project: 'Build and deploy a full stack capstone application.',
    knowledge: ['HTML, CSS and JavaScript basics', 'Basic understanding of databases'] }),
  make({ id: 'ELV-AI-001', title: 'Introduction to Artificial Intelligence', category: 'artificial-intelligence', days: 60, difficulty: 'Intermediate', type: 'Training + Project', status: 'upcoming', posted: '2026-11-18',
    description: 'Explore how intelligent systems work and build a practical AI application.',
    skills: ['Python', 'Search Algorithms', 'NLP Basics', 'AI Ethics'], tech: ['Python', 'NumPy', 'Jupyter'], keywords: ['ai', 'chatbot'],
    outcomes: ['Explain core AI concepts and approaches', 'Implement basic intelligent algorithms', 'Build a small AI-powered application'],
    topics: ['AI concepts and problem solving', 'Search and reasoning', 'Language and text basics', 'Responsible AI'], project: 'Build a simple rule-based or ML-assisted chatbot.',
    knowledge: ['Python basics', 'Basic mathematics'] }),
  make({ id: 'ELV-ML-001', title: 'Machine Learning Foundations', category: 'machine-learning', days: 90, difficulty: 'Intermediate', type: 'Project-Based', featured: true, seats: 25, posted: '2026-10-12', deadline: '2027-01-08',
    description: 'Train, evaluate and improve machine learning models on real datasets.',
    skills: ['Python', 'Pandas', 'scikit-learn', 'Model Evaluation'], tech: ['Python', 'Pandas', 'scikit-learn', 'Jupyter'], keywords: ['ml', 'models', 'prediction'],
    outcomes: ['Prepare data for machine learning', 'Train and compare classical models', 'Evaluate models with the right metrics'],
    topics: ['Data preparation', 'Supervised learning', 'Model evaluation and tuning', 'Unsupervised learning'], project: 'Develop an end-to-end prediction project on a public dataset.',
    knowledge: ['Python basics', 'Basic statistics'] }),
  make({ id: 'ELV-DS-001', title: 'Data Analysis and Visualization', category: 'data-science', days: 30, difficulty: 'Beginner', type: 'Training + Project', seats: 45, posted: '2026-10-30', deadline: '2027-01-18',
    description: 'Turn raw data into clear insights with analysis and visualization.',
    skills: ['Python', 'Pandas', 'Data Visualization', 'SQL'], tech: ['Python', 'Pandas', 'Matplotlib', 'SQL'], keywords: ['analytics', 'charts', 'dashboard'],
    outcomes: ['Clean and explore datasets', 'Create clear charts and summaries', 'Communicate findings to others'],
    topics: ['Data basics and cleaning', 'Analysis with Pandas', 'Visualization', 'Insights and reporting'], project: 'Analyze a public dataset and present your findings.' }),
  make({ id: 'ELV-CS-001', title: 'Cybersecurity Fundamentals', category: 'cybersecurity', days: 60, difficulty: 'Intermediate', type: 'Training + Project', seats: 30, posted: '2026-09-15', deadline: '2027-01-02',
    description: 'Understand common threats and learn how to build and test safer systems.',
    skills: ['Networking', 'Web Security', 'Linux', 'Threat Analysis'], tech: ['Linux', 'Wireshark', 'OWASP Top 10'], keywords: ['security', 'ethical hacking', 'network'],
    outcomes: ['Explain common attacks and defenses', 'Apply secure coding practices', 'Assess a simple system for weaknesses'],
    topics: ['Security basics and networking', 'Web application security', 'Linux and tools', 'Risk assessment'], project: 'Perform a security review of a sample web application in a safe lab setup.',
    knowledge: ['Basic networking concepts', 'Comfort with using a command line'] }),
  make({ id: 'ELV-CL-001', title: 'Cloud Computing Essentials', category: 'cloud-computing', days: 30, difficulty: 'Beginner', type: 'Self-Paced', posted: '2026-10-08', deadline: '2027-01-10',
    description: 'Learn cloud fundamentals and deploy a simple application online.',
    skills: ['Cloud Concepts', 'Virtual Machines', 'Storage', 'Deployment'], tech: ['Cloud platforms', 'Linux', 'Docker basics'], keywords: ['aws', 'azure', 'devops', 'deployment'],
    outcomes: ['Explain core cloud service models', 'Deploy an app to the cloud', 'Understand basic cost and security practices'],
    topics: ['Cloud concepts', 'Compute and storage', 'Networking and security basics', 'Deployment'], project: 'Deploy a small web application using a cloud platform.' }),
  make({ id: 'ELV-UX-001', title: 'UI/UX Design Fundamentals', category: 'ui-ux-design', days: 30, difficulty: 'Beginner', type: 'Project-Based', seats: 35, posted: '2026-10-18', deadline: '2027-01-15',
    description: 'Learn the design process and craft user-friendly interface prototypes.',
    skills: ['User Research', 'Wireframing', 'Prototyping', 'Design Systems'], tech: ['Figma'], keywords: ['design', 'figma', 'interface', 'prototype'],
    outcomes: ['Plan a design using user research', 'Create wireframes and prototypes', 'Apply consistent visual design'],
    topics: ['Design thinking and research', 'Wireframes and layouts', 'Visual design and color', 'Prototyping and testing'], project: 'Design and prototype a mobile app interface.',
    knowledge: ['Creativity and curiosity about design'] }),
  make({ id: 'ELV-C-001', title: 'C Programming Fundamentals', category: 'c-programming', days: 7, difficulty: 'Beginner', type: 'Training + Project', seats: 60, posted: '2026-11-12', deadline: '2027-01-10',
    description: 'A focused week covering C syntax, control flow, functions and arrays.',
    skills: ['C', 'Control Flow', 'Functions', 'Arrays'], tech: ['GCC', 'Code editor'], keywords: ['programming basics'],
    outcomes: ['Write and compile C programs', 'Use functions and arrays effectively', 'Debug common beginner errors'],
    topics: ['C basics and operators', 'Control flow and functions', 'Arrays and strings', 'Wrap-up'], project: 'Build a small menu-driven program.' }),
  make({ id: 'ELV-C-002', title: 'C Programming and Data Structures', category: 'c-programming', days: 60, difficulty: 'Intermediate', type: 'Project-Based', status: 'open', posted: '2026-08-10', deadline: '2026-10-31',
    description: 'Go deeper with pointers, memory and core data structures in C.',
    skills: ['C', 'Pointers', 'Data Structures', 'Memory Management'], tech: ['GCC', 'GDB'], keywords: ['dsa', 'linked list', 'stack', 'queue'],
    outcomes: ['Use pointers and dynamic memory safely', 'Implement lists, stacks and queues', 'Debug programs with a debugger'],
    topics: ['Pointers and memory', 'Structures and files', 'Linked lists', 'Stacks, queues and trees'], project: 'Implement a data structure library with tests.',
    knowledge: ['C basics', 'Familiarity with loops and functions'] }),
  make({ id: 'ELV-SD-001', title: 'Software Development Practices', category: 'software-development', days: 90, difficulty: 'Advanced', type: 'Project-Based', seats: 20, posted: '2026-09-22', deadline: '2027-01-12',
    description: 'Learn how professional teams design, build, test and ship software.',
    skills: ['Design Patterns', 'Testing', 'Git', 'Agile'], tech: ['Git', 'GitHub', 'Unit testing tools'], keywords: ['engineering', 'clean code', 'agile', 'ci'],
    outcomes: ['Apply design principles and patterns', 'Write automated tests', 'Work in a version-controlled team workflow'],
    topics: ['Requirements and design', 'Clean code and patterns', 'Testing and quality', 'Collaboration and delivery'], project: 'Develop and document a multi-module application using team practices.',
    knowledge: ['Programming experience in any language'] }),
  make({ id: 'ELV-SD-002', title: 'Version Control and Testing Basics', category: 'software-development', days: 30, difficulty: 'Intermediate', type: 'Training + Project', posted: '2026-11-05', deadline: '2027-01-18',
    description: 'Master Git workflows and write your first automated tests.',
    skills: ['Git', 'GitHub', 'Unit Testing', 'Debugging'], tech: ['Git', 'GitHub', 'Testing frameworks'], keywords: ['version control', 'collaboration'],
    outcomes: ['Use branches and pull requests confidently', 'Write and run unit tests', 'Debug code methodically'],
    topics: ['Git fundamentals', 'Branching and collaboration', 'Unit testing', 'Debugging and review'], project: 'Add tests and a clean Git history to an existing small project.',
    knowledge: ['Basic programming in any language'] }),
];
