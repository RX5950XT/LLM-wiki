package com.llmwiki.ui.wiki

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.llmwiki.R
import com.llmwiki.data.room.PageEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

private class GraphNode(val slug: String, val label: String, val kind: String, val degree: Int, var x: Float, var y: Float)

// Mirrors KIND_COLOR / KIND_COLOR_DARK in apps/web/components/wiki/graph-view.tsx
private fun kindColor(kind: String, dark: Boolean): Color {
    val k = kind.lowercase()
    return when {
        k.startsWith("entit") -> if (dark) Color(0xFF8FC9F5) else Color(0xFF4EA8DE)
        k.startsWith("concept") -> if (dark) Color(0xFF75E4D8) else Color(0xFF2EC4B6)
        k.startsWith("summar") -> if (dark) Color(0xFFB1B9FF) else Color(0xFF7B8ED8)
        k.startsWith("synthes") -> if (dark) Color(0xFFFFD18A) else Color(0xFFE8A33D)
        else -> if (dark) Color(0xFFC4CCD5) else Color(0xFF8B9095)
    }
}

private fun nodeRadius(degree: Int): Float = min(3f + sqrt(degree.toFloat()) * 1.6f, 12f)

/** Small Fruchterman–Reingold layout, run once off the main thread. */
private fun layoutGraph(pages: List<PageEntity>, edges: List<Pair<String, String>>): List<GraphNode> {
    val degree = HashMap<String, Int>()
    edges.forEach { (a, b) -> degree[a] = (degree[a] ?: 0) + 1; degree[b] = (degree[b] ?: 0) + 1 }
    val n = pages.size
    val ring = 30f * sqrt(n.toFloat().coerceAtLeast(1f))
    val nodes = pages.mapIndexed { i, p ->
        val angle = i * 2.399963f // golden angle spreads the initial positions evenly
        val r = ring * sqrt((i + 0.5f) / n)
        GraphNode(p.slug, p.title ?: p.slug.substringAfterLast('/').removeSuffix(".md"), p.kind, degree[p.slug] ?: 0,
            r * kotlin.math.cos(angle), r * kotlin.math.sin(angle))
    }
    val index = nodes.withIndex().associate { it.value.slug to it.index }
    val links = edges.mapNotNull { (a, b) -> index[a]?.let { ia -> index[b]?.let { ib -> ia to ib } } }
    val k = 40f
    // Only linked pages take part in the simulation: summed repulsion would fling orphans
    // far away and the fit-to-screen would shrink the real graph to a dot (seen on device).
    val active = nodes.indices.filter { nodes[it].degree > 0 }
    val dx = FloatArray(n); val dy = FloatArray(n)
    var temp = ring / 2f
    repeat(300) {
        dx.fill(0f); dy.fill(0f)
        for (ai in active.indices) for (bi in ai + 1 until active.size) {
            val i = active[ai]; val j = active[bi]
            val vx = nodes[i].x - nodes[j].x; val vy = nodes[i].y - nodes[j].y
            val d2 = max(vx * vx + vy * vy, 0.01f)
            val f = k * k / d2
            dx[i] += vx * f; dy[i] += vy * f; dx[j] -= vx * f; dy[j] -= vy * f
        }
        for ((a, b) in links) {
            val vx = nodes[a].x - nodes[b].x; val vy = nodes[a].y - nodes[b].y
            val d = max(sqrt(vx * vx + vy * vy), 0.1f)
            // Dense wikis (index.md links to everything) collapse into a hairball at full FR pull.
            val f = d / k * 0.12f
            dx[a] -= vx * f; dy[a] -= vy * f; dx[b] += vx * f; dy[b] += vy * f
        }
        for (i in active) {
            dx[i] -= nodes[i].x * 0.02f; dy[i] -= nodes[i].y * 0.02f
            val d = max(sqrt(dx[i] * dx[i] + dy[i] * dy[i]), 0.01f)
            val step = min(d, temp)
            nodes[i].x += dx[i] / d * step; nodes[i].y += dy[i] / d * step
        }
        temp *= 0.985f
    }
    // Orphans sit on a ring just outside the linked graph, like Obsidian's loose nodes.
    val orphans = nodes.filter { it.degree == 0 }
    val outer = (active.maxOfOrNull { sqrt(nodes[it].x * nodes[it].x + nodes[it].y * nodes[it].y) } ?: ring) * 1.12f + k
    orphans.forEachIndexed { i, node ->
        val angle = (i.toFloat() / orphans.size) * 6.2831855f - 1.5707964f
        node.x = outer * kotlin.math.cos(angle); node.y = outer * kotlin.math.sin(angle)
    }
    return nodes
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GraphViewDialog(
    pages: List<PageEntity>,
    edges: List<Pair<String, String>>?,
    isLoading: Boolean,
    error: String?,
    onRetry: () -> Unit,
    onOpenInsights: () -> Unit,
    onPageClick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val wikiPages = remember(pages) { pages.filter { it.zone == "wiki" } }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(stringResource(R.string.graph_view_title)) },
                    navigationIcon = {
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.action_back))
                        }
                    },
                    actions = {
                        TextButton(onClick = onOpenInsights) { Text(stringResource(R.string.graph_insights_title)) }
                    },
                )
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                when {
                    error != null -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(error, color = MaterialTheme.colorScheme.error)
                        OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.graph_insights_retry)) }
                    }
                    edges == null || isLoading -> CircularProgressIndicator()
                    wikiPages.isEmpty() -> Text(stringResource(R.string.graph_insights_empty))
                    else -> GraphCanvas(wikiPages, edges, onPageClick)
                }
            }
        }
    }
}

