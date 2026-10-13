import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import score_labs_with_gemini as scorer
from rebuild_verified_atlas import apply_lab_ai_scores

LAB = {"id": "lab-1", "labName": "Campana Lab", "department": "Anesthesiology", "labWebsiteUrl": "https://www.campanalab.com"}


def interaction(text, status="success", url="https://www.campanalab.com"):
    return {"status": "completed", "steps": [
        {"type": "url_context_call", "arguments": {"urls": [url]}},
        {"type": "url_context_result", "result": [{"url": url, "status": status}]},
        {"type": "model_output", "content": [{"type": "text", "text": text}]},
    ]}


class ParseVerdictTests(unittest.TestCase):
    def test_reads_json_wrapped_in_prose_or_fences(self):
        verdict = scorer.parse_verdict('```json\n{"category": "lab", "score": 92, "reason": "Lab members page."}\n```')
        self.assertEqual(verdict, {"category": "lab", "score": 92, "reason": "Lab members page."})

    def test_score_is_clamped_into_its_category_band(self):
        self.assertEqual(scorer.parse_verdict('{"category": "lab", "score": 40}')["score"], 75)
        self.assertEqual(scorer.parse_verdict('{"category": "maybe_lab", "score": 75}')["score"], 74)
        self.assertEqual(scorer.parse_verdict('{"category": "not_lab", "score": 10}')["score"], 25)
        self.assertEqual(scorer.parse_verdict('{"category": "unreachable", "score": 30}')["score"], 24)

    def test_missing_score_uses_band_floor(self):
        self.assertEqual(scorer.parse_verdict('{"category": "maybe_lab"}')["score"], 50)

    def test_bad_replies_are_api_errors_not_scores(self):
        for text in ["no json here", '{"category": "course", "score": 30}', "{not json}"]:
            with self.assertRaises(scorer.ApiError):
                scorer.parse_verdict(text)


class ScoreLabTests(unittest.TestCase):
    def test_scores_lab_and_keeps_retrieval_status(self):
        call = mock.Mock(return_value=interaction('{"category": "unreachable", "score": 5, "reason": "404."}', status="error"))
        result = scorer.score_lab(LAB, "key", "test-model", call=call)
        self.assertEqual((result["score"], result["category"], result["retrievalStatus"]), (5, "unreachable", "error"))
        self.assertEqual((result["url"], result["model"]), (LAB["labWebsiteUrl"], "test-model"))
        self.assertIn(LAB["labWebsiteUrl"], call.call_args.args[2])

    @mock.patch.object(scorer.time, "sleep")
    def test_retryable_failures_are_retried(self, _sleep):
        call = mock.Mock(side_effect=[scorer.ApiError("HTTP 429: busy"), interaction('{"category": "lab", "score": 88}')])
        self.assertEqual(scorer.score_lab(LAB, "key", "m", call=call)["score"], 88)
        self.assertEqual(call.call_count, 2)

    @mock.patch.object(scorer.time, "sleep")
    def test_non_retryable_failure_raises_instead_of_scoring_zero(self, _sleep):
        call = mock.Mock(side_effect=scorer.ApiError("HTTP 403: bad key", retryable=False))
        with self.assertRaises(scorer.ApiError):
            scorer.score_lab(LAB, "key", "m", call=call)
        self.assertEqual(call.call_count, 1)


class MergeTests(unittest.TestCase):
    def scores(self, url):
        return {"byLabId": {"lab-1": {"url": url, "score": 90, "category": "lab", "reason": "r", "retrievalStatus": "success",
                                      "model": "m", "observedAt": "2026-10-13T00:00:00+00:00"}}}

    def test_score_attaches_when_url_matches(self):
        data = {"labs": [dict(LAB)]}
        apply_lab_ai_scores(data, self.scores("https://www.campanalab.com/"))
        self.assertEqual(data["labs"][0]["aiLabScore"]["score"], 90)
        self.assertNotIn("url", data["labs"][0]["aiLabScore"])

    def test_stale_score_is_dropped_when_lab_url_changes(self):
        data = {"labs": [dict(LAB, aiLabScore={"score": 90, "category": "lab"})]}
        apply_lab_ai_scores(data, self.scores("https://old-site.example.edu"))
        self.assertNotIn("aiLabScore", data["labs"][0])


if __name__ == "__main__":
    unittest.main()
