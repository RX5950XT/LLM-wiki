package com.llmwiki.ui.wiki

import com.llmwiki.data.room.PageEntity
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class RequestGuardTest {
    @Test
    fun latePageResponseCannotOverwriteAfterWorkspaceRoundTrip() = runBlocking {
        var latestToken = 0L
        val pageA = page(workspaceId = "A")
        val oldResponse = CompletableDeferred<String>()
        val oldToken = ++latestToken
        val oldJob = async {
            oldResponse.await().takeIf {
                isPageRequestCurrent(oldToken, latestToken, "A", pageA, pageA)
            }
        }

        // The user visits B, then returns to A before the original A request finishes.
        ++latestToken
        val newResponse = CompletableDeferred<String>()
        val newToken = ++latestToken
        val newJob = async {
            newResponse.await().takeIf {
                isPageRequestCurrent(newToken, latestToken, "A", pageA, pageA)
            }
        }

        newResponse.complete("new A content")
        assertEquals("new A content", newJob.await())
        oldResponse.complete("stale A content")
        assertNull(oldJob.await())
    }

    @Test
    fun lateQueryResponseCannotUpdateAfterWorkspaceSwitch() = runBlocking {
        var latestToken = 0L
        val oldResponse = CompletableDeferred<String>()
        val oldToken = ++latestToken
        val oldJob = async {
            oldResponse.await().takeIf {
                isQueryRequestCurrent(oldToken, latestToken, "workspace-a", "workspace-b")
            }
        }

        val newToken = ++latestToken
        val newResponse = CompletableDeferred<String>()
        val newJob = async {
            newResponse.await().takeIf {
                isQueryRequestCurrent(newToken, latestToken, "workspace-b", "workspace-b")
            }
        }

        newResponse.complete("workspace B answer")
        assertEquals("workspace B answer", newJob.await())
        oldResponse.complete("workspace A answer")
        assertNull(oldJob.await())
    }

    private fun page(workspaceId: String) = PageEntity(
        workspaceId = workspaceId,
        accountName = "account@example.com",
        slug = "index.md",
        title = "Index",
        content = null,
        version = 1L,
        driveFileId = "drive-file",
        kind = "page",
        updatedAt = "2026-09-08T00:00:00Z",
        updatedBy = "human",
    )
}
