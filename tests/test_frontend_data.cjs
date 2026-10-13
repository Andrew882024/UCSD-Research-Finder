const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dummy = { addEventListener() {} };
const context = vm.createContext({
  document: { querySelector: () => dummy, querySelectorAll: () => [], addEventListener() {} },
  localStorage: { getItem: () => null },
  window: { matchMedia: () => ({ matches: true }) },
  fetch: () => new Promise(() => {}),
  URL,
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/app.js'), 'utf8'), context);
const evaluate = expression => vm.runInContext(expression, context);

assert.deepEqual(
  [...evaluate(`(() => {
    const row = (name, recordType, score, ai) => ({ score, record: { displayName: name, recordType, aiLabScore: ai === undefined ? undefined : { score: ai } } });
    const rows = [row("Low lab", "lab", 30, 20), row("Prof", "professor", 20), row("High lab", "lab", 10, 95), row("Unscored lab", "lab", 40)];
    rows.sort(SORTERS.relevance);
    orderLabsByAiScore(rows);
    return rows.map((r) => r.record.displayName);
  })()`)],
  ['High lab', 'Low lab', 'Prof', 'Unscored lab'],
  'labs follow AI lab score over text relevance and keep their slots among other record types',
);
assert.notEqual(
  evaluate('professorMergeKey({ displayName: "One Professor", email: "department@ucsd.edu" })'),
  evaluate('professorMergeKey({ displayName: "Another Professor", email: "department@ucsd.edu" })'),
  'shared department email must not merge different people',
);
assert.equal(evaluate('sourceChecked({ sourceUrls: ["https://ucsd.edu"], lastVerified: "2026-10-02" })'), false,
  'source links and legacy timestamps do not verify a record');
assert.equal(evaluate('ratedPlatforms({ ratings: { rateMyPI: { status: "no_reviews", score: 0, reviewCount: 0 } } }).length'), 0,
  'unreviewed profiles cannot become zero-star ratings');
assert.equal(evaluate('ratingStatusLabel({status: "no_reviews"})'), 'No reviews on matched profile');
assert.equal(evaluate('hasScholarProfile({ googleScholarUrl: "https://scholar.google.com/citations?view_op=search_authors&mauthors=Example" })'), false,
  'Scholar search pages are not verified author profiles');
assert.equal(evaluate('hasScholarProfile({ googleScholarUrl: "https://scholar.google.ch/citations?user=ExampleID" })'), true);
assert.equal(evaluate('dateLabel("2026-10-03T01:00:00Z")'), '2026-10-02', 'timestamps use the campus Pacific calendar date');
assert.equal(evaluate('dateLabel("2026-10-03")'), '2026-10-03', 'date-only source dates must not shift timezones');
assert(evaluate('courseTermOrder({term:"Fall 2026"}) > courseTermOrder({term:"Winter 2025"})'), 'teaching terms sort by year and season, not alphabetically');
assert.equal(evaluate('coursesFor({ teaching: { courses: [], candidates: [{courseCode:"ASTR 1"}] } }).length'), 0,
  'surname-only teaching leads cannot count as verified courses');
assert.equal(evaluate('buildIndex([{ displayName: "Example", links: [], teaching: { candidates: [{courseCode:"ASTR 1"}] } }])[0].haystack.includes("astr")'), false,
  'unverified leads cannot enter the normal course search index');
assert(evaluate('buildIndex([{displayName: "Example Professor", links: [], teaching: {courses: [{courseCode:"CSE 151A", title:"Machine Learning", term:"Fall 2026"}]}}])[0].haystack.includes("cse151a")'),
  'compact course-code queries must be searchable');
assert(evaluate('buildIndex([{displayName: "Example", links: [], researchKeywords: ["Zika virus"]}])[0].haystack.includes("zika")'),
  'official profile keywords must be searchable');
console.log('PASS: shared-email identity, field verification, missing scores, and course-code indexing');
