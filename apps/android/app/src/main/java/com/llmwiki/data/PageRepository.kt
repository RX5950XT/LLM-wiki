package com.llmwiki.data

import com.llmwiki.data.room.AppDatabase
import com.llmwiki.data.room.PageEntity
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Order
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.statement.HttpResponse
import kotlinx.coroutines.flow.Flow

class PageRepository(
    private val db: AppDatabase,
    private val driveClient: DriveClient?,
) {
    private val supabase get() = SupabaseClientProvider.client

    fun observePages(workspaceId: String, accountName: String): Flow<List<PageEntity>> =
        db.pageDao().observePages(workspaceId, accountName)

    suspend fun syncPages(workspaceId: String, accountName: String, locale: String) {
        ensureSystemPages(workspaceId, locale)
        val rows = withSupabaseRetry {
            supabase.from("pages")
                .select {
                    filter { eq("workspace_id", workspaceId) }
                    order("updated_at", order = Order.DESCENDING)
                }
                .decodeList<PageRow>()
        }

        val entities = rows.map { row ->
            val existing = db.pageDao().getPage(row.workspaceId, accountName, row.slug)
            PageEntity(
                workspaceId = row.workspaceId,
                accountName = accountName,
                slug = row.slug,
                title = row.title,
                content = existing?.content?.takeIf { existing.version == row.version },
                version = row.version,
                driveFileId = row.driveFileId,
                kind = row.kind,
                zone = row.zone,
                updatedAt = row.updatedAt,
                updatedBy = row.updatedBy,
                lockedByHuman = row.lockedByHuman,
            )
        }
        if (entities.isEmpty()) {
            db.pageDao().deleteByWorkspace(workspaceId, accountName)
            return
        }
        db.pageDao().deleteMissingPages(workspaceId, accountName, entities.map { it.slug })
        db.pageDao().upsertAll(entities)
    }

    suspend fun loadPageContent(workspaceId: String, accountName: String, slug: String): String? {
        val entity = db.pageDao().getPage(workspaceId, accountName, slug) ?: return null
        if (entity.content != null) return entity.content
        val content = driveClient?.readFile(entity.driveFileId) ?: return null
        db.pageDao().updateContent(workspaceId, accountName, slug, content)
        return content
    }

    suspend fun getWorkspaces(): List<WorkspaceRow> {
        return runCatching {
            withSupabaseRetry {
                supabase.from("workspaces")
                    .select {
                        order("sort_order", order = Order.ASCENDING)
                        order("created_at", order = Order.ASCENDING)
                    }
                    .decodeList<WorkspaceRow>()
            }
        }.recoverCatching {
            if (!isMissingSortOrder(it)) throw it
            withSupabaseRetry {
                supabase.from("workspaces")
                    .select {
                        order("created_at", order = Order.ASCENDING)
                    }
                    .decodeList<WorkspaceRow>()
            }
        }.getOrThrow()
    }

    private suspend fun ensureSystemPages(workspaceId: String, locale: String) {
        runCatching {
            var accessToken = supabase.requireAccessToken(forceRefresh = false)
                ?: supabase.requireAccessToken(forceRefresh = true)
                ?: return

            var response = postEnsureSystemPages(accessToken, workspaceId, locale)
            if (response.status.value == 401) {
                accessToken = supabase.requireAccessToken(forceRefresh = true) ?: return
                response = postEnsureSystemPages(accessToken, workspaceId, locale)
            }

            // This endpoint is a compatibility nicety, not a hard requirement.
            if (response.status.value !in 200..299) return
        }
    }

    private suspend fun postEnsureSystemPages(accessToken: String, workspaceId: String, locale: String): HttpResponse =
        AndroidHttpClient.instance.post("${com.llmwiki.BuildConfig.WEB_API_BASE_URL.trimEnd('/')}/api/workspaces/$workspaceId/ensure-system-pages") {
            header("Authorization", "Bearer $accessToken")
            header("x-llm-wiki-locale", locale)
        }

    private suspend fun <T> withSupabaseRetry(block: suspend () -> T): T {
        supabase.requireAccessToken(forceRefresh = false) ?: supabase.requireAccessToken(forceRefresh = true)
        return runCatching { block() }
            .recoverCatching { error ->
                if (!error.isSupabaseAuthProblem()) throw error
                supabase.requireAccessToken(forceRefresh = true) ?: throw error
                block()
            }
            .getOrThrow()
    }

    private fun isMissingSortOrder(error: Throwable): Boolean {
        val message = error.message.orEmpty()
        return message.contains("sort_order", ignoreCase = true) &&
            (
                message.contains("column", ignoreCase = true) ||
                    message.contains("schema cache", ignoreCase = true)
                )
    }
}
