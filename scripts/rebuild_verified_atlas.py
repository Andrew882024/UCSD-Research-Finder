#!/usr/bin/env python3
"""Build the served atlas from reviewed legacy records and independently captured evidence.

Offline and deterministic for fixed inputs. Never turns a fetch date into a whole-record
verification date. Removed legacy values and non-lab records remain in a review archive.
"""
from __future__ import annotations

import argparse
import collections
import copy
import datetime as dt
import json
import html
import re
import unicodedata
import urllib.parse
from pathlib import Path

from lab_destinations import nonlab_destination_reason

ROOT = Path(__file__).resolve().parents[1]
MISSING = "Not found"
RESEARCH_PHRASES = {
    "Machine learning": r"machine learning", "Deep learning": r"deep learning", "Artificial intelligence": r"artificial intelligence",
    "Computer vision": r"computer vision", "Robotics": r"robotics?", "Natural language processing": r"natural language processing",
    "Human-computer interaction": r"human[ -]computer interaction", "Cryptography": r"cryptograph(?:y|ic)",
    "Computer security": r"computer security|cybersecurity", "Databases": r"databases?|database systems",
    "Distributed systems": r"distributed systems", "Computer architecture": r"computer architecture", "Algorithms": r"algorithms?",
    "Computer networks": r"computer networks?|network protocols", "Signal processing": r"signal processing",
    "Quantum computing": r"quantum comput(?:ing|ation)", "Quantum physics": r"quantum physics|quantum mechanics",
    "Condensed matter": r"condensed matter", "Photonics": r"photonics?", "Astrophysics": r"astrophysics?|astrophysical",
    "Cosmology": r"cosmology|cosmological", "Climate science": r"climate change|climate science|climate dynamics",
    "Oceanography": r"oceanography|oceanographic", "Genomics": r"genomics?|genomic", "Genetics": r"genetics|genetic regulation",
    "Bioinformatics": r"bioinformatics", "Cell biology": r"cell biology|cellular biology", "Molecular biology": r"molecular biology",
    "Neuroscience": r"neuroscience|neurobiology|neural circuits", "Neurodegeneration": r"neurodegenerat(?:ion|ive)",
    "Cancer": r"cancer|oncology", "Immunology": r"immunology|immune system|immune response", "Metabolism": r"metabolism|metabolic",
    "Synthetic biology": r"synthetic biology", "Structural biology": r"structural biology", "Biophysics": r"biophysics|biophysical",
    "Biomechanics": r"biomechanics|biomechanical", "Tissue engineering": r"tissue engineering", "Biomaterials": r"biomaterials?",
    "Nanotechnology": r"nanotechnology|nanomaterials?|nanoscience", "Fluid mechanics": r"fluid mechanics|fluid dynamics",
    "Materials science": r"materials science|materials chemistry", "Electrochemistry": r"electrochemistry|electrochemical",
    "Organic chemistry": r"organic chemistry|organic synthesis", "Cognitive science": r"cognitive science|cognition",
    "Social psychology": r"social psychology", "Linguistics": r"linguistics|linguistic theory", "Language acquisition": r"language acquisition",
    "Archaeology": r"archaeology|archaeological", "Cultural anthropology": r"cultural anthropology|ethnography",
    "Public health": r"public health|epidemiology", "Econometrics": r"econometrics|econometric",
    "Labor economics": r"labor economics|labour economics", "Political economy": r"political economy",
    "Education": r"educational research|education policy|science education", "Ecology": r"ecology|ecological",
    "Evolution": r"evolutionary biology|evolutionary genetics", "Statistics": r"statistical inference|statistics",
}


def known(x):
    return x is not None and x not in ("", "Not found", "Unknown", [])


def valid_url(url):
    if not isinstance(url, str) or re.search(r"\s", url):
        return False
    try:
        p = urllib.parse.urlsplit(url)
        return p.scheme in {"http", "https"} and bool(p.hostname) and not p.username and not p.password
    except ValueError:
        return False


def url_key(url):
    url = encode_url(url)
    if not valid_url(url):
        return ""
    p = urllib.parse.urlsplit(html.unescape(url))
    query = urllib.parse.urlencode([(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)
                                   if not k.lower().startswith("utm_") and k.lower() not in {"gclid", "fbclid"}])
    path = re.sub(r"/index\.(?:html?|php)$", "", p.path.rstrip("/"))
    return p.netloc.lower().removeprefix("www.") + path + ("?" + query if query else "")


def encode_url(url):
    if not isinstance(url, str):
        return url
    try:
        parts = urllib.parse.urlsplit(html.unescape(url.strip()))
        url = urllib.parse.urlunsplit(parts._replace(netloc=parts.netloc.strip()))
    except ValueError:
        return url
    return urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%")


def name_key(name):
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = re.sub(r"\([^)]*\)", " ", name)
    return re.sub(r"[^a-z]+", " ", name.lower()).strip()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


def profile(data):
    professors, labs = data.get("professors", []), data.get("labs", [])
    return {
        "professors": len(professors), "labs": len(labs),
        "departments": len({r["department"] for r in professors + labs}),
        "professorFieldsPresent": {f: sum(known(p.get(f)) for p in professors) for f in
                                   ["email", "personalWebsiteUrl", "googleScholarUrl", "labAffiliationUrl", "researchSummary"]},
        "professorsWithFieldEvidence": sum(bool(p.get("fieldEvidence")) for p in professors),
        "professorFieldsWithEvidence": {f: sum(bool(p.get("fieldEvidence", {}).get(f)) for p in professors) for f in
                                        ["name", "email", "personalWebsiteUrl", "googleScholarUrl", "researchSummary", "researchAreas", "labAffiliationUrl", "catalogListing"]},
        "professorsWithLabEvidence": sum(bool(p.get("fieldEvidence", {}).get("labAffiliationUrl")) for p in professors),
        "professorsWithCourses": sum(bool(p.get("teaching", {}).get("courses")) for p in professors),
        "courseAssignments": sum(len(p.get("teaching", {}).get("courses", [])) for p in professors),
        "uniqueProfessorCourseTerms": len({(p["id"], c["courseCode"], c["term"]) for p in professors for c in p.get("teaching", {}).get("courses", [])}),
        "professorsWithRatings": {key: sum(p.get("ratings", {}).get(key, {}).get("status") == "verified" and
                                          isinstance(p.get("ratings", {}).get(key, {}).get("score"), (int, float))
                                          for p in professors) for key in ["rateMyPI", "rateMyProfessors"]},
        "distinctRatedProfiles": {key: len({p["ratings"][key]["sourceUrl"] for p in professors
                                            if p.get("ratings", {}).get(key, {}).get("status") == "verified"
                                            and p["ratings"][key].get("sourceUrl")})
                                 for key in ["rateMyPI", "rateMyProfessors"]},
        "verificationStatuses": dict(collections.Counter(p.get("verification", {}).get("status", "legacy_unverified") for p in professors)),
        "duplicateProfessorNameDepartmentGroups": sum(n > 1 for n in collections.Counter((name_key(p["name"]), p["department"]) for p in professors).values()),
        "duplicateLabUrlGroups": sum(n > 1 for k, n in collections.Counter(url_key(p["labWebsiteUrl"]) for p in labs).items() if k),
    }


