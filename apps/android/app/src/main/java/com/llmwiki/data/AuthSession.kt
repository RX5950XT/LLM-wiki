package com.llmwiki.data

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private val refreshMutex = Mutex()

suspend fun SupabaseClient.requireAccessToken(forceRefresh: Boolean = false): String? {
    auth.awaitInitialization()
    currentAccessToken()?.let { token ->
        if (!forceRefresh) return token
    }

    return refreshMutex.withLock {
        auth.awaitInitialization()
        currentAccessToken()?.let { token ->
            if (!forceRefresh) return@withLock token
        }

        if (forceRefresh || auth.currentSessionOrNull() != null) {
            runCatching { auth.refreshCurrentSession() }
        }

        currentAccessToken()
    }
}

fun Throwable.isSupabaseAuthProblem(): Boolean {
    val detail = message.orEmpty().lowercase()
    return detail.contains("unauthorized") ||
        detail.contains("jwt") ||
        detail.contains("invalid refresh token") ||
        detail.contains("refresh token") ||
        detail.contains("session missing") ||
        detail.contains("session not found") ||
        detail.contains("not authenticated")
}

private fun SupabaseClient.currentAccessToken(): String? =
    auth.currentAccessTokenOrNull()
        ?: auth.currentSessionOrNull()?.accessToken
