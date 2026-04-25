package com.llmwiki.data

import com.llmwiki.data.room.AppDatabase
import com.llmwiki.data.room.PageEntity
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.coroutines.flow.Flow

class PageRepository(
    private val db: AppDatabase,
    private val driveClient: DriveClient?,
) {
    private val supabase get() = SupabaseClientProvider.client

    /** Observe local Room cache (updates in real time via Flow) */
    fun observePages(workspaceId: String): Flow<List<PageEntity>> =
        db.pageDao().observePages(workspaceId)

    /** Refresh page list from Supabase and sync metadata to Room */
    suspend fun syncPages(workspaceId: String) {
        val rows: List<PageRow> = supabase.from("pages")
            .select {
                filter { eq("workspace_id", workspaceId) }
                order("updated_at", order = Order.DESCENDING)
                limit(200)
            }
            .decodeList()

        val entities = rows.map { row ->
            PageEntity(
                workspaceId = row.workspaceId,
                slug = row.slug,
                title = row.title,
                content = db.pageDao().getPage(row.workspaceId, row.slug)?.content,
                version = row.version,
                driveFileId = row.driveFileId,
                kind = row.kind,
                updatedAt = row.updatedAt,
                updatedBy = row.updatedBy,
                lockedByHuman = row.lockedByHuman,
            )
        }
        db.pageDao().upsertAll(entities)
    }

    /** Fetch page content from Drive; update Room cache; return content */
    suspend fun loadPageContent(workspaceId: String, slug: String): String? {
        val entity = db.pageDao().getPage(workspaceId, slug) ?: return null

        // Return cached content immediately if available
        if (entity.content != null) return entity.content

        // Fetch from Drive
        val content = driveClient?.readFile(entity.driveFileId) ?: return null
        db.pageDao().updateContent(workspaceId, slug, content)
        return content
    }

    suspend fun getWorkspaces(): List<WorkspaceRow> =
        supabase.from("workspaces")
            .select()
            .decodeList()
}