def clean_legacy(data):
    """One-time removal of demonstrated unsafe extraction classes; archive every change."""
    changes, quarantine = [], []
    if data.get("qualityMigrationVersion") == 1:
        return changes, quarantine
    emails = collections.defaultdict(set)
    for p in data["professors"]:
        for f in ["officialProfileUrl", "personalWebsiteUrl", "labAffiliationUrl"]:
            if known(p.get(f)) and valid_url(encode_url(p[f])):
                p[f] = encode_url(p[f])
        p["sourceUrls"] = [encode_url(u) for u in p["sourceUrls"]]
        if known(p.get("email")):
            emails[p["email"].lower()].add(name_key(p["name"]))

    def replace(record, field, value, reason):
        old = record.get(field)
        if old != value:
            changes.append({"recordId": record["id"], "field": field, "previousValue": old,
                            "replacement": value, "reason": reason})
            record[field] = value

    for p in data["professors"]:
        p.setdefault("fieldEvidence", {})
        p["verification"] = {"status": "legacy_unverified", "lastAttemptedAt": None, "fieldsVerified": [],
                             "issues": ["Legacy fields require fresh, field-level evidence."]}
        if not p["fieldEvidence"].get("researchAreas"):
            replace(p, "researchAreas", [], "Legacy keyword extraction included navigation and raw markup; awaiting person-specific research evidence.")
        if re.search(r"signals research in|details need|links need|profile-level enrichment|faculty listing from|faculty profile discovered", p.get("researchSummary", ""), re.I):
            replace(p, "researchSummary", MISSING, "Generated summary did not contain verified person-specific research information.")
        for f in ["labAffiliation", "labAffiliationUrl"]:
            if not p["fieldEvidence"].get(f):
                replace(p, f, MISSING, "Old generic navigation extraction did not establish a PI–lab relationship.")
        scholar = p.get("googleScholarUrl", MISSING)
        if known(scholar) and not (valid_url(scholar) and urllib.parse.urlsplit(scholar).hostname in {"scholar.google.com", "scholar.google.ch", "scholar.google.co.uk"} and
                                   "user=" in urllib.parse.urlsplit(scholar).query):
            replace(p, "googleScholarUrl", MISSING, "Link was not an identified Google Scholar author profile.")
        email = p.get("email", "")
        if known(email) and (len(emails[email.lower()]) >= 3 or re.search(r"support|webmaster|^info@", email, re.I)):
            replace(p, "email", MISSING, "Shared departmental/support email was incorrectly attributed to multiple people.")
        site = p.get("personalWebsiteUrl", "")
        if known(site) and (not valid_url(site) or re.search(r"courses\.ucsd\.edu/?$|terms-of-use|privacy", site)):
            replace(p, "personalWebsiteUrl", MISSING, "Generic navigation link was not a personal website.")
        for f in ["officialProfileUrl", "personalWebsiteUrl", "labAffiliationUrl"]:
            if known(p.get(f)) and not valid_url(p[f]):
                replace(p, f, MISSING, "Malformed HTTP URL.")
        p["sourceUrls"] = list(dict.fromkeys(u for u in p["sourceUrls"] if valid_url(u)))
        p["googleScholarSearchUrl"] = "https://scholar.google.com/scholar?" + urllib.parse.urlencode({"q": p["name"] + " UC San Diego"})
        p["unverifiedFields"] = [f for f in ["email", "personalWebsiteUrl", "researchSummary", "academicProfile"] if known(p.get(f))]
    remaining = []
    lab_emails = collections.Counter(l.get("contactEmail") for l in data["labs"] if known(l.get("contactEmail")))
    for lab in data["labs"]:
        if lab.get("recordSubtype") == "personal_research_site" or "research site" in lab["labName"].lower():
            quarantine.append({"reason": "Personal research website is not evidence of a laboratory.", "record": copy.deepcopy(lab)})
            # Keep a useful personal website on an exactly named professor, with its legacy status.
            matches = [p for p in data["professors"] if name_key(p["name"]) == name_key(lab.get("principalInvestigator", ""))]
            for p in matches:
                if not known(p.get("personalWebsiteUrl")):
                    p["personalWebsiteUrl"] = lab["labWebsiteUrl"]
                    p["sourceUrls"] = list(dict.fromkeys(p["sourceUrls"] + lab["sourceUrls"]))
                    p["unverifiedFields"] = list(dict.fromkeys(p["unverifiedFields"] + ["personalWebsiteUrl"]))
            continue
        lab.setdefault("fieldEvidence", {})
        lab["verification"] = {"status": "legacy_unverified", "lastAttemptedAt": None, "fieldsVerified": [],
                               "issues": ["Lab identity and affiliation await refreshed evidence."]}
        if not lab["fieldEvidence"].get("researchAreas"):
            replace(lab, "researchAreas", [], "Legacy research keywords were not supported by field-level evidence.")
        if not lab["fieldEvidence"].get("description") and re.search(r"Research direction:|Lab entry from|Personal research website|Faculty research website", lab.get("description", ""), re.I):
            replace(lab, "description", MISSING, "Old generated lab summaries contained unsupported research labels.")
        if not lab["fieldEvidence"].get("contactEmail") and known(lab.get("contactEmail")) and lab_emails[lab["contactEmail"]] >= 3:
            replace(lab, "contactEmail", MISSING, "Shared contact mailbox needs evidence tying it to this lab.")
        lab["unverifiedFields"] = [f for f in ["principalInvestigator", "principalInvestigatorProfileUrl", "contactEmail", "description"] if known(lab.get(f)) and not lab["fieldEvidence"].get(f)]
        if lab.get("recruitingStatus") != "Unknown" and not lab["fieldEvidence"].get("recruitingStatus"):
            replace(lab, "recruitingStatus", "Unknown", "Old recruiting statements require a fresh check before claiming current openings.")
            replace(lab, "recruitingEvidence", {"text": "", "url": ""}, "Previous recruiting evidence retained in this archive for review.")
        remaining.append(lab)
    data["labs"] = remaining
    data["qualityMigrationVersion"] = 1
    return changes, quarantine


