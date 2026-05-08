package com.llmwiki.ui.wiki

import android.content.Intent
import android.net.Uri
import android.text.method.LinkMovementMethod
import android.widget.TextView
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.Markwon
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin

private fun stripFrontmatterAndWikilinks(content: String): String {
    var result = content
    if (result.startsWith("---")) {
        val end = result.indexOf("\n---", startIndex = 3)
        if (end != -1) {
            result = result.substring(end + 4).trimStart()
        }
    }
    return result.replace(Regex("""\[\[([^\]]+)]]""")) { match ->
        val slug = match.groupValues[1]
        "[$slug](wiki://$slug)"
    }
}

private fun parseInternalWikiLink(link: String): String? {
    if (link.startsWith("wiki://")) {
        return normalizeWikiSlug(Uri.decode(link.removePrefix("wiki://").substringBefore("#")))
    }
    if (link.startsWith("#")) return null
    if (link.startsWith("http://") || link.startsWith("https://") || link.startsWith("mailto:")) return null
    return normalizeWikiSlug(link.removePrefix("/").substringBefore("#"))
}

private fun normalizeWikiSlug(raw: String): String? {
    val slug = raw.trim()
    if (slug.isBlank()) return null
    return if (slug.endsWith(".md")) slug else "$slug.md"
}

@Composable
fun MarkdownViewer(
    markdown: String,
    onWikiLinkClick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val colorScheme = MaterialTheme.colorScheme
    val textColor = colorScheme.onBackground.toArgb()
    val linkColor = colorScheme.primary.toArgb()
    val markwon = remember(context, onWikiLinkClick) {
        Markwon.builder(context)
            .usePlugin(StrikethroughPlugin.create())
            .usePlugin(TablePlugin.create(context))
            .usePlugin(object : AbstractMarkwonPlugin() {
                override fun configureConfiguration(builder: io.noties.markwon.MarkwonConfiguration.Builder) {
                    builder.linkResolver { view, link ->
                        val slug = parseInternalWikiLink(link)
                        if (slug != null) {
                            onWikiLinkClick(slug)
                            return@linkResolver
                        }

                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
                        view.context.startActivity(intent)
                    }
                }
            })
            .build()
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            TextView(ctx).apply {
                textSize = 15f
                linksClickable = true
                movementMethod = LinkMovementMethod.getInstance()
                setTextIsSelectable(false)
                setTextColor(textColor)
                setLinkTextColor(linkColor)
            }
        },
        update = { view ->
            view.setTextColor(textColor)
            view.setLinkTextColor(linkColor)
            markwon.setMarkdown(view, stripFrontmatterAndWikilinks(markdown))
            view.movementMethod = LinkMovementMethod.getInstance()
        },
    )
}
