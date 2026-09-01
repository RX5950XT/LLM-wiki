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

@Serializable
data class PageLinkRow(
    @SerialName("from_slug") val fromSlug: String,
)

/** A page in one of the user's other workspaces — the target of a re-shelved wiki link. */
@Serializable
data class WikiTargetRow(
    @SerialName("workspace_id") val workspaceId: String,
    val slug: String,
    val title: String? = null,
)

@Serializable
data class SourceRow(
    val id: String,
    val kind: String = "",
    val title: String? = null,
    val url: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("ingested_at") val ingestedAt: String? = null,
)

@Serializable
data class IngestJobRow(
    val id: String? = null,
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("source_id") val sourceId: String = "",
    val status: String = "",
    val phase: String? = null,
    val error: String? = null,
    @SerialName("touched_pages") val touchedPages: List<String> = emptyList(),
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("finished_at") val finishedAt: String? = null,
    @SerialName("attempt_count") val attemptCount: Int = 0,
    val result: String? = null,
    @SerialName("source_sha256") val sourceSha256: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("source_title") val sourceTitle: String? = null,
    @SerialName("source_mime_type") val sourceMimeType: String? = null,
)

/** UI-side join of a source with its latest ingest job. */
data class SourceListItem(
    val source: SourceRow,
    val jobStatus: String? = null,
    val jobError: String? = null,
    val touchedCount: Int = 0,
)

@Serializable
data class RawSourceLocator(
    @SerialName("line_start") val lineStart: Int,
    @SerialName("line_end") val lineEnd: Int,
)

@Serializable
data class RawSourceCitation(
    @SerialName("source_id") val sourceId: String,
    val title: String? = null,
    val kind: String = "file",
    val url: String? = null,
    @SerialName("content_sha256") val contentSha256: String,
    val locator: RawSourceLocator,
)

@Serializable
data class GraphInsightPage(
    val slug: String,
    val title: String? = null,
)

@Serializable
data class GraphInsightMissingLink(
    @SerialName("from_slug") val fromSlug: String,
    @SerialName("to_slug") val toSlug: String,
)

@Serializable
data class GraphInsightCommunity(
    val id: String,
    val pages: List<GraphInsightPage> = emptyList(),
)

@Serializable
data class GraphInsightCounts(
    val pages: Int = 0,
    val links: Int = 0,
    val orphans: Int = 0,
    val communities: Int = 0,
    val bridges: Int = 0,
    val missingLinks: Int = 0,
)

@Serializable
data class GraphInsights(
    val counts: GraphInsightCounts = GraphInsightCounts(),
    val orphans: List<GraphInsightPage> = emptyList(),
    val communities: List<GraphInsightCommunity> = emptyList(),
    val bridges: List<GraphInsightPage> = emptyList(),
    val missingLinks: List<GraphInsightMissingLink> = emptyList(),
)