@Composable
private fun GraphCanvas(pages: List<PageEntity>, edges: List<Pair<String, String>>, onPageClick: (String) -> Unit) {
    val nodes by produceState<List<GraphNode>?>(null, pages, edges) {
        value = withContext(Dispatchers.Default) { layoutGraph(pages, edges) }
    }
    val laidOut = nodes ?: run { CircularProgressIndicator(); return }
    val dark = MaterialTheme.colorScheme.background.luminanceIsDark()
    val edgeColor = MaterialTheme.colorScheme.outlineVariant
    val labelColor = MaterialTheme.colorScheme.onSurfaceVariant
    val measurer = rememberTextMeasurer()
    var zoom by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    val bySlug = remember(laidOut) { laidOut.associateBy { it.slug } }
    val labelled = remember(laidOut) { laidOut.sortedByDescending { it.degree }.take(8).map { it.slug }.toSet() }
    val orphanCount = laidOut.count { it.degree == 0 }

    Column(Modifier.fillMaxSize()) {
        Text(
            stringResource(R.string.graph_orphans, laidOut.size, orphanCount),
            style = MaterialTheme.typography.labelMedium,
            color = labelColor,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        )
        Canvas(
            Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    detectTransformGestures { _, panChange, zoomChange, _ ->
                        zoom = (zoom * zoomChange).coerceIn(0.3f, 6f)
                        pan += panChange
                    }
                }
                .pointerInput(laidOut) {
                    detectTapGestures { tap ->
                        val fit = fitScale(laidOut, size.width.toFloat(), size.height.toFloat())
                        val s = fit * zoom
                        val cx = size.width / 2f + pan.x; val cy = size.height / 2f + pan.y
                        val hit = laidOut.minByOrNull { n ->
                            val px = cx + n.x * s - tap.x; val py = cy + n.y * s - tap.y
                            px * px + py * py
                        } ?: return@detectTapGestures
                        val px = cx + hit.x * s - tap.x; val py = cy + hit.y * s - tap.y
                        if (sqrt(px * px + py * py) <= 28.dp.toPx()) onPageClick(hit.slug)
                    }
                },
        ) {
            val s = fitScale(laidOut, size.width, size.height) * zoom
            val c = Offset(size.width / 2f + pan.x, size.height / 2f + pan.y)
            fun pos(n: GraphNode) = Offset(c.x + n.x * s, c.y + n.y * s)
            // Node size lives in graph units (like Web) so zooming out never piles nodes on top of each other
            val minR = 2.dp.toPx()
            fun radius(n: GraphNode) = max(nodeRadius(n.degree) * s * 1.2f, minR)
            edges.forEach { (a, b) ->
                val na = bySlug[a] ?: return@forEach; val nb = bySlug[b] ?: return@forEach
                drawLine(edgeColor, pos(na), pos(nb), strokeWidth = 1.dp.toPx())
            }
            laidOut.forEach { n ->
                val r = radius(n)
                val color = kindColor(n.kind, dark)
                // Orphans are hollow: an unlinked page is a finding, not noise (same as Web)
                if (n.degree == 0) drawCircle(color, r, pos(n), style = Stroke(1.5.dp.toPx()))
                else drawCircle(color, r, pos(n))
            }
            // Hubs label first; a label that would overlap one already drawn is skipped.
            val taken = ArrayList<Rect>()
            laidOut.sortedByDescending { it.degree }.forEach { n ->
                if (zoom < 1.5f && n.slug !in labelled) return@forEach
                val p = pos(n)
                val layout = measurer.measure(n.label.take(24), TextStyle(fontSize = 11.sp, color = labelColor))
                val topLeft = Offset(p.x - layout.size.width / 2f, p.y + radius(n) + 2.dp.toPx())
                val rect = Rect(topLeft, Size(layout.size.width.toFloat(), layout.size.height.toFloat()))
                if (taken.any { it.overlaps(rect) }) return@forEach
                taken += rect
                drawText(layout, topLeft = topLeft)
            }
        }
    }
}

private fun fitScale(nodes: List<GraphNode>, w: Float, h: Float): Float {
    if (nodes.isEmpty()) return 1f
    val span = nodes.maxOf { max(kotlin.math.abs(it.x), kotlin.math.abs(it.y)) }.coerceAtLeast(1f)
    return min(w, h) / 2f * 0.85f / span
}

private fun Color.luminanceIsDark(): Boolean = (0.299f * red + 0.587f * green + 0.114f * blue) < 0.5f
