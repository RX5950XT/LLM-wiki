package com.llmwiki.ui.wiki

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DragIndicator
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.llmwiki.R
import com.llmwiki.data.WorkspaceRow
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private val RowHeight = 56.dp

/**
 * Workspace list for the drawer dropdown. Long-press any row to pick it up and drag it;
 * the other rows slide aside and the order is committed on release.
 */
@Composable
internal fun WorkspaceMenuList(
    workspaces: List<WorkspaceRow>,
    currentId: String?,
    onSelect: (WorkspaceRow) -> Unit,
    onMove: (WorkspaceRow, Int) -> Unit,
    onRename: (WorkspaceRow) -> Unit,
    onDelete: (WorkspaceRow) -> Unit,
) {
    val rowPx = with(LocalDensity.current) { RowHeight.toPx() }
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val latest by rememberUpdatedState(workspaces)
    var draggingId by remember { mutableStateOf<String?>(null) }
    // A long-press release can still reach clickable; swallow that one click.
    var suppressClick by remember { mutableStateOf(false) }
    val dragOffset = remember { Animatable(0f) }

    val fromIndex = workspaces.indexOfFirst { it.id == draggingId }
    val targetIndex = if (fromIndex < 0) -1
    else (fromIndex + (dragOffset.value / rowPx).roundToInt()).coerceIn(0, workspaces.lastIndex)

    fun finishDrag() {
        val list = latest
        val from = list.indexOfFirst { it.id == draggingId }
        scope.launch {
            if (from >= 0) {
                val to = (from + (dragOffset.value / rowPx).roundToInt()).coerceIn(0, list.lastIndex)
                dragOffset.animateTo((to - from) * rowPx, spring(dampingRatio = 1f, stiffness = Spring.StiffnessMediumLow))
                if (to != from) onMove(list[from], to)
            }
            draggingId = null
            dragOffset.snapTo(0f)
            suppressClick = false
        }
    }

    Column {
        Text(
            stringResource(R.string.wiki_workspace_drag_hint),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 6.dp),
        )
        workspaces.forEachIndexed { index, workspace ->
            key(workspace.id) {
                val isDragging = workspace.id == draggingId
                val shift = when {
                    fromIndex < 0 || isDragging -> 0f
                    index in (fromIndex + 1)..targetIndex -> -rowPx
                    index in targetIndex until fromIndex -> rowPx
                    else -> 0f
                }
                // Snap back when the drag ends: the list itself has reordered by then.
                val animatedShift by animateFloatAsState(
                    targetValue = shift,
                    animationSpec = if (fromIndex < 0) snap() else spring(stiffness = Spring.StiffnessMediumLow),
                    label = "workspaceShift",
                )
                val elevation by animateDpAsState(if (isDragging) 8.dp else 0.dp, label = "workspaceLift")
                val moveUp = stringResource(R.string.workspace_move_up)
                val moveDown = stringResource(R.string.workspace_move_down)
                WorkspaceMenuRow(
                    name = workspace.name,
                    selected = workspace.id == currentId,
                    dragging = isDragging,
                    onClick = {
                        if (suppressClick) suppressClick = false else onSelect(workspace)
                    },
                    onRename = { onRename(workspace) },
                    onDelete = { onDelete(workspace) },
                    modifier = Modifier
                        .zIndex(if (isDragging) 1f else 0f)
                        .graphicsLayer {
                            translationY = if (isDragging) dragOffset.value else animatedShift
                            val scale = if (isDragging) 1.02f else 1f
                            scaleX = scale; scaleY = scale
                        }
                        .shadow(elevation, RoundedCornerShape(12.dp))
                        .semantics {
                            customActions = buildList {
                                if (index > 0) add(CustomAccessibilityAction(moveUp) { onMove(workspace, index - 1); true })
                                if (index < workspaces.lastIndex) add(CustomAccessibilityAction(moveDown) { onMove(workspace, index + 1); true })
                            }
                        }
                        .pointerInput(workspace.id) {
                            detectDragGesturesAfterLongPress(
                                onDragStart = {
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    suppressClick = true
                                    draggingId = workspace.id
                                },
                                onDrag = { change, amount ->
                                    change.consume()
                                    val from = latest.indexOfFirst { it.id == workspace.id }
                                    val next = (dragOffset.value + amount.y)
                                        .coerceIn(-from * rowPx, (latest.lastIndex - from) * rowPx)
                                    scope.launch { dragOffset.snapTo(next) }
                                },
                                onDragEnd = ::finishDrag,
                                onDragCancel = ::finishDrag,
                            )
                        },
                )
            }
        }
    }
}

@Composable
private fun WorkspaceMenuRow(
    name: String,
    selected: Boolean,
    dragging: Boolean,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var showActions by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val background = when {
        dragging -> colors.surfaceContainerHighest
        selected -> colors.primary.copy(alpha = 0.12f)
        else -> colors.surfaceContainerHigh.copy(alpha = 0f)
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(RowHeight)
            .padding(horizontal = 6.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(background)
            .clickable(onClick = onClick)
            .padding(start = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Default.DragIndicator,
            contentDescription = null,
            tint = colors.onSurfaceVariant.copy(alpha = if (dragging) 1f else 0.5f),
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(10.dp))
        Text(
            name,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) colors.primary else colors.onSurface,
            modifier = Modifier.weight(1f),
        )
        if (selected) {
            Icon(
                Icons.Default.Check,
                contentDescription = stringResource(R.string.wiki_current_workspace),
                tint = colors.primary,
                modifier = Modifier.size(18.dp),
            )
        }
        IconButton(onClick = { showActions = true }) {
            Icon(
                Icons.Default.MoreVert,
                contentDescription = stringResource(R.string.workspace_actions),
                tint = colors.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
            DropdownMenu(expanded = showActions, onDismissRequest = { showActions = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.workspace_rename_title)) },
                    leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                    onClick = { showActions = false; onRename() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.workspace_delete_title), color = colors.error) },
                    leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, tint = colors.error) },
                    onClick = { showActions = false; onDelete() },
                )
            }
        }
    }
}

@Composable
internal fun WorkspaceCreateMenuRow(onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(RowHeight)
            .padding(horizontal = 6.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.Add, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Text(
            stringResource(R.string.workspace_create_action),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}
