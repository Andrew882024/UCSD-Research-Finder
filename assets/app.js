const DATA_URL = "data/research-atlas.json";
const REAL_PORTAL_DATA_URL = "data/ucsd/real-portal-resources.json";
const NOT_FOUND = "Not found";
const UNKNOWN = "Unknown";
const PAGE_SIZE = 40;
const AUTO_LOAD_LIMIT = PAGE_SIZE * 5;
const SEARCH_DEBOUNCE_MS = 140;
const SAVED_KEY = "researchAtlasSaved";
const DATA_FETCH_OPTIONS = { credentials: "same-origin", cache: "no-cache" };
const METRIC_STOPWORDS = new Set([
  "about",
  "across",
  "advanced",
  "analysis",
  "and",
  "array",
  "based",
  "california",
  "computer",
  "course",
  "data",
  "department",
  "diego",
  "effect",
  "engineering",
  "faculty",
  "for",
  "from",
  "learning",
  "machine",
  "methods",
  "model",
  "models",
  "profile",
  "public",
  "research",
  "san",
  "science",
  "signals",
  "study",
  "through",
  "ucsd",
  "university",
  "using",
  "with",
]);

const DEFAULT_FILTERS = {
  query: "",
  type: "all",
  department: "all",
  savedOnly: false,
  sort: "relevance",
};

// Short URL parameter names keep shared links readable.
const URL_KEYS = {
  query: "q",
  type: "type",
  department: "dept",
  savedOnly: "saved",
  sort: "sort",
};

const TYPE_KEYS = ["professor", "lab", "resource"];
const RATING_PLATFORMS = [
  ["rateMyPI", "PI Review", "Mentoring opinions"],
  ["rateMyProfessors", "Rate My Professors", "Teaching opinions"],
];
const RATING_SHORT = { rateMyPI: "PI Review", rateMyProfessors: "RMP" };

const media = (query) => window.matchMedia(query);
const DESKTOP_DETAIL_QUERY = media("(min-width: 1280px)");
const DRAWER_QUERY = media("(max-width: 899px)");
const COMPACT_QUERY = media("(max-width: 639px)");
const REDUCED_MOTION_QUERY = media("(prefers-reduced-motion: reduce)");

const state = {
  ...DEFAULT_FILTERS,
  data: null,
  records: [],
  index: [],
  byId: new Map(),
  results: [],
  highlighter: null,
  visibleLimit: PAGE_SIZE,
  activeId: "",
  userSelected: false,
  saved: new Set(readStoredList(SAVED_KEY)),
};

const els = {
  form: document.querySelector("#searchForm"),
  query: document.querySelector("#query"),
  typeButtons: [...document.querySelectorAll("[data-type-choice]")],
  typeCounts: [...document.querySelectorAll("[data-count]")],
  department: document.querySelector("#departmentFilter"),
  sort: document.querySelector("#sortFilter"),
  clear: document.querySelector("#clearFilters"),
  filtersButton: document.querySelector("#filtersButton"),
  filterCount: document.querySelector("#filterCount"),
  savedToggle: document.querySelector("#savedToggle"),
  savedCountTop: document.querySelector("#savedCountTop"),
  shareButton: document.querySelector("#shareButton"),
  rail: document.querySelector("#filterRail"),
  railClose: document.querySelector("#railClose"),
  railApply: document.querySelector("#railApply"),
  professorCount: document.querySelector("#professorCount"),
  labCount: document.querySelector("#labCount"),
  realResourceCount: document.querySelector("#realResourceCount"),
  courseCount: document.querySelector("#courseCount"),
  ratingCount: document.querySelector("#ratingCount"),
  updatedAt: document.querySelector("#updatedAt"),
  workspace: document.querySelector("#workspace"),
  resultHeading: document.querySelector("#resultHeading"),
  coverageLine: document.querySelector("#coverageLine"),
  activeFilters: document.querySelector("#activeFilters"),
  results: document.querySelector("#results"),
  loadMore: document.querySelector("#loadMore"),
  empty: document.querySelector("#emptyState"),
  emptyHint: document.querySelector("#emptyHint"),
  emptyReset: document.querySelector("#emptyReset"),
  savedCount: document.querySelector("#savedCount"),
  savedList: document.querySelector("#savedList"),
  detailPanel: document.querySelector("#detailPanel"),
  detailContent: document.querySelector("#detailContent"),
  detailClose: document.querySelector("#detailClose"),
  scrim: document.querySelector("#scrim"),
  toast: document.querySelector("#toast"),
};

/* ---------- Small utilities ---------- */

function readStoredList(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredList(key, values) {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Private mode or blocked storage: saving still works for this visit.
  }
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}@.+-]+/gu, " ")
    .trim();
}

function isKnown(value) {
  return value !== null && value !== undefined && value !== "" && value !== NOT_FOUND && value !== UNKNOWN;
}

