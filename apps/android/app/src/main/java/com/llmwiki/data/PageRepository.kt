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

    fun observePages(workspaceId: String, accountName: String): Flow<List<PageEntity>> =
        db.pageDao().observePages(workspaceId, accountName)

    suspend fun syncPages(workspaceId: String, accountName: String) {
        supabase.requireAccessToken(forceRefresh = true)
        val rows: List<PageRow> = supabase.from("pages")
            .select {
                filter { eq("workspace_id", workspaceId) }
                order("updated_at", order = Order.DESCENDING)
            }
            .decodeList()

        val entities = rows.map { row ->
            PageEntity(
                workspaceId = row.workspaceId,
                accountName = accountName,
                slug = row.slug,
                title = row.title,
                content = db.pageDao().getPage(row.workspaceId, accountName, row.slug)?.content,
                version = row.version,
                driveFileId = row.driveFileId,
                kind = row.kind,
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
        supabase.requireAccessToken(forceRefresh = true)
        return supabase.from("workspaces")
            .select {
                order("created_at", order = Order.ASCENDING)
            }
            .decodeList()
    }
}
