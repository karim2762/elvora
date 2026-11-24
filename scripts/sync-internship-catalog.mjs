// Regenerates server/src/data/internshipCatalog.json from the client's demo internships.
// The API needs its own copy so it can verify an internship exists and is open WITHOUT trusting the browser.
// Run after editing client/src/data/internships.demo.js:   npm run catalog:sync
// When internships move into a real database, replace server/src/internships/catalog.js and delete this script.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { demoInternships } from '../client/src/data/internships.demo.js';

// Stage 07B: the snapshot carries every field the listing table stores. It is only used ONCE, to seed internship_listings
// (migration 10) on a database that has none; after that the database is the source of truth and administrators manage it.
export const toCatalogEntry = (i) => ({
  id: i.id, title: i.title, category: i.category, durationDays: i.durationDays,
  description: i.description, status: i.status, deadline: i.deadline, seats: i.seats,
  difficulty: i.difficulty, type: i.type, featured: i.featured, skills: i.skills, outcomes: i.outcomes, eligibility: i.eligibility,
  overview: i.overview, technologies: i.technologies, keywords: i.keywords, structure: i.structure, certificate: i.certificate, postedAt: i.postedAt,
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = new URL('../server/src/data/internshipCatalog.json', import.meta.url);
  fs.writeFileSync(out, `${JSON.stringify(demoInternships.map(toCatalogEntry), null, 2)}\n`);
  console.log(`Wrote ${demoInternships.length} internships to server/src/data/internshipCatalog.json`);
}
