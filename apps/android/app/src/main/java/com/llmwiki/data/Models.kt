package com.llmwiki.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class WorkspaceRow(
    val id: String,
    val name: String,
    val description: String? = null,
    @SerialName("drive_folder_id") val driveFolderId: String,
    @SerialName("default_profile_id") val defaultProfileId: String? = null,
    @SerialName("sort_order") val sortOrder: Int = 0,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
data class PageRow(
    val id: String,
    @SerialName("workspace_id") val workspaceId: String,
    val slug: String,
    val kind: String,
    val zone: String,
    val title: String? = null,
    @SerialName("drive_file_id") val driveFileId: String,
    @SerialName("content_hash") val contentHash: String? = null,
    val version: Long,
    @SerialName("updated_at") val updatedAt: String,
    @SerialName("updated_by") val updatedBy: String,
    @SerialName("locked_by_human") val lockedByHuman: Boolean = false,
)

@Serializable
data class LlmProfile(
    val id: String,
    val name: String,
    @SerialName("base_url") val baseUrl: String = "",
    val model: String = "",
    @SerialName("is_default") val isDefault: Boolean = false,
)

@Serializable
data class SearchResult(
    val slug: String,
    val title: String? = null,
    val kind: String = "",
    @SerialName("updated_at") val updatedAt: String = "",
)