def attach_evidence(record, field, evidence):
    items = evidence if isinstance(evidence, list) else [evidence]
    accepted = [e for e in items if isinstance(e, dict) and valid_url(e.get("sourceUrl", "")) and e.get("observedAt") and e.get("evidence")]
    if not accepted:
        return False
    existing = record.setdefault("fieldEvidence", {}).setdefault(field, [])
    if isinstance(existing, dict):
        existing = record["fieldEvidence"][field] = [existing]
    for e in accepted:
        key = (e["sourceUrl"], e.get("method"), e["evidence"])
        same = next((i for i, old in enumerate(existing) if (old["sourceUrl"], old.get("method"), old["evidence"]) == key), None)
        if same is None:
            existing.append(copy.deepcopy(e))
        elif e["observedAt"] > existing[same]["observedAt"]:
            existing[same] = copy.deepcopy(e)
    record["sourceUrls"] = list(dict.fromkeys(record.get("sourceUrls", []) + [e["sourceUrl"] for e in accepted]))
    return True


def derive_research_tags(record):
    """Combine evidenced directory labels and explicit phrases in research prose
    or in the person's own official profile keywords."""
    def evidence_list(field):
        value = record.get("fieldEvidence", {}).get(field, [])
        return [value] if isinstance(value, dict) else value

    def phrase_areas(text):
        return [label for label, pattern in RESEARCH_PHRASES.items() if re.search(r"\b(?:" + pattern + r")\b", text, re.I)]

    directory_sources = evidence_list("researchAreasFromDirectory")
    areas = list(record.get("researchAreasFromDirectory", [])) if directory_sources else []
    sources = evidence_list("researchSummary")
    paragraph_areas = phrase_areas(record["researchSummary"]) if sources and known(record.get("researchSummary")) else []
    keyword_sources = evidence_list("researchKeywords")
    keyword_areas = phrase_areas("; ".join(record.get("researchKeywords", []))) if keyword_sources else []
    areas = list(dict.fromkeys(areas + paragraph_areas + keyword_areas))
    if sources or directory_sources or keyword_sources:
        record["researchAreas"] = areas
        record["fieldEvidence"].pop("researchAreas", None)
        for source in directory_sources:
            attach_evidence(record, "researchAreas", {**source, "method": "explicit_research_areas_in_official_directory"})
        for source in sources if paragraph_areas else []:
            attach_evidence(record, "researchAreas", {**source, "method": "explicit_topic_phrases_in_sourced_research_paragraph"})
        for source in keyword_sources if keyword_areas else []:
            attach_evidence(record, "researchAreas", {**source, "method": "explicit_topic_phrases_in_official_profile_keywords"})


def merge_patch(record, patch):
    fields = patch.get("fields", patch)
    for field, evidence in patch.get("fieldEvidence", {}).items():
        if field in fields or field in {"name", "institution", "department"}:
            if attach_evidence(record, field, evidence) and field in fields:
                if field == "name" and fields[field] != record.get("name"):
                    record["aliasNames"] = list(dict.fromkeys(record.get("aliasNames", []) + [record["name"]]))
                record[field] = copy.deepcopy(fields[field])
    if "verification" in patch:
        record["verification"] = copy.deepcopy(patch["verification"])
        v = record["verification"]
        v["lastAttemptedAt"] = v.get("lastAttemptedAt") or v.get("observedAt")
        if v.get("status") == "deferred_crawl_delay":
            v["fetchStatus"] = "deferred_crawl_delay"
        v["status"] = {"verified": "source_checked", "catalog_only": "legacy_unverified", "not_attempted": "legacy_unverified",
                       "deferred_crawl_delay": "legacy_unverified",
                       "identity_not_confirmed": "needs_review", "error": "unavailable", "blocked": "unavailable", "robots_disallowed": "unavailable"}.get(v.get("status"), v.get("status", "legacy_unverified"))
    if patch.get("labAffiliations"):
        record["labAffiliations"] = copy.deepcopy(patch["labAffiliations"])
    for f in ["directoryListings", "appointmentStatus", "departmentAffiliations", "directorySection"]:
        if f in patch:
            record[f] = copy.deepcopy(patch[f])
    if patch.get("professorIds"):
        record["professorIds"] = list(dict.fromkeys(record.get("professorIds", []) + patch["professorIds"]))
    if patch.get("nameAliases"):
        record["aliasNames"] = list(dict.fromkeys(record.get("aliasNames", []) + patch["nameAliases"]))
    record["sourceUrls"] = list(dict.fromkeys(record.get("sourceUrls", []) + [u for u in patch.get("sourceUrls", []) if valid_url(u)]))


def consolidate_catalog_duplicates(data):
    """Only fold same-name/same-department catalog duplicates into a personal record."""
    grouped = collections.defaultdict(list)
    for p in data["professors"]:
        derive_research_tags(p)
        grouped[(name_key(p["name"]), p["department"])].append(p)
    removed, aliases = [], {}
    for group in grouped.values():
        people = [p for p in group if "catalog.ucsd.edu" not in p.get("officialProfileUrl", "")]
        catalogs = [p for p in group if "catalog.ucsd.edu" in p.get("officialProfileUrl", "")]
        if len(people) != 1 or not catalogs:
            continue
        target = people[0]
        for old in catalogs:
            aliases[old["id"]] = target["id"]
            removed.append({"reason": "Same normalized name and department: catalog duplicate consolidated into personal faculty record.", "record": old})
            target["aliasIds"] = list(dict.fromkeys(target.get("aliasIds", []) + [old["id"]]))
            target["sourceUrls"] = list(dict.fromkeys(target["sourceUrls"] + old["sourceUrls"]))
            for f, evidence in old.get("fieldEvidence", {}).items():
                attach_evidence(target, f, evidence)
            for f in ["email", "personalWebsiteUrl", "researchSummary", "catalogListing", "teaching"]:
                if not known(target.get(f)) and known(old.get(f)):
                    target[f] = copy.deepcopy(old[f])
            courses = target.get("teaching", {}).get("courses", []) + old.get("teaching", {}).get("courses", [])
            if courses:
                target["teaching"] = {**target.get("teaching", {}), "status": "verified", "courses": list({(c["courseCode"], c["term"], c["sourceUrl"]): c for c in courses}.values())}
    if aliases:
        data["professors"] = [p for p in data["professors"] if p["id"] not in aliases]
        for lab in data["labs"]:
            if "professorIds" in lab:
                lab["professorIds"] = list(dict.fromkeys(aliases.get(pid, pid) for pid in lab["professorIds"]))
    return removed


def nonlab_reason(name, url):
    """Reason a lab name/URL pair cannot be a laboratory record, or ''."""
    # Captured links can contain repairable host/path whitespace. Use the
    # same normalization as served URLs, but archive the untouched record.
    reason = nonlab_destination_reason(encode_url(url))
    if re.search(r"doi\.org/|\.pdf(?:$|[?#])|/publications?(?:[/.?#]|$)|people/lab-staff", url, re.I):
        reason = "Publication, DOI, PDF, or staff directory is not a laboratory homepage."
    if name.strip().lower() in {"lab staff", "lab awards", "lab publications", "our publications"}:
        reason = "Generic staff/publication/award page is not a laboratory."
    return reason


