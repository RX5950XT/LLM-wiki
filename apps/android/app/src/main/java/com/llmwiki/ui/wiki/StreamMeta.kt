package com.llmwiki.ui.wiki

import com.llmwiki.data.RawSourceCitation
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal data class StreamMeta(
    val text: String,
    val citedSlugs: List<String>,
    val rawCitations: List<RawSourceCitation>,
    val proposals: List<ActionProposal>,
)

@Serializable
private data class ProposalWire(
    val action: String,
    val params: Map<String, String> = emptyMap(),
    val label: String = "",
)

private val streamJson = Json { ignoreUnknownKeys = true }

/** Parses the trailing NUL-delimited query metadata without trusting its shape. */
internal fun parseStreamMeta(raw: String): StreamMeta {
    val markers = Regex("\\u0000([A-Z_]+)\\u0000")
        .findAll(raw)
        .toList()
    if (markers.isEmpty()) return StreamMeta(raw, emptyList(), emptyList(), emptyList())

    val text = raw.substring(0, markers.first().range.first)
    var citedSlugs = emptyList<String>()
    var rawCitations = emptyList<RawSourceCitation>()
    var proposals = emptyList<ActionProposal>()

    markers.forEachIndexed { index, marker ->
        val start = marker.range.last + 1
        val end = markers.getOrNull(index + 1)?.range?.first ?: raw.length
        val jsonPart = raw.substring(start, end).trim()
        runCatching {
            val element = streamJson.parseToJsonElement(jsonPart)
            when (marker.groupValues[1]) {
                "CITATIONS" -> citedSlugs = (element as? JsonArray)
                    ?.mapNotNull { item -> runCatching { item.jsonPrimitive.contentOrNull }.getOrNull() }
                    ?.filter { it.isNotBlank() }
                    ?: emptyList()
                "RAW_CITATIONS" -> rawCitations = decodeRawCitations(element)
                "ACTIONS" -> proposals = decodeProposals(element)
            }
        }
    }
    return StreamMeta(text, citedSlugs, rawCitations, proposals)
}

private fun decodeRawCitations(element: JsonElement): List<RawSourceCitation> =
    (element as? JsonArray).orEmpty().mapNotNull { item ->
        runCatching {
            val citation = streamJson.decodeFromJsonElement(RawSourceCitation.serializer(), item)
            citation.takeIf {
                citation.sourceId.isNotBlank() &&
                    citation.kind in setOf("url", "file", "text") &&
                    citation.contentSha256.isNotBlank() &&
                    citation.locator.lineStart >= 1 &&
                    citation.locator.lineEnd >= citation.locator.lineStart
            }
        }.getOrNull()
    }

private fun decodeProposals(element: JsonElement): List<ActionProposal> =
    (element as? JsonArray).orEmpty().mapNotNull { item ->
        runCatching {
            val proposal = streamJson.decodeFromJsonElement(ProposalWire.serializer(), item)
            proposal.takeIf {
                it.action == "delete_page" || it.action == "delete_workspace"
            }?.let { ActionProposal(action = it.action, params = it.params, label = it.label) }
        }.getOrNull()
    }
