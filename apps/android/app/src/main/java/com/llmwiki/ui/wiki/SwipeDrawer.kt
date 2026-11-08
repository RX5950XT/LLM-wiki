package com.llmwiki.ui.wiki

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.material3.DrawerDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.input.pointer.util.addPointerInputChange
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlin.math.abs

/** A drag must travel this many times further sideways than up or down to move the drawer. */
private const val MIN_HORIZONTAL_RATIO = 1.5f
private const val FLING_VELOCITY_DP_PER_S = 400f
private val MAX_DRAWER_WIDTH = 360.dp
private val MIN_VISIBLE_PAGE = 56.dp
private val EDGE_ZONE_WIDTH = 40.dp
private val EDGE_ZONE_HEIGHT = 200.dp // The most Android honors per screen edge.

@Stable
internal class SwipeDrawerState(initiallyOpen: Boolean) {
    /** 0 is fully closed, 1 is fully open. */
    val progress = Animatable(if (initiallyOpen) 1f else 0f)

    var isOpen by mutableStateOf(initiallyOpen)
        private set

    val isClosed by derivedStateOf { progress.value == 0f }

    suspend fun open() {
        isOpen = true
        progress.animateTo(1f)
    }

    suspend fun close() {
        isOpen = false
        progress.animateTo(0f)
    }
}

@Composable
internal fun rememberSwipeDrawerState(): SwipeDrawerState = rememberSaveable(
    saver = Saver(save = { it.isOpen }, restore = { SwipeDrawerState(it) }),
) { SwipeDrawerState(initiallyOpen = false) }

/**
 * Side drawer that follows a horizontal swipe and never takes a page scroll.
 *
 * Replaces Material's ModalNavigationDrawer, which has no way to do either: it claims a
 * drag as soon as it has moved far enough sideways, however far it moved vertically, and
 * in the Material 3 version we use a slow drag released past halfway snaps back shut.
 */
@Composable
internal fun SwipeDrawer(
    state: SwipeDrawerState,
    gesturesEnabled: Boolean,
    paneTitle: String,
    closeLabel: String,
    drawerContent: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val scrimColor = DrawerDefaults.scrimColor
    BoxWithConstraints(modifier.fillMaxSize()) {
        val width = min(MAX_DRAWER_WIDTH, maxWidth - MIN_VISIBLE_PAGE)
        val widthPx = with(LocalDensity.current) { width.toPx() }
        Box(
            Modifier
                .fillMaxSize()
                .pointerInput(gesturesEnabled, widthPx) {
                    if (gesturesEnabled) trackDrawerSwipes(state, widthPx, scope)
                },
        ) {
            content()
            if (!state.isClosed) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer { alpha = state.progress.value }
                        .background(scrimColor)
                        .clickable(
                            interactionSource = null,
                            indication = null,
                            onClickLabel = closeLabel,
                        ) { scope.launch { state.close() } },
                )
            }
            // Stays composed while closed so the page list keeps its scroll position.
            Box(
                Modifier
                    .width(width)
                    .fillMaxHeight()
                    .graphicsLayer { translationX = -(1f - state.progress.value) * widthPx }
                    .then(
                        if (state.isClosed) {
                            Modifier.clearAndSetSemantics { }
                        } else {
                            Modifier.semantics {
                                this.paneTitle = paneTitle
                                dismiss {
                                    scope.launch { state.close() }
                                    true
                                }
                            }
                        },
                    ),
            ) {
                drawerContent()
            }
        }
    }
}

/**
 * Pointer events reach this node after every scroller inside it. So a scroller that wants
 * a drag has already consumed it by the time this looks, and a drag this turns down is
 * left untouched for that scroller to pick up. Only a clearly sideways drag gets consumed.
 */
private suspend fun PointerInputScope.trackDrawerSwipes(
    state: SwipeDrawerState,
    widthPx: Float,
    scope: CoroutineScope,
) {
    val flingVelocity = FLING_VELOCITY_DP_PER_S * density
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        val slop = viewConfiguration.touchSlop
        var total = Offset.Zero
        while (true) {
            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id }
                ?: return@awaitEachGesture
            if (!change.pressed || change.isConsumed) return@awaitEachGesture
            total += change.positionChange()
            if (abs(total.x) < slop) {
                if (abs(total.y) >= slop) return@awaitEachGesture
                continue
            }
            if (abs(total.x) < abs(total.y) * MIN_HORIZONTAL_RATIO) return@awaitEachGesture
            val canMove = if (total.x > 0) state.progress.value < 1f else state.progress.value > 0f
            if (!canMove) return@awaitEachGesture
            change.consume()
            break
        }

        val velocity = VelocityTracker().apply { addPointerInputChange(down) }
        var progress = state.progress.value
        while (true) {
            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
            if (!change.pressed) {
                if (change.changedToUp()) break
                // Cancelled, usually by the system Back gesture taking over. Put the drawer
                // back as it was: closing it here would leave Back nothing to close, and
                // Back would exit the app. A cancel arrives already consumed, a lift does not.
                scope.launch { if (state.isOpen) state.open() else state.close() }
                return@awaitEachGesture
            }
            velocity.addPointerInputChange(change)
            progress = (progress + change.positionChange().x / widthPx).coerceIn(0f, 1f)
            change.consume()
            val next = progress
            scope.launch { state.progress.snapTo(next) }
        }

        val speed = velocity.calculateVelocity().x
        val shouldOpen = when {
            speed > flingVelocity -> true
            speed < -flingVelocity -> false
            else -> progress >= 0.5f
        }
        scope.launch { if (shouldOpen) state.open() else state.close() }
    }
}

/**
 * Lets a swipe from the left screen edge open the drawer instead of triggering the
 * system Back gesture, within a band at mid height. Back still works on the rest of
 * the edge, and the band is only applied while the drawer can be swiped open.
 */
internal fun Modifier.drawerEdgeSwipeZone(density: Density): Modifier =
    systemGestureExclusion { coordinates ->
        val width = with(density) { EDGE_ZONE_WIDTH.toPx() }
        val height = with(density) { EDGE_ZONE_HEIGHT.toPx() }
        val top = (coordinates.size.height - height) / 2
        Rect(0f, top, width, top + height)
    }