def reject_nonlabs(data):
    """Exclude concrete non-lab page types even when an anchor contains 'lab'."""
    rejected, keep = [], []
    bad_urls, bad_ids = set(), set()
    for lab in data["labs"]:
        url = lab["labWebsiteUrl"]
        reason = nonlab_reason(lab["labName"], url)
        if reason:
            rejected.append({"reason": reason, "record": copy.deepcopy(lab)})
            bad_urls.add(url_key(url))
            bad_ids.add(lab["id"])
        else:
            keep.append(lab)
    data["labs"] = keep
    for p in data["professors"]:
        affiliations = [a for a in p.get("labAffiliations", []) if a.get("labId") not in bad_ids and url_key(a.get("url", "")) not in bad_urls]
        if "labAffiliations" in p:
            p["labAffiliations"] = affiliations
        if url_key(p.get("labAffiliationUrl", "")) in bad_urls:
            for f in ["labAffiliation", "labAffiliationUrl"]:
                p[f] = MISSING
                p.get("fieldEvidence", {}).pop(f, None)
            if affiliations:
                a = affiliations[0]
                p["labAffiliation"], p["labAffiliationUrl"] = a["labName"], a["url"]
                for f in ["labAffiliation", "labAffiliationUrl"]:
                    attach_evidence(p, f, a["fieldEvidence"])
    return rejected


def consolidate_lab_urls(data):
    kept, removed = {}, []
    for lab in data["labs"]:
        # The old migrator stripped identity-bearing query strings. Restore only
        # a unique exact-base URL already retained in that record's source list.
        p = urllib.parse.urlsplit(lab["labWebsiteUrl"])
        if not p.query:
            candidates = {u for u in lab.get("sourceUrls", []) if valid_url(u) and urllib.parse.urlsplit(u).query
                          and urllib.parse.urlsplit(u).netloc == p.netloc and urllib.parse.urlsplit(u).path.rstrip("/") == p.path.rstrip("/")
                          and not all(k.startswith("utm_") for k, _ in urllib.parse.parse_qsl(urllib.parse.urlsplit(u).query))}
            if len(candidates) == 1:
                lab["labWebsiteUrl"] = next(iter(candidates))
        key = url_key(lab["labWebsiteUrl"])
        if key not in kept:
            kept[key] = lab
            continue
        target = kept[key]
        removed.append({"reason": "Same lab website after removing tracking parameters; canonical lab ID retained.", "record": copy.deepcopy(lab)})
        for field, evidence in lab.get("fieldEvidence", {}).items():
            attach_evidence(target, field, evidence)
        target["sourceUrls"] = list(dict.fromkeys(target["sourceUrls"] + lab["sourceUrls"]))
        target["aliasIds"] = list(dict.fromkeys(target.get("aliasIds", []) + [lab["id"]]))
        target["professorIds"] = list(dict.fromkeys(target.get("professorIds", []) + lab.get("professorIds", [])))
        for f in ["principalInvestigator", "principalInvestigatorProfileUrl"]:
            if not known(target.get(f)) and known(lab.get(f)):
                target[f] = lab[f]
    data["labs"] = list(kept.values())
    return removed


def apply_lab_identity_review(data, review):
    """Apply explicit, sourced review decisions without treating an institute as a lab alias."""
    by_id = {l["id"]: l for l in data["labs"]}
    removed = []
    for item in review.get("entries", []):
        if item.get("action") != "merge" or item["targetLabId"] not in by_id:
            continue
        source, target = by_id.get(item["sourceLabId"]), by_id[item["targetLabId"]]
        if not attach_evidence(target, "identityReview", item.get("evidence", [])):
            raise ValueError("Lab identity merge requires source evidence")
        target["identityReview"] = {"reason": item["reason"], "limitations": item.get("limitations", [])}
        target["labName"] = item.get("primaryLabName", target["labName"])
        attach_evidence(target, "labName", item["evidence"])
        target["labWebsiteUrl"] = item.get("primaryLabWebsiteUrl", target["labWebsiteUrl"])
        target["aliasIds"] = list(dict.fromkeys(target.get("aliasIds", []) + [item["sourceLabId"]] + (source or {}).get("aliasIds", [])))
        target["alternateWebsiteUrls"] = list(dict.fromkeys(target.get("alternateWebsiteUrls", []) + item.get("acceptedAliasUrls", [])))
        if source:
            removed.append({"reason": item["reason"], "record": copy.deepcopy(source)})
            target["professorIds"] = list(dict.fromkeys(target.get("professorIds", []) + source.get("professorIds", [])))
            target["sourceUrls"] = list(dict.fromkeys(target["sourceUrls"] + source["sourceUrls"]))
            # Only same-identity name/PI evidence can transfer; a rejected website cannot.
            transferable = ["labName", "principalInvestigator"]
            if url_key(source["labWebsiteUrl"]) in {url_key(u) for u in item.get("acceptedAliasUrls", [])}:
                transferable.append("labWebsiteUrl")
            for field in transferable:
                if not known(target.get(field)) and known(source.get(field)):
                    target[field] = source[field]
                if source.get("fieldEvidence", {}).get(field):
                    attach_evidence(target, field, source["fieldEvidence"][field])
        for p in data["professors"]:
            for affiliation in p.get("labAffiliations", []):
                if affiliation.get("labId") == item["sourceLabId"]:
                    affiliation.update(labId=target["id"], labName=target["labName"], url=target["labWebsiteUrl"])
                    affiliation["identityReviewEvidence"] = item["evidence"]
            if source and url_key(p.get("labAffiliationUrl", "")) == url_key(source["labWebsiteUrl"]):
                p["labAffiliation"], p["labAffiliationUrl"] = target["labName"], target["labWebsiteUrl"]
                attach_evidence(p, "labAffiliationUrl", item["evidence"])
    removed_ids = {r["record"]["id"] for r in removed}
    data["labs"] = [l for l in data["labs"] if l["id"] not in removed_ids]
    for item in review.get("keptDistinct", []):
        target = by_id.get(item["labId"])
        if not target:
            continue
        for field, key in [("labName", "recommendedName"), ("recordSubtype", "recommendedRecordSubtype")]:
            if item.get(key):
                target[field] = item[key]
                attach_evidence(target, field, item["evidence"])
        if item.get("relationshipType") == "principal_investigator":
            target["principalInvestigator"] = item["professorName"]
            attach_evidence(target, "principalInvestigator", item["evidence"])
    for item in review.get("corrections", []):
        target = by_id.get(item["labId"])
        if not target:
            continue
        for field in item.get("clearFields", []):
            if field not in {"principalInvestigator", "principalInvestigatorProfileUrl"}:
                raise ValueError("Unsupported lab review field correction")
            target[field] = MISSING
            target.get("fieldEvidence", {}).pop(field, None)
            target["unverifiedFields"] = [f for f in target.get("unverifiedFields", []) if f != field]
        target["identityReview"] = {"reason": item["reason"]}
        attach_evidence(target, "identityReview", item["evidence"])
        for p in data["professors"]:
            for affiliation in p.get("labAffiliations", []):
                if affiliation.get("labId") == target["id"]:
                    affiliation["relationship"] = item.get("relationship", affiliation.get("relationship"))
    return removed


