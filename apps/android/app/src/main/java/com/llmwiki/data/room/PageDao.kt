package com.llmwiki.data.room

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface PageDao {

    @Query("SELECT * FROM pages WHERE workspace_id = :workspaceId AND account_name = :accountName ORDER BY updated_at DESC")
    fun observePages(workspaceId: String, accountName: String): Flow<List<PageEntity>>

    @Query("SELECT * FROM pages WHERE workspace_id = :workspaceId AND account_name = :accountName AND slug = :slug LIMIT 1")
    suspend fun getPage(workspaceId: String, accountName: String, slug: String): PageEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(page: PageEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(pages: List<PageEntity>)

    @Query("UPDATE pages SET content = :content WHERE workspace_id = :workspaceId AND account_name = :accountName AND slug = :slug")
    suspend fun updateContent(workspaceId: String, accountName: String, slug: String, content: String)

    @Query("UPDATE pages SET locked_by_human = :locked WHERE workspace_id = :workspaceId AND account_name = :accountName AND slug = :slug")
    suspend fun updateLock(workspaceId: String, accountName: String, slug: String, locked: Boolean)

    @Query("UPDATE pages SET content = NULL WHERE workspace_id = :workspaceId AND account_name = :accountName AND slug = :slug")
    suspend fun clearContent(workspaceId: String, accountName: String, slug: String)

    @Query("DELETE FROM pages WHERE workspace_id = :workspaceId AND account_name = :accountName")
    suspend fun deleteByWorkspace(workspaceId: String, accountName: String)

    @Query("DELETE FROM pages WHERE workspace_id = :workspaceId AND account_name = :accountName AND slug = :slug")
    suspend fun deletePage(workspaceId: String, accountName: String, slug: String)

    @Query("DELETE FROM pages WHERE workspace_id = :workspaceId AND account_name = :accountName AND slug NOT IN (:slugs)")
    suspend fun deleteMissingPages(workspaceId: String, accountName: String, slugs: List<String>)

    @Query("DELETE FROM pages WHERE account_name = :accountName")
    suspend fun deleteByAccount(accountName: String)

    @Query("DELETE FROM pages")
    suspend fun deleteAll()

    @Query("SELECT cached_revision FROM workspace_cache_state WHERE workspace_id = :workspaceId AND account_name = :accountName")
    suspend fun getCachedRevision(workspaceId: String, accountName: String): Long?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun setCachedRevision(state: WorkspaceCacheStateEntity)
}
