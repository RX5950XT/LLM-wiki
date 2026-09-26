package com.llmwiki.ui.wiki

import com.llmwiki.data.IngestJobRow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ApiResponseParsingTest {
    @Test
    fun readsEveryErrorShapeTheWebApiSends() {
        assertEquals("Workspace not found", extractApiErrorMessage("""{"error":"Workspace not found"}"""))
        // ingest / re-ingest: nested object
        assertEquals(
            "No LLM profile configured",
            extractApiErrorMessage("""{"error":{"code":"NO_PROFILE","message":"No LLM profile configured"}}"""),
        )
        // non-string sibling used to break Map<String, String> decoding
        assertEquals(
            "An organize job is already running",
            extractApiErrorMessage("""{"error":"An organize job is already running","jobId":"x","retry":true}"""),
        )
        // zod flatten object carries no readable message
        assertNull(extractApiErrorMessage("""{"error":{"formErrors":[],"fieldErrors":{"name":["Required"]}}}"""))
        assertNull(extractApiErrorMessage("Unauthorized"))
    }

    @Test
    fun batchCountsIgnoreOldHistory() {
        val jobs = listOf(
            job("running", "2026-09-26T09:00:00+00:00"),
            job("done", "2026-09-26T08:50:00.123456+00:00"),
            job("failed", "2026-09-26T08:45:00Z"),
            // a week-old failure is not part of today's import
            job("failed", "2026-09-19T08:45:00+00:00"),
            job("done", "2026-09-19T08:40:00+00:00"),
        )
        assertEquals(1 to 1, ingestBatchCounts(jobs))
        assertEquals(0 to 0, ingestBatchCounts(jobs.filter { it.status != "running" }))
    }

    private fun job(status: String, startedAt: String) =
        IngestJobRow(id = startedAt, sourceId = "s", status = status, startedAt = startedAt)
}