def sourced(e):
    """An evidence item with a valid source URL, an observation time and non-empty supporting text."""
    return isinstance(e, dict) and isinstance(e.get("sourceUrl"), str) and valid_url(e["sourceUrl"]) \
        and isinstance(e.get("observedAt"), str) and bool(e["observedAt"].strip()) \
        and isinstance(e.get("evidence"), str) and bool(e["evidence"].strip())


def apply_lab_expansion(data, expansion):
    """Add manually reviewed labs and fill missing lab fields from official sources.

    Reviewed additions are idempotent by ID. A website or alias URL already owned by
    another lab is an unresolved duplicate and stops the build. Enrichment only fills
    placeholders; an existing value is never replaced. Professor links are appended so
    existing multiple affiliations survive.
    """
    by_id = {l["id"]: l for l in data["labs"]}
    owners = {}
    for lab in data["labs"]:
        for u in [lab["labWebsiteUrl"]] + lab.get("alternateWebsiteUrls", []):
            owners.setdefault(url_key(u), lab["id"])
    for item in expansion.get("additions", []):
        evidence = item.get("fieldEvidence", {})
        for field in ["labName", "labWebsiteUrl"] + (["principalInvestigator"] if known(item.get("principalInvestigator")) else []):
            items = evidence.get(field)
            if not isinstance(items, list) or not any(sourced(e) for e in items):
                raise ValueError(f"Reviewed lab {item['id']} lacks {field} evidence")
        hosts = [(urllib.parse.urlsplit(e["sourceUrl"]).hostname or "").lower() for e in evidence["labName"]]
        if not any(h == "ucsd.edu" or h.endswith(".ucsd.edu") for h in hosts):
            raise ValueError(f"Reviewed lab {item['id']} lacks an official UCSD source for its name")
        for u in [item["labWebsiteUrl"]] + item.get("alternateWebsiteUrls", []):
            reason = nonlab_reason(item["labName"], u)
            if reason:
                raise ValueError(f"Reviewed lab {item['id']} uses a non-lab destination {u}: {reason}")
            owner = owners.get(url_key(u))
            if owner and owner != item["id"]:
                raise ValueError(f"Reviewed lab {item['id']} duplicates {owner} at {u}")
        record = {k: copy.deepcopy(v) for k, v in item.items() if k not in {"candidateId", "fieldEvidence"}}
        record.setdefault("institution", "University of California San Diego")
        for f in ["principalInvestigatorProfileUrl", "description", "contactEmail"]:
            record.setdefault(f, MISSING)
        record.setdefault("researchAreas", [])
        record.setdefault("recruitingStatus", "Unknown")
        record.setdefault("recruitingEvidence", {"text": "", "url": ""})
        old = by_id.get(item["id"])
        if old:
            # Lossless merge: later captures may have filled fields, aliases or sources.
            # The reviewed snapshot only adds list members and fills placeholders.
            for field, value in record.items():
                if isinstance(value, list) and isinstance(old.get(field, []), list):
                    merged = list(old.get(field, []))
                    merged += [v for v in value if v not in merged]
                    if merged or field in old:
                        old[field] = merged
                elif not known(old.get(field)) and (known(value) or field not in old):
                    old[field] = value
            record = old
        else:
            record["fieldEvidence"] = {}
            data["labs"].append(record)
            by_id[record["id"]] = record
        for field, items in evidence.items():
            attach_evidence(record, field, items)
        for u in [record["labWebsiteUrl"]] + record.get("alternateWebsiteUrls", []):
            owners.setdefault(url_key(u), record["id"])
    skipped = []
    for item in expansion.get("enrichments", []):
        target = by_id.get(item["labId"])
        if not target:
            raise ValueError(f"Lab enrichment targets unknown lab {item['labId']}")
        for field, value in item.get("fields", {}).items():
            if field not in {"principalInvestigator", "principalInvestigatorProfileUrl", "description", "researchAreas"}:
                raise ValueError(f"Unsupported lab enrichment field {field}")
            if known(target.get(field)) and target[field] != value:
                skipped.append({"labId": target["id"], "field": field, "kept": target[field], "proposed": value})
                continue
            proof = (item.get("evidence") or {}).get(field)
            proof = [e for e in (proof if isinstance(proof, list) else [proof]) if sourced(e)]
            if proof and attach_evidence(target, field, proof):
                target[field] = copy.deepcopy(value)
            else:
                raise ValueError(f"Lab enrichment {target['id']}.{field} lacks evidence")
    people = {pid: p for p in data["professors"] for pid in [p["id"]] + p.get("aliasIds", [])}
    for link in expansion.get("professorAffiliations", []):
        person, lab = people.get(link["professorId"]), by_id.get(link["labId"])
        if not person or not lab:
            raise ValueError(f"Reviewed affiliation references unknown record {link['professorId']} -> {link['labId']}")
        items = link.get("evidence") if isinstance(link.get("evidence"), list) else [link.get("evidence")]
        proof = [copy.deepcopy(e) for e in items if sourced(e)]
        relationship = link.get("relationship")
        if not proof or not isinstance(relationship, str) or not relationship.strip():
            raise ValueError(f"Reviewed affiliation {link['professorId']} -> {link['labId']} lacks source evidence or relationship")
        affiliations = person.setdefault("labAffiliations", [])
        if not any(a.get("labId") == lab["id"] or url_key(a.get("url", "")) == url_key(lab["labWebsiteUrl"]) for a in affiliations):
            affiliations.append({"labId": lab["id"], "labName": lab["labName"], "url": lab["labWebsiteUrl"],
                                 "relationship": link["relationship"], "fieldEvidence": proof[0] if len(proof) == 1 else proof})
        if not known(person.get("labAffiliationUrl")):
            person["labAffiliation"], person["labAffiliationUrl"] = lab["labName"], lab["labWebsiteUrl"]
            for f in ["labAffiliation", "labAffiliationUrl"]:
                attach_evidence(person, f, proof)
        lab["professorIds"] = list(dict.fromkeys(lab.get("professorIds", []) + [person["id"]]))
    return skipped


def apply_lab_ai_scores(data, lab_ai_scores):
    """Attach Gemini lab-likeness scores; a score only applies to the URL it was given for."""
    scores = lab_ai_scores.get("byLabId", {})
    for lab in data["labs"]:
        lab.pop("aiLabScore", None)
        entry = scores.get(lab["id"])
        if entry and url_key(entry["url"]) == url_key(lab["labWebsiteUrl"]):
            lab["aiLabScore"] = {k: entry[k] for k in ["score", "category", "reason", "retrievalStatus", "model", "observedAt"] if k in entry}


