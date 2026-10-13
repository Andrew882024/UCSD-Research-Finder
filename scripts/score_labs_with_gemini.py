#!/usr/bin/env python3
"""Ask Gemini to open each lab website and score how clearly it is a lab (0-100).

Bands: 75-100 clearly a lab, 50-74 loads but only possibly a lab, 25-49 loads but
not a lab (course, department page, ...), 0-24 the page could not be opened.

Needs python-dotenv. Reads GEMINI_API_KEY from .env at the repo root. Results go to an evidence file that
rebuild_verified_atlas.py merges into each lab as `aiLabScore`. The run is
resumable: labs already scored for the same URL are skipped unless --rescore.
A failed API call is recorded as a failure, never as an unreachable website.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
DEFAULT_MODEL = "gemini-3.8-flash"
BANDS = {
    "lab": (75, 100),
    "maybe_lab": (50, 74),
    "not_lab": (25, 49),
    "unreachable": (0, 24),
}
RETRYABLE_HTTP = {429, 500, 502, 503, 504}

PROMPT = """Open this URL with the URL context tool: {url}

Our directory lists it as the website of "{lab_name}" (UC San Diego, {department}).
Decide what the page actually is and pick exactly one category:

- "lab": the page opened and you are confident it is a research laboratory or
  research group website (e.g. lab name, PI, members, research projects,
  publications, joining information). Score 75-100.
- "maybe_lab": the page opened and looks lab-like but you are not sure, e.g. a
  faculty profile or personal homepage that may double as the lab site, or a
  page that mentions the lab without being its site. Score 50-74.
- "not_lab": the page opened and you are confident it is not a lab, e.g. a
  course page, department or school homepage, news article, event, unrelated
  or parked domain, or a login wall. Score 25-49.
- "unreachable": the page could not be opened (error, timeout, 404, empty or
  blocked content). Score 0-24.

Within a band, a higher score means stronger evidence. Reply with only one JSON
object and nothing else:
{{"category": "lab" | "maybe_lab" | "not_lab" | "unreachable", "score": <integer>, "reason": "<one short sentence citing what you saw>"}}"""


class ApiError(Exception):
    """The Gemini call itself failed; says nothing about the lab website."""

    def __init__(self, message, retryable=True):
        super().__init__(message)
        self.retryable = retryable


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


def call_gemini(api_key, model, prompt, timeout=120):
    body = json.dumps({"model": model, "input": prompt, "tools": [{"type": "url_context"}]}).encode()
    request = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        raise ApiError(f"HTTP {error.code}: {detail}", retryable=error.code in RETRYABLE_HTTP) from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ApiError(f"{type(error).__name__}: {error}") from error


def model_text(interaction):
    parts = [item.get("text", "")
             for step in interaction.get("steps", []) if step.get("type") == "model_output"
             for item in step.get("content", []) if item.get("type") == "text"]
    return "".join(parts).strip()


def retrieval_status(interaction, url):
    """Gemini's own fetch status for the URL: success, error, paywall, unsafe, or None."""
    statuses = [item.get("status")
                for step in interaction.get("steps", []) if step.get("type") == "url_context_result"
                for item in step.get("result", [])]
    matching = [item.get("status")
                for step in interaction.get("steps", []) if step.get("type") == "url_context_result"
                for item in step.get("result", []) if item.get("url", "").rstrip("/") == url.rstrip("/")]
    found = matching or statuses
    return found[-1] if found else None


def parse_verdict(text):
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ApiError(f"No JSON object in model reply: {text[:200]!r}")
    try:
        verdict = json.loads(match.group(0))
    except json.JSONDecodeError as error:
        raise ApiError(f"Unparseable model reply: {text[:200]!r}") from error
    category = verdict.get("category")
    if category not in BANDS:
        raise ApiError(f"Unknown category {category!r}")
    low, high = BANDS[category]
    try:
        score = int(round(float(verdict.get("score"))))
    except (TypeError, ValueError):
        score = low
    return {
        "category": category,
        "score": min(max(score, low), high),
        "reason": str(verdict.get("reason", "")).strip(),
    }


def score_lab(lab, api_key, model, call=call_gemini, retries=3):
    url = lab["labWebsiteUrl"]
    prompt = PROMPT.format(url=url, lab_name=lab.get("labName", ""), department=lab.get("department", ""))
    for attempt in range(retries + 1):
        try:
            interaction = call(api_key, model, prompt)
            if interaction.get("status") not in {None, "completed"}:
                raise ApiError(f"Interaction status {interaction.get('status')}")
            verdict = parse_verdict(model_text(interaction))
            break
        except ApiError as error:
            if attempt == retries or not error.retryable:
                raise
            time.sleep(2 ** attempt * 5)
    return {"url": url, **verdict, "retrievalStatus": retrieval_status(interaction, url),
            "model": model, "observedAt": now()}


def load_scores(path):
    if path.exists():
        return json.loads(path.read_text())
    return {"rubric": {k: list(v) for k, v in BANDS.items()}, "byLabId": {}, "failures": {}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--atlas", type=Path, default=ROOT / "data/research-atlas.json")
    ap.add_argument("--out", type=Path, default=ROOT / "data/ucsd/lab-ai-scores.json")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--limit", type=int, default=0, help="score at most N labs this run (0 = all)")
    ap.add_argument("--ids", nargs="*", default=[], help="only these lab IDs")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--rescore", action="store_true", help="re-score labs that already have a score")
    args = ap.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit(f"Set GEMINI_API_KEY in {ROOT / '.env'} first.")

    labs = json.loads(args.atlas.read_text())["labs"]
    scores = load_scores(args.out)
    done = scores["byLabId"]
    todo = [lab for lab in labs
            if (not args.ids or lab["id"] in args.ids)
            and str(lab.get("labWebsiteUrl", "")).startswith("http")
            and (args.rescore or done.get(lab["id"], {}).get("url") != lab["labWebsiteUrl"])]
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(todo)} labs to score with {args.model} ({len(done)} already scored)")

    lock = threading.Lock()
    completed = 0

    def save():
        scores["generatedAt"] = now()
        scores["model"] = args.model
        write_json(args.out, scores)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(score_lab, lab, api_key, args.model): lab for lab in todo}
        for future in concurrent.futures.as_completed(futures):
            lab = futures[future]
            with lock:
                try:
                    result = future.result()
                    done[lab["id"]] = result
                    scores["failures"].pop(lab["id"], None)
                    line = f"{result['score']:>3} {result['category']:<11} {lab['labName']}"
                except ApiError as error:
                    scores["failures"][lab["id"]] = {"url": lab["labWebsiteUrl"], "error": str(error), "observedAt": now()}
                    line = f"ERR {lab['labName']}: {error}"
                completed += 1
                print(f"[{completed}/{len(todo)}] {line}", flush=True)
                if completed % 10 == 0:
                    save()
    save()
    print(f"Scored {len(done)} labs; {len(scores['failures'])} API failures to retry. Wrote {args.out}")


if __name__ == "__main__":
    main()
