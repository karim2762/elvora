// Stage 09B — adds any missing built-in task templates to the database (safe to run any number of times).  Usage: npm run tasks:seed
const { seedTaskLibrary } = await import('../server/src/services/taskLibrarySeed.js');
const { migrate } = await import('../server/src/db/index.js');
migrate();
console.log(seedTaskLibrary());