def build(data, lab_evidence, teaching, ratings, source_checks, faculty_evidence=None, lab_review=None, lab_expansion=None, lab_ai_scores=None):
    faculty_evidence = faculty_evidence or {}
    lab_review = lab_review or {}
    lab_expansion = lab_expansion or {}
    lab_ai_scores = lab_ai_scores or {}
    before = profile(data)
    changes, quarantine = clean_legacy(data)
    by_id = {p["id"]: p for p in data["professors"]}
    for new in lab_evidence.get("professors", []) + faculty_evidence.get("professors", []):
        existing = next((p for p in by_id.values() if name_key(p["name"]) == name_key(new["name"]) and p["department"] == new["department"]), None)
        if new["id"] not in by_id and existing is not None:
            by_id[new["id"]] = existing
            existing["aliasIds"] = list(dict.fromkeys(existing.get("aliasIds", []) + [new["id"]]))
        elif new["id"] not in by_id:
            new = copy.deepcopy(new)
            data["professors"].append(new)
            by_id[new["id"]] = new
    for capture in [lab_evidence, faculty_evidence]:
        for pid, patch in capture.get("byProfessorId", {}).items():
            if pid in by_id:
                merge_patch(by_id[pid], patch)
    labs_by_url = {url_key(l["labWebsiteUrl"]): l for l in data["labs"]}
    labs_by_url.update({url_key(u): l for l in data["labs"] for u in l.get("alternateWebsiteUrls", [])})
    for new in lab_evidence.get("labs", []):
        key = url_key(new["labWebsiteUrl"])
        if not key:
            continue
        if key in labs_by_url:
            old = labs_by_url[key]
            merge_patch(old, new)
            if new.get("fieldEvidence"):
                # Display labels and descriptions come from the freshly parsed directory row.
                for f in ["labName", "department", "principalInvestigator", "principalInvestigatorProfileUrl"]:
                    if known(new.get(f)) and new.get("fieldEvidence", {}).get(f):
                        old[f] = new[f]
        else:
            new = copy.deepcopy(new)
            data["labs"].append(new)
            labs_by_url[key] = new
    checks = {c["sourceUrl"]: c for c in source_checks.get("checks", [])}
    catalog_checks = {u: c for u, c in checks.items() if "catalogListings" in c}
    alias_lookup = collections.defaultdict(list)
    for pid, record in by_id.items():
        alias_lookup[record["id"]].append(pid)
    for p in data["professors"]:
        if "byProfessorId" in teaching:
            # A new capture replaces assignments; removed rows must not survive a refresh.
            # An absent instructor may belong to a department not covered by these sources.
            p["teaching"] = {"status": "not_checked", "lastChecked": None, "courses": []}
            p.setdefault("fieldEvidence", {}).pop("teaching", None)
        person_ids = list(dict.fromkeys([p["id"]] + p.get("aliasIds", []) + alias_lookup[p["id"]]))
        courses = []
        for pid in person_ids:
            rows = teaching.get("byProfessorId", {}).get(pid, [])
            courses.extend(rows.get("courses", []) if isinstance(rows, dict) else rows)
        courses = list({json.dumps(c, sort_keys=True): c for c in courses}.values())
        candidates = [c for c in courses if c.get("matchConfidence") == "low" or c.get("verificationStatus") == "needs_review"]
        courses = [c for c in courses if c not in candidates]
        if courses:
            p["teaching"] = {"status": "verified", "lastChecked": teaching.get("generatedAt"), "courses": courses}
            for c in courses:
                attach_evidence(p, "teaching", {k: c[k] for k in ["sourceUrl", "observedAt", "evidence"]})
        else:
            p.setdefault("teaching", {"status": "not_checked", "lastChecked": None, "courses": []})
        if candidates:
            p["teaching"]["candidates"] = candidates
            p["teaching"]["lastChecked"] = teaching.get("generatedAt")
            if not courses:
                p["teaching"]["status"] = "needs_review"
        p.setdefault("ratings", {})
        for key in ["rateMyPI", "rateMyProfessors"]:
            rating = next((ratings["byProfessorId"][pid][key] for pid in person_ids
                           if ratings.get("byProfessorId", {}).get(pid, {}).get(key)), None)
            if rating:
                p["ratings"][key] = rating
                p.setdefault("fieldEvidence", {}).pop("ratings." + key, None)
                if rating.get("status") == "verified":
                    attach_evidence(p, "ratings." + key, {
                        "sourceUrl": rating.get("evidenceUrl") or rating["sourceUrl"], "observedAt": rating["observedAt"],
                        "evidence": rating.get("evidence") or f"{rating.get('matchedName', p['name'])}; {rating.get('matchedInstitution', p['institution'])}; {rating.get('score')}/{rating.get('scale')}; {rating.get('reviewCount')} ratings",
                        "method": rating.get("matchMethod", "name_and_institution")})
            else:
                p["ratings"].setdefault(key, {"platform": "PI Review" if key == "rateMyPI" else "Rate My Professors", "status": "not_checked", "score": None, "scale": 5, "reviewCount": None,
                                             "sourceUrl": None, "observedAt": None})
        for u in p.get("sourceUrls", [])[:]:
            c = catalog_checks.get(u)
            if not c:
                continue
            rows = [row for row in c["catalogListings"] if name_key(row["name"]) == name_key(p["name"])]
            if rows:
                p["catalogListing"] = {"status": "listed_undated", "sourceUrl": u, "observedAt": c["observedAt"], "contentDate": None,
                                       "rolesAsListed": sorted({r["listingRole"] for r in rows}),
                                       "note": "Catalog content may be outdated. This does not confirm a current appointment."}
                attach_evidence(p, "catalogListing", {"sourceUrl": u, "observedAt": c["observedAt"], "evidence": " | ".join(r["evidence"] for r in rows), "method": "exact_name_catalog_row"})
                break
    quarantine.extend(consolidate_catalog_duplicates(data))
    quarantine.extend(reject_nonlabs(data))
    quarantine.extend(consolidate_lab_urls(data))
    quarantine.extend(apply_lab_identity_review(data, lab_review))
    apply_lab_expansion(data, lab_expansion)
    labs_by_url = {url_key(l["labWebsiteUrl"]): l for l in data["labs"]}
    labs_by_url.update({url_key(u): l for l in data["labs"] for u in l.get("alternateWebsiteUrls", [])})
    canonical_ids = {pid: p["id"] for p in data["professors"] for pid in [p["id"]] + p.get("aliasIds", [])}
    for record in data["professors"] + data["labs"]:
        if "professorIds" in record:
            record["professorIds"] = list(dict.fromkeys(canonical_ids.get(pid, pid) for pid in record["professorIds"]))
        for f in ["officialProfileUrl", "personalWebsiteUrl", "labAffiliationUrl", "labWebsiteUrl", "principalInvestigatorProfileUrl", "googleScholarUrl"]:
            if known(record.get(f)):
                record[f] = encode_url(record[f])
        record["sourceUrls"] = list(dict.fromkeys(encode_url(u) for u in record.get("sourceUrls", []) if valid_url(encode_url(u))))
        evidence = record.setdefault("fieldEvidence", {})
        for f, value in list(evidence.items()):
            if isinstance(value, dict):
                evidence[f] = [value]
        v = record.setdefault("verification", {"status": "legacy_unverified", "lastAttemptedAt": None, "issues": []})
        v.setdefault("lastAttemptedAt", None)
        v.setdefault("issues", [])
        if v.get("status") not in {"source_checked", "needs_review", "unavailable", "legacy_unverified"}:
            v["fetchStatus"] = v.get("status")
            v["status"] = "unavailable"
        v["fieldsVerified"] = sorted(evidence)
        dates = [e["observedAt"] for items in evidence.values() for e in (items if isinstance(items, list) else [items]) if e.get("observedAt")]
        if dates:
            v["lastEvidenceAt"] = max(dates)
        if evidence:
            v["status"] = "source_checked"
        if "labWebsiteUrl" in record and record["labWebsiteUrl"] in checks:
            c = checks[record["labWebsiteUrl"]]
            record["websiteCheck"] = {k: c[k] for k in ["sourceUrl", "status", "observedAt", "httpStatus", "finalUrl", "title"] if k in c}
            v["lastAttemptedAt"] = c["observedAt"]
            if not evidence:
                v["status"] = "needs_review" if c["status"] == "reachable" else "unavailable"
        for correction in lab_review.get("websiteCorrections", []):
            if correction["labId"] == record["id"]:
                observed = correction["evidence"][-1]
                record["websiteCheck"] = {k: observed[k] for k in ["sourceUrl", "observedAt", "httpStatus", "finalUrl"] if k in observed}
                record["websiteCheck"]["status"] = correction["value"]
                v["issues"] = list(dict.fromkeys(v["issues"] + [correction["reason"]]))
        record["unverifiedFields"] = [f for f in record.get("unverifiedFields", []) if f not in evidence]
        for affiliation in record.get("labAffiliations", []):
            affiliation["url"] = encode_url(affiliation.get("url", ""))
            target = labs_by_url.get(url_key(affiliation.get("url", "")))
            if target:
                affiliation["labId"] = target["id"]
                if affiliation.get("fieldEvidence") and record["id"] in by_id:
                    target["professorIds"] = list(dict.fromkeys(target.get("professorIds", []) + [record["id"]]))
    apply_lab_ai_scores(data, lab_ai_scores)
    data["schemaVersion"] = "3.0.0"
    stamps = [p.get("generatedAt") for p in [lab_evidence, teaching, ratings, source_checks, faculty_evidence, lab_review, lab_expansion] if p.get("generatedAt")]
    data["generatedAt"] = max(stamps, default=data["generatedAt"])
    data["description"] = "UCSD research discovery with field-level evidence, source checks, teaching schedules, and separate student-rating platforms."
    data["collectionPolicy"].update({"fieldEvidenceRequiredForNewClaims": True, "fetchDateIsNotWholeRecordVerification": True,
                                    "ratingsAreSubjective": True, "scheduledCoursesAreNotTeachingHistory": True})
    after = profile(data)
    data["dataQuality"] = {"asOf": data["generatedAt"], "coverage": after,
                           "limitations": ["A source check verifies only the listed fields, not the whole record or current employment.",
                                           "Unmatched courses and ratings remain in evidence files for review.",
                                           "Missing ratings are unknown, never zero; PI and teaching reviews measure different experiences.",
                                           "Source timestamps describe retrieval; undated catalogs may still contain outdated appointments."]}
    return data, {"generatedAt": data["generatedAt"], "before": before, "after": after,
                  "remediationCounts": dict(collections.Counter(c["field"] for c in changes)),
                  "sourceCheckStatuses": dict(collections.Counter(c["status"] for c in checks.values())),
                  "quarantinedRecords": len(quarantine)}, changes, quarantine


