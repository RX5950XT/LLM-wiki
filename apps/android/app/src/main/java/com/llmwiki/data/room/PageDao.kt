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

    @Query("SELECT * FROM pages WHERE workspace_id = :workspaceId AND slug = :slug LIMIT 1")
    suspend fun getPage(workspaceId: String, slug: String): PageEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(page: PageEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(pages: List<PageEntity>)

    @Query("UPDATE pages SET content = :content WHERE workspace_id = :workspaceId AND slug = :slug")
    suspend fun updateContent(workspaceId: String, slug: String, content: String)

    @Query("UPDATE pages SET locked_by_human = :locked WHERE workspace_id = :workspaceId AND slug = :slug")
    suspend fun updateLock(workspaceId: String, slug: String, locked: Boolean)

    @Query("DELETE FROM pages")
    suspend fun deleteAll()
}
