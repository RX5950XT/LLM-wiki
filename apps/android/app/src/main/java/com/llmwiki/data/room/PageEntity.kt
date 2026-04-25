package com.llmwiki.data.room

import androidx.room.ColumnInfo
import androidx.room.Entity

@Entity(tableName = "pages", primaryKeys = ["workspace_id", "slug"])
data class PageEntity(
    @ColumnInfo(name = "workspace_id") val workspaceId: String,
    val slug: String,
    val title: String?,
    /** Cached Drive content — null if not yet fetched */
    val content: String?,
    val version: Long,
    @ColumnInfo(name = "drive_file_id") val driveFileId: String,
    val kind: String,
    @ColumnInfo(name = "updated_at") val updatedAt: String,
    @ColumnInfo(name = "updated_by") val updatedBy: String,
    @ColumnInfo(name = "locked_by_human") val lockedByHuman: Boolean = false,
)