def write_report_markdown(path, report):
    a, b = report["after"], report["before"]
    lines = ["# UCSD 数据更新与质量报告", "", f"构建时间：{report['generatedAt']}。具体字段以各自 `observedAt` 为准。", "",
             "## 记录覆盖", "", "| 项目 | 原始快照 | 当前数据 |", "|---|---:|---:|",
             f"| 教授记录 | {b['professors']} | {a['professors']} |", f"| Lab / research group | {b['labs']} | {a['labs']} |",
             f"| 有至少一个字段证据的教授 | {b['professorsWithFieldEvidence']} | {a['professorsWithFieldEvidence']} |",
             f"| 有明确姓名匹配课程的教授 | 0 | {a['professorsWithCourses']} |",
             f"| 课程来源记录（可能同课多来源） | 0 | {a['courseAssignments']} |",
             f"| 去重教授 × 课程 × 学期 | 0 | {a['uniqueProfessorCourseTerms']} |",
             f"| 有 PI Review 分数的教授记录 | 0 | {a['professorsWithRatings']['rateMyPI']} |",
             f"| 有 Rate My Professors 分数的教授记录 | 0 | {a['professorsWithRatings']['rateMyProfessors']} |", "",
             "同一个人可能有多个院系任职记录；教授数和有分数记录数不是独立自然人数。部分字段得到核实不代表整个档案或现任职务得到核实。", "",
             "## 字段证据覆盖", "", "| 字段 | 教授记录数 |", "|---|---:|"]
    lines += [f"| {f} | {n} |" for f, n in a["professorFieldsWithEvidence"].items()]
    lines += ["", "## 清理的旧数据", "", "所有被替换值见 `data/quality/legacy-remediation.json`，移出 lab 的个人研究主页和重复记录见 `quarantined-records.json`。", ""]
    lines += [f"- {f}：{n} 处修正。" for f, n in report["remediationCounts"].items()]
    lines += ["", "## 来源检查与缺口", "", "- `data/ucsd/lab-evidence.json`：官方教授主页、lab 目录、逐条抓取状态与证据。", "- `data/ucsd/faculty-evidence.json`：当前院系目录、任职类别和交叉任职。", "- `data/ucsd/teaching-evidence.json`：官方排课表、原文、来源日期、未匹配及仅姓候选。", "- `data/ucsd/ratings-evidence.json`：两个平台的检索范围、样本数、身份匹配及失败状态。", "- `data/ucsd/source-checks.json`：旧 lab URL 和 catalog 的 HTTP/robots 检查；HTTP 200 不证明网页内容最新。", "- `data/ucsd/real-portal-resources.json`：完整公开分页列表，每页附实际抓取时间及 SHA-256。", ""]
    lines += [f"- 来源可达性 `{status}`：{count} 个 URL。" for status, count in report["sourceCheckStatuses"].items()]
    lines += ["- `data/ucsd/lab-identity-review.json`：人工复核的新旧网址合并、研究所错误链接和研究组成员身份；Chien lab 的 Google 页面需要登录，不能把其 HTTP 200 当作公开可用。"]
    capture = report.get("captureCoverage", {})
    labs = capture.get("Lab/profile capture", {})
    faculty = capture.get("Faculty directory capture", {})
    teaching = capture.get("Teaching sources", {})
    platforms = {p["key"]: p for p in capture.get("Rating platforms", [])}
    lines += ["", "## 本轮采集范围", "",
              f"- 官方个人页面：尝试 {labs.get('profileAttempts', 0)} 条，确认姓名身份 {labs.get('verificationStatuses', {}).get('verified', 0)} 条；{labs.get('verificationStatuses', {}).get('deferred_crawl_delay', 0)} 条因网站限速等待后续采集。其余身份不符、HTTP 或 robots 失败逐条保留。",
              f"- 院系名册：{faculty.get('departmentsObserved', 0)} 个系、{faculty.get('directoryListingCount', 0)} 条目录记录，观察到 {faculty.get('distinctProfessorsObserved', 0)} 个教授档案；其中新增 {faculty.get('newProfessorCount', 0)} 条。",
              f"- 课程：{teaching.get('sourceCount', 0)} 个官方来源、{teaching.get('failedSources', 0)} 个抓取失败；{teaching.get('highConfidenceAssignmentEvidenceCount', 0)} 条明确姓名匹配，{teaching.get('assignmentsNeedingIdentityReview', 0)} 条待核实候选，{teaching.get('unmatchedAssignmentCount', 0)} 条未匹配。未覆盖院系或未匹配教授不代表没有授课。",
              f"- Rate My Professors：完成 {platforms.get('rateMyProfessors', {}).get('namesSearched', 0)} 个不同姓名检索，{a['distinctRatedProfiles']['rateMyProfessors']} 个独立有分页面。使用各精确姓名查询首个公开响应，不能保证平台内部所有同名页面均被返回。",
              f"- PI Review：读取 {platforms.get('rateMyPI', {}).get('observedProfiles', 0)} 个公开档案，其中 {platforms.get('rateMyPI', {}).get('observedRatedProfiles', 0)} 个有评价，共 {platforms.get('rateMyPI', {}).get('observedReviews', 0)} 条评价。",
              f"- REAL Portal：完整读取本次公开目录的 {capture.get('REAL Portal records', 0)} 条记录，包括 co-curricular 项目。",
              "", "各系覆盖数字和完整状态统计见 `data/quality/refresh-report.json`；原始来源、内容摘要与采集回执见上列证据文件。"]
    lines += ["", "## 如何解读", "", "- UCSD Profiles 公开 robots 要求每请求间隔 10 秒。未完成的慢域页面标记 deferred，不能声称全部教授资料已重新核实。采集器支持缓存续跑及每轮预算。", "- Catalog 页可能仍包含历史职务。`listed_undated` 只确认公开目录列名，不确认目前仍在职。", "- `scheduled` 是来源公布的排课安排，可能改变；`historical` 是历史学期排课证据，不证明实际完成授课。仅姓匹配不进入已核实课程列表。", "- PI Review 是科研导师评价来源，Rate My Professors 是授课评价来源。它们是匿名主观评价，不合并打分；没查到、无评价和抓取失败各自记录，分数缺失不是 0。", "- 老的公共邮箱、导航 lab 关系、关键词推测和 Scholar 假链接已移除。保留但没有字段证据的旧值仍待核验。", "- REAL 的 co-curricular 项目与研究机会保留独立类型；目录列出不等于正在招人。", "", "## 复现", "", "运行顺序和参数见 [README](../README.md)。核心逻辑检查：`python3 -m unittest discover -s tests -v`；完整数据检查：`python3 scripts/validate_data.py`。报告由离线合并器生成。", ""]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--atlas", type=Path, default=ROOT / "data/research-atlas.json")
    ap.add_argument("--evidence-dir", type=Path, default=ROOT / "data/ucsd")
    ap.add_argument("--out", type=Path, default=ROOT / "data/research-atlas.json")
    ap.add_argument("--quality-dir", type=Path, default=ROOT / "data/quality")
    args = ap.parse_args()
    def read(name):
        path = args.evidence_dir / name
        value = json.loads(path.read_text()) if path.exists() else {}
        if value.get("collectionState") not in {None, "completed"}:
            raise SystemExit(f"Refusing incomplete capture {name}: {value['collectionState']}; served dataset preserved.")
        return value
    atlas, report, changes, quarantine = build(json.loads(args.atlas.read_text()), read("lab-evidence.json"),
                                              read("teaching-evidence.json"), read("ratings-evidence.json"), read("source-checks.json"), read("faculty-evidence.json"), read("lab-identity-review.json"),
                                              read("lab-expansion-review.json"), read("lab-ai-scores.json"))
    from validate_data import validate_professor, validate_lab, validate_references
    ids = set()
    for kind, validate in [("professors", validate_professor), ("labs", validate_lab)]:
        for record in atlas[kind]:
            validate(record)
            if record["id"] in ids:
                raise SystemExit(f"Duplicate ID {record['id']}; served dataset preserved.")
            ids.add(record["id"])
    validate_references(atlas)
    write_json(args.out, atlas)
    old_report = args.quality_dir / "refresh-report.json"
    if old_report.exists():
        previous = json.loads(old_report.read_text())
        report["before"] = previous["before"]
    for filename, rows in [("legacy-remediation.json", changes), ("quarantined-records.json", quarantine)]:
        path = args.quality_dir / filename
        existing = json.loads(path.read_text()) if path.exists() else []
        combined = list({(r["record"]["id"] if filename == "quarantined-records.json" else json.dumps(r, sort_keys=True)): r for r in existing + rows}.values())
        write_json(path, combined)
        if filename == "legacy-remediation.json":
            report["remediationCounts"] = dict(collections.Counter(c["field"] for c in combined))
        else:
            report["quarantinedRecords"] = len(combined)
    report["captureCoverage"] = {
        "Lab/profile capture": read("lab-evidence.json").get("stats", {}),
        "Faculty directory capture": read("faculty-evidence.json").get("coverage", {}),
        "Teaching sources": read("teaching-evidence.json").get("coverage", {}),
        "Rating platforms": read("ratings-evidence.json").get("platforms", []),
        "REAL Portal records": read("real-portal-resources.json").get("importedCount", 0),
    }
    report["departments"] = {dept: profile({"professors": [p for p in atlas["professors"] if p["department"] == dept], "labs": [l for l in atlas["labs"] if l["department"] == dept]})
                             for dept in sorted({p["department"] for p in atlas["professors"] + atlas["labs"]})}
    write_json(old_report, report)
    if args.out.resolve() == (ROOT / "data/research-atlas.json").resolve():
        write_report_markdown(ROOT / "docs/DATA_QUALITY_REPORT.md", report)
    print(json.dumps({"after": report["after"], "remediationCounts": report["remediationCounts"]}, indent=2))


if __name__ == "__main__":
    main()
