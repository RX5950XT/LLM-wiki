package com.llmwiki.data.room

import androidx.room.ColumnInfo
import androidx.room.Entity

@Entity(tableName = "workspace_cache_state", primaryKeys = ["workspace_id", "account_name"])
data class WorkspaceCacheStateEntity(
    @ColumnInfo(name = "workspace_id") val workspaceId: String,
    @ColumnInfo(name = "account_name") val accountName: String,
    @ColumnInfo(name = "cached_revision") val cachedRevision: Long,
)