function knownText(value) {
  return isKnown(value) ? String(value) : "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueByNormalized(values) {
  const seen = new Set();
  const out = [];
  for (const value of values.filter(isKnown)) {
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function uniqueLinks(links) {
  const seen = new Set();
  const out = [];
  for (const [label, url] of links) {
    if (!isKnown(url) || seen.has(url)) continue;
    seen.add(url);
    out.push([label, url]);
  }
  return out;
}

function numericMetric(value) {
  const numeric = Number(value);
  return isKnown(value) && Number.isFinite(numeric) && numeric >= 0;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function slugLabel(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

function make(tag, className = "", content = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== "" && content !== null && content !== undefined) node.append(content);
  return node;
}

function makeExternal(label, url, className = "") {
  const anchor = make("a", className, label);
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  return anchor;
}

function prefersReducedMotion() {
  return REDUCED_MOTION_QUERY.matches;
}

/* ---------- Evidence model ---------- */

function coursesFor(record) {
  return Array.isArray(record.teaching?.courses) ? record.teaching.courses : [];
}

function courseTermOrder(course) {
  const term = String(course.term || "");
  const year = Number(term.match(/\b(?:19|20)\d{2}\b/)?.[0] || 0);
  const season = (term.match(/\b(winter|spring|summer|fall|autumn)\b/i)?.[1] || "").toLowerCase();
  return year * 10 + ({ winter: 1, spring: 2, summer: 3, fall: 4, autumn: 4 }[season] || 0);
}

function ratedPlatforms(record) {
  return Object.entries(record.ratings || {}).filter(([, rating]) => (
    rating.status === "verified" && numericMetric(rating.score) && Number(rating.reviewCount) > 0
  ));
}

function bestRating(record) {
  return ratedPlatforms(record).sort(([, a], [, b]) => Number(b.reviewCount) - Number(a.reviewCount))[0] || null;
}

function evidenceFields(record) {
  return Object.entries(record.fieldEvidence || {}).filter(([, items]) => (
    Array.isArray(items) && items.some((item) => item.sourceUrl && item.observedAt)
  ));
}

function sourceChecked(record) {
  return record.verification?.status === "source_checked" || evidenceFields(record).length > 0;
}

function verificationLabel(record) {
  if (record.verification?.status === "needs_review") return "Needs review";
  if (record.verification?.status === "unavailable") return "Source unavailable";
  if (sourceChecked(record)) return "Partly source checked";
  return "Legacy · not reverified";
}

function facultyLabel(record) {
  const legacyRole = {
    emeritus: "Emeritus faculty",
    former: "Former faculty · directory",
    deceased: "Deceased · directory",
  }[record.facultyStatus];
  return legacyRole || ({
    listed_faculty: "Listed in official faculty directory",
    affiliate: "Affiliate · directory",
    emeritus: "Emeritus faculty",
    lecturer: "Lecturer · directory",
    adjunct: "Adjunct faculty · directory",
  })[record.appointmentStatus] || (record.facultyStatus === "listed_in_official_directory" ? "Listed in official directory" : "Status not verified");
}

function departmentNames(record) {
  return uniqueByNormalized([
    record.department,
    ...(record.departmentAffiliations || []).map((item) => typeof item === "string" ? item : item.department || item.name),
    ...(Array.isArray(record.directoryListings) ? record.directoryListings.map((item) => item.department) : []),
  ]);
}

function dateLabel(value) {
  if (!isKnown(value)) return "Not checked";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function ratingStatusLabel(rating) {
  return ({
    no_reviews: "No reviews on matched profile",
    not_found: "No exact match in checked source",
    unavailable: "Source unavailable",
    needs_review: "Identity needs review",
    not_checked: "Not checked",
  })[rating?.status] || "Not verified";
}

function hasScholarProfile(record) {
  if (!isKnown(record.googleScholarUrl)) return false;
  try {
    const url = new URL(record.googleScholarUrl);
    return /^scholar\.google\.[a-z.]+$/.test(url.hostname) && url.pathname === "/citations" && Boolean(url.searchParams.get("user"));
  } catch {
    return false;
  }
}

function tokenSet(value) {
  return new Set(
    normalize(cleanText(value))
      .split(/\s+/)
      .filter((token) => token.length > 2 && !/^\d+$/.test(token) && !METRIC_STOPWORDS.has(token)),
  );
}

function relevantPublications(record) {
  const recordTokens = tokenSet([record.department, record.summary, record.labAffiliation, ...(record.researchAreas || [])].join(" "));
  const publications = record.academicProfile?.recentPublications || [];
  return publications
    .map((paper) => {
      let score = 0;
      for (const token of tokenSet([paper.title, paper.venue].join(" "))) {
        if (recordTokens.has(token)) score += 1;
      }
      return { paper, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || String(b.paper.publicationDate || b.paper.year || "").localeCompare(String(a.paper.publicationDate || a.paper.year || "")))
    .map(({ paper }) => paper);
}

function hasAcademicMetrics(record) {
  const profile = record.academicProfile || {};
  return numericMetric(profile.citationCount) || numericMetric(profile.worksCount) || numericMetric(profile.hIndex);
}

// Citation numbers are shown only when the author match itself carries verification evidence.
function academicMetrics(record) {
  const profile = record.academicProfile || {};
  const hasMetrics = hasAcademicMetrics(record);
  const source = isKnown(profile.source) ? profile.source : (isKnown(profile.openAlexUrl) ? "OpenAlex" : UNKNOWN);
  const verified = hasMetrics && (
    profile.verificationStatus === "verified"
    || (record.fieldEvidence?.academicProfile || []).some((evidence) => evidence.sourceUrl && evidence.observedAt && evidence.status === "verified")
  );
  return {
    profile,
    hasMetrics,
    verified,
    source,
    citationCount: verified && numericMetric(profile.citationCount) ? Number(profile.citationCount) : -1,
    status: verified ? `${source} verified` : (hasMetrics ? `${source} needs review` : "Not verified"),
  };
}

/* ---------- Record model ---------- */

function professorLinks(professor) {
  return [
    ["Faculty profile", professor.officialProfileUrl],
    ["Personal website", professor.personalWebsiteUrl],
    ["Google Scholar profile", hasScholarProfile(professor) ? professor.googleScholarUrl : null],
    ["Google Scholar search", professor.googleScholarSearchUrl],
    ["OpenAlex author", professor.academicProfile?.openAlexUrl],
    ["LinkedIn search", professor.linkedinSearchUrl],
    ["Lab affiliation", professor.labAffiliationUrl],
    ...(professor.labAffiliations || []).filter((lab) => lab.url !== professor.labAffiliationUrl).map((lab) => [lab.labName || "Related lab", lab.url]),
  ].filter(([, url]) => isKnown(url));
}

function labLinks(lab) {
  return [
    ["Lab website", lab.labWebsiteUrl],
    ["PI profile", lab.principalInvestigatorProfileUrl],
  ].filter(([, url]) => isKnown(url));
}

function resourceLinks(resource) {
  return [
    ["REAL Portal listing", resource.sourceUrl],
    ...(resource.externalUrls || []).map((url, index) => [`External link ${index + 1}`, url]),
  ].filter(([, url]) => isKnown(url));
}

function resourceAreas(resource) {
  const areas = ["Experiential learning"];
  const text = normalize(`${resource.title} ${resource.description} ${resource.resourceType}`);
  if (text.includes("research")) areas.push("Research");
  if (text.includes("intern")) areas.push("Internship");
  if (text.includes("volunteer")) areas.push("Volunteer");
  if (text.includes("co curricular") || resource.resourceType === "Co-curricular") areas.push("Co-curricular");
  return unique(areas);
}

function professorKind(item) {
  const flagged = ["emeritus", "former", "deceased"].includes(item.facultyStatus)
    || ["affiliate", "emeritus", "lecturer", "adjunct"].includes(item.appointmentStatus);
  return flagged ? facultyLabel(item).split(" · ")[0] : "Professor";
}

// Derived facts are computed once so filtering and sorting stay cheap on every keystroke.
function withFacts(record) {
  const rating = bestRating(record);
  record.facts = {
    courses: coursesFor(record).length,
    ratings: ratedPlatforms(record).map(([key]) => key),
    rating,
    checked: sourceChecked(record),
    needsReview: record.verification?.status === "needs_review",
    metrics: academicMetrics(record),
  };
  return record;
}

function buildRecords(data, realPortalData = null) {
  const professors = mergeProfessorDuplicates((data.professors || []).map((item) => ({
    ...item,
    recordType: "professor",
    displayName: knownText(item.name) || NOT_FOUND,
    displayKind: professorKind(item),
    summary: knownText(item.researchSummary),
    email: knownText(item.email),
    researchAreas: item.researchAreas || [],
    sourceUrls: item.sourceUrls || [],
    links: professorLinks(item),
  }))).map((record) => withFacts({
    ...record,
    departments: record.mergedProfileCount > 1 ? record.departmentAffiliations : departmentNames(record),
  }));

  const labs = (data.labs || []).map((item) => withFacts({
    ...item,
    recordType: "lab",
    displayName: knownText(item.labName) || NOT_FOUND,
    displayKind: item.recordSubtype === "research_group" ? "Research group" : "Lab",
    departments: departmentNames(item),
    summary: knownText(item.description),
    email: knownText(item.contactEmail),
    researchAreas: item.researchAreas || [],
    sourceUrls: item.sourceUrls || [],
    links: labLinks(item),
  }));

  const resources = (realPortalData?.resources || []).map((item) => withFacts({
    ...item,
    id: item.id || `real-${item.title}`,
    recordType: "resource",
    displayName: knownText(item.title) || NOT_FOUND,
    displayKind: "REAL resource",
    institution: "University of California San Diego",
    department: knownText(item.organization),
    departments: uniqueByNormalized([item.organization]),
    summary: knownText(item.description),
    email: knownText(item.contactEmails?.[0]),
    researchAreas: resourceAreas(item),
    sourceUrls: [item.sourceUrl || realPortalData.sourceUrl].filter(isKnown),
    links: resourceLinks(item),
    recruitingStatus: UNKNOWN,
    recruitingEvidence: { text: "", url: "" },
  }));

  return [...professors, ...labs, ...resources];
}

function professorMergeKey(record) {
  const name = normalize(record.displayName || record.name);
  if (!name || !isKnown(record.displayName || record.name)) return "";
  // Department offices and research centers share contact addresses. An email
  // alone is not a person identity and must not collapse different professors.
  if (isKnown(record.email)) return `name:${name}|email:${String(record.email).toLowerCase()}`;
  if (hasScholarProfile(record)) return `name:${name}|scholar:${record.googleScholarUrl}`;
  return "";
}

function academicScore(record) {
  const profile = record.academicProfile || {};
  let score = 0;
  if (isKnown(profile.citationCount)) score += 10;
  if (isKnown(profile.worksCount)) score += 8;
  if (isKnown(profile.openAlexUrl)) score += 6;
  score += Math.min((profile.recentPublications || []).length, 5);
  return score;
}

function summaryScore(record) {
  const text = String(record.summary || "");
  let score = Math.min(text.length, 400);
  if (/public .*faculty profile/i.test(text)) score -= 80;
  if (/catalog|listing/i.test(text)) score -= 45;
  if (/research on|research in|focus/i.test(text)) score += 80;
  return score;
}

function bestBy(records, scorer) {
  return [...records].sort((a, b) => scorer(b) - scorer(a))[0];
}

function mergeProfessorGroup(records) {
  if (records.length === 1) return records[0];

  const base = { ...bestBy(records, (record) => summaryScore(record) + academicScore(record)) };
  const academicRecord = bestBy(records, academicScore);
  const summaryRecord = bestBy(records, summaryScore);
  const departments = uniqueByNormalized(records.map((record) => record.department));
  const institutions = uniqueByNormalized(records.map((record) => record.institution));
  const profileIds = records.map((record) => record.id).filter(Boolean);

  base.id = profileIds[0] || base.id;
  base.mergedProfileIds = profileIds;
  base.mergedProfileCount = records.length;
  base.department = departments.join(" + ");
  base.institution = institutions[0] || base.institution;
  base.summary = summaryRecord.summary;
  base.researchSummary = summaryRecord.summary;
  base.email = records.find((record) => isKnown(record.email))?.email || base.email;
  base.personalWebsiteUrl = records.find((record) => isKnown(record.personalWebsiteUrl))?.personalWebsiteUrl || base.personalWebsiteUrl;
  base.officialProfileUrl = records.find((record) => isKnown(record.officialProfileUrl))?.officialProfileUrl || base.officialProfileUrl;
  base.googleScholarUrl = records.find((record) => hasScholarProfile(record))?.googleScholarUrl || base.googleScholarUrl;
  base.googleScholarSearchUrl = records.find((record) => isKnown(record.googleScholarSearchUrl))?.googleScholarSearchUrl || base.googleScholarSearchUrl;
  base.linkedinSearchUrl = records.find((record) => isKnown(record.linkedinSearchUrl))?.linkedinSearchUrl || base.linkedinSearchUrl;
  base.labAffiliation = uniqueByNormalized(records.map((record) => record.labAffiliation)).join(" + ") || base.labAffiliation;
  base.labAffiliationUrl = records.find((record) => isKnown(record.labAffiliationUrl))?.labAffiliationUrl || base.labAffiliationUrl;
  base.labAffiliations = [...new Map(records.flatMap((record) => record.labAffiliations || []).map((lab) => [`${lab.labId}|${lab.url}`, lab])).values()];
  base.aliasNames = uniqueByNormalized(records.flatMap((record) => record.aliasNames || []));
  base.departmentAffiliations = uniqueByNormalized(records.flatMap(departmentNames));
  base.directoryListings = records.flatMap((record) => Array.isArray(record.directoryListings) ? record.directoryListings : []);
  base.researchAreas = uniqueByNormalized(records.flatMap((record) => record.researchAreas || []));
  base.sourceUrls = unique(records.flatMap((record) => record.sourceUrls || []).filter(isKnown));
  base.links = uniqueLinks(records.flatMap((record) => record.links || []));
  base.academicProfile = academicRecord.academicProfile || base.academicProfile;
  const courseMap = new Map(records.flatMap(coursesFor).map((course) => [
    [course.courseCode, course.term, course.sourceUrl].join("|"), course,
  ]));
  base.teaching = { ...(base.teaching || {}), courses: [...courseMap.values()] };
  base.teaching.candidates = [...new Map(records.flatMap((record) => record.teaching?.candidates || []).map((course) => [
    [course.courseCode, course.term, course.sourceUrl, course.instructorName].join("|"), course,
  ])).values()];
  base.ratings = {};
  for (const record of [...records].sort((a, b) => String(a.verification?.lastAttemptedAt || "").localeCompare(String(b.verification?.lastAttemptedAt || "")))) {
    for (const [key, rating] of Object.entries(record.ratings || {})) {
      if (!base.ratings[key] || rating.status === "verified") base.ratings[key] = rating;
    }
  }
  base.fieldEvidence = {};
  records.forEach((record) => Object.entries(record.fieldEvidence || {}).forEach(([key, values]) => {
    base.fieldEvidence[key] = [...(base.fieldEvidence[key] || []), ...(Array.isArray(values) ? values : [])];
  }));
  base.verification = records.find((record) => record.verification?.status === "needs_review")?.verification
    || records.find((record) => record.verification?.status === "source_checked")?.verification
    || base.verification;
  base.recruitingStatus = records.find((record) => record.recruitingStatus === "Recruiting")?.recruitingStatus
    || records.find((record) => record.recruitingStatus === "Not recruiting")?.recruitingStatus
    || base.recruitingStatus;
  base.recruitingEvidence = records.find((record) => record.recruitingEvidence?.text)?.recruitingEvidence || base.recruitingEvidence;
  return base;
}

function mergeProfessorDuplicates(professors) {
  const groups = new Map();
  const singles = [];
  for (const professor of professors) {
    const key = professorMergeKey(professor);
    if (!key) {
      singles.push(professor);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(professor);
  }

  return [...groups.values()].map(mergeProfessorGroup).concat(singles);
}

function buildIndex(records) {
  return records.map((record) => {
    const departments = record.departments || departmentNames(record);
    const fields = [
      record.displayName,
      record.displayKind,
      record.institution,
      record.facultyStatus,
      record.directorySection,
      record.appointmentStatus,
      ...(record.aliasNames || []),
      ...departments,
      record.summary,
      record.email,
      record.labAffiliation,
      ...(record.labAffiliations || []).flatMap((lab) => [lab.labName, lab.url]),
      record.principalInvestigator,
      ...(record.relatedProfessorNames || []),
      record.organization,
      record.resourceType,
      record.applicationProcedure,
      record.academicProfile?.matchedName,
      record.academicProfile?.openAlexUrl,
      ...(record.academicProfile?.recentPublications || []).flatMap((paper) => [paper.title, paper.venue, paper.year]),
      record.recruitingStatus,
      record.recruitingEvidence?.text,
      // Compact codes ("cse151a") are indexed so course searches work without the space.
      ...coursesFor(record).flatMap((course) => [course.courseCode, String(course.courseCode || "").replace(/\s+/g, ""), course.title, course.term, course.status]),
      ...Object.values(record.ratings || {}).map((rating) => rating.platform),
      ...(record.researchAreas || []),
      ...(record.researchKeywords || []),
      ...(record.links || []).flatMap(([label, url]) => [label, url]),
      ...(record.sourceUrls || []),
    ];

    return {
      haystack: normalize(fields.filter(isKnown).join(" ")),
      name: normalize(record.displayName),
      departments: departments.map(normalize),
      areas: (record.researchAreas || []).map(normalize),
    };
  });
}

/* ---------- Search & filtering ---------- */

function compileTerms() {
  return normalize(state.query).split(/\s+/).filter(Boolean);
}

function matchesFilters(record, indexed, terms) {
  const { facts } = record;
  if (state.savedOnly && !state.saved.has(record.id)) return false;
  if (state.department !== "all" && !record.departments.includes(state.department)) return false;
  if (terms.length && !terms.every((term) => indexed.haystack.includes(term))) return false;
  return true;
}

function scoreRecord(record, indexed, terms) {
  const { facts } = record;
  // Without a query, records with more checked evidence surface first.
  let score = (facts.checked ? 4 : 0) + (facts.courses ? 3 : 0) + (facts.ratings.length ? 2 : 0) + (facts.metrics.verified ? 2 : 0);
  for (const term of terms) {
    if (indexed.name.startsWith(term)) score += 6;
    if (indexed.name.includes(term)) score += 10;
    if (indexed.departments.some((department) => department.includes(term))) score += 5;
    if (indexed.areas.some((area) => area.includes(term))) score += 6;
    if (indexed.haystack.includes(term)) score += 1;
  }
  if (record.recruitingStatus === "Recruiting") score += 3;
  return score;
}

function ratingSortValue(record) {
  const rating = record.facts.rating?.[1];
  return rating ? Number(rating.score) * 1000 + Math.min(Number(rating.reviewCount), 999) : -1;
}

const byName = (a, b) => a.record.displayName.localeCompare(b.record.displayName);
const SORTERS = {
  relevance: (a, b) => b.score - a.score || byName(a, b),
  name: byName,
  department: (a, b) => (a.record.departments[0] || "").localeCompare(b.record.departments[0] || "") || byName(a, b),
  courses: (a, b) => b.record.facts.courses - a.record.facts.courses || byName(a, b),
  rating: (a, b) => ratingSortValue(b.record) - ratingSortValue(a.record) || byName(a, b),
  citations: (a, b) => b.record.facts.metrics.citationCount - a.record.facts.metrics.citationCount || byName(a, b),
  sources: (a, b) => b.record.sourceUrls.length - a.record.sourceUrls.length || byName(a, b),
};

// One pass computes the visible rows and the per-type counts under every other filter,
// so the type tabs always show how many records each tab would reveal.
function computeResults() {
  const terms = compileTerms();
  const counts = { all: 0, professor: 0, lab: 0, resource: 0 };
  const rows = [];
  state.records.forEach((record, i) => {
    const indexed = state.index[i];
    if (!matchesFilters(record, indexed, terms)) return;
    counts.all += 1;
    counts[record.recordType] += 1;
    if (state.type !== "all" && record.recordType !== state.type) return;
    rows.push({ record, score: state.sort === "relevance" ? scoreRecord(record, indexed, terms) : 0 });
  });
  rows.sort(SORTERS[state.sort] || SORTERS.relevance);
  return { records: rows.map((row) => row.record), counts, terms };
}

function buildHighlighter(terms) {
  const usable = terms.filter((term) => term.length > 1).sort((a, b) => b.length - a.length);
  return usable.length ? new RegExp(usable.map(escapeRegExp).join("|"), "gi") : null;
}

function highlight(value) {
  const source = String(value || "");
  const fragment = document.createDocumentFragment();
  if (!state.highlighter) {
    fragment.append(source);
    return fragment;
  }
  let last = 0;
  for (const match of source.matchAll(state.highlighter)) {
    fragment.append(source.slice(last, match.index), make("mark", "", match[0]));
    last = match.index + match[0].length;
  }
  fragment.append(source.slice(last));
  return fragment;
}

/* ---------- URL state ---------- */

function readUrl() {
  const params = new URL(window.location.href).searchParams;
  for (const [key, param] of Object.entries(URL_KEYS)) {
    if (!params.has(param)) continue;
    const value = params.get(param);
    state[key] = typeof DEFAULT_FILTERS[key] === "boolean" ? value === "1" : value;
  }
  if (!["all", ...TYPE_KEYS].includes(state.type)) state.type = "all";
  if (!SORTERS[state.sort]) state.sort = "relevance";
  if (params.has("id")) {
    state.activeId = params.get("id");
    state.userSelected = true;
  }
}

function writeUrl() {
  const params = new URLSearchParams();
  for (const [key, param] of Object.entries(URL_KEYS)) {
    const value = state[key];
    if (value === DEFAULT_FILTERS[key] || value === "") continue;
    params.set(param, typeof value === "boolean" ? "1" : value);
  }
  if (state.userSelected && state.activeId) params.set("id", state.activeId);
  const query = params.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (next !== `${window.location.pathname}${window.location.search}`) {
    window.history.replaceState(null, "", next);
  }
}

/* ---------- Facets & controls ---------- */

function countBy(values) {
  const counts = new Map();
  for (const value of values) {
    if (isKnown(value)) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function setSelectOptions(select, entries, allLabel, current) {
  const options = [new Option(allLabel, "all")];
  for (const [value, count] of entries) options.push(new Option(`${value} (${formatNumber(count)})`, value));
  select.replaceChildren(...options);
  select.value = entries.some(([value]) => value === current) ? current : "all";
}

function renderFacets() {
  setSelectOptions(els.department, countBy(state.records.flatMap((record) => record.departments)), "All departments", state.department);
  state.department = els.department.value;
}

function syncStateFromControls() {
  state.query = els.query.value.trim();
  state.department = els.department.value;
  state.sort = els.sort.value;
}

function syncControls() {
  if (els.query.value.trim() !== state.query) els.query.value = state.query;
  els.department.value = state.department;
  els.sort.value = state.sort;
  els.department.classList.toggle("is-set", els.department.value !== "all");
  els.savedToggle.setAttribute("aria-pressed", String(state.savedOnly));
}

function activeFilterEntries() {
  const entries = [];
  if (state.savedOnly) entries.push(["savedOnly", "Saved", "only"]);
  if (state.department !== "all") entries.push(["department", "Dept", state.department]);
  return entries;
}

function renderActiveFilters() {
  const entries = activeFilterEntries();
  els.activeFilters.hidden = entries.length === 0;
  const chips = entries.map(([key, label, value]) => {
    const chip = make("button", "chip");
    chip.type = "button";
    chip.dataset.filterKey = key;
    chip.setAttribute("aria-label", `Remove filter ${label}: ${value}`);
    chip.append(make("small", "", label), value);
    return chip;
  });
  if (entries.length > 1) {
    const clearAll = make("button", "text-button chip-clear", "Clear all");
    clearAll.type = "button";
    clearAll.dataset.filterKey = "*";
    chips.push(clearAll);
  }
  els.activeFilters.replaceChildren(...chips);
  const railFilters = entries.filter(([key]) => key !== "savedOnly").length;
  els.filterCount.hidden = railFilters === 0;
  els.filterCount.textContent = railFilters;
}

function resetFilters({ keepQuery = false } = {}) {
  const query = state.query;
  Object.assign(state, DEFAULT_FILTERS);
  if (keepQuery) state.query = query;
  syncControls();
  update({ scroll: true });
}

function clearFilter(key) {
  if (key === "*") {
    resetFilters({ keepQuery: true });
    return;
  }
  state[key] = DEFAULT_FILTERS[key];
  syncControls();
  update({ scroll: true });
}

/* ---------- Result rows ---------- */

const BOOKMARK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11v17L12 16.2l-5.5 4.3z"/></svg>';

function rowMetric(label, value, known = true) {
  const cell = make("div", `row-metric${known ? "" : " is-empty"}`);
  cell.append(make("dt", "", label), make("dd", "", known ? value : "—"));
  return cell;
}

function rowMetrics(record) {
  const list = make("dl", "row-metrics");
  const { facts } = record;
  if (record.recordType === "professor") {
    if (facts.metrics.verified) list.append(rowMetric("Citations", formatNumber(facts.metrics.citationCount)));
    list.append(rowMetric("Courses", formatNumber(facts.courses), facts.courses > 0));
    if (facts.rating) {
      const [key, rating] = facts.rating;
      list.append(rowMetric(`${RATING_SHORT[key] || rating.platform} · ${formatNumber(rating.reviewCount)}`, `${rating.score}`));
    } else {
      list.append(rowMetric("Rating", "", false));
    }
  } else if (record.recordType === "lab") {
    list.append(rowMetric("Sources", formatNumber(record.sourceUrls.length)));
  } else if (isKnown(record.yearOfActivity)) {
    list.append(rowMetric("Year", String(record.yearOfActivity)));
  }
  return list;
}

function rowTags(record) {
  const departments = new Set(record.departments.map(normalize));
  const tags = record.researchAreas.filter((area) => !departments.has(normalize(area)));
  // Profile keywords fill in for records whose prose matched no controlled area.
  if (tags.length < 3) tags.push(...(record.researchKeywords || []).slice(0, 4 - tags.length));
  if (record.recordType === "lab" && isKnown(record.principalInvestigator)) tags.unshift(`PI ${record.principalInvestigator}`);
  if (record.recordType === "professor" && record.facts.courses) {
    tags.unshift(...unique(coursesFor(record).map((course) => course.courseCode)).slice(0, 3));
  }
  if (!tags.length) return null;
  const row = make("p", "row-tags");
  row.append(...tags.slice(0, 6).map((tag) => make("span", "", highlight(tag))));
  return row;
}

function makeSaveToggle(record) {
  const saved = state.saved.has(record.id);
  const button = make("button", "save-toggle");
  button.type = "button";
  button.dataset.saveId = record.id;
  button.innerHTML = BOOKMARK_SVG;
  button.setAttribute("aria-pressed", String(saved));
  button.setAttribute("aria-label", `${saved ? "Remove" : "Save"} ${record.displayName}`);
  button.title = saved ? "Saved (S)" : "Save (S)";
  return button;
}

function renderRow(record, position, animateIndex) {
  const row = make("li", "row");
  row.dataset.id = record.id;
  if (record.id === state.activeId) row.classList.add("is-selected");
  if (animateIndex !== null && !prefersReducedMotion()) {
    row.classList.add("is-entering");
    row.style.setProperty("--i", animateIndex);
    row.addEventListener("animationend", () => row.classList.remove("is-entering"), { once: true });
  }

  const meta = make("p", "row-meta");
  meta.append(make("span", "row-kind", record.displayKind));
  const departmentLine = record.recordType === "resource"
    ? [record.resourceType, record.organization].filter(isKnown).join(" · ")
    : record.departments.join(" · ");
  if (departmentLine) meta.append(make("span", "row-dept", departmentLine));
  if (record.recruitingStatus === "Recruiting") meta.append(make("span", "row-flag", "Recruiting"));
  if (record.facts.needsReview) meta.append(make("span", "row-flag is-warn", "Needs review"));

  const title = make("button", "row-title", highlight(record.displayName));
  title.type = "button";
  title.dataset.openId = record.id;

  const main = make("div", "row-main");
  main.append(meta, title);
  if (record.summary) main.append(make("p", "row-summary", highlight(record.summary)));
  const tags = rowTags(record);
  if (tags) main.append(tags);

  const side = make("div", "row-side");
  side.append(rowMetrics(record), makeSaveToggle(record));

  row.append(make("span", "row-index", String(position + 1).padStart(3, "0")), main, side);
  return row;
}

function appendRows(from, to, animate) {
  const fragment = document.createDocumentFragment();
  state.results.slice(from, to).forEach((record, offset) => {
    fragment.append(renderRow(record, from + offset, animate && offset < 14 ? offset : null));
  });
  els.results.append(fragment);
}

function renderCounts(counts) {
  els.typeCounts.forEach((node) => {
    node.textContent = formatNumber(counts[node.dataset.count] || 0);
  });
  els.typeButtons.forEach((button) => {
    const type = button.dataset.typeChoice;
    button.setAttribute("aria-pressed", String(type === state.type));
    button.classList.toggle("is-empty", !counts[type]);
  });
}

function renderHeading(total) {
  els.resultHeading.textContent = `${formatNumber(total)} ${total === 1 ? "record" : "records"}`;
  if (state.query) els.coverageLine.textContent = `matching “${state.query}”`;
  else if (state.savedOnly) els.coverageLine.textContent = "in your saved list";
  else els.coverageLine.textContent = "across UC San Diego";
}

function renderEmpty(total) {
  els.empty.hidden = total !== 0;
  if (total !== 0) return;
  const filters = activeFilterEntries().length + (state.type !== "all" ? 1 : 0);
  if (state.savedOnly && !state.saved.size) {
    els.emptyHint.textContent = "You haven’t saved anything yet. Use the bookmark on any record, or press S.";
  } else if (state.query && filters) {
    els.emptyHint.textContent = `No records match “${state.query}” with ${filters} filter${filters > 1 ? "s" : ""} applied. Try removing a filter.`;
  } else if (state.query) {
    els.emptyHint.textContent = `No records contain “${state.query}”. Try a shorter or more general term — course codes work with or without the space.`;
  } else {
    els.emptyHint.textContent = "The current filters exclude every record. Remove one to widen the search.";
  }
}

function renderLoadMore() {
  const remaining = state.results.length - Math.min(state.visibleLimit, state.results.length);
  els.loadMore.hidden = remaining <= 0;
  els.loadMore.textContent = `Show ${formatNumber(Math.min(remaining, PAGE_SIZE))} more — ${formatNumber(remaining)} remaining`;
}

function render() {
  const { records, counts, terms } = computeResults();
  state.results = records;
  state.highlighter = buildHighlighter(terms);

  renderHeading(records.length);
  renderCounts(counts);
  renderActiveFilters();
  renderEmpty(records.length);

  els.results.replaceChildren();
  els.results.setAttribute("aria-busy", "false");
  appendRows(0, Math.min(state.visibleLimit, records.length), true);
  renderLoadMore();

  const activeVisible = records.some((record) => record.id === state.activeId);
  if (!activeVisible && !state.userSelected && DESKTOP_DETAIL_QUERY.matches && records.length) {
    showDetail(records[0].id);
  } else {
    highlightSelectedRow();
  }
  renderSaved();
  writeUrl();
}

function loadMore() {
  const from = Math.min(state.visibleLimit, state.results.length);
  state.visibleLimit += PAGE_SIZE;
  appendRows(from, Math.min(state.visibleLimit, state.results.length), true);
  renderLoadMore();
}

function scrollToResults() {
  const top = els.workspace.getBoundingClientRect().top + window.scrollY - els.form.offsetHeight;
  if (window.scrollY > top + 4) {
    window.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }
}

function update({ scroll = false } = {}) {
  state.visibleLimit = PAGE_SIZE;
  render();
  if (scroll) scrollToResults();
}

/* ---------- Saved ---------- */

function toggleSaved(id) {
  if (!id) return;
  const record = state.byId.get(id);
  if (state.saved.has(id)) state.saved.delete(id);
  else state.saved.add(id);
  writeStoredList(SAVED_KEY, [...state.saved]);
  const saved = state.saved.has(id);
  document.querySelectorAll(`[data-save-id="${CSS.escape(id)}"]`).forEach((button) => {
    button.setAttribute("aria-pressed", String(saved));
    if (button.classList.contains("save-toggle")) {
      button.setAttribute("aria-label", `${saved ? "Remove" : "Save"} ${record?.displayName || "record"}`);
      button.title = saved ? "Saved (S)" : "Save (S)";
    } else {
      button.textContent = saved ? "Saved" : "Save";
    }
  });
  showToast(saved ? `Saved ${record?.displayName || ""}` : "Removed from saved");
  if (state.savedOnly) update();
  else renderSaved();
}

function renderSaved() {
  const saved = [...state.saved].map((id) => state.byId.get(id)).filter(Boolean);
  els.savedCount.textContent = saved.length;
  els.savedCountTop.textContent = saved.length;
  if (!saved.length) {
    els.savedList.replaceChildren(make("p", "saved-empty", "Bookmark records to keep a shortlist here."));
    return;
  }
  els.savedList.replaceChildren(
    ...saved.slice(0, 8).map((record) => {
      const item = make("button", "saved-item");
      item.type = "button";
      item.dataset.openId = record.id;
      item.append(make("strong", "", record.displayName), make("span", "", record.displayKind));
      return item;
    }),
  );
  if (saved.length > 8) {
    const more = make("button", "text-button", `View all ${saved.length} saved`);
    more.type = "button";
    more.addEventListener("click", () => {
      state.savedOnly = true;
      syncControls();
      closeRail();
      update({ scroll: true });
    });
    els.savedList.append(more);
  }
}

/* ---------- Detail ---------- */

function highlightSelectedRow() {
  els.results.querySelectorAll(".row").forEach((row) => {
    row.classList.toggle("is-selected", row.dataset.id === state.activeId);
  });
}

function showDetail(id) {
  const record = state.byId.get(id);
  if (!record) return false;
  state.activeId = id;
  const view = renderDetail(record);
  if (!prefersReducedMotion()) {
    view.classList.add("is-entering");
    view.addEventListener("animationend", () => view.classList.remove("is-entering"), { once: true });
  }
  els.detailContent.replaceChildren(view);
  els.detailPanel.scrollTop = 0;
  highlightSelectedRow();
  return true;
}

// Explicit selection: records the choice in the URL and, on narrow screens, opens the sheet.
function openDetail(id, { reveal = true } = {}) {
  if (!showDetail(id)) return;
  state.userSelected = true;
  writeUrl();
  if (reveal && !DESKTOP_DETAIL_QUERY.matches) openSheet();
}

function detailSection(title, ...children) {
  const section = make("section", "detail-section");
  section.append(make("h3", "", title), ...children.filter(Boolean));
  return section;
}

function note(text) {
  return make("p", "note", text);
}

function fieldGrid(fields) {
  const grid = make("dl", "field-grid");
  for (const [label, value, url] of fields) {
    const known = Array.isArray(value) ? value.length > 0 : isKnown(value);
    const display = Array.isArray(value) ? value.join(", ") : String(value);
    const cell = make("div");
    const dd = make("dd", known ? "" : "is-empty");
    if (known && isKnown(url)) dd.append(makeExternal(display, url, "inline-link"));
    else dd.textContent = known ? display : "—";
    cell.append(make("dt", "", label), dd);
    grid.append(cell);
  }
  return grid;
}

function evidenceItem(title, meta, excerpt, links) {
  const item = make("li");
  item.append(make("strong", "", title));
  if (meta) item.append(make("span", "evidence-meta", meta));
  if (excerpt) item.append(make("p", "evidence-quote", excerpt));
  const actions = links.filter(([, url]) => isKnown(url));
  if (actions.length) {
    const row = make("p", "evidence-links");
    row.append(...actions.map(([label, url]) => makeExternal(label, url)));
    item.append(row);
  }
  return item;
}

function detailHead(record) {
  const head = make("header", "detail-head");
  const kind = make("p", "detail-kind");
  kind.append(make("span", "", record.displayKind));
  if (record.recruitingStatus === "Recruiting") kind.append(make("span", "is-recruiting", "Recruiting"));
  else if (record.recruitingStatus === "Not recruiting") kind.append(make("span", "is-muted", "Not recruiting"));
  kind.append(make("span", record.facts.needsReview ? "is-warn" : "is-muted", verificationLabel(record)));
  if (record.mergedProfileCount > 1) kind.append(make("span", "is-muted", `${record.mergedProfileCount} profiles merged`));

  const affiliation = [record.departments.join(" / "), record.institution].filter(isKnown).join(" — ");
  head.append(kind, make("h2", "detail-title", record.displayName), make("p", "detail-affiliation", affiliation || NOT_FOUND));

  const quick = make("div", "detail-quick");
  const save = make("button", "line-button", state.saved.has(record.id) ? "Saved" : "Save");
  save.type = "button";
  save.dataset.saveId = record.id;
  save.setAttribute("aria-pressed", String(state.saved.has(record.id)));
  quick.append(save);
  if (record.email) {
    const mail = make("a", "line-button", "Email");
    mail.href = `mailto:${record.email}`;
    const copy = make("button", "line-button", "Copy email");
    copy.type = "button";
    copy.dataset.copy = record.email;
    copy.dataset.copyLabel = `Copied ${record.email}`;
    quick.append(mail, copy);
  }
  const share = make("button", "line-button", "Copy link");
  share.type = "button";
  share.dataset.copyRecordLink = record.id;
  quick.append(share);
  head.append(quick);
  return head;
}

function detailLinks(record) {
  if (!record.links.length) return null;
  const list = make("ul", "link-list");
  for (const [label, url] of record.links) {
    const item = make("li");
    item.append(makeExternal(label, url));
    list.append(item);
  }
  return detailSection("Links", list);
}

function detailOverview(record) {
  const body = record.summary ? make("p", "", record.summary) : note("No public summary was captured for this record.");
  let tags = null;
  if (record.researchAreas.length) {
    tags = make("div", "tag-list");
    for (const area of record.researchAreas.slice(0, 14)) {
      tags.append(make("span", "", area));
    }
  }
  let keywords = null;
  if (record.researchKeywords?.length) {
    keywords = make("div", "keyword-list");
    keywords.append(make("span", "keyword-label", "Profile keywords"));
    for (const keyword of record.researchKeywords) {
      const button = make("button", "", keyword);
      button.type = "button";
      button.dataset.searchKeyword = keyword;
      button.title = `Search for ${keyword}`;
      keywords.append(button);
    }
  }
  return detailSection("Overview", body, tags, keywords);
}

function teachingDetails(record) {
  const courses = coursesFor(record);
  const candidates = record.teaching?.candidates || [];
  const parts = [];
  if (!courses.length) {
    const status = candidates.length
      ? "candidate assignments need identity verification"
      : record.teaching?.status === "not_found" ? "not found in checked sources" : "not yet checked";
    parts.push(note(`No verified teaching records captured. Status: ${status}.`));
  } else {
    const list = make("ul", "evidence-list");
    [...courses].sort((a, b) => courseTermOrder(b) - courseTermOrder(a)).forEach((course) => {
      const status = { historical: "Teaching history", current: "Current term", planned: "Planned", tentative: "Tentative", scheduled: "Scheduled", unknown: "Term not classified" }[course.status] || course.status || "Term not classified";
      list.append(evidenceItem(
        [course.courseCode, course.title].filter(isKnown).join(" · "),
        `${course.term || "Term not specified"} · ${course.isTentative ? `${status} (tentative)` : status} · observed ${dateLabel(course.observedAt)}`,
        "",
        [["Official course source", course.sourceUrl], ["Published schedule", course.dataUrl !== course.sourceUrl ? course.dataUrl : null]],
      ));
    });
    parts.push(list, note("Official teaching records. Historical assignments do not promise a future offering; planned assignments may change."));
  }
  if (candidates.length) {
    const details = make("details", "candidate-details");
    details.append(make("summary", "", `Unverified teaching leads (${candidates.length})`));
    details.append(note("These assignments need an identity check. A surname-only match does not establish that this professor teaches the course. Leads are excluded from verified course counts and the official teaching filter."));
    const list = make("ul", "evidence-list");
    [...candidates].sort((a, b) => courseTermOrder(b) - courseTermOrder(a)).forEach((course) => {
      const identity = `Listed instructor: ${course.instructorName || "Not captured"} · ${String(course.matchMethod || "").includes("surname") ? "Surname-only match" : "Identity match needs review"}`;
      list.append(evidenceItem(
        [course.courseCode, course.title].filter(isKnown).join(" · "),
        `${course.term || "Term not specified"}${course.isTentative ? " · tentative schedule" : ""} · observed ${dateLabel(course.observedAt)} · ${identity}`,
        course.evidence || "",
        [["Official teaching source", course.sourceUrl], ["Published schedule", course.dataUrl !== course.sourceUrl ? course.dataUrl : null]],
      ));
    });
    details.append(list);
    parts.push(details);
  }
  return detailSection("Courses & teaching", ...parts);
}

function ratingDetails(record) {
  const grid = make("div", "rating-grid");
  const verifiedKeys = record.facts.ratings;
  for (const [key, label, purpose] of RATING_PLATFORMS) {
    const rating = record.ratings?.[key];
    const verified = verifiedKeys.includes(key);
    const panel = make("article", `rating-panel${verified ? "" : " is-empty"}`);
    panel.append(make("h4", "", rating?.platform || label), make("p", "rating-purpose", purpose));
    if (verified) {
      const score = make("p", "rating-score");
      score.append(String(rating.score), make("small", "", ` / ${rating.scale || 5}`));
      panel.append(score, make("p", "rating-count", `${formatNumber(rating.reviewCount)} ${Number(rating.reviewCount) === 1 ? "review" : "reviews"}`));
      if (Number(rating.reviewCount) < 5) panel.append(make("p", "rating-warn", "Small sample: fewer than five reviews."));
      if (key === "rateMyProfessors") {
        const extra = [
          numericMetric(rating.difficulty) ? `Difficulty ${rating.difficulty}/5` : "",
          numericMetric(rating.wouldTakeAgainPercent) ? `${rating.wouldTakeAgainPercent}% would take again` : "",
        ].filter(Boolean).join(" · ");
        if (extra) panel.append(make("p", "rating-extra", extra));
      }
    } else {
      panel.append(make("p", "rating-status", ratingStatusLabel(rating)));
    }
    panel.append(make("p", "evidence-meta", rating?.observedAt
      ? `Retrieved ${dateLabel(rating.observedAt)}${rating.latestReviewAt ? ` · latest review ${dateLabel(rating.latestReviewAt)}` : " · review dates: see source"}`
      : "Not checked for this professor"));
    const fallback = key === "rateMyPI"
      ? ["Browse PI Review UCSD directory", "https://pi-review.com/universities/158"]
      : ["Search Rate My Professors", `https://www.ratemyprofessors.com/search/professors/1079?q=${encodeURIComponent(record.displayName)}`];
    const [linkLabel, linkUrl] = rating?.sourceUrl ? [verified ? "Open rating source" : "Open platform search", rating.sourceUrl] : fallback;
    panel.append(makeExternal(linkLabel, linkUrl, "inline-link"));
    grid.append(panel);
  }
  return detailSection(
    "Student ratings",
    grid,
    note("Separate platforms and measures. PI Review (pi-review.com) is the mentoring source used here. Reviews are self-selected opinions; a freshly retrieved score can still be based on old reviews."),
  );
}

function labAffiliationDetails(record) {
  const affiliations = record.labAffiliations || [];
  if (!affiliations.length) return detailSection("Labs & research groups", note("No lab relationship has been reverified for this professor yet."));
  const relationLabels = {
    faculty_lab_link: "Lab linked from faculty profile",
    official_directory_same_record: "Listed together in official directory",
    principal_investigator: "Listed as principal investigator",
  };
  const list = make("ul", "evidence-list");
  for (const lab of affiliations) {
    const evidence = Array.isArray(lab.fieldEvidence) ? lab.fieldEvidence[0] || {} : (lab.fieldEvidence || {});
    list.append(evidenceItem(
      lab.labName || "Research group",
      `${relationLabels[lab.relationship] || "Documented lab association"} · observed ${dateLabel(evidence.observedAt)}`,
      evidence.evidence || "",
      [["Lab website", lab.url], ["Relationship source", evidence.sourceUrl]],
    ));
  }
  return detailSection(
    "Labs & research groups",
    list,
    note("An associated lab link alone does not establish that the professor leads the lab. The relationship and original wording are shown above."),
  );
}

function academicDetails(record) {
  const { verified, hasMetrics, status, profile } = record.facts.metrics;
  if (!verified) {
    return detailSection("Academic metrics", note(hasMetrics
      ? `${status}. Citation numbers are hidden because the publication match needs review.`
      : "Citation metrics are not verified in the local metadata yet."));
  }
  const grid = make("dl", "metric-grid");
  for (const [label, value] of [["Citations", profile.citationCount], ["Works", profile.worksCount], ["h-index", profile.hIndex], ["i10-index", profile.i10Index]]) {
    const cell = make("div", numericMetric(value) ? "" : "is-empty");
    cell.append(make("dt", "", label), make("dd", "", numericMetric(value) ? formatNumber(value) : "—"));
    grid.append(cell);
  }
  const list = make("ol", "publication-list");
  const publications = relevantPublications(record).slice(0, 5);
  if (!publications.length) list.append(make("li", "is-placeholder", "No relevant recent publications in the local metadata."));
  for (const paper of publications) {
    const item = make("li");
    item.append(
      isKnown(paper.url) ? makeExternal(cleanText(paper.title), paper.url, "paper-title") : make("span", "paper-title", cleanText(paper.title)),
      make("span", "", [paper.publicationDate || paper.year, paper.venue].filter(isKnown).join(" · ") || "Venue not listed"),
      make("small", "", numericMetric(paper.citationCount) ? `${formatNumber(paper.citationCount)} citations` : ""),
    );
    list.append(item);
  }
  return detailSection("Academic metrics", grid, note(status), make("h4", "sub-heading", "Recent publications"), list);
}

function facultyDirectoryDetails(record) {
  const fields = [
    ["Directory status", facultyLabel(record)],
    ["Department affiliations", record.departments],
  ];
  if (record.aliasNames?.length) fields.push(["Also listed as", record.aliasNames]);
  if (record.directorySection) fields.push(["Directory section", record.directorySection]);
  const parts = [fieldGrid(fields)];
  const listings = Array.isArray(record.directoryListings) ? record.directoryListings : [];
  if (listings.length) {
    const list = make("ul", "evidence-list");
    for (const entry of listings) {
      const excerpt = typeof entry.evidence === "string" ? entry.evidence : entry.evidence?.evidence || "";
      list.append(evidenceItem(
        [entry.department, entry.listedRole].filter(isKnown).join(" · ") || "Official directory listing",
        `Observed ${dateLabel(entry.observedAt)}`,
        excerpt,
        [["Directory source", entry.sourceUrl]],
      ));
    }
    parts.push(list);
  }
  parts.push(note("These roles describe how official directories list this person. A directory listing alone does not confirm current employment."));
  return detailSection("Faculty roles & affiliations", ...parts);
}

function detailFields(record) {
  if (record.recordType === "professor") {
    return detailSection("Contact", fieldGrid([
      ["Email", record.email],
      ["Lab affiliation", record.labAffiliation, record.labAffiliationUrl],
      ["Legacy verification date", record.lastVerified],
    ]));
  }
  if (record.recordType === "lab") {
    return detailSection("Lab details", fieldGrid([
      ["Principal investigator", record.principalInvestigator, record.principalInvestigatorProfileUrl],
      ["Associated professors", record.relatedProfessorNames || []],
      ["Contact", record.email],
      ["Type", record.displayKind],
      ["Legacy verification date", record.lastVerified],
    ]));
  }
  const fields = [
    ["Organization", record.organization],
    ["Type", record.resourceType],
    ["Year", record.yearOfActivity],
    ["Contact", record.email],
    ["How to apply", record.applicationProcedure],
  ];
  for (const [label, value] of Object.entries(record.detailFields || {})) {
    if (!fields.some(([existing]) => existing === label)) fields.push([label, value]);
  }
  return detailSection("REAL Portal details", fieldGrid(fields));
}

function detailRecruitment(record) {
  const evidence = record.recruitingEvidence || {};
  const status = record.recruitingStatus || UNKNOWN;
  const body = isKnown(evidence.text)
    ? make("p", "", `${status}: “${cleanText(evidence.text)}”`)
    : make("p", "", status === UNKNOWN
      ? "No explicit public recruiting statement was captured. That doesn’t mean the group is closed — a short, specific email is usually the best way to ask."
      : status);
  const link = isKnown(evidence.url) ? makeExternal("View evidence source", evidence.url, "inline-link") : null;
  return detailSection("Recruiting", body, link);
}

function verificationDetails(record) {
  const parts = [note(`${verificationLabel(record)}. Last source attempt: ${dateLabel(record.verification?.lastAttemptedAt)}. Each item applies only to the named field.`)];
  const issues = record.verification?.issues || [];
  if (issues.length) {
    parts.push(make("p", "rating-warn", issues.map((issue) => typeof issue === "string" ? issue : (issue.message || issue.reason || issue.code || "Review needed")).join(" · ")));
  }
  const list = make("ul", "evidence-list");
  for (const [key, items] of evidenceFields(record)) {
    for (const evidence of items) {
      if (!evidence.sourceUrl || !evidence.observedAt) continue;
      list.append(evidenceItem(
        slugLabel(key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\./g, " ")),
        dateLabel(evidence.observedAt),
        evidence.evidence || evidence.text || "",
        [["Field source", evidence.sourceUrl]],
      ));
    }
  }
  if (list.children.length) {
    const details = make("details", "candidate-details");
    details.append(make("summary", "", `Field evidence (${list.children.length})`), list);
    parts.push(details);
  } else {
    parts.push(note("No field-level evidence recorded. Existing source links and legacy dates do not establish that this entry was reverified."));
  }
  return detailSection("Verification", ...parts);
}

function detailSources(record) {
  const section = make("section", "detail-section");
  const details = make("details", "source-details");
  const summary = make("summary", "", "Source URLs");
  summary.append(make("span", "", String(record.sourceUrls.length)));
  const list = make("ul", "source-list");
  for (const url of record.sourceUrls) {
    const item = make("li");
    item.append(makeExternal(url.replace(/^https?:\/\/(www\.)?/, ""), url));
    list.append(item);
  }
  if (!record.sourceUrls.length) list.append(make("li", "", "No source URLs recorded."));
  details.append(summary, list);
  section.append(details);
  return section;
}

function renderDetail(record) {
  const root = make("article", "detail-record");
  root.append(detailHead(record));
  const sections = [detailLinks(record), detailOverview(record)];
  if (record.recordType === "professor") {
    sections.push(
      teachingDetails(record),
      ratingDetails(record),
      labAffiliationDetails(record),
      academicDetails(record),
      facultyDirectoryDetails(record),
    );
  }
  sections.push(detailFields(record));
  if (record.recordType !== "resource") sections.push(detailRecruitment(record));
  sections.push(verificationDetails(record), detailSources(record));
  root.append(...sections.filter(Boolean));
  return root;
}

/* ---------- Overlays (filter drawer, detail sheet) ---------- */

let lastFocus = null;

function syncOverlay() {
  const open = els.rail.classList.contains("is-open") || els.detailPanel.classList.contains("is-open");
  els.scrim.hidden = !open;
  document.body.classList.toggle("is-locked", open);
}

function openSheet() {
  lastFocus = document.activeElement;
  els.detailPanel.classList.add("is-open");
  els.detailPanel.setAttribute("role", "dialog");
  els.detailPanel.setAttribute("aria-modal", "true");
  syncOverlay();
  els.detailPanel.focus({ preventScroll: true });
}

function closeSheet() {
  if (!els.detailPanel.classList.contains("is-open")) return;
  els.detailPanel.classList.remove("is-open");
  els.detailPanel.removeAttribute("role");
  els.detailPanel.removeAttribute("aria-modal");
  syncOverlay();
  const row = els.results.querySelector(`[data-open-id="${CSS.escape(state.activeId)}"]`);
  (row || lastFocus)?.focus?.({ preventScroll: true });
}

function openRail() {
  els.rail.classList.add("is-open");
  els.filtersButton.setAttribute("aria-expanded", "true");
  syncOverlay();
  els.rail.querySelector("button, select")?.focus({ preventScroll: true });
}

function closeRail() {
  if (!els.rail.classList.contains("is-open")) return;
  els.rail.classList.remove("is-open");
  els.filtersButton.setAttribute("aria-expanded", "false");
  syncOverlay();
  els.filtersButton.focus({ preventScroll: true });
}

function resetOverlaysForLayout() {
  if (DESKTOP_DETAIL_QUERY.matches) {
    els.detailPanel.classList.remove("is-open");
    els.detailPanel.removeAttribute("role");
    els.detailPanel.removeAttribute("aria-modal");
    if (!state.activeId && state.results.length) showDetail(state.results[0].id);
  }
  if (!DRAWER_QUERY.matches) {
    els.rail.classList.remove("is-open");
    els.filtersButton.setAttribute("aria-expanded", "false");
  }
  syncOverlay();
}

/* ---------- Keyboard navigation ---------- */

function moveSelection(delta) {
  const current = state.results.findIndex((record) => record.id === state.activeId);
  selectIndex(current === -1 ? 0 : current + delta);
}

function selectIndex(index) {
  if (!state.results.length) return;
  const next = Math.max(0, Math.min(state.results.length - 1, index));
  if (next >= state.visibleLimit) loadMore();
  const record = state.results[next];
  openDetail(record.id, { reveal: false });
  const button = els.results.querySelector(`[data-open-id="${CSS.escape(record.id)}"]`);
  button?.focus({ preventScroll: true });
  button?.closest(".row")?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.matches("input, select, textarea") || target.isContentEditable);
}

function focusSearch() {
  els.query.focus();
  els.query.select();
}

function handleKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    focusSearch();
    return;
  }
  if (event.key === "Escape") {
    if (els.detailPanel.classList.contains("is-open")) closeSheet();
    else if (els.rail.classList.contains("is-open")) closeRail();
    else if (document.activeElement === els.query) els.query.blur();
    return;
  }
  if (event.target === els.query && event.key === "ArrowDown") {
    event.preventDefault();
    selectIndex(0);
    return;
  }
  if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
  const inResults = els.results.contains(event.target);
  const key = event.key;
  if (key === "/") {
    event.preventDefault();
    focusSearch();
  } else if (key === "j" || (inResults && key === "ArrowDown")) {
    event.preventDefault();
    moveSelection(1);
  } else if (key === "k" || (inResults && key === "ArrowUp")) {
    event.preventDefault();
    moveSelection(-1);
  } else if (key === "s" && state.activeId) {
    event.preventDefault();
    toggleSaved(state.activeId);
  }
}

/* ---------- Feedback ---------- */

let toastTimer = 0;

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove("is-visible"), 1800);
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const field = make("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  showToast(message);
}

function recordLink(id) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("id", id);
  return url.toString();
}

/* ---------- Hero numbers ---------- */

function animateNumber(element, target) {
  const value = Number(target) || 0;
  if (prefersReducedMotion()) {
    element.textContent = formatNumber(value);
    return;
  }
  const start = performance.now();
  const duration = 900;
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = formatNumber(Math.round(value * eased));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderStats() {
  const count = (predicate) => state.records.filter(predicate).length;
  animateNumber(els.professorCount, count((record) => record.recordType === "professor"));
  animateNumber(els.labCount, count((record) => record.recordType === "lab"));
  animateNumber(els.realResourceCount, count((record) => record.recordType === "resource"));
  animateNumber(els.courseCount, count((record) => record.facts.courses > 0));
  animateNumber(els.ratingCount, count((record) => record.facts.ratings.length > 0));
  els.updatedAt.textContent = state.data?.generatedAt
    ? `Dataset built ${dateLabel(state.data.generatedAt)} · field dates vary`
    : "Bundled dataset";
}

/* ---------- Data loading ---------- */

async function loadData() {
  const [data, realPortalData] = await Promise.all([
    fetch(DATA_URL, DATA_FETCH_OPTIONS).then((response) => {
      if (!response.ok) throw new Error(`Could not load ${DATA_URL} (HTTP ${response.status}).`);
      return response.json();
    }),
    fetch(REAL_PORTAL_DATA_URL, DATA_FETCH_OPTIONS)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
  ]);
  state.data = data;
  state.records = buildRecords(data, realPortalData);
  state.index = buildIndex(state.records);
  state.byId = new Map(state.records.map((record) => [record.id, record]));

  renderFacets();
  syncControls();
  renderStats();
  render();

  if (state.userSelected && state.byId.has(state.activeId)) {
    openDetail(state.activeId, { reveal: true });
  } else if (state.userSelected) {
    state.userSelected = false;
    state.activeId = "";
    writeUrl();
  }
}

/* ---------- Wiring ---------- */

function bindEvents() {
  const debouncedUpdate = debounce(() => update({ scroll: true }), SEARCH_DEBOUNCE_MS);

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    syncStateFromControls();
    update({ scroll: true });
    if (DRAWER_QUERY.matches) els.query.blur();
  });

  els.query.addEventListener("input", () => {
    syncStateFromControls();
    debouncedUpdate();
  });

  for (const control of [els.department, els.sort]) {
    control.addEventListener("change", () => {
      syncStateFromControls();
      syncControls();
      update({ scroll: true });
    });
  }

  els.typeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.type = button.dataset.typeChoice || "all";
      update({ scroll: true });
    });
  });

  els.activeFilters.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-filter-key]");
    if (chip) clearFilter(chip.dataset.filterKey);
  });

  els.clear.addEventListener("click", () => resetFilters({ keepQuery: true }));
  els.emptyReset.addEventListener("click", () => resetFilters());
  els.loadMore.addEventListener("click", loadMore);

  els.savedToggle.addEventListener("click", () => {
    state.savedOnly = !state.savedOnly;
    syncControls();
    update({ scroll: true });
  });

  els.shareButton.addEventListener("click", () => copyText(window.location.href, "Search link copied"));
  els.filtersButton.addEventListener("click", openRail);
  els.railClose.addEventListener("click", closeRail);
  els.railApply.addEventListener("click", closeRail);
  els.detailClose.addEventListener("click", closeSheet);
  els.scrim.addEventListener("click", () => {
    closeSheet();
    closeRail();
  });

  // Delegated clicks: row titles, saved list, save toggles, tags, copy buttons.
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-open-id], [data-save-id], [data-search-keyword], [data-copy], [data-copy-record-link]");
    if (!target) return;
    if (target.dataset.saveId) {
      toggleSaved(target.dataset.saveId);
    } else if (target.dataset.openId) {
      closeRail();
      openDetail(target.dataset.openId);
    } else if (target.dataset.searchKeyword) {
      state.query = target.dataset.searchKeyword;
      syncControls();
      closeSheet();
      update({ scroll: true });
    } else if (target.dataset.copy) {
      copyText(target.dataset.copy, target.dataset.copyLabel || "Copied");
    } else if (target.dataset.copyRecordLink) {
      copyText(recordLink(target.dataset.copyRecordLink), "Record link copied");
    }
  });

  document.addEventListener("keydown", handleKeydown);
  DESKTOP_DETAIL_QUERY.addEventListener("change", resetOverlaysForLayout);
  DRAWER_QUERY.addEventListener("change", resetOverlaysForLayout);

  const syncPlaceholder = () => {
    els.query.placeholder = COMPACT_QUERY.matches ? "Search" : "Search a professor, lab, course, or topic";
  };
  COMPACT_QUERY.addEventListener("change", syncPlaceholder);
  syncPlaceholder();

  // Auto-load the first few pages as the reader nears the end of the list; after that the button stays manual.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !els.loadMore.hidden && state.visibleLimit < AUTO_LOAD_LIMIT) {
        loadMore();
      }
    }, { rootMargin: "0px 0px 600px 0px" }).observe(els.loadMore);
  }
}

function boot() {
  bindEvents();
  readUrl();
  syncControls();
  loadData().catch((error) => {
    els.resultHeading.textContent = "Data unavailable";
    els.coverageLine.textContent = error.message;
    els.results.replaceChildren();
    els.results.setAttribute("aria-busy", "false");
    els.empty.hidden = false;
    els.emptyHint.textContent = "The dataset could not be loaded. If you opened index.html directly, serve the folder with `python3 -m http.server` instead.";
  });
}

// tests/test_frontend_data.cjs evaluates this file in a bare VM to exercise the data helpers;
// only a real page (which has a document.readyState) boots the UI.
if (document.readyState) boot();
