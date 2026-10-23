package com.llmwiki.ui.wiki

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
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
import androidx.compose.material.icons.filled.DragIndicator
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
    onRename: (WorkspaceRow, String) -> Unit,
    onDelete: (WorkspaceRow) -> Unit,
) {
    var editingId by remember { mutableStateOf<String?>(null) }
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
                    editing = workspace.id == editingId,
                    onClick = {
                        if (suppressClick) suppressClick = false else onSelect(workspace)
                    },
                    onStartRename = { editingId = workspace.id },
                    onCommitRename = { newName ->
                        editingId = null
                        onRename(workspace, newName)
                    },
                    onCancelRename = { editingId = null },
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
                        .pointerInput(workspace.id, editingId) {
                            if (editingId != null) return@pointerInput // no dragging while a name is being edited
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
    editing: Boolean,
    onClick: () -> Unit,
    onStartRename: () -> Unit,
    onCommitRename: (String) -> Unit,
    onCancelRename: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
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
            .clickable(enabled = !editing, onClick = onClick)
            .semantics { this.selected = selected }
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
        if (editing) {
            // Explorer-style: whole name selected, so typing replaces it
            var value by remember(name) { mutableStateOf(TextFieldValue(name, TextRange(0, name.length))) }
            val commit = {
                val trimmed = value.text.trim()
                if (trimmed.isEmpty() || trimmed == name) onCancelRename() else onCommitRename(trimmed)
            }
            InlineNameField(value, { value = it }, commit, Modifier.weight(1f))
            ActionIcon(Icons.Default.Check, stringResource(R.string.action_save), colors.primary, commit)
            ActionIcon(Icons.Default.Close, stringResource(R.string.action_cancel), colors.onSurfaceVariant, onCancelRename)
        } else {
            Text(
                name,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = if (selected) colors.primary else colors.onSurface,
                modifier = Modifier.weight(1f),
            )
            ActionIcon(Icons.Outlined.Edit, stringResource(R.string.workspace_rename_title), colors.onSurfaceVariant, onStartRename)
            ActionIcon(Icons.Outlined.Delete, stringResource(R.string.workspace_delete_title), colors.onSurfaceVariant, onDelete)
        }
    }
}

/** The workspace name as an in-place text field, focused with the keyboard up. */
@Composable
private fun InlineNameField(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val colors = MaterialTheme.colorScheme
    LaunchedEffect(Unit) {
        focus.requestFocus()
        keyboard?.show()
    }
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface),
        cursorBrush = SolidColor(colors.primary),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = modifier
            .focusRequester(focus)
            .border(1.5.dp, colors.primary, RoundedCornerShape(8.dp))
            .background(colors.surface, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    )
}

@Composable
private fun ActionIcon(icon: ImageVector, label: String, tint: Color, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(44.dp)) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(20.dp))
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
