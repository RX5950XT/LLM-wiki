package com.llmwiki.ui.wiki

import android.widget.TextView
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
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

@Composable
fun MarkdownViewer(
    markdown: String,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val colorScheme = MaterialTheme.colorScheme
    val textColor = colorScheme.onBackground.toArgb()
    val linkColor = colorScheme.primary.toArgb()
    val markwon = remember(context) {
        Markwon.builder(context)
            .usePlugin(StrikethroughPlugin.create())
            .usePlugin(TablePlugin.create(context))
            .build()
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            TextView(ctx).apply {
                textSize = 15f
                setTextIsSelectable(true)
                setTextColor(textColor)
                setLinkTextColor(linkColor)
            }
        },
        update = { view ->
            view.setTextColor(textColor)
            view.setLinkTextColor(linkColor)
            markwon.setMarkdown(view, stripFrontmatterAndWikilinks(markdown))
        },
    )
}
